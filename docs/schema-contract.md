# Database and RPC contract

Apply migrations 001–004 in order. All application database calls use the signed-in user JWT and public anon key. No service key in the UI. Provision Auth users and matching `staff` administratively; there is no signup or activation trigger. `staff.id` is the domain UUID, `staff.auth_user_id` matches Auth.

## Shared shapes

New IDs are UUID strings; `clients.id` is bigint (serialize as string at boundaries). Dates are YYYY-MM-DD, event timestamps UTC ISO. Domain tables have `created_at`; most editable records have `updated_at`. Domain deletion uses archival/tombstones, never hard delete. All active staff can manage operational records. Only service role can import, process reminders, or provision/alter staff access.

- `clients`: id, name, phone, email, company, cell_phone, billing_address, contact_notes, referral_source, office_client_number (nullable unique), archived_at, archived_by.
- `staff`: id, auth_user_id(nullable unique), display_name, email, is_active(default false), is_admin(default false). Legacy names have no Auth link and stay inactive.
- `projects`: id, client_id, office_prefix, project_number (not unique), title, property_address, details, services(text[]), status (`Active`, `On hold`, `Completed`, `Archived`), original_status, notes, timeframe, first_contact_date, proposal_sent_date, proposal_accepted_date, filed_date, meeting_date, legacy_assignment, historical_completed_unverified, import_run_id, source_sheet, source_row, completed_at/by, archived_at/by.
- `project_staff`: project_id, staff_id composite PK. `task_staff`: task_id, staff_id composite PK.
- `call_logs`: id, client_id?, project_id?, caller_name, phone, email, called_at, summary, recorded_by, deleted_at/by. `call_updates`: id, call_log_id, body, author_id, created_at, deleted_at/by. Deleted rows retain original text and become immutable tombstones. Actor/time assigned in DB.
- `preset_tasks`: id, name, description, category (`fieldwork`, `paperwork`, `other`), is_required, requires_proposal, intake_fields JSON[], document_requirements JSON[], revision, archived_at.
- `preset_groups`: id, name, description, intake_fields JSON[], revision, archived_at. `preset_group_items`: id, group_id, preset_task_id, parent_item_id?, position (unique within group). At most one subtask level, same group. Parent comes before children.
- `project_preset_applications`: id, project_id, preset_type (`task` or `group`), source_preset_id, source_revision, definition_snapshot JSON, intake_answers JSON object, applied_by/at. Snapshot immutable. Task-local intake field IDs are namespaced with the group item UUID plus `:`. Read the snapshot `intake_fields` for the authoritative combined fields.
- `tasks`: id, project_id, parent_task_id?, title, description, category, status (`To do`, `In progress`, `Blocked`, `Awaiting paperwork`, `Completed`), due_date, position, is_required, requires_proposal, application_id?, source_snapshot?, completed_at/by, archived_at. Parent must belong to same project, nesting max one level. Post-proposal work cannot move into In progress/Completed without proposal_accepted_date.
- `documents`: id, project_id, title, category (`Proposal`, `Transmittal`, `Filings`, `Permits`, `Compliance docs`, `Other`), subtype, current_version_id (RPC maintained), archived_at/by.
- `document_versions`: id, document_id, object_path, original_filename, media_type, byte_size (1..25000000), upload_state (`pending`, `available`, `invalid`), date_events JSON array, uploaded_by, created_at, available_at. Events: `{type:"hearing"|"filing"|"issuance"|"closure",date:"YYYY-MM-DD",note?:string}`. Repeated hearing events allowed. Uploaded version metadata immutable.
- `document_requirements`: id, project_id, task_id?, deadline_id?, application_id?, label, category?, is_required, requires_signed, verified_version_id?, verified_by?, verified_at?. Staff explicitly attests to signature in verification RPC. Current available nonarchived evidence only; all links same project. Invalidating/archiving/replacing evidence clears verification and reopens satisfied deadlines/completed projects.
- `deadlines`: id, project_id, kind (`permit`, `final_sign_off`), label, due_date, notice_offsets(integer[3], descending, default30/14/3), revision, satisfied_at/by (RPC maintained), archived_at. At least one required verified document requirement needed for satisfaction.
- `deadline_recipients`: deadline_id, staff_id PK. Only active staff with email eligible.
- `import_runs`: id, workbook_sha256 unique, filename, state, expected_rows, imported_rows, summary, completed_at. `import_rows`: id, import_run_id, source_sheet,row, source_cells, mapped_values, validation_flags, project_id; unique source identity.
- `audit_events`: id, actor_id?, action, entity_type, entity_id(text), metadata JSON, created_at. Read only to staff; DB writes.

## Intake JSON

Field `{id:string,label:string,type:"text"|"textarea"|"number"|"date"|"select"|"boolean",required:boolean,position?:number,options?:string[]}`. IDs unique per definition. Missing required answers allowed in drafts; invalid supplied values rejected. Empty string/null counts missing; false/zero are valid. Completion requires all required snapshot fields. Requirement definition `{label:string,category?:string,requires_signed?:boolean,is_required?:boolean}`.

## User RPCs

