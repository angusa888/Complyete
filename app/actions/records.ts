'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getActiveStaff } from '@/lib/supabase/auth';
import {
  ActionState,
  safeActionError,
  STAFF_REQUIRED_MESSAGE,
} from '@/lib/features/shared';
import {
  dateSchema,
  emailSchema,
  formOptionalText,
  formStringList,
  formText,
  uuidSchema,
} from '@/lib/features/validation';

const clientIdSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger, 'Enter a valid client.');
const clientStatusSchema = z.enum(['Active', 'On hold', 'Archived']);
const taskCategorySchema = z.enum(['fieldwork', 'paperwork', 'other']);
const taskStatusSchema = z.enum(['To do', 'In progress', 'Blocked', 'Awaiting paperwork', 'Completed']);

class UserInputError extends Error {}

function text(form: FormData, key: string, max = 5000) {
  const value = formOptionalText(form, key, max);
  return value;
}

function requiredText(form: FormData, key: string, max = 500) {
  return z.string().trim().min(1, `${key.replaceAll('_', ' ')} is required.`).max(max).parse(formText(form, key));
}

function optionalEmail(form: FormData) {
  const value = formText(form, 'email');
  return value ? emailSchema.parse(value) : null;
}

function parseError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? 'Check the form fields and try again.';
  if (error instanceof UserInputError) return error.message;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P0001') {
    return 'The project cannot be completed yet. Check required intake, tasks, signed documents, and deadlines.';
  }
  return safeActionError(error);
}

async function runAction(
  mutation: (context: NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>) => Promise<void>,
  success: string,
  paths: string[] | (() => string[]),
): Promise<ActionState> {
  const context = await getActiveStaff();
  if (!context) return { error: STAFF_REQUIRED_MESSAGE };
  try {
    await mutation(context);
    const pathsToRevalidate = typeof paths === 'function' ? paths() : paths;
    for (const path of new Set(pathsToRevalidate)) revalidatePath(path);
    return { success };
  } catch (error) {
    return { error: parseError(error) };
  }
}

function staffIdsFromForm(form: FormData): string[] | undefined {
  if (!form.has('staff_ids_present') && !form.has('staff_ids')) return undefined;
  return [...new Set(formStringList(form, 'staff_ids').map((id) => uuidSchema.parse(id)))];
}

async function validateActiveStaffIds(
  supabase: NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>['supabase'],
  ids: string[] | undefined,
) {
  if (!ids?.length) return;
  const { data, error } = await supabase.from('staff').select('id').eq('is_active', true).in('id', ids);
  if (error) throw error;
  if ((data?.length ?? 0) !== ids.length) throw new UserInputError('Choose only active ESE staff members.');
}

async function syncProjectStaff(
  supabase: NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>['supabase'],
  projectId: string,
  ids: string[] | undefined,
) {
  if (ids === undefined) return;
  const { error: deleteError } = await supabase.from('project_staff').delete().eq('project_id', projectId);
  if (deleteError) throw deleteError;
  if (!ids.length) return;
  const { error } = await supabase.from('project_staff').insert(ids.map((staffId) => ({ project_id: projectId, staff_id: staffId })));
  if (error) throw error;
}

async function syncTaskStaff(
  supabase: NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>['supabase'],
  taskId: string,
  ids: string[] | undefined,
) {
  if (ids === undefined) return;
  const { error: deleteError } = await supabase.from('task_staff').delete().eq('task_id', taskId);
  if (deleteError) throw deleteError;
  if (!ids.length) return;
  const { error } = await supabase.from('task_staff').insert(ids.map((staffId) => ({ task_id: taskId, staff_id: staffId })));
  if (error) throw error;
}

function optionalDate(form: FormData, key: string) {
  const raw = formText(form, key);
  return raw ? dateSchema.parse(raw) : null;
}

