import { buildReminderPreviews, calculateReminder, officeClock, DEMO_RECIPIENT, validEmail } from "../_shared/reminders.ts";
import type { EmailPayload, ReminderDeadline, ReminderProject, ReminderStaff, ReminderRecipient } from "../_shared/reminders.ts";
import { sendReminderEmail } from "../_shared/email.ts";
import type { ProviderResult } from "../_shared/email.ts";

type Env = (key: string) => string | undefined;
interface Delivery {
  id: string; deadline_id: string; deadline_revision: number; recipient_email: string;
  recipient_staff_ids: string[]; payload: EmailPayload; idempotency_key: string;
  lease_token: string; first_attempt_at: string;
  stage: string; occurrence_date: string;
}
/** Fixed-length digest comparison avoids leaking the matching secret prefix. */
export async function authorized(header: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [actual, expected] = await Promise.all([digest(header.slice(7)), digest(secret)]);
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= actual[i] ^ expected[i];
  return different === 0;
}
function json(body: unknown, status = 200): Response { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
export function createReminderHandler(env: Env, fetcher: typeof fetch = fetch, clock: () => Date = () => new Date()) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!await authorized(request.headers.get("authorization"), env("REMINDER_CRON_SECRET"))) return json({ error: "Unauthorized" }, 401);
    const mode = env("REMINDER_MODE") ?? "preview";
    if (!["preview", "demo", "live"].includes(mode)) return json({ error: "Unsupported reminder mode" }, 503);
    if (mode !== "preview" && (env("REMINDER_DELIVERY_ENABLED") !== "true" || !env("RESEND_API_KEY") || !env("REMINDER_FROM"))) return json({ error: "Delivery remains disabled: configure explicit enablement, API key and sender" }, 503);
    const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ error: "Reminder service database configuration missing" }, 503);
    const rest = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetcher(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Database operation failed (${response.status})`);
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    };
    const rpc = <T>(name: string, body: unknown) => rest<T>(`rpc/${name}`, body);
    // Paginate: PostgREST's default row cap must not silently hide deadlines/recipients.
    const rows = async <T>(table: string, select: string, filter = ""): Promise<T[]> => {
      const result: T[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = await rest<T[]>(`${table}?select=${select}${filter}&order=id.asc&limit=500&offset=${offset}`);
        result.push(...page);
        if (page.length < 500) return result;
      }
    };
    try {
      const now = clock();
      if (officeClock(now).hour < 9 && mode !== "preview") return json({ mode, sent: 0, reason: "Before office dispatch time" });
      const [deadlines, projects, staff] = await Promise.all([
        rows<ReminderDeadline>("deadlines", "id,project_id,label,due_date,notice_offsets,revision,satisfied_at,archived_at", "&satisfied_at=is.null&archived_at=is.null"),
        rows<ReminderProject>("projects", "id,title,property_address"),
        rows<ReminderStaff>("staff", "id,email,is_active", "&is_active=eq.true"),
      ]);
      const recipients: ReminderRecipient[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = await rest<ReminderRecipient[]>(`deadline_recipients?select=deadline_id,staff_id&order=deadline_id.asc,staff_id.asc&limit=500&offset=${offset}`);
        recipients.push(...page); if (page.length < 500) break;
      }
      const previews = buildReminderPreviews({ deadlines, projects, staff, recipients, now, from: env("REMINDER_FROM"), appUrl: env("APP_URL"), mode: mode === "live" ? "live" : "demo" });
      if (mode === "preview") return json({ mode, sends_enabled: false, previews });
      // Bound enqueue cost per invocation. Ordering rotates naturally once recorded deliveries exist.
      // Enqueue every applicable occurrence in bounded pages; each invocation caps new RPC work.
      // Cursor is supplied by cron only if needed; no request payload is trusted for identity/payload.
      let enqueued = 0;
      // Existing occurrence lookup allows later deadlines to progress beyond the first 25.
      const existing = await rows<{ id: string; deadline_id: string; deadline_revision: number; stage: string; occurrence_date: string; recipient_email: string }>("reminder_deliveries", "id,deadline_id,deadline_revision,stage,occurrence_date,recipient_email");
      const identities = new Set(existing.map((r) => `${r.deadline_id}/${r.deadline_revision}/${r.stage}/${r.occurrence_date}/${r.recipient_email}`));
      for (const preview of previews) {
        const identity = `${preview.deadline_id}/${preview.deadline_revision}/${preview.stage}/${preview.occurrence_date}/${preview.recipient_email}`;
        if (identities.has(identity)) continue;
        await rpc("enqueue_reminder_delivery", { p_deadline_id: preview.deadline_id, p_revision: preview.deadline_revision, p_stage: preview.stage, p_occurrence_date: preview.occurrence_date, p_recipient_email: preview.recipient_email, p_recipient_staff_ids: preview.recipient_staff_ids, p_payload: preview.payload });
        if (++enqueued >= 25) break;
      }
      // Five sequential sends cap provider timeout exposure at 40 seconds per invocation.
      const claimed = await rpc<Delivery[]>("claim_reminder_deliveries", { p_limit: 5, p_now: now.toISOString() });
      let sent = 0, deferred = 0;
      const lastQuota = await rest<Array<{ metadata: Record<string, string | number | boolean> }>>("reminder_attempts?select=metadata&result=eq.quota&order=attempted_at.desc&limit=1");
      const quotaMetadata = lastQuota[0]?.metadata;
      let quota: ProviderResult | null = typeof quotaMetadata?.retry_at === "string" && Date.parse(quotaMetadata.retry_at) > now.getTime() ? { result: "quota", error: "Provider quota remains deferred until recorded reset/retry time", metadata: quotaMetadata } : null;
      for (const delivery of claimed) {
        let result: ProviderResult;
        if (quota) { result = { ...quota, error: "Batch deferred after provider quota/rate limit; no provider request attempted", metadata: { ...quota.metadata, provider_request_attempted: false } }; deferred++; }
        else {
          // Recheck after claim immediately before external IO; do not trust enqueue-time snapshots.
          const current = await rest<ReminderDeadline[]>(`deadlines?id=eq.${encodeURIComponent(delivery.deadline_id)}&select=id,project_id,label,due_date,notice_offsets,revision,satisfied_at,archived_at`);
          const liveRecipients = await rest<Array<{ staff_id: string; staff: ReminderStaff | null }>>(`deadline_recipients?deadline_id=eq.${encodeURIComponent(delivery.deadline_id)}&select=staff_id,staff(id,email,is_active)`);
          const live = current[0];
          const occurrence = live ? calculateReminder(live, clock()) : null;
          const eligible = live && live.revision === delivery.deadline_revision && occurrence?.stage === delivery.stage && occurrence.occurrence_date === delivery.occurrence_date && delivery.recipient_staff_ids.length > 0 && delivery.recipient_staff_ids.every((id) => liveRecipients.some((r) => r.staff_id === id && r.staff?.is_active && r.staff.email && validEmail(r.staff.email.trim()) && (mode === "demo" || r.staff.email.trim().toLowerCase() === delivery.recipient_email)));
          if (!eligible || (mode === "demo" && delivery.recipient_email !== DEMO_RECIPIENT) || delivery.payload.to !== delivery.recipient_email || Object.keys(delivery.payload).sort().join(",") !== "from,html,subject,text,to") result = { result: "permanent", error: "Deadline, occurrence, recipient or immutable request no longer eligible", metadata: {} };
          else result = await sendReminderEmail({ payload: delivery.payload, idempotencyKey: delivery.idempotency_key, apiKey: env("RESEND_API_KEY")!, firstAttemptAt: delivery.first_attempt_at, now: clock(), fetcher });
          if (result.result === "quota") { quota = result; deferred++; }
          if (result.result === "sent") sent++;
        }
        await rpc("record_reminder_result", { p_delivery_id: delivery.id, p_lease_token: delivery.lease_token, p_result: result.result, p_provider_id: result.provider_id ?? null, p_error: result.error ?? null, p_metadata: result.metadata, p_now: clock().toISOString() });
      }
      return json({ mode, enqueued, claimed: claimed.length, sent, deferred });
    } catch {
      // Never echo provider keys, SQL responses, request payloads, or staff PII to logs/errors.
      return json({ error: "Reminder operation failed; inspect queue and service configuration. Existing leases will recover safely." }, 500);
    }
  };
}
const deno = (globalThis as typeof globalThis & { Deno?: { env: { get: Env }; serve: (handler: (request: Request) => Promise<Response>) => void } }).Deno;
if (deno) deno.serve(createReminderHandler((key) => deno.env.get(key)));
