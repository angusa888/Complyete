import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getActiveStaff: vi.fn(), revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase/auth", () => ({ getActiveStaff: mocks.getActiveStaff }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { previewRemindersAction, saveDeadlineAction } from "@/app/actions/deadlines";

type QueryResult = { data: unknown; error: null };
type QueryBuilder = {
  select: (columns?: string) => QueryBuilder;
  eq: (column: string, value: unknown) => QueryBuilder;
  in: (column: string, values: unknown[]) => QueryBuilder;
  maybeSingle: () => Promise<QueryResult>;
  then: <TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
};

function queryBuilder(result: QueryResult): QueryBuilder {
  const query: QueryBuilder = {
    select: () => query,
    eq: () => query,
    in: () => query,
    maybeSingle: async () => result,
    then: (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected),
  };
  return query;
}

describe("deadline actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid or non-descending reminder offsets before querying data", async () => {
    const from = vi.fn();
    mocks.getActiveStaff.mockResolvedValue({ supabase: { from, rpc: vi.fn() }, staff: { id: "staff-id" } });
    const form = new FormData();
    form.set("project_id", "11111111-1111-4111-8111-111111111111");
    form.set("label", "Permit expires");
    form.set("kind", "permit");
    form.set("due_date", "2027-03-10");
    form.set("notice_offsets", "14,30,3");

    const result = await saveDeadlineAction({}, form);

    expect(result.error).toContain("descending");
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects inactive recipients before mutating an existing deadline", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const deadlineId = "22222222-2222-4222-8222-222222222222";
    const staffId = "33333333-3333-4333-8333-333333333333";
    const from = vi.fn((table: string) => queryBuilder(table === "projects"
      ? { data: { id: projectId, archived_at: null }, error: null }
      : { data: [], error: null }));
    mocks.getActiveStaff.mockResolvedValue({ supabase: { from, rpc: vi.fn() }, staff: { id: staffId } });
    const form = new FormData();
    form.set("id", deadlineId);
    form.set("project_id", projectId);
    form.set("label", "Permit expires");
    form.set("kind", "permit");
    form.set("due_date", "2027-03-10");
    form.set("notice_offsets", "30,14,3");
    form.set("recipient_ids_present", "1");
    form.append("recipient_ids", staffId);

    const result = await saveDeadlineAction({}, form);

    expect(result.error).toContain("current ESE staff");
    expect(from).toHaveBeenCalledWith("staff");
    expect(from).not.toHaveBeenCalledWith("deadlines");
  });

  it("previews through the pure helper without enqueueing or sending", async () => {
    const deadlineId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const staffId = "33333333-3333-4333-8333-333333333333";
    const tableData: Record<string, QueryResult> = {
      deadlines: { data: { id: deadlineId, project_id: projectId, label: "Permit", due_date: "2099-01-01", notice_offsets: [30, 14, 3], revision: 1, satisfied_at: null, archived_at: null }, error: null },
      projects: { data: { id: projectId, title: "Property staking", property_address: "1 Main St" }, error: null },
      deadline_recipients: { data: [{ deadline_id: deadlineId, staff_id: staffId }], error: null },
      staff: { data: [{ id: staffId, email: "staff@example.com", is_active: true }], error: null },
    };
    const from = vi.fn((table: string) => queryBuilder(tableData[table]));
    const rpc = vi.fn();
    mocks.getActiveStaff.mockResolvedValue({ supabase: { from, rpc }, staff: { id: staffId } });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const form = new FormData();
    form.set("id", deadlineId);

    try {
      const result = await previewRemindersAction({}, form);
      expect(result.data).toEqual([]);
      expect(result.success).toContain("No email was queued or sent");
      expect(rpc).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
