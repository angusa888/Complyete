/** Baseline types from migrations 001–004. Regenerate against Supabase after deployment. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
type Times = { created_at: string; updated_at: string };
type Archive = { archived_at: string | null };
type ActorArchive = Archive & { archived_by: string | null };
type Table<Row, Required extends keyof Row = never> = { Row: Row; Insert: Partial<Row> & Pick<Row, Required>; Update: Partial<Row>; Relationships: [] };
export type Staff = Times & { id: string; auth_user_id: string | null; display_name: string; email: string | null; is_active: boolean; is_admin: boolean };
type Client = Times & ActorArchive & { id: number; name: string; phone: string | null; email: string | null; company: string | null; cell_phone: string | null; billing_address: string | null; contact_notes: string | null; referral_source: string | null; office_client_number: string | null };
type Project = Times & ActorArchive & { id: string; client_id: number | null; office_prefix: string | null; project_number: string | null; property_address: string | null; title: string; details: string | null; services: string[]; status: "Active" | "On hold" | "Completed" | "Archived"; original_status: string | null; notes: string | null; timeframe: string | null; first_contact_date: string | null; proposal_sent_date: string | null; proposal_accepted_date: string | null; filed_date: string | null; meeting_date: string | null; legacy_assignment: string | null; historical_completed_unverified: boolean; import_run_id: string | null; source_sheet: string | null; source_row: number | null; completed_at: string | null; completed_by: string | null };
type PresetTask = Times & Archive & { id: string; name: string; description: string | null; category: "fieldwork" | "paperwork" | "other"; is_required: boolean; requires_proposal: boolean; intake_fields: Json; document_requirements: Json; revision: number };
type Task = Times & Archive & { id: string; project_id: string; parent_task_id: string | null; title: string; description: string | null; category: "fieldwork" | "paperwork" | "other"; status: "To do" | "In progress" | "Blocked" | "Awaiting paperwork" | "Completed"; due_date: string | null; position: number; is_required: boolean; requires_proposal: boolean; application_id: string | null; source_snapshot: Json; completed_at: string | null; completed_by: string | null };
type DocumentVersion = { id: string; document_id: string; object_path: string; original_filename: string; media_type: string; byte_size: number; upload_state: "pending" | "available" | "invalid"; date_events: Json; uploaded_by: string | null; created_at: string; available_at: string | null };
type Delivery = { id: string; deadline_id: string; deadline_revision: number; stage: string; occurrence_date: string; recipient_email: string; recipient_staff_ids: string[]; payload: Json; idempotency_key: string; state: string; attempt_count: number; available_at: string; lease_token: string | null; leased_until: string | null; first_attempt_at: string | null; sent_at: string | null; provider_id: string | null; last_error: string | null; created_at: string };
export type Database = {
  public: {
    Tables: {
      staff: Table<Staff, "display_name">;
      clients: Table<Client, "name">;
      projects: Table<Project, "title">;
      project_staff: Table<{project_id: string; staff_id: string}, "project_id" | "staff_id">;
      call_logs: Table<{id: string; client_id: number | null; project_id: string | null; caller_name: string; phone: string | null; email: string | null; called_at: string; summary: string; recorded_by: string | null; created_at: string; deleted_at: string | null; deleted_by: string | null}, "caller_name" | "summary">;
      call_updates: Table<{id: string; call_log_id: string; body: string; author_id: string | null; created_at: string; deleted_at: string | null; deleted_by: string | null}, "call_log_id" | "body">;
      preset_tasks: Table<PresetTask, "name">;
      preset_groups: Table<Times & Archive & {id: string; name: string; description: string | null; intake_fields: Json; revision: number}, "name">;
      preset_group_items: Table<{id: string; group_id: string; preset_task_id: string; parent_item_id: string | null; position: number}, "group_id" | "preset_task_id" | "position">;
      project_preset_applications: Table<{id: string; project_id: string; preset_type: "task" | "group"; source_preset_id: string; source_revision: number; definition_snapshot: Json; intake_answers: Json; applied_by: string | null; applied_at: string}, "project_id" | "preset_type" | "source_preset_id" | "source_revision" | "definition_snapshot">;
      tasks: Table<Task, "project_id" | "title">;
      task_staff: Table<{task_id: string; staff_id: string}, "task_id" | "staff_id">;
      documents: Table<Times & ActorArchive & {id: string; project_id: string; title: string; category: string; subtype: string | null; current_version_id: string | null}, "project_id" | "title">;
      document_versions: Table<DocumentVersion, "document_id" | "object_path" | "original_filename" | "media_type" | "byte_size">;
      document_requirements: Table<{id: string; project_id: string; task_id: string | null; deadline_id: string | null; application_id: string | null; label: string; category: string | null; is_required: boolean; requires_signed: boolean; verified_version_id: string | null; verified_by: string | null; verified_at: string | null; created_at: string}, "project_id" | "label">;
      deadlines: Table<Times & Archive & {id: string; project_id: string; kind: "permit" | "final_sign_off"; label: string; due_date: string; notice_offsets: number[]; revision: number; satisfied_at: string | null; satisfied_by: string | null}, "project_id" | "kind" | "label" | "due_date">;
      deadline_recipients: Table<{deadline_id: string; staff_id: string}, "deadline_id" | "staff_id">;
      reminder_deliveries: Table<Delivery, "deadline_id" | "deadline_revision" | "stage" | "occurrence_date" | "recipient_email" | "payload" | "idempotency_key">;
      reminder_attempts: Table<{id: string; delivery_id: string; attempted_at: string; result: string; error: string | null; provider_id: string | null; metadata: Json}, "delivery_id" | "result">;
      import_runs: Table<{id: string; workbook_sha256: string; filename: string; state: string; expected_rows: number; imported_rows: number; summary: Json; created_at: string; completed_at: string | null}, "workbook_sha256" | "filename">;
      import_rows: Table<{id: string; import_run_id: string; source_sheet: string; source_row: number; source_cells: Json; mapped_values: Json; validation_flags: Json; project_id: string | null; created_at: string}, "import_run_id" | "source_sheet" | "source_row" | "source_cells" | "mapped_values">;
      audit_events: Table<{id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; metadata: Json; created_at: string}, "action" | "entity_type" | "entity_id">;
    };
    Views: Record<string, never>;
    Functions: {
      apply_preset: {Args: {p_project_id: string; p_preset_type: string; p_preset_id: string; p_intake_answers?: Json}; Returns: string};
      update_preset_intake: {Args: {p_application_id: string; p_intake_answers: Json}; Returns: undefined};
      verify_document_requirement: {Args: {p_requirement_id: string; p_document_version_id: string}; Returns: undefined};
      complete_project: {Args: {p_project_id: string}; Returns: undefined};
      satisfy_deadline: {Args: {p_deadline_id: string}; Returns: undefined};
      begin_document_upload: {Args: {p_document_id: string; p_original_filename: string; p_media_type: string; p_byte_size: number; p_date_events?: Json}; Returns: DocumentVersion};
      finalize_document_upload: {Args: {p_version_id: string}; Returns: undefined};
      invalidate_document_version: {Args: {p_version_id: string}; Returns: undefined};
      enqueue_reminder_delivery: {Args: {p_deadline_id: string; p_revision: number; p_stage: string; p_occurrence_date: string; p_recipient_email: string; p_recipient_staff_ids: string[]; p_payload: Json}; Returns: string};
      claim_reminder_deliveries: {Args: {p_limit?: number; p_now?: string}; Returns: Delivery[]};
      record_reminder_result: {Args: {p_delivery_id: string; p_lease_token: string; p_result: string; p_provider_id?: string | null; p_error?: string | null; p_metadata?: Json; p_now?: string}; Returns: undefined};
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
export type Tables<Name extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][Name]["Row"];