/** datetime-local values are interpreted as ESE office time, not the Worker host's timezone. */
function officeDateTimeToIso(raw: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) throw new UserInputError('Enter a valid call date and time.');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const nominalUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(nominalUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    throw new UserInputError('Enter a valid call date and time.');
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  function localParts(timestamp: number) {
    const parsed = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
    return [Number(parsed.year), Number(parsed.month), Number(parsed.day), Number(parsed.hour), Number(parsed.minute), Number(parsed.second)];
  }
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta += 6) {
    const sample = nominalUtc + delta * 60 * 60 * 1000;
    const [sampleYear, sampleMonth, sampleDay, sampleHour, sampleMinute, sampleSecond] = localParts(sample);
    const representedUtc = Date.UTC(sampleYear, sampleMonth - 1, sampleDay, sampleHour, sampleMinute, sampleSecond);
    offsets.add((representedUtc - sample) / 60_000);
  }
  const candidates = [...offsets]
    .map((offset) => nominalUtc - offset * 60_000)
    .filter((timestamp) => localParts(timestamp).every((value, index) => value === parts[index]))
    .sort((left, right) => left - right);
  if (!candidates.length) throw new UserInputError('That local time does not exist because clocks change for daylight saving time. Choose another time.');
  // When the fall-back hour occurs twice, choose its earlier occurrence consistently.
  return new Date(candidates[0]).toISOString();
}

async function validateClientExists(
  supabase: NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>['supabase'],
  id: number,
  requireActive = false,
) {
  let query = supabase.from('clients').select('id,archived_at').eq('id', id);
  if (requireActive) query = query.is('archived_at', null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new UserInputError('Choose an existing, active client.');
}

function clientValues(form: FormData) {
  return {
    name: requiredText(form, 'name'),
    company: text(form, 'company', 500),
    phone: text(form, 'phone', 100),
    cell_phone: text(form, 'cell_phone', 100),
    email: optionalEmail(form),
    office_client_number: text(form, 'office_client_number', 100),
    billing_address: text(form, 'billing_address', 1000),
    referral_source: text(form, 'referral_source', 500),
    contact_notes: text(form, 'contact_notes', 5000),
  };
}

export async function createClientAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const { error } = await supabase.from('clients').insert(clientValues(form));
    if (error) throw error;
  }, 'Client added.', ['/clients', '/projects']);
}

export async function updateClientAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const id = clientIdSchema.parse(formText(form, 'id'));
    const { data, error } = await supabase.from('clients').update(clientValues(form)).eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new UserInputError('Client not found.');
  }, 'Client updated.', ['/clients', '/projects']);
}

export async function archiveClientAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, staff }) => {
    const id = clientIdSchema.parse(formText(form, 'id'));
    const { data, error } = await supabase.from('clients').update({ archived_at: new Date().toISOString(), archived_by: staff.id })
      .eq('id', id).is('archived_at', null).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new UserInputError('Client not found or already archived.');
  }, 'Client archived. Linked projects and calls are preserved.', ['/clients', '/projects', '/calls']);
}

export async function restoreClientAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const id = clientIdSchema.parse(formText(form, 'id'));
    const { data, error } = await supabase.from('clients').update({ archived_at: null, archived_by: null })
      .eq('id', id).not('archived_at', 'is', null).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new UserInputError('Client not found or already active.');
  }, 'Client restored.', ['/clients', '/projects', '/calls']);
}

function projectValues(form: FormData) {
  return {
    title: requiredText(form, 'title'),
    office_prefix: text(form, 'office_prefix', 100),
    project_number: text(form, 'project_number', 100),
    property_address: text(form, 'property_address', 1000),
    details: text(form, 'details', 5000),
  };
}

export async function createProjectAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const values = projectValues(form);
    const clientId = clientIdSchema.parse(formText(form, 'client_id'));
    const staffIds = staffIdsFromForm(form);
    await validateClientExists(supabase, clientId, true);
    await validateActiveStaffIds(supabase, staffIds);
    const { data, error } = await supabase.from('projects').insert({ ...values, client_id: clientId }).select('id').single();
    if (error) throw error;
    await syncProjectStaff(supabase, data.id, staffIds);
  }, 'Project created.', ['/projects', '/clients']);
}

