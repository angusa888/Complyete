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
  formChecked,
  formJson,
  formOptionalText,
  formText,
  uuidSchema,
} from '@/lib/features/validation';

const presetTypeSchema = z.enum(['task', 'group']);
const categorySchema = z.enum(['Proposal', 'Transmittal', 'Filings', 'Permits', 'Compliance docs', 'Other']);
const intakeFieldSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(500),
  type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'boolean']),
  required: z.boolean(),
  position: z.number().int().nonnegative().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
}).superRefine((field, context) => {
  if (field.type === 'select' && (!field.options || field.options.length === 0)) {
    context.addIssue({ code: 'custom', message: `Add at least one choice for “${field.label}”.`, path: ['options'] });
  }
  if (field.type !== 'select' && field.options?.length) {
    context.addIssue({ code: 'custom', message: `Choices are only valid for select fields (“${field.label}”).`, path: ['options'] });
  }
  if (field.options && new Set(field.options.map((option) => option.toLocaleLowerCase())).size !== field.options.length) {
    context.addIssue({ code: 'custom', message: `Choices for “${field.label}” must be unique.`, path: ['options'] });
  }
});

const intakeFieldsSchema = z.array(intakeFieldSchema).max(100).superRefine((fields, context) => {
  const ids = new Set<string>();
  for (const [index, field] of fields.entries()) {
    if (ids.has(field.id)) context.addIssue({ code: 'custom', message: 'Question IDs must be unique.', path: [index, 'id'] });
    ids.add(field.id);
  }
}).transform((fields) => fields.map((field, position) => ({ ...field, position })));

const documentRequirementSchema = z.object({
  label: z.string().trim().min(1).max(500),
  category: z.preprocess((value) => value === '' ? null : value, categorySchema.nullable().optional()),
  is_required: z.boolean().default(true),
  requires_signed: z.boolean().default(false),
}).transform((requirement) => ({
  label: requirement.label,
  category: requirement.category ?? null,
  is_required: requirement.is_required,
  requires_signed: requirement.requires_signed,
}));

const requirementsSchema = z.array(documentRequirementSchema).max(100);
const groupItemSchema = z.object({
  id: uuidSchema,
  preset_task_id: uuidSchema,
  parent_item_id: uuidSchema.nullable().optional(),
  position: z.number().int().nonnegative(),
});
const groupItemsSchema = z.array(groupItemSchema).max(500).superRefine((items, context) => {
  const ids = new Set<string>();
  const positions = new Set<number>();
  const itemById = new Map<string, z.infer<typeof groupItemSchema>>();
  items.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: 'custom', message: 'Group item IDs must be unique.', path: [index, 'id'] });
    if (positions.has(item.position)) context.addIssue({ code: 'custom', message: 'Group task positions must be unique.', path: [index, 'position'] });
    ids.add(item.id);
    positions.add(item.position);
    itemById.set(item.id, item);
  });
  for (const [index, item] of items.entries()) {
    if (!item.parent_item_id) continue;
    const parent = itemById.get(item.parent_item_id);
    if (!parent || parent.parent_item_id || parent.position >= item.position) {
      context.addIssue({ code: 'custom', message: 'A subtask must follow a top-level task in this group.', path: [index, 'parent_item_id'] });
    }
  }
});

const intakeAnswerValueSchema = z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]);
const intakeAnswersSchema = z.record(z.string().max(200), intakeAnswerValueSchema).refine(
  (answers) => Object.keys(answers).length <= 500,
  'Too many intake answers were submitted.',
);

class UserInputError extends Error {}

function requiredText(form: FormData, key: string, max = 500) {
  return z.string().trim().min(1, `${key.replaceAll('_', ' ')} is required.`).max(max).parse(formText(form, key));
}

function optionalText(form: FormData, key: string, max = 5000) {
  return formOptionalText(form, key, max);
}

function parseError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? 'Check the form fields and try again.';
  if (error instanceof UserInputError) return error.message;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P0001') {
    return 'Check that the preset is active and its questions or group tasks are valid.';
  }
  return safeActionError(error);
}

async function runAction(
  mutation: (context: NonNullable<Awaited<ReturnType<typeof getActiveStaff>>>) => Promise<void>,
  success: string,
  paths: string[] | (() => string[]),
): Promise<ActionState> {
  try {
    const context = await getActiveStaff();
    if (!context) return { error: STAFF_REQUIRED_MESSAGE };
    await mutation(context);
    const pathsToRevalidate = typeof paths === 'function' ? paths() : paths;
    for (const path of new Set(pathsToRevalidate)) revalidatePath(path);
    return { success };
  } catch (error) {
    return { error: parseError(error) };
  }
}

