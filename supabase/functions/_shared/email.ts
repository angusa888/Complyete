import type { EmailPayload } from "./reminders.ts";

export type DeliveryResult = "sent" | "transient" | "quota" | "ambiguous" | "permanent";
export interface ProviderResult {
  result: DeliveryResult; provider_id?: string; error?: string;
  metadata: Record<string, string | number | boolean>;
}
export function retryAfterDate(header: string | null, now: Date): Date | null {
  if (!header) return null;
  const ms = /^\d+(\.\d+)?$/.test(header.trim()) ? now.getTime() + Number(header) * 1000 : Date.parse(header);
  return Number.isFinite(ms) && ms > now.getTime() ? new Date(ms) : null;
}
export function classifyProviderResponse(status: number, body: Record<string, unknown>, headers: Headers, now: Date): ProviderResult {
  const name = typeof body.name === "string" ? body.name : "unknown";
  const error = typeof body.message === "string" ? body.message.slice(0, 500) : `Provider HTTP ${status}`;
  const metadata: ProviderResult["metadata"] = { http_status: status, provider_error: name };
  if (status >= 200 && status < 300) return typeof body.id === "string" && body.id ? { result: "sent", provider_id: body.id, metadata } : { result: "transient", error: "Provider success missing email ID; retry immutable request within idempotency window", metadata };
  if (status === 429 || name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") {
    let retry = retryAfterDate(headers.get("retry-after"), now);
    if (name === "daily_quota_exceeded") {
      const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      if (!retry || retry < midnight) retry = midnight;
    } else if (name === "monthly_quota_exceeded") {
      // Billing reset may differ from calendar month: prefer provider Retry-After, otherwise
      // retain visibly deferred for a day and require operator billing/reset verification.
      retry ??= new Date(now.getTime() + 24 * 60 * 60 * 1000);
      metadata.operator_review = !headers.has("retry-after");
    }
    retry ??= new Date(now.getTime() + 60 * 60 * 1000);
    metadata.retry_at = retry.toISOString();
    metadata.quota_scope = name;
    return { result: "quota", error, metadata };
  }
  if (name === "invalid_idempotent_request") return { result: "ambiguous", error: "Immutable request mismatch; manual provider review required", metadata };
  if (status >= 500 || status === 408 || (status === 409 && name === "concurrent_idempotent_requests")) return { result: "transient", error, metadata };
  return { result: "permanent", error, metadata };
}
/** Network uncertainty is retried only with the original payload and original stable key. */
export async function sendReminderEmail(input: {
  payload: EmailPayload; idempotencyKey: string; apiKey: string; firstAttemptAt: string;
  now?: Date; fetcher?: typeof fetch; timeoutMs?: number;
}): Promise<ProviderResult> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(Date.parse(input.firstAttemptAt)) || now.getTime() - Date.parse(input.firstAttemptAt) >= 23 * 60 * 60 * 1000) return { result: "ambiguous", error: "Provider idempotency window nearly expired; manual review required", metadata: {} };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const response = await (input.fetcher ?? fetch)("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify(input.payload), signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    return classifyProviderResponse(response.status, body, response.headers, now);
  } catch {
    return { result: "transient", error: "Provider outcome unknown (network/timeout); retry original idempotency key only", metadata: { provider_outcome_unknown: true } };
  } finally { clearTimeout(timeout); }
}