export async function updateProjectAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  let projectPath = '/projects';
  return runAction(async ({ supabase, staff }) => {
    const id = uuidSchema.parse(formText(form, 'id'));
    projectPath = `/projects/${id}`;
    const values = projectValues(form);
    const status = clientStatusSchema.parse(formText(form, 'status'));
    const staffIds = staffIdsFromForm(form);
    await validateActiveStaffIds(supabase, staffIds);
    const { data: existing, error: lookupError } = await supabase.from('projects').select('id,status').eq('id', id).maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) throw new UserInputError('Project not found.');
    const savedStatus = existing.status === 'Completed' ? 'Completed' : status;
    const acceptedDate = optionalDate(form, 'proposal_accepted_date');
    const { error } = await supabase.from('projects').update({
      ...values,
      status: savedStatus,
      proposal_accepted_date: acceptedDate,
      notes: text(form, 'notes', 5000),
      archived_at: savedStatus === 'Archived' ? new Date().toISOString() : null,
      archived_by: savedStatus === 'Archived' ? staff.id : null,
    }).eq('id', id);
    if (error) throw error;
    await syncProjectStaff(supabase, id, staffIds);
  }, 'Project updated.', () => ['/projects', projectPath, '/clients']);
}

export async function completeProjectAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  let projectPath = '/projects';
  return runAction(async ({ supabase }) => {
    const id = uuidSchema.parse(formText(form, 'id'));
    projectPath = `/projects/${id}`;
    const { error } = await supabase.rpc('complete_project', { p_project_id: id });
    if (error) throw error;
  }, 'Project completed.', () => ['/projects', projectPath]);
}

async function validateCallLinks(
  supabase: NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>['supabase'],
  clientId: number | null,
  projectId: string | null,
) {
  if (clientId !== null) await validateClientExists(supabase, clientId);
  if (!projectId) return clientId;
  const { data: project, error } = await supabase.from('projects').select('id,client_id').eq('id', projectId).maybeSingle();
  if (error) throw error;
  if (!project) throw new UserInputError('Choose an existing project.');
  if (clientId !== null && project.client_id !== null && project.client_id !== clientId) {
    throw new UserInputError('The selected client does not match the project.');
  }
  return clientId ?? project.client_id;
}

export async function createCallAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, staff }) => {
    const callerName = requiredText(form, 'caller_name');
    const calledAt = officeDateTimeToIso(requiredText(form, 'called_at', 40));
    const clientRaw = formText(form, 'client_id');
    const clientId = clientRaw ? clientIdSchema.parse(clientRaw) : null;
    const projectRaw = formText(form, 'project_id');
    const projectId = projectRaw ? uuidSchema.parse(projectRaw) : null;
    const phone = text(form, 'phone', 100);
    const email = optionalEmail(form);
    const summary = requiredText(form, 'summary', 5000);
    const linkedClient = await validateCallLinks(supabase, clientId, projectId);
    const { error } = await supabase.from('call_logs').insert({
      caller_name: callerName,
      called_at: calledAt,
      phone,
      email,
      client_id: linkedClient,
      project_id: projectId,
      summary,
      recorded_by: staff.id,
    });
    if (error) throw error;
  }, 'Call recorded.', ['/calls', '/clients', '/projects']);
}

export async function addCallUpdateAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, staff }) => {
    const callId = uuidSchema.parse(formText(form, 'call_log_id'));
    const body = requiredText(form, 'body', 5000);
    const { data: call, error: lookupError } = await supabase.from('call_logs').select('id,deleted_at').eq('id', callId).maybeSingle();
    if (lookupError) throw lookupError;
    if (!call || call.deleted_at) throw new UserInputError('Follow-ups can only be added to an active call.');
    const { error } = await supabase.from('call_updates').insert({ call_log_id: callId, body, author_id: staff.id });
    if (error) throw error;
  }, 'Follow-up added.', ['/calls']);
}

