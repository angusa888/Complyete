import { describe, expect, it, vi } from "vitest";
import { buildReminderPreviews, calculateReminder, officeClock, projectLink, type ReminderDeadline } from "../supabase/functions/_shared/reminders";
import { classifyProviderResponse, retryAfterDate, sendReminderEmail } from "../supabase/functions/_shared/email";
import { authorized, createReminderHandler } from "../supabase/functions/dispatch-reminders/index";

const deadline: ReminderDeadline = { id: "deadline-1", project_id: "project-1", label: 'Signed <permit> & "approval"', due_date: "2026-12-18", notice_offsets: [30, 14, 3], revision: 2 };
const now = new Date("2026-11-18T14:00:00Z");
const input = {
  deadlines: [deadline], projects: [{ id: "project-1", title: "<script>alert(1)</script>", property_address: "1 Main & Oak" }],
  staff: [{ id: "staff-1", email: "a@example.com", is_active: true }, { id: "staff-2", email: "b@example.com", is_active: true }, { id: "inactive", email: "x@example.com", is_active: false }, { id: "invalid", email: "bad", is_active: true }],
  recipients: [{ deadline_id: deadline.id, staff_id: "staff-1" }, { deadline_id: deadline.id, staff_id: "staff-2" }, { deadline_id: deadline.id, staff_id: "inactive" }, { deadline_id: deadline.id, staff_id: "invalid" }], now,
};
const secret = "a-long-random-cron-secret-with-32-characters";
const request = () => new Request("https://edge.example/dispatch-reminders", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
const result = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers });
describe("office calendar and occurrence identity", () => {
  it("gates before 9AM in winter and summer", () => {
    expect(calculateReminder(deadline, new Date("2026-11-18T13:59:59Z"))).toBeNull();
    expect(calculateReminder({ ...deadline, due_date: "2026-07-01" }, new Date("2026-06-01T12:59:59Z"))).toBeNull();
    expect(calculateReminder({ ...deadline, due_date: "2026-07-01" }, new Date("2026-06-01T13:00:00Z"))?.stage).toBe("notice_30");
  });
  it("keeps 9AM local across both DST transitions", () => {
    expect(officeClock(new Date("2026-03-08T13:00:00Z"))).toEqual({ date: "2026-03-08", hour: 9 });
    expect(officeClock(new Date("2026-11-01T14:00:00Z"))).toEqual({ date: "2026-11-01", hour: 9 });
    expect(officeClock(new Date("2026-03-08T04:30:00Z")).date).toBe("2026-03-07");
  });
  it("catches up with only highest urgency and original scheduled occurrence date", () => {
    expect(calculateReminder(deadline, now)).toEqual({ stage: "notice_30", occurrence_date: "2026-11-18", days_until_due: 30 });
    expect(calculateReminder(deadline, new Date("2026-12-10T15:00:00Z"))).toEqual({ stage: "notice_14", occurrence_date: "2026-12-04", days_until_due: 8 });
    expect(calculateReminder(deadline, new Date("2026-12-17T15:00:00Z"))).toEqual({ stage: "notice_3", occurrence_date: "2026-12-15", days_until_due: 1 });
    expect(calculateReminder(deadline, new Date("2026-11-17T15:00:00Z"))).toBeNull();
  });
  it("uses editable offsets with stable database stage enums", () => {
    expect(calculateReminder({ ...deadline, notice_offsets: [45, 20, 0] }, new Date("2026-12-01T15:00:00Z"))).toEqual({ stage: "notice_14", occurrence_date: "2026-11-28", days_until_due: 17 });
    expect(calculateReminder({ ...deadline, notice_offsets: [45, 20, 0] }, new Date("2026-12-18T15:00:00Z"))?.stage).toBe("notice_3");
  });
  it("overdue occurs once per office day and never emits historical days", () => {
    expect(calculateReminder(deadline, new Date("2027-01-05T15:00:00Z"))).toEqual({ stage: "overdue", occurrence_date: "2027-01-05", days_until_due: -18 });
    expect(calculateReminder(deadline, new Date("2026-12-18T15:00:00Z"))?.stage).toBe("notice_3");
  });
  it("suppresses satisfied/archived/invalid schedules independently", () => {
    expect(calculateReminder({ ...deadline, satisfied_at: now.toISOString() }, now)).toBeNull();
    expect(calculateReminder({ ...deadline, archived_at: now.toISOString() }, now)).toBeNull();
    expect(calculateReminder({ ...deadline, due_date: "2026-02-30" }, now)).toBeNull();
    expect(calculateReminder({ ...deadline, notice_offsets: [3, 14, 30] }, now)).toBeNull();
    expect(buildReminderPreviews({ ...input, deadlines: [{ ...deadline, satisfied_at: now.toISOString() }, { ...deadline, id: "other" }], recipients: [{ deadline_id: "other", staff_id: "staff-1" }] })).toHaveLength(1);
  });
});
describe("immutable email previews", () => {
  it("redirects all eligible staff once and preserves IDs; excludes inactive/invalid", () => {
    const previews = buildReminderPreviews(input);
    expect(previews).toHaveLength(1);
    expect(previews[0].recipient_email).toBe("revisa@rpi.edu");
    expect(previews[0].recipient_staff_ids).toEqual(["staff-1", "staff-2"]);
    expect(typeof previews[0].payload.to).toBe("string");
    expect(previews[0].payload.html).toContain("&lt;script&gt;");
    expect(previews[0].payload.html).not.toContain("<script>");
    expect(previews[0].payload.text).toContain('Signed <permit> & "approval"');
    expect(Object.keys(previews[0].payload).sort()).toEqual(["from", "html", "subject", "text", "to"]);
  });
  it("live mode groups normalized duplicate addresses, keeps separate staff emails", () => {
    const previews = buildReminderPreviews({ ...input, mode: "live", staff: [...input.staff, { id: "staff-3", email: " A@EXAMPLE.COM ", is_active: true }], recipients: [...input.recipients, { deadline_id: deadline.id, staff_id: "staff-3" }] });
    expect(previews).toHaveLength(2);
    expect(previews.find((p) => p.recipient_email === "a@example.com")?.recipient_staff_ids).toEqual(["staff-1", "staff-3"]);
    expect(previews[0].payload.text).not.toContain("Demonstration delivery");
  });
  it("rejects unsafe app URLs and sender injection, omits unavailable links", () => {
    expect(projectLink(undefined, "p")).toBeNull();
    expect(projectLink("https://example.com/app/", "a/b")).toBe("https://example.com/app/projects/a%2Fb");
    for (const url of ["javascript:alert(1)", "http://example.com", "https://user:pass@example.com", "https://example.com?x=1"]) expect(() => projectLink(url, "p")).toThrow();
    expect(() => buildReminderPreviews({ ...input, from: "x\r\nBcc: bad@example.com" })).toThrow();
    expect(buildReminderPreviews({ ...input, staff: [] })).toEqual([]);
    expect(buildReminderPreviews(input)).toEqual(buildReminderPreviews(input));
  });
});
describe("provider classification, quotas and immutable retries", () => {
  it("handles retry-after seconds and HTTP dates", () => {
    expect(retryAfterDate("120", now)?.toISOString()).toBe("2026-11-18T14:02:00.000Z");
    expect(retryAfterDate("Wed, 18 Nov 2026 15:00:00 GMT", now)?.toISOString()).toBe("2026-11-18T15:00:00.000Z");
    expect(retryAfterDate("yesterday", now)).toBeNull();
  });
  it("defers daily quota to UTC midnight and monthly to provider reset", () => {
    expect(classifyProviderResponse(429, { name: "daily_quota_exceeded" }, new Headers({ "retry-after": "60" }), now).metadata.retry_at).toBe("2026-11-19T00:00:00.000Z");
    expect(classifyProviderResponse(429, { name: "monthly_quota_exceeded" }, new Headers({ "retry-after": "172800" }), now).metadata.retry_at).toBe("2026-11-20T14:00:00.000Z");
    expect(classifyProviderResponse(429, { name: "monthly_quota_exceeded" }, new Headers(), now).metadata.operator_review).toBe(true);
  });
  it("distinguishes transient errors, permanent rejection and idempotency mismatch", () => {
    expect(classifyProviderResponse(500, {}, new Headers(), now).result).toBe("transient");
    expect(classifyProviderResponse(409, { name: "concurrent_idempotent_requests" }, new Headers(), now).result).toBe("transient");
    expect(classifyProviderResponse(409, { name: "invalid_idempotent_request" }, new Headers(), now).result).toBe("ambiguous");
    expect(classifyProviderResponse(403, { name: "validation_error" }, new Headers(), now).result).toBe("permanent");
    expect(classifyProviderResponse(200, {}, new Headers(), now).result).toBe("transient");
  });
  it("reuses identical request and key through unknown network result", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(result({ id: "email-1" }));
    const options = { payload: buildReminderPreviews(input)[0].payload, idempotencyKey: "stable-key", apiKey: "test-key", firstAttemptAt: now.toISOString(), now, fetcher };
    expect((await sendReminderEmail(options)).result).toBe("transient");
    expect((await sendReminderEmail(options)).provider_id).toBe("email-1");
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    expect((fetcher.mock.calls[1][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("stable-key");
  });
  it("never calls provider at/after 23h ambiguity boundary", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await sendReminderEmail({ payload: buildReminderPreviews(input)[0].payload, idempotencyKey: "same", apiKey: "test", firstAttemptAt: "2026-11-17T15:00:00Z", now, fetcher });
    expect(response.result).toBe("ambiguous"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("aborts a stalled provider request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const response = await sendReminderEmail({ payload: buildReminderPreviews(input)[0].payload, idempotencyKey: "same", apiKey: "test", firstAttemptAt: now.toISOString(), now, fetcher, timeoutMs: 5 });
    expect(response.result).toBe("transient");
    expect(response.metadata.provider_outcome_unknown).toBe(true);
  });
});
describe("HTTP service authorization and IO boundaries", () => {
  const config: Record<string, string> = { REMINDER_CRON_SECRET: secret, SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "service-only", REMINDER_FROM: "office@example.com", RESEND_API_KEY: "fake-never-real", REMINDER_DELIVERY_ENABLED: "true" };
  function mockService(options: { changed?: boolean; quota?: boolean; existingQuota?: boolean } = {}) {
    const preview = buildReminderPreviews(input)[0];
    const deliveries = [1, 2].map((n) => ({ ...preview, id: `delivery-${n}`, lease_token: `lease-${n}`, idempotency_key: `immutable-${n}`, first_attempt_at: now.toISOString() }));
    const records: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (address, init) => {
      const url = String(address);
      if (url === "https://api.resend.com/emails") return options.quota ? result({ name: "daily_quota_exceeded", message: "Daily quota" }, 429) : result({ id: "provider-1" });
      const path = new URL(url).pathname.split("/").pop();
      if (path === "record_reminder_result") { records.push(JSON.parse(String(init?.body))); return result(null); }
      if (path === "enqueue_reminder_delivery") return result("queued-id");
      if (path === "claim_reminder_deliveries") return result(deliveries);
      if (path === "deadlines") return result([{ ...deadline, ...(options.changed && url.includes("id=eq.") ? { revision: 3 } : {}) }]);
      if (path === "projects") return result(input.projects);
      if (path === "staff") return result(input.staff);
      if (path === "deadline_recipients") return result(url.includes("staff(id") ? input.staff.slice(0, 2).map((staff) => ({ staff_id: staff.id, staff })) : input.recipients);
      if (path === "reminder_deliveries") return result([]);
      if (path === "reminder_attempts") return result(options.existingQuota ? [{ metadata: { retry_at: "2026-11-19T00:00:00Z", quota_scope: "daily_quota_exceeded" } }] : []);
      throw new Error(`Unexpected mock request ${path}`);
    });
    return { fetcher, records };
  }
  it("requires a sufficiently strong exact bearer and rejects GET/anonymous before database IO", async () => {
    expect(await authorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(await authorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(await authorized("Bearer short", "short")).toBe(false);
    const fetcher = vi.fn<typeof fetch>();
    const handler = createReminderHandler((key) => config[key], fetcher);
    expect((await handler(new Request("https://edge.example"))).status).toBe(405);
    expect((await handler(new Request("https://edge.example", { method: "POST" }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("defaults preview with no enqueue, claim, result or provider request", async () => {
    const { fetcher } = mockService();
    const response = await createReminderHandler((key) => config[key], fetcher, () => now)(request());
    const body = await response.json() as { mode: string; sends_enabled: boolean; previews: unknown[] };
    expect(response.status).toBe(200); expect(body.mode).toBe("preview"); expect(body.sends_enabled).toBe(false);
    expect(body.previews).toHaveLength(1);
    expect(fetcher.mock.calls.every(([url, init]) => !String(url).includes("/rpc/") && !String(url).includes("resend.com") && init?.method === "GET")).toBe(true);
  });
  it("requires explicit sending enablement and credentials", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createReminderHandler((key) => key === "REMINDER_MODE" ? "demo" : key === "REMINDER_DELIVERY_ENABLED" ? undefined : config[key], fetcher)(request());
    expect(response.status).toBe(503); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rechecks revision after claim and never sends a changed deadline", async () => {
    const { fetcher, records } = mockService({ changed: true });
    await createReminderHandler((key) => key === "REMINDER_MODE" ? "demo" : config[key], fetcher, () => now)(request());
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("resend.com"))).toBe(false);
    expect(records.map((r) => r.p_result)).toEqual(["permanent", "permanent"]);
  });
  it("stops batch on quota, records remaining work without provider sends", async () => {
    const { fetcher, records } = mockService({ quota: true });
    const response = await createReminderHandler((key) => key === "REMINDER_MODE" ? "demo" : config[key], fetcher, () => now)(request());
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("resend.com"))).toHaveLength(1);
    expect(records.map((r) => r.p_result)).toEqual(["quota", "quota"]);
    expect(records[1].p_metadata).toMatchObject({ provider_request_attempted: false, retry_at: "2026-11-19T00:00:00.000Z" });
  });
  it("honors persisted quota ledger across invocations", async () => {
    const { fetcher, records } = mockService({ existingQuota: true });
    await createReminderHandler((key) => key === "REMINDER_MODE" ? "demo" : config[key], fetcher, () => now)(request());
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("resend.com"))).toHaveLength(0);
    expect(records.map((r) => r.p_result)).toEqual(["quota", "quota"]);
  });
  it("sends only frozen demo payloads with stable keys and records genuine provider success", async () => {
    const { fetcher, records } = mockService();
    const response = await createReminderHandler((key) => key === "REMINDER_MODE" ? "demo" : config[key], fetcher, () => now)(request());
    const body = await response.json() as { sent: number };
    expect(body.sent).toBe(2);
    const calls = fetcher.mock.calls.filter(([url]) => String(url).includes("resend.com"));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0][1]?.body)).to).toBe("revisa@rpi.edu");
    expect((calls[0][1]?.headers as Record<string, string>)["Idempotency-Key"]).toBe("immutable-1");
    expect(records[0]).toMatchObject({ p_result: "sent", p_provider_id: "provider-1", p_lease_token: "lease-1" });
  });
  it("does not claim pending work before local 9AM", async () => {
    const { fetcher } = mockService();
    const response = await createReminderHandler((key) => key === "REMINDER_MODE" ? "demo" : config[key], fetcher, () => new Date("2026-11-18T13:00:00Z"))(request());
    expect(response.status).toBe(200); expect(fetcher).not.toHaveBeenCalled();
  });
});
