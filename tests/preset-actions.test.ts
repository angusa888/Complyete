import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveStaff: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/supabase/auth', () => ({ getActiveStaff: mocks.getActiveStaff }));

import { applyPresetAction, savePresetGroupAction } from '@/app/actions/presets';

const activeStaffId = '11111111-1111-4111-8111-111111111111';
const presetId = '22222222-2222-4222-8222-222222222222';
const rootItemId = '33333333-3333-4333-8333-333333333333';
const childItemId = '44444444-4444-4444-8444-444444444444';
const rootTaskId = '55555555-5555-4555-8555-555555555555';
const childTaskId = '66666666-6666-4666-8666-666666666666';

describe('preset server actions', () => {
  let supabase: { rpc: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    supabase = { rpc: vi.fn().mockResolvedValue({ data: presetId, error: null }) };
    mocks.getActiveStaff.mockResolvedValue({
      supabase,
      staff: { id: activeStaffId, is_active: true },
    });
  });

  it('saves a group through the atomic RPC with stable ordered items', async () => {
    const form = new FormData();
    form.set('name', 'Property Staking');
    form.set('description', 'Ordered work');
    form.set('intake_fields', JSON.stringify([{ id: 'permit_type', label: 'Permit type', type: 'select', required: true, options: ['Local', 'State'] }]));
    form.set('items', JSON.stringify([
      { id: rootItemId, preset_task_id: rootTaskId, position: 0 },
      { id: childItemId, preset_task_id: childTaskId, parent_item_id: rootItemId, position: 1 },
    ]));

    const result = await savePresetGroupAction({}, form);

    expect(result).toEqual({ success: 'Preset group saved. Existing project copies are unchanged.' });
    expect(supabase.rpc).toHaveBeenCalledWith('save_preset_group', {
      p_group_id: null,
      p_name: 'Property Staking',
      p_description: 'Ordered work',
      p_intake_fields: [{ id: 'permit_type', label: 'Permit type', type: 'select', required: true, options: ['Local', 'State'], position: 0 }],
      p_items: [
        { id: rootItemId, preset_task_id: rootTaskId, position: 0 },
        { id: childItemId, preset_task_id: childTaskId, parent_item_id: rootItemId, position: 1 },
      ],
    });
  });

  it('rejects duplicate field IDs before making a database call', async () => {
    const form = new FormData();
    form.set('name', 'Duplicate questions');
    form.set('intake_fields', JSON.stringify([
      { id: 'same', label: 'First', type: 'text', required: false },
      { id: 'same', label: 'Second', type: 'text', required: false },
    ]));
    form.set('items', '[]');

    const result = await savePresetGroupAction({}, form);

    expect(result.error).toBe('Question IDs must be unique.');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('keeps false and zero intake answers when applying a preset', async () => {
    const projectId = '77777777-7777-4777-8777-777777777777';
    const form = new FormData();
    form.set('project_id', projectId);
    form.set('preset_id', presetId);
    form.set('preset_type', 'task');
    form.set('intake_answers', JSON.stringify({ approved: false, count: 0 }));

    const result = await applyPresetAction({}, form);

    expect(result).toEqual({ success: 'Preset applied. This project now has its own copy of the tasks and requirements.' });
    expect(supabase.rpc).toHaveBeenCalledWith('apply_preset', {
      p_project_id: projectId,
      p_preset_type: 'task',
      p_preset_id: presetId,
      p_intake_answers: { approved: false, count: 0 },
    });
  });
});
