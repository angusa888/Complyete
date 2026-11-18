import "server-only";
import type { Tables } from "@/lib/database.types";
import { getActiveStaff } from "@/lib/supabase/auth";
import { WORKSPACE_LOAD_ERROR } from "./shared";

type SectionRows = {
  clients: Tables<"clients">[];
  projects: Tables<"projects">[];
  staff: Pick<Tables<"staff">, "id" | "display_name" | "email" | "is_active" | "is_admin">[];
  calls: Tables<"call_logs">[];
  callUpdates: Tables<"call_updates">[];
  tasks: Tables<"tasks">[];
  taskStaff: Tables<"task_staff">[];
  projectStaff: Tables<"project_staff">[];
  presetTasks: Tables<"preset_tasks">[];
  presetGroups: Tables<"preset_groups">[];
  presetGroupItems: Tables<"preset_group_items">[];
  presetApplications: Tables<"project_preset_applications">[];
  documents: Tables<"documents">[];
  documentVersions: Pick<Tables<"document_versions">, "id" | "document_id" | "original_filename" | "media_type" | "byte_size" | "upload_state" | "date_events" | "created_at" | "available_at">[];
  requirements: Tables<"document_requirements">[];
  deadlines: Tables<"deadlines">[];
  deadlineRecipients: Tables<"deadline_recipients">[];
  reminderDeliveries: Pick<Tables<"reminder_deliveries">, "id" | "deadline_id" | "stage" | "recipient_email" | "state" | "last_error" | "created_at">[];
  /** Raw imported source rows contain client information and are intentionally never returned. */
  importRows: never[];
};

export type WorkspaceSection = keyof SectionRows;
export type WorkspaceData = SectionRows & { error?: string };
export type WorkspaceQueryOptions = {
  projectId?: string;
  sections?: WorkspaceSection[];
};

const PAGE_SIZE = 500;
const MAX_PAGES = 100;

function emptyData(): SectionRows {
  return {
    clients: [], projects: [], staff: [], calls: [], callUpdates: [], tasks: [], taskStaff: [],
    projectStaff: [], presetTasks: [], presetGroups: [], presetGroupItems: [], presetApplications: [],
    documents: [], documentVersions: [], requirements: [], deadlines: [], deadlineRecipients: [],
    reminderDeliveries: [], importRows: [],
  };
}

type PageResult<T> = { data: T[] | null; error: { message: string } | null };
type PageQuery<T> = (from: number, to: number) => PromiseLike<PageResult<T>>;

async function fetchAll<T>(makeQuery: PageQuery<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await makeQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const current = data ?? [];
    rows.push(...current);
    if (current.length < PAGE_SIZE) return rows;
  }
  throw new Error("Workspace result exceeded the configured page limit.");
}

/** Load only data visible to the authenticated ESE staff session. */
export async function getWorkspaceData(options: WorkspaceQueryOptions = {}): Promise<WorkspaceData> {
  const context = await getActiveStaff();
  if (!context) return { ...emptyData(), error: "Sign in with an active staff account to continue." };

  const result = emptyData();
  const selected = new Set(options.sections ?? Object.keys(result) as WorkspaceSection[]);
  const { supabase } = context;
  const projectId = options.projectId;

  async function load<K extends WorkspaceSection>(
    key: K,
    query: PageQuery<SectionRows[K][number]>,
  ): Promise<SectionRows[K]> {
    if (!selected.has(key)) return [] as SectionRows[K];
    return await fetchAll(query) as SectionRows[K];
  }

  try {
    const [
      clients, projects, staff, calls, callUpdates, tasks, taskStaff, projectStaff,
      presetTasks, presetGroups, presetGroupItems, presetApplications, documents,
      documentVersions, requirements, deadlines, deadlineRecipients, reminderDeliveries,
    ] = await Promise.all([
      load("clients", (from, to) => supabase.from("clients").select("*").order("name").range(from, to)),
      load("projects", (from, to) => {
        let query = supabase.from("projects").select("*").order("created_at", { ascending: false });
        if (projectId) query = query.eq("id", projectId);
        return query.range(from, to);
      }),
      load("staff", (from, to) => supabase.from("staff").select("id,display_name,email,is_active,is_admin").order("display_name").range(from, to)),
      load("calls", (from, to) => supabase.from("call_logs").select("*").order("called_at", { ascending: false }).range(from, to)),
      load("callUpdates", (from, to) => supabase.from("call_updates").select("*").order("created_at").range(from, to)),
      load("tasks", (from, to) => {
        let query = supabase.from("tasks").select("*").order("position").order("created_at", { ascending: false });
        if (projectId) query = query.eq("project_id", projectId);
        return query.range(from, to);
      }),
      load("taskStaff", (from, to) => supabase.from("task_staff").select("*").range(from, to)),
      load("projectStaff", (from, to) => supabase.from("project_staff").select("*").range(from, to)),
      load("presetTasks", (from, to) => supabase.from("preset_tasks").select("*").order("name").range(from, to)),
      load("presetGroups", (from, to) => supabase.from("preset_groups").select("*").order("name").range(from, to)),
      load("presetGroupItems", (from, to) => supabase.from("preset_group_items").select("*").order("position").range(from, to)),
      load("presetApplications", (from, to) => {
        let query = supabase.from("project_preset_applications").select("*").order("applied_at", { ascending: false });
        if (projectId) query = query.eq("project_id", projectId);
        return query.range(from, to);
      }),
      load("documents", (from, to) => {
        let query = supabase.from("documents").select("*").order("created_at", { ascending: false });
        if (projectId) query = query.eq("project_id", projectId);
        return query.range(from, to);
      }),
      load("documentVersions", (from, to) => supabase.from("document_versions").select("id,document_id,original_filename,media_type,byte_size,upload_state,date_events,created_at,available_at").order("created_at", { ascending: false }).range(from, to)),
      load("requirements", (from, to) => {
        let query = supabase.from("document_requirements").select("*").order("created_at");
        if (projectId) query = query.eq("project_id", projectId);
        return query.range(from, to);
      }),
      load("deadlines", (from, to) => {
        let query = supabase.from("deadlines").select("*").order("due_date");
        if (projectId) query = query.eq("project_id", projectId);
        return query.range(from, to);
      }),
      load("deadlineRecipients", (from, to) => supabase.from("deadline_recipients").select("*").range(from, to)),
      load("reminderDeliveries", (from, to) => supabase.from("reminder_deliveries").select("id,deadline_id,stage,recipient_email,state,last_error,created_at").order("created_at", { ascending: false }).range(from, to)),
    ]);
    return {
      ...result,
      clients,
      projects,
      staff,
      calls,
      callUpdates,
      tasks,
      taskStaff,
      projectStaff,
      presetTasks,
      presetGroups,
      presetGroupItems,
      presetApplications,
      documents,
      documentVersions,
      requirements,
      deadlines,
      deadlineRecipients,
      reminderDeliveries,
    };
  } catch {
    return { ...emptyData(), error: WORKSPACE_LOAD_ERROR };
  }
}
