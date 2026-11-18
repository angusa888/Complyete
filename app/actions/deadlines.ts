"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { buildReminderPreviews, type ReminderDeadline, type ReminderProject, type ReminderRecipient, type ReminderStaff } from "@/supabase/functions/_shared/reminders";
import { getActiveStaff } from "@/lib/supabase/auth";
import type { Tables } from "@/lib/database.types";
import { safeActionError, STAFF_REQUIRED_MESSAGE, type ActionState } from "@/lib/features/shared";
import { dateSchema, formStringList, formText, uuidSchema } from "@/lib/features/validation";

const deadlineKindSchema = z.enum(["permit", "final_sign_off"]);
const offsetsSchema = z.array(z.number().int().min(0).max(366)).length(3).refine(
  ([advance, reminder, urgent]) => advance > reminder && reminder > urgent,
  "Enter three distinct offsets in descending order: advance, reminder, urgent.",
);
const emailSchema = z.string().trim().email().max(254);
type StaffContext = NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>;
type DeadlineRow = Tables<"deadlines">;

class UserInputError extends Error {}

function requiredText(form: FormData, key: string, max = 500) {
  return z.string().trim().min(1, `${key.replaceAll("_", " ")} is required.`).max(max).parse(formText(form, key));
}

function parseOffsets(form: FormData) {
  const raw = requiredText(form, "notice_offsets", 100);
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new UserInputError("Enter three offsets as comma-separated whole days, for example 30,14,3.");
  }
  return offsetsSchema.parse(parts.map(Number));
}

function selectedRecipientIds(form: FormData): string[] | undefined {
  if (!form.has("recipient_ids_present") && !form.has("recipient_ids")) return undefined;
  return [...new Set(formStringList(form, "recipient_ids").map((id) => uuidSchema.parse(id)))];
}

function parseError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the deadline fields and try again.";
  if (error instanceof UserInputError) return error.message;
  return safeActionError(error, "The deadline request could not be completed. Please try again.");
}

async function activeContext() {
  const context = await getActiveStaff();
  if (!context) throw new UserInputError(STAFF_REQUIRED_MESSAGE);
  return context;
}

async function runAction(
  mutation: (context: StaffContext) => Promise<{ success?: string; data?: unknown; paths?: string[] }>,
): Promise<ActionState> {
  try {
    const context = await activeContext();
    const result = await mutation(context);
    for (const path of new Set(result.paths ?? [])) revalidatePath(path);
    return { success: result.success, data: result.data };
  } catch (error) {
    return { error: parseError(error) };
  }
}

async function projectPath(context: StaffContext, id: string) {
  const { data, error } = await context.supabase.from("projects").select("id,archived_at").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || data.archived_at) throw new UserInputError("Choose an active project.");
  return `/projects/${data.id}`;
}

async function validateRecipients(context: StaffContext, ids: string[]) {
  if (ids.length === 0) throw new UserInputError("Choose at least one active ESE staff recipient.");
  const { data, error } = await context.supabase.from("staff").select("id,email,is_active").eq("is_active", true).in("id", ids);
  if (error) throw error;
  if (!data || data.length !== ids.length) throw new UserInputError("Choose only current ESE staff members.");
  if (data.some((staff) => !staff.email || !emailSchema.safeParse(staff.email.trim()).success)) {
    throw new UserInputError("Every recipient must have a valid staff email address.");
  }
}

async function syncRecipients(context: StaffContext, deadlineId: string, desired: string[]) {
  const { data: current, error: listError } = await context.supabase.from("deadline_recipients").select("staff_id").eq("deadline_id", deadlineId);
  if (listError) throw listError;
  const existing = new Set((current ?? []).map((row) => row.staff_id));
  const requested = new Set(desired);
  const remove = [...existing].filter((id) => !requested.has(id));
  const add = [...requested].filter((id) => !existing.has(id));
  if (remove.length) {
    const { error } = await context.supabase.from("deadline_recipients").delete().eq("deadline_id", deadlineId).in("staff_id", remove);
    if (error) throw error;
  }
  if (add.length) {
    const { error } = await context.supabase.from("deadline_recipients").insert(add.map((staffId) => ({ deadline_id: deadlineId, staff_id: staffId })));
    if (error) throw error;
  }
}