function parseIntakeFields(form: FormData) {
  return formJson(form, 'intake_fields', intakeFieldsSchema, []);
}

function parseRequirements(form: FormData) {
  return formJson(form, 'document_requirements', requirementsSchema, []);
}

function parseGroupItems(form: FormData) {
  const items = formJson(form, 'items', groupItemsSchema, []);
  if (new Set(items.map((item) => item.position)).size !== items.length) {
    throw new UserInputError('Group task positions must be unique.');
  }
  return items;
}

function presetId(form: FormData) {
  const raw = formText(form, 'id');
  return raw ? uuidSchema.parse(raw) : null;
}

export async function savePresetTaskAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const id = presetId(form);
    const name = requiredText(form, 'name');
    const description = optionalText(form, 'description');
    const category = z.enum(['fieldwork', 'paperwork', 'other']).parse(formText(form, 'category'));
    const isRequired = formChecked(form, 'is_required');
    const requiresProposal = formChecked(form, 'requires_proposal');
    const intakeFields = parseIntakeFields(form);
    const documentRequirements = parseRequirements(form);
    const values = {
      name,
      description,
      category,
      is_required: isRequired,
      requires_proposal: requiresProposal,
      intake_fields: intakeFields,
      document_requirements: documentRequirements,
    };

    if (id) {
      const { data, error } = await supabase.from('preset_tasks').update(values).eq('id', id).select('id').maybeSingle();
      if (error) throw error;
      if (!data) throw new UserInputError('Task preset not found.');
    } else {
      const { error } = await supabase.from('preset_tasks').insert(values);
      if (error) throw error;
    }
  }, 'Task preset saved. Existing project copies are unchanged.', ['/presets', '/projects']);
}

export async function savePresetGroupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const groupId = presetId(form);
    const name = requiredText(form, 'name');
    const description = optionalText(form, 'description');
    const intakeFields = parseIntakeFields(form);
    const items = parseGroupItems(form);
    const { data, error } = await supabase.rpc('save_preset_group', {
      p_group_id: groupId,
      p_name: name,
      p_description: description,
      p_intake_fields: intakeFields,
      p_items: items,
    });
    if (error) throw error;
    if (!data) throw new UserInputError('The group could not be saved.');
  }, 'Preset group saved. Existing project copies are unchanged.', ['/presets', '/projects']);
}

export async function archivePresetAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const id = uuidSchema.parse(formText(form, 'id'));
    const type = presetTypeSchema.parse(formText(form, 'preset_type'));
    const table = type === 'task' ? 'preset_tasks' : 'preset_groups';
    const { data, error } = await supabase.from(table).update({ archived_at: new Date().toISOString() })
      .eq('id', id).is('archived_at', null).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new UserInputError('Preset not found or already archived.');
  }, 'Preset archived. Existing project copies are unchanged.', ['/presets', '/projects']);
}

export async function applyPresetAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  let projectPath = '/projects';
  return runAction(async ({ supabase }) => {
    const projectId = uuidSchema.parse(formText(form, 'project_id'));
    projectPath = `/projects/${projectId}`;
    const presetId = uuidSchema.parse(formText(form, 'preset_id'));
    const presetType = presetTypeSchema.parse(formText(form, 'preset_type'));
    const intakeAnswers = formJson(form, 'intake_answers', intakeAnswersSchema, {});
    const { error } = await supabase.rpc('apply_preset', {
      p_project_id: projectId,
      p_preset_type: presetType,
      p_preset_id: presetId,
      p_intake_answers: intakeAnswers,
    });
    if (error) throw error;
  }, 'Preset applied. This project now has its own copy of the tasks and requirements.', () => ['/projects', projectPath, '/tasks']);
}

export async function updateIntakeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  let projectPath = '/projects';
  return runAction(async ({ supabase }) => {
    const applicationId = uuidSchema.parse(formText(form, 'application_id'));
    const intakeAnswers = formJson(form, 'intake_answers', intakeAnswersSchema, {});
    const { data: application, error: lookupError } = await supabase.from('project_preset_applications')
      .select('id,project_id').eq('id', applicationId).maybeSingle();
    if (lookupError) throw lookupError;
    if (!application) throw new UserInputError('Preset application not found.');
    projectPath = `/projects/${application.project_id}`;
    const { error } = await supabase.rpc('update_preset_intake', {
      p_application_id: applicationId,
      p_intake_answers: intakeAnswers,
    });
    if (error) throw error;
  }, 'Intake answers saved.', () => ['/projects', projectPath]);
}
