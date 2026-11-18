-- Additive baseline: preserves the existing bigint clients identity and all linked history.
begin;
create extension if not exists pgcrypto;
create table if not exists public.clients (
 id bigint generated always as identity primary key, name text not null,
 phone text, email text, created_at timestamptz not null default now()
);
alter table public.clients add column if not exists company text;
alter table public.clients add column if not exists cell_phone text;
alter table public.clients add column if not exists billing_address text;
alter table public.clients add column if not exists contact_notes text;
alter table public.clients add column if not exists referral_source text;
alter table public.clients add column if not exists office_client_number text unique;
alter table public.clients add column if not exists archived_at timestamptz;
alter table public.clients add column if not exists archived_by uuid;
alter table public.clients add column if not exists updated_at timestamptz not null default now();
create table public.staff (
 id uuid primary key default gen_random_uuid(), auth_user_id uuid unique references auth.users(id),
 display_name text not null check (btrim(display_name) <> ''), email text,
 is_active boolean not null default false, is_admin boolean not null default false,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (not is_active or auth_user_id is not null), check (not is_admin or is_active)
);
alter table public.clients add constraint clients_archived_by_fkey foreign key (archived_by) references public.staff(id);
-- Only the known disposable starter rows are archived, never deleted.
update public.clients set archived_at=now() where (name,phone) in (('Test Client A','508-555-0101'),('Test Client B','508-555-0102'));
create table public.import_runs (
 id uuid primary key default gen_random_uuid(), workbook_sha256 text not null unique check (workbook_sha256 ~ '^[0-9a-f]{64}$'),
 filename text not null, state text not null default 'running' check(state in ('running','completed','failed')),
 expected_rows integer not null default 557, imported_rows integer not null default 0,
 summary jsonb not null default '{}', created_at timestamptz not null default now(), completed_at timestamptz
);
create table public.projects (
 id uuid primary key default gen_random_uuid(), client_id bigint references public.clients(id),
 office_prefix text, project_number text, property_address text, title text not null,
 details text, services text[] not null default '{}', status text not null default 'Active' check(status in ('Active','On hold','Completed','Archived')),
 original_status text, notes text, timeframe text, first_contact_date date, proposal_sent_date date,
 proposal_accepted_date date, filed_date date, meeting_date date,
 legacy_assignment text, historical_completed_unverified boolean not null default false,
 import_run_id uuid references public.import_runs(id), source_sheet text, source_row integer,
 completed_at timestamptz, completed_by uuid references public.staff(id), archived_at timestamptz, archived_by uuid references public.staff(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check ((status='Completed')=(completed_at is not null)),
 unique(import_run_id,source_sheet,source_row)
);
create index projects_client_idx on public.projects(client_id);
create index projects_search_idx on public.projects using gin(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(property_address,'') || ' ' || coalesce(details,'') || ' ' || coalesce(project_number,'')));
create table public.project_staff (
 project_id uuid not null references public.projects(id), staff_id uuid not null references public.staff(id), primary key(project_id,staff_id)
);
create table public.call_logs (
 id uuid primary key default gen_random_uuid(), client_id bigint references public.clients(id), project_id uuid references public.projects(id),
 caller_name text not null, phone text, email text, called_at timestamptz not null default now(), summary text not null,
 recorded_by uuid references public.staff(id), created_at timestamptz not null default now(),
 deleted_at timestamptz, deleted_by uuid references public.staff(id)
);
create table public.call_updates (
 id uuid primary key default gen_random_uuid(), call_log_id uuid not null references public.call_logs(id), body text not null check(btrim(body)<>''),
 author_id uuid references public.staff(id), created_at timestamptz not null default now(),
 deleted_at timestamptz, deleted_by uuid references public.staff(id)
);
create table public.preset_tasks (
 id uuid primary key default gen_random_uuid(), name text not null, description text,
 category text not null default 'other' check(category in ('fieldwork','paperwork','other')),
 is_required boolean not null default true, requires_proposal boolean not null default false,
 intake_fields jsonb not null default '[]' check(jsonb_typeof(intake_fields)='array'),
 document_requirements jsonb not null default '[]' check(jsonb_typeof(document_requirements)='array'),
 revision integer not null default 1, archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.preset_groups (
 id uuid primary key default gen_random_uuid(), name text not null, description text,
 intake_fields jsonb not null default '[]' check(jsonb_typeof(intake_fields)='array'),
 revision integer not null default 1, archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.preset_group_items (
 id uuid primary key default gen_random_uuid(), group_id uuid not null references public.preset_groups(id),
 preset_task_id uuid not null references public.preset_tasks(id), parent_item_id uuid references public.preset_group_items(id),
 position integer not null check(position>=0), unique(group_id,position), check(parent_item_id is distinct from id)
);
create table public.project_preset_applications (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 preset_type text not null check(preset_type in ('task','group')), source_preset_id uuid not null, source_revision integer not null,
 definition_snapshot jsonb not null, intake_answers jsonb not null default '{}' check(jsonb_typeof(intake_answers)='object'),
 applied_by uuid references public.staff(id), applied_at timestamptz not null default now()
);
create table public.tasks (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 parent_task_id uuid references public.tasks(id), title text not null, description text,
 category text not null default 'other' check(category in ('fieldwork','paperwork','other')),
 status text not null default 'To do' check(status in ('To do','In progress','Blocked','Awaiting paperwork','Completed')),
 due_date date, position integer not null default 0, is_required boolean not null default true,
 requires_proposal boolean not null default false,
 application_id uuid references public.project_preset_applications(id), source_snapshot jsonb,
 completed_at timestamptz, completed_by uuid references public.staff(id), archived_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check(parent_task_id is distinct from id)
);
create index tasks_project_idx on public.tasks(project_id);
create table public.task_staff (task_id uuid not null references public.tasks(id), staff_id uuid not null references public.staff(id), primary key(task_id,staff_id));
create table public.documents (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id), title text not null,
 category text not null default 'Other' check(category in ('Proposal','Transmittal','Filings','Permits','Compliance docs','Other')),
 subtype text, current_version_id uuid, archived_at timestamptz, archived_by uuid references public.staff(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.document_versions (
 id uuid primary key default gen_random_uuid(), document_id uuid not null references public.documents(id),
 object_path text not null unique, original_filename text not null, media_type text not null,
 byte_size bigint not null check(byte_size between 1 and 25000000),
 upload_state text not null default 'pending' check(upload_state in ('pending','available','invalid')),
 date_events jsonb not null default '[]' check(jsonb_typeof(date_events)='array'),
 uploaded_by uuid references public.staff(id), created_at timestamptz not null default now(), available_at timestamptz,
 check(lower(original_filename) ~ '\.(pdf|docx|xlsx|jpg|jpeg|png|dwg|dxf|zip)$')
);
alter table public.documents add constraint documents_current_version_fkey foreign key(current_version_id) references public.document_versions(id);
create table public.deadlines (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 kind text not null check(kind in ('permit','final_sign_off')), label text not null, due_date date not null,
 notice_offsets integer[] not null default '{30,14,3}', revision integer not null default 1,
 satisfied_at timestamptz, satisfied_by uuid references public.staff(id), archived_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(array_length(notice_offsets,1)=3 and notice_offsets[1]>notice_offsets[2] and notice_offsets[2]>notice_offsets[3] and notice_offsets[3]>=0)
);
create table public.document_requirements (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id),
 task_id uuid references public.tasks(id), deadline_id uuid references public.deadlines(id),
 application_id uuid references public.project_preset_applications(id), label text not null, category text,
 is_required boolean not null default true, requires_signed boolean not null default true,
 verified_version_id uuid references public.document_versions(id), verified_by uuid references public.staff(id), verified_at timestamptz,
 created_at timestamptz not null default now(),
 check((verified_version_id is null and verified_by is null and verified_at is null) or (verified_version_id is not null and verified_by is not null and verified_at is not null))
);
create index document_requirements_project_idx on public.document_requirements(project_id);
create table public.deadline_recipients (
 deadline_id uuid not null references public.deadlines(id), staff_id uuid not null references public.staff(id), primary key(deadline_id,staff_id)
);
create table public.reminder_deliveries (
 id uuid primary key default gen_random_uuid(), deadline_id uuid not null references public.deadlines(id), deadline_revision integer not null,
 stage text not null check(stage in ('notice_30','notice_14','notice_3','overdue')),
 occurrence_date date not null, recipient_email text not null, recipient_staff_ids uuid[] not null default '{}',
 payload jsonb not null, idempotency_key text not null unique,
 state text not null default 'pending' check(state in ('pending','leased','retry','sent','cancelled','ambiguous','deferred','failed')),
 attempt_count integer not null default 0, available_at timestamptz not null default now(),
 lease_token uuid, leased_until timestamptz, first_attempt_at timestamptz, sent_at timestamptz, provider_id text, last_error text,
 created_at timestamptz not null default now(), unique(deadline_id,deadline_revision,stage,occurrence_date,recipient_email)
);
create index reminder_queue_idx on public.reminder_deliveries(state,available_at);
create table public.reminder_attempts (
 id uuid primary key default gen_random_uuid(), delivery_id uuid not null references public.reminder_deliveries(id),
 attempted_at timestamptz not null default now(), result text not null, error text, provider_id text, metadata jsonb not null default '{}'
);
create table public.import_rows (
 id uuid primary key default gen_random_uuid(), import_run_id uuid not null references public.import_runs(id),
 source_sheet text not null, source_row integer not null, source_cells jsonb not null, mapped_values jsonb not null,
 validation_flags jsonb not null default '[]', project_id uuid references public.projects(id),
 created_at timestamptz not null default now(), unique(import_run_id,source_sheet,source_row)
);
create table public.audit_events (
 id uuid primary key default gen_random_uuid(), actor_id uuid references public.staff(id), action text not null,
 entity_type text not null, entity_id text not null, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
commit;