async function ensureDeadlineRequirement(
  context: StaffContext,
  deadline: Pick<DeadlineRow, "id" | "project_id" | "kind" | "label">,
) {
  const category = deadline.kind === "permit" ? "Permits" : "Compliance docs";
  const { data: existing, error: listError } = await context.supabase
    .from("document_requirements").select("id,requires_signed").eq("deadline_id", deadline.id).eq("is_required", true);
  if (listError) throw listError;
  if (!existing?.length) {
    const { error } = await context.supabase.from("document_requirements").insert({
      project_id: deadline.project_id,
      deadline_id: deadline.id,
      label: `${deadline.label} — signed paperwork`,
      category,
      is_required: true,
      requires_signed: true,
    });
    if (error) throw error;
    return;
  }
  const missingSignedEvidence = existing.filter((requirement) => !requirement.requires_signed).map((requirement) => requirement.id);
  if (missingSignedEvidence.length) {
    const { error } = await context.supabase.from("document_requirements").update({ requires_signed: true })
      .eq("deadline_id", deadline.id).in("id", missingSignedEvidence);
    if (error) throw error;
  }
}

export async function saveDeadlineAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (context) => {
    const idRaw = formText(form, "id");
    const id = idRaw ? uuidSchema.parse(idRaw) : null;
    const projectId = uuidSchema.parse(formText(form, "project_id"));
    const label = requiredText(form, "label");
    const kind = deadlineKindSchema.parse(formText(form, "kind"));
    const dueDate = dateSchema.parse(formText(form, "due_date"));
    const noticeOffsets = parseOffsets(form);
    const recipientIds = selectedRecipientIds(form);
    const path = await projectPath(context, projectId);

    // Reject invalid assignments before changing the deadline schedule or its recipients.
    if (recipientIds !== undefined) await validateRecipients(context, recipientIds);
    else if (!id) throw new UserInputError("Choose at least one active ESE staff recipient.");

    let deadlineId = id;
    if (id) {
      const { data: existing, error: lookupError } = await context.supabase.from("deadlines")
        .select("id,project_id,archived_at").eq("id", id).maybeSingle();
      if (lookupError) throw lookupError;
      if (!existing || existing.project_id !== projectId || existing.archived_at) throw new UserInputError("Deadline not found or archived.");
      const { error } = await context.supabase.from("deadlines").update({ label, kind, due_date: dueDate, notice_offsets: noticeOffsets }).eq("id", id);
      if (error) throw error;
    } else {
      const { data, error } = await context.supabase.from("deadlines").insert({
        project_id: projectId,
        label,
        kind,
        due_date: dueDate,
        notice_offsets: noticeOffsets,
      }).select("id").single();
      if (error) throw error;
      deadlineId = data.id;
    }

    try {
      await ensureDeadlineRequirement(context, { id: deadlineId!, project_id: projectId, kind, label });
      if (recipientIds !== undefined) await syncRecipients(context, deadlineId!, recipientIds);
    } catch (error) {
      if (!id && deadlineId) {
        // A newly created deadline must not remain active without its required paperwork record.
        await context.supabase.from("deadlines").update({ archived_at: new Date().toISOString() }).eq("id", deadlineId);
      }
      throw error;
    }

    return { success: id ? "Deadline updated." : "Deadline created with its own signed-document requirement.", paths: ["/projects", path] };
  });
}