- `apply_preset(p_project_id uuid,p_preset_type text,p_preset_id uuid,p_intake_answers jsonb default '{}') returns uuid` application ID. Atomic immutable snapshot + parent/subtasks + document requirements.
- `update_preset_intake(p_application_id uuid,p_intake_answers jsonb) returns void` replaces answers after validating types.
- `verify_document_requirement(p_requirement_id uuid,p_document_version_id uuid) returns void` attests that this exact version satisfies the requirement, including signed paperwork where requested.
- `complete_project(p_project_id uuid) returns void` validates required snapshot intake/tasks/documents and all live deadlines; sets completion actor/time. Trigger applies same validation to direct update.
- `satisfy_deadline(p_deadline_id uuid) returns void` checks required verified paperwork before satisfaction.
- `begin_document_upload(p_document_id uuid,p_original_filename text,p_media_type text,p_byte_size bigint,p_date_events jsonb default '[]') returns public.document_versions`. Upload returned object_path to private bucket `project-documents` with upsert false.
- `finalize_document_upload(p_version_id uuid) returns void` validates storage object size then marks available and makes it current; reopens previous evidence.
- `invalidate_document_version(p_version_id uuid) returns void` invalidates evidence, preserving immutable version history.

Mutations reject inactive users even with valid Auth JWT. Database SQLSTATE errors map to validation feedback. All functions pin search_path and restrict EXECUTE.

## Service-only reminder RPCs

`reminder_deliveries`: id, deadline_id, deadline_revision, stage(`notice_30`,`notice_14`,`notice_3`,`overdue`; ordinal offset labels even when offsets edited), occurrence_date, recipient_email, recipient_staff_ids[], payload JSON immutable exact Resend request, idempotency_key unique, state(`pending`,`leased`,`retry`,`sent`,`cancelled`,`ambiguous`,`deferred`,`failed`), attempt_count, available_at, lease_token, leased_until, first_attempt_at, sent_at, provider_id,last_error,created_at. Unique(deadline_id,deadline_revision,stage,occurrence_date,recipient_email). `reminder_attempts`: id, delivery_id, attempted_at, result,error,provider_id,metadata.

- `enqueue_reminder_delivery(p_deadline_id uuid,p_revision integer,p_stage text,p_occurrence_date date,p_recipient_email text,p_recipient_staff_ids uuid[],p_payload jsonb) returns uuid` upserts occurrence; validates live revision/recipients. Payload constructed by reminder service; DB freezes payload and stable key.
- `claim_reminder_deliveries(p_limit integer default 25,p_now timestamptz default now()) returns setof reminder_deliveries` leases with skip locked and UUID token for five minutes; increments attempt count; expired first attempts older than 23 hours become ambiguous. Never claims stale/satisfied deadlines.
- `record_reminder_result(p_delivery_id uuid,p_lease_token uuid,p_result text,p_provider_id text default null,p_error text default null,p_metadata jsonb default '{}',p_now timestamptz default now()) returns void`. Results `sent`, `transient`, `quota`, `ambiguous`, `permanent`; transient retries 5/15/60 mins; four attempts max. Quota defaults to 60 mins, or honors `p_metadata.retry_at` (future finite timestamp within 366 days); attempts retain provider/reset metadata. Lease token required. Old unresolved deliveries still become ambiguous after 23 hours, including long quota deferrals; staff must review instead of blind resending after the provider's 24-hour idempotency window.

Cron remains disabled until configured. Default office time America/New_York 09:00, every five minutes. Preview must not enqueue/claim/record. Demo service redirects to revisa@rpi.edu and deduplicates staff recipients before enqueue. The service computes the most urgent currently applicable stage only, never all missed stages. DB revises/cancels pending work when deadline scheduling/recipients change and preserves sent history.

## Import

`scripts/prepare_import.py WORKBOOK --output .env.import-tracker.local` extracts actual source data without changing workbook. Output must be a Git-ignored .env* file. `node scripts/import_tracker.mjs .env.import-tracker.local` validates summary and performs no writes by default; add `--apply` and set SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY for authorized offline import. Service-only `import_tracker_row(p_run_id uuid,p_row jsonb) returns uuid` commits each row atomically/idempotently. 164 main +379 completed+14 proposal=557. No project merging. Exact trimmed source client-label grouping. Non-person Field remains legacy_assignment. Completed sheet remains historical unverified, status Active. Invalid dates preserved and flagged, never guessed. Import creates no deadlines/reminders.

## Validation status

Local execution validation is tracked in the delivery report. Local harness with Auth/Storage stubs is not a live Supabase policy or remote deployment test. Docker engine unavailable at initial inspection. No cloud administrative key supplied; no remote migration/import performed.


Atomic group editor RPC: `save_preset_group(p_group_id uuid nullable,p_name text,p_description text,p_intake_fields jsonb,p_items jsonb) returns uuid`. Items are `{id:uuid,preset_task_id:uuid,parent_item_id?:uuid,position:integer}`; stable IDs are required. Replaces all items atomically, validates ordered single-level hierarchy and active source tasks; any failure restores original group/items. Pass null group ID to create.
