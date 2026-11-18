/** Pure office-calendar scheduling shared by the app preview and Edge dispatcher. */
export const DEMO_RECIPIENT = "revisa@rpi.edu";
export type ReminderStage = "notice_30" | "notice_14" | "notice_3" | "overdue";
export interface ReminderDeadline {
  id: string; project_id: string; label: string; due_date: string; notice_offsets: number[];
  revision: number; satisfied_at?: string | null; archived_at?: string | null;
}
export interface ReminderProject { id: string; title: string; property_address?: string | null }
export interface ReminderStaff { id: string; email: string | null; is_active: boolean }
export interface ReminderRecipient { deadline_id: string; staff_id: string }
export interface ReminderOccurrence { stage: ReminderStage; occurrence_date: string; days_until_due: number }
export interface EmailPayload { from: string; to: string; subject: string; html: string; text: string }
export interface ReminderPreview extends ReminderOccurrence {
  deadline_id: string; deadline_revision: number; recipient_email: string;
  recipient_staff_ids: string[]; payload: EmailPayload;
}
const dayMs = 86_400_000;
function dateNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const result = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value ? result / dayMs : NaN;
}
function calendarDate(day: number): string { return new Date(day * dayMs).toISOString().slice(0, 10); }
export function officeClock(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}
/** Before 09:00 there is no dispatch, including catch-up. Overdue starts the day after due. */
export function calculateReminder(deadline: ReminderDeadline, now = new Date()): ReminderOccurrence | null {
  if (deadline.satisfied_at || deadline.archived_at) return null;
  const clock = officeClock(now);
  if (clock.hour < 9) return null;
  const due = dateNumber(deadline.due_date), today = dateNumber(clock.date);
  const offsets = deadline.notice_offsets;
  if (!Number.isFinite(due) || offsets.length !== 3 || offsets.some((v) => !Number.isInteger(v) || v < 0) || !(offsets[0] > offsets[1] && offsets[1] > offsets[2])) return null;
  const days = due - today;
  if (days < 0) return { stage: "overdue", occurrence_date: clock.date, days_until_due: days };
  const stages: ReminderStage[] = ["notice_30", "notice_14", "notice_3"];
  for (let i = 2; i >= 0; i--) {
    if (days <= offsets[i]) return { stage: stages[i], occurrence_date: calendarDate(due - offsets[i]), days_until_due: days };
  }
  return null;
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
export function validEmail(value: string): boolean { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && !/[\r\n]/.test(value); }
export function projectLink(appUrl: string | undefined, id: string): string | null {
  if (!appUrl) return null;
  const url = new URL(appUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("APP_URL must be an HTTPS URL without credentials, query, or fragment");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}/projects/${encodeURIComponent(id)}`;
}
export function buildReminderPreviews(input: {
  deadlines: ReminderDeadline[]; projects: ReminderProject[]; staff: ReminderStaff[];
  recipients: ReminderRecipient[]; now?: Date; from?: string; appUrl?: string; mode?: "preview" | "demo" | "live";
}): ReminderPreview[] {
  const result: ReminderPreview[] = [];
  const now = input.now ?? new Date();
  const from = input.from ?? "Complyete <onboarding@resend.dev>";
  if (/[\r\n]/.test(from)) throw new Error("Invalid sender");
  for (const deadline of input.deadlines) {
    const occurrence = calculateReminder(deadline, now);
    const project = input.projects.find((p) => p.id === deadline.project_id);
    if (!occurrence || !project) continue;
    const groups = new Map<string, string[]>();
    for (const r of input.recipients.filter((r) => r.deadline_id === deadline.id)) {
      const staff = input.staff.find((s) => s.id === r.staff_id);
      if (!staff?.is_active || !staff.email || !validEmail(staff.email.trim())) continue;
      const to = input.mode === "live" ? staff.email.trim().toLowerCase() : DEMO_RECIPIENT;
      groups.set(to, [...(groups.get(to) ?? []), staff.id]);
    }
    const link = projectLink(input.appUrl, project.id);
    const status = occurrence.stage === "overdue" ? `Overdue by ${-occurrence.days_until_due} day(s)` : `Due ${deadline.due_date}`;
    const lines = ["Complyete deadline reminder", `Project: ${project.title}`, `Property: ${project.property_address || "Not specified"}`, `Paperwork: ${deadline.label}`, `Due date: ${deadline.due_date}`, status,
      "Upload the signed paperwork and verify this deadline's document requirement in Complyete to stop its reminders.", ...(link ? [`Open project: ${link}`] : []), ...(input.mode === "live" ? [] : ["Demonstration delivery: redirected to revisa@rpi.edu."])];
    for (const [to, staffIds] of groups) {
      const payload = { from, to, subject: `Complyete: ${deadline.label} — ${status}`.replace(/[\r\n]/g, " "), text: lines.join("\n"), html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("") };
      result.push({ ...occurrence, deadline_id: deadline.id, deadline_revision: deadline.revision, recipient_email: to, recipient_staff_ids: [...new Set(staffIds)].sort(), payload });
    }
  }
  return result;
}