export async function verifyRequirementAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (context) => {
    const requirementId = uuidSchema.parse(formText(form, "requirement_id"));
    const documentVersionId = uuidSchema.parse(formText(form, "document_version_id"));
    const { data: requirement, error: lookupError } = await context.supabase.from("document_requirements")
      .select("id,project_id,deadline_id").eq("id", requirementId).maybeSingle();
    if (lookupError) throw lookupError;
    if (!requirement) throw new UserInputError("Document requirement not found.");

    const { error } = await context.supabase.rpc("verify_document_requirement", {
      p_requirement_id: requirementId,
      p_document_version_id: documentVersionId,
    });
    if (error) throw error;

    let success = "Signed-document requirement verified.";
    if (requirement.deadline_id) {
      const { data: required, error: requirementsError } = await context.supabase.from("document_requirements")
        .select("verified_version_id").eq("deadline_id", requirement.deadline_id).eq("is_required", true);
      if (requirementsError) throw requirementsError;
      if (!required?.length) throw new UserInputError("This deadline has no required paperwork configured.");
      if (required.every((item) => item.verified_version_id)) {
        const { error: satisfyError } = await context.supabase.rpc("satisfy_deadline", { p_deadline_id: requirement.deadline_id });
        if (satisfyError) throw satisfyError;
        success = "Signed-document requirement verified; this deadline is satisfied.";
      } else {
        success = "Signed-document requirement verified; the deadline stays open until all required paperwork is verified.";
      }
    }
    return { success, paths: ["/projects", `/projects/${requirement.project_id}`] };
  });
}

export async function reopenDeadlineAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (context) => {
    const id = uuidSchema.parse(formText(form, "id"));
    const { data: deadline, error: lookupError } = await context.supabase.from("deadlines")
      .select("id,project_id,satisfied_at,archived_at").eq("id", id).maybeSingle();
    if (lookupError) throw lookupError;
    if (!deadline || deadline.archived_at) throw new UserInputError("Deadline not found or archived.");
    if (!deadline.satisfied_at) throw new UserInputError("This deadline is already open.");
    const { error } = await context.supabase.from("deadlines").update({ satisfied_at: null }).eq("id", id);
    if (error) throw error;
    // The database guard clears satisfied_by and the audit trigger records who reopened it.
    return { success: "Deadline reopened. Existing document evidence remains on record.", paths: ["/projects", `/projects/${deadline.project_id}`] };
  });
}

function safeHttpsAppUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export async function previewRemindersAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async (context) => {
    const id = uuidSchema.parse(formText(form, "id"));
    const { data: deadline, error: deadlineError } = await context.supabase.from("deadlines")
      .select("id,project_id,label,due_date,notice_offsets,revision,satisfied_at,archived_at").eq("id", id).maybeSingle();
    if (deadlineError) throw deadlineError;
    if (!deadline) throw new UserInputError("Deadline not found.");
    const { data: project, error: projectError } = await context.supabase.from("projects")
      .select("id,title,property_address").eq("id", deadline.project_id).maybeSingle();
    if (projectError) throw projectError;
    if (!project) throw new UserInputError("The project for this deadline could not be found.");
    const { data: recipientRows, error: recipientError } = await context.supabase.from("deadline_recipients")
      .select("deadline_id,staff_id").eq("deadline_id", id);
    if (recipientError) throw recipientError;
    const recipientIds = [...new Set((recipientRows ?? []).map((row) => row.staff_id))];
    const { data: staffRows, error: staffError } = recipientIds.length
      ? await context.supabase.from("staff").select("id,email,is_active").eq("is_active", true).in("id", recipientIds)
      : { data: [], error: null };
    if (staffError) throw staffError;

    const previews = buildReminderPreviews({
      deadlines: [deadline as ReminderDeadline],
      projects: [project as ReminderProject],
      staff: (staffRows ?? []) as ReminderStaff[],
      recipients: (recipientRows ?? []) as ReminderRecipient[],
      now: new Date(),
      from: process.env.REMINDER_FROM || "Complyete <onboarding@resend.dev>",
      appUrl: safeHttpsAppUrl(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL),
      mode: "demo",
    });
    return {
      success: previews.length ? "Reminder preview ready. No email was queued or sent." : "No reminder is currently due to preview. No email was queued or sent.",
      data: previews,
      paths: [],
    };
  });
}