export async function deleteCallAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, staff }) => {
    const id = uuidSchema.parse(formText(form, 'id'));
    const { data, error } = await supabase.from('call_logs').update({ deleted_at: new Date().toISOString(), deleted_by: staff.id })
      .eq('id', id).is('deleted_at', null).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new UserInputError('Call not found or already deleted.');
  }, 'Call deleted; its original conversation and follow-ups are retained.', ['/calls']);
}

export async function deleteCallUpdateAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, staff }) => {
    const id = uuidSchema.parse(formText(form, 'id'));
    const { data, error } = await supabase.from('call_updates').update({ deleted_at: new Date().toISOString(), deleted_by: staff.id })
      .eq('id', id).is('deleted_at', null).select('id,call_log_id').maybeSingle();
    if (error) throw error;
    if (!data) throw new UserInputError('Follow-up not found or already deleted.');
  }, 'Follow-up deleted; its history is retained.', ['/calls']);
}

export async function createTaskAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  let projectPath = '/projects';
  return runAction(async ({ supabase }) => {
    const projectId = uuidSchema.parse(formText(form, 'project_id'));
    projectPath = `/projects/${projectId}`;
    const parentRaw = formText(form, 'parent_task_id');
    const parentTaskId = parentRaw ? uuidSchema.parse(parentRaw) : null;
    const title = requiredText(form, 'title');
    const category = taskCategorySchema.parse(formText(form, 'category'));
    const description = text(form, 'description', 5000);
    const dueDate = optionalDate(form, 'due_date');
    const staffIds = staffIdsFromForm(form);
    await validateActiveStaffIds(supabase, staffIds);
    const { data: project, error: projectError } = await supabase.from('projects').select('id,archived_at').eq('id', projectId).maybeSingle();
    if (projectError) throw projectError;
    if (!project || project.archived_at) throw new UserInputError('Choose an active project.');
    if (parentTaskId) {
      const { data: parent, error: parentError } = await supabase.from('tasks').select('id,project_id,parent_task_id').eq('id', parentTaskId).maybeSingle();
      if (parentError) throw parentError;
      if (!parent || parent.project_id !== projectId || parent.parent_task_id !== null) {
        throw new UserInputError('A subtask must use a top-level task from this project.');
      }
    }
    const { data, error } = await supabase.from('tasks').insert({
      project_id: projectId,
      parent_task_id: parentTaskId,
      title,
      category,
      description,
      due_date: dueDate,
      status: 'To do',
      is_required: true,
      requires_proposal: false,
    }).select('id').single();
    if (error) throw error;
    await syncTaskStaff(supabase, data.id, staffIds);
  }, 'Task created.', () => ['/tasks', '/projects', projectPath]);
}

export async function updateTaskAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  let projectPath = '/projects';
  return runAction(async ({ supabase }) => {
    const id = uuidSchema.parse(formText(form, 'id'));
    const title = requiredText(form, 'title');
    const description = text(form, 'description', 5000);
    const dueDate = optionalDate(form, 'due_date');
    const category = taskCategorySchema.parse(formText(form, 'category'));
    const status = taskStatusSchema.parse(formText(form, 'status'));
    const staffIds = staffIdsFromForm(form);
    await validateActiveStaffIds(supabase, staffIds);
    const { data: existing, error: lookupError } = await supabase.from('tasks').select('id,project_id,archived_at').eq('id', id).maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing || existing.archived_at) throw new UserInputError('Task not found or archived.');
    projectPath = `/projects/${existing.project_id}`;
    const { error } = await supabase.from('tasks').update({ title, description, due_date: dueDate, category, status }).eq('id', id);
    if (error) throw error;
    await syncTaskStaff(supabase, id, staffIds);
  }, 'Task updated.', () => ['/tasks', '/projects', projectPath]);
}
