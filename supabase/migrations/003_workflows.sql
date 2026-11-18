begin;
-- A single validator is used by presets, saved answers, and completion.
create function public.validate_intake(p_fields jsonb,p_answers jsonb,p_require_all boolean default false) returns void language plpgsql immutable set search_path=public,pg_temp as $$
declare f jsonb; v jsonb; k text; ids text[]:='{}'; missing boolean; begin
 if jsonb_typeof(p_fields)<>'array' or jsonb_typeof(p_answers)<>'object' then raise exception 'Invalid intake shape'; end if;
 for f in select value from jsonb_array_elements(p_fields) loop
  k:=f->>'id';
  if k is null or btrim(k)='' or k=any(ids) or coalesce(btrim(f->>'label'),'')='' or coalesce(f->>'type','') not in ('text','textarea','number','date','select','boolean') then raise exception 'Invalid or duplicate intake field %',k; end if;
  ids:=array_append(ids,k); v:=p_answers->k;
  if f ? 'required' and jsonb_typeof(f->'required')<>'boolean' then raise exception 'Required flag must be boolean'; end if;
  if f->>'type'='select' and (jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options')=0) then raise exception 'Choice options required'; end if;
  missing:=v is null or v='null'::jsonb or (jsonb_typeof(v)='string' and btrim(v#>>'{}')='');
  if missing then if p_require_all and coalesce((f->>'required')::boolean,false) then raise exception 'Required intake missing: %',f->>'label'; end if; continue; end if;
  if f->>'type' in ('text','textarea','date','select') and jsonb_typeof(v)<>'string' then raise exception 'Text expected for %',k; end if;
  if f->>'type'='number' and jsonb_typeof(v)<>'number' then raise exception 'Number expected for %',k; end if;
  if f->>'type'='boolean' and jsonb_typeof(v)<>'boolean' then raise exception 'Boolean expected for %',k; end if;
  if f->>'type'='date' then
   if (v#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'ISO date expected for %',k; end if;
   perform (v#>>'{}')::date;
  end if;
  if f->>'type'='select' and not (f->'options' @> jsonb_build_array(v)) then raise exception 'Invalid choice for %',k; end if;
 end loop;
 for k in select jsonb_object_keys(p_answers) loop if not k=any(ids) then raise exception 'Unknown intake field %',k; end if; end loop;
end $$;
create function public.project_completion_errors(p_project_id uuid) returns text[] language plpgsql security definer set search_path=public,pg_temp as $$
declare errors text[]:='{}'; a record; begin
 for a in select * from public.project_preset_applications where project_id=p_project_id loop
  begin perform public.validate_intake(a.definition_snapshot->'intake_fields',a.intake_answers,true);
  exception when others then errors:=array_append(errors,sqlerrm); end;
 end loop;
 if exists(select 1 from public.tasks where project_id=p_project_id and is_required and status<>'Completed') then errors:=array_append(errors,'Required tasks are incomplete'); end if;
 if exists(select 1 from public.document_requirements r left join public.document_versions v on v.id=r.verified_version_id left join public.documents d on d.id=v.document_id
  where r.project_id=p_project_id and r.is_required and (v.id is null or v.upload_state<>'available' or d.archived_at is not null or d.project_id<>p_project_id or d.current_version_id is distinct from v.id)) then errors:=array_append(errors,'Required signed document evidence is missing or invalid'); end if;
 if exists(select 1 from public.deadlines where project_id=p_project_id and archived_at is null and satisfied_at is null) then errors:=array_append(errors,'Deadline paperwork is outstanding'); end if;
 return errors;
end $$;
create function public.reopen_project_if_needed(p_project_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform 1 from public.projects where id=p_project_id for update;
 update public.projects set status='Active',completed_at=null,completed_by=null where id=p_project_id and status='Completed' and cardinality(public.project_completion_errors(p_project_id))>0;
end $$;
create function public.guard_project_completion() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare errors text[]; begin
 if new.status='Completed' then
  if tg_op='INSERT' then raise exception 'Create the project before completing it'; end if;
  errors:=public.project_completion_errors(new.id);
  if cardinality(errors)>0 then raise exception '%',array_to_string(errors,'; '); end if;
  new.completed_at:=coalesce(old.completed_at,now()); new.completed_by:=coalesce(old.completed_by,public.require_active_staff()); new.historical_completed_unverified:=false;
 else new.completed_at:=null; new.completed_by:=null; end if;
 if tg_op='UPDATE' and old.proposal_accepted_date is not null and new.proposal_accepted_date is null and exists(select 1 from public.tasks where project_id=new.id and requires_proposal and status in ('In progress','Completed')) then raise exception 'Post-proposal work already started; preserve acceptance or reset those tasks first'; end if;
 return new;
end $$;
create trigger guard_completion before insert or update on public.projects for each row execute function public.guard_project_completion();
create function public.complete_project(p_project_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform public.require_active_staff(); perform 1 from public.projects where id=p_project_id for update;
 if not found then raise exception 'Project not found'; end if;
 update public.projects set status='Completed' where id=p_project_id;
end $$;
create function public.guard_project_links() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare pid uuid; parent public.tasks; item public.preset_group_items; begin
 if tg_op='DELETE' then pid:=old.project_id; else pid:=new.project_id; end if;
 perform 1 from public.projects where id=pid for update;
 if tg_op='UPDATE' and old.project_id is distinct from new.project_id then raise exception 'Project links are immutable'; end if;
 if tg_table_name='tasks' then
  if new.parent_task_id is not null then
   select * into parent from public.tasks where id=new.parent_task_id;
   if parent.id is null or parent.project_id<>new.project_id or parent.parent_task_id is not null or new.id=parent.id or exists(select 1 from public.tasks where parent_task_id=new.id) then raise exception 'Subtasks require a top-level parent in the same project'; end if;
  end if;
  if new.application_id is not null and not exists(select 1 from public.project_preset_applications where id=new.application_id and project_id=new.project_id) then raise exception 'Application belongs to another project'; end if;
  if tg_op='UPDATE' and old.application_id is not null and (old.is_required is distinct from new.is_required or old.requires_proposal is distinct from new.requires_proposal or old.application_id is distinct from new.application_id or old.source_snapshot is distinct from new.source_snapshot or old.parent_task_id is distinct from new.parent_task_id) then raise exception 'Preset requirements and origin are immutable'; end if;
  if new.requires_proposal and new.status in ('In progress','Completed') and not exists(select 1 from public.projects where id=new.project_id and proposal_accepted_date is not null) then raise exception 'Accepted proposal date required before proceeding'; end if;
  if new.status='Completed' then new.completed_at:=now(); new.completed_by:=public.current_staff_id(); else new.completed_at:=null; new.completed_by:=null; end if;
 elsif tg_table_name='document_requirements' then
  if new.task_id is not null and not exists(select 1 from public.tasks where id=new.task_id and project_id=new.project_id) then raise exception 'Task belongs to another project'; end if;
  if new.deadline_id is not null and not exists(select 1 from public.deadlines where id=new.deadline_id and project_id=new.project_id) then raise exception 'Deadline belongs to another project'; end if;
  if new.application_id is not null and not exists(select 1 from public.project_preset_applications where id=new.application_id and project_id=new.project_id) then raise exception 'Application belongs to another project'; end if;
  if tg_op='UPDATE' and old.application_id is not null and (old.is_required is distinct from new.is_required or old.requires_signed is distinct from new.requires_signed or old.application_id is distinct from new.application_id or old.task_id is distinct from new.task_id) then raise exception 'Preset document requirements are immutable'; end if;
  if new.verified_version_id is not null and not exists(select 1 from public.document_versions v join public.documents d on d.id=v.document_id where v.id=new.verified_version_id and d.project_id=new.project_id and d.archived_at is null and v.upload_state='available' and d.current_version_id=v.id) then raise exception 'Evidence must be the available current version from this project'; end if;
 elsif tg_table_name='documents' then
  if new.current_version_id is not null and not exists(select 1 from public.document_versions where id=new.current_version_id and document_id=new.id and upload_state='available') then raise exception 'Invalid current document version'; end if;
 end if;
 return new;
end $$;
create trigger guard_links before insert or update on public.tasks for each row execute function public.guard_project_links();
create trigger guard_links before insert or update on public.documents for each row execute function public.guard_project_links();
create trigger guard_links before insert or update on public.document_requirements for each row execute function public.guard_project_links();
-- Verification columns are RPC-only; direct REST mutations cannot forge attestations.
revoke insert,update on public.document_requirements from authenticated;
grant insert(project_id,task_id,deadline_id,label,category,is_required,requires_signed),update(label,category,is_required,requires_signed) on public.document_requirements to authenticated;
-- Source-snapshot changes are RPC-only, but staff can add independent tasks.
revoke insert,update on public.tasks from authenticated;
grant insert(project_id,parent_task_id,title,description,category,status,due_date,position,is_required,requires_proposal),update(parent_task_id,title,description,category,status,due_date,position,is_required,requires_proposal,archived_at) on public.tasks to authenticated;
create function public.after_project_evidence_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if tg_table_name='document_requirements' then
  if new.deadline_id is not null then
   update public.deadlines set satisfied_at=null,satisfied_by=null where id=new.deadline_id and satisfied_at is not null and exists(select 1 from public.document_requirements where deadline_id=new.deadline_id and is_required and verified_version_id is null);
  end if;
 end if;
 perform public.reopen_project_if_needed(new.project_id); return new;
end $$;
create trigger reopen_project after insert or update on public.tasks for each row execute function public.after_project_evidence_change();
create trigger reopen_project after insert or update on public.document_requirements for each row execute function public.after_project_evidence_change();
create trigger reopen_project after insert or update on public.deadlines for each row execute function public.after_project_evidence_change();
create function public.guard_application() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform 1 from public.projects where id=new.project_id for update;
 if tg_op='UPDATE' and (to_jsonb(new)-'intake_answers') is distinct from (to_jsonb(old)-'intake_answers') then raise exception 'Applied preset snapshot is immutable'; end if;
 perform public.validate_intake(new.definition_snapshot->'intake_fields',new.intake_answers,false); return new;
end $$;
create trigger guard_application before insert or update on public.project_preset_applications for each row execute function public.guard_application();
create trigger reopen_project after insert or update on public.project_preset_applications for each row execute function public.after_project_evidence_change();
create function public.update_preset_intake(p_application_id uuid,p_intake_answers jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform public.require_active_staff(); update public.project_preset_applications set intake_answers=p_intake_answers where id=p_application_id;
 if not found then raise exception 'Preset application not found'; end if;
end $$;
create function public.verify_document_requirement(p_requirement_id uuid,p_document_version_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid; pid uuid; begin
 actor:=public.require_active_staff(); select project_id into pid from public.document_requirements where id=p_requirement_id;
 if pid is null then raise exception 'Requirement not found'; end if;
 perform 1 from public.projects where id=pid for update;
 update public.document_requirements set verified_version_id=p_document_version_id,verified_by=actor,verified_at=now() where id=p_requirement_id;
end $$;
create function public.satisfy_deadline(p_deadline_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid; begin
 actor:=public.require_active_staff();
 update public.deadlines set satisfied_at=now(),satisfied_by=actor where id=p_deadline_id;
 if not found then raise exception 'Deadline not found'; end if;
end $$;
-- Deadline validation also applies to direct table writes.
create function public.guard_deadline() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 perform 1 from public.projects where id=new.project_id for update;
 if tg_op='UPDATE' and new.project_id<>old.project_id then raise exception 'Project links are immutable'; end if;
 if new.satisfied_at is not null then
  if not exists(select 1 from public.document_requirements where deadline_id=new.id and is_required) or exists(select 1 from public.document_requirements r left join public.document_versions v on v.id=r.verified_version_id left join public.documents d on d.id=v.document_id where r.deadline_id=new.id and r.is_required and (v.id is null or v.upload_state<>'available' or d.archived_at is not null or d.current_version_id is distinct from v.id)) then raise exception 'Verified signed deadline paperwork is required'; end if;
  new.satisfied_at:=now(); new.satisfied_by:=public.current_staff_id();
 else new.satisfied_by:=null; end if;
 return new;
end $$;
create trigger guard_deadline before insert or update on public.deadlines for each row execute function public.guard_deadline();
create function public.guard_preset() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; begin
 perform public.validate_intake(new.intake_fields,'{}',false);
 if tg_table_name='preset_tasks' then
  for r in select value from jsonb_array_elements(new.document_requirements) loop
   if coalesce(btrim(r->>'label'),'')='' then raise exception 'Document requirement label required'; end if;
  end loop;
 end if;
 if tg_op='UPDATE' then new.revision:=old.revision+1; end if; return new;
end $$;
create trigger guard_preset before insert or update on public.preset_tasks for each row execute function public.guard_preset();
create trigger guard_preset before insert or update on public.preset_groups for each row execute function public.guard_preset();
create function public.guard_group_item() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare g uuid; begin
 g:=case when tg_op='DELETE' then old.group_id else new.group_id end;
 perform 1 from public.preset_groups where id=g for update;
 if tg_op<>'DELETE' and new.parent_item_id is not null and not exists(select 1 from public.preset_group_items where id=new.parent_item_id and group_id=g and parent_item_id is null and position<new.position) then raise exception 'Subtask parent must be a preceding top-level item in same group'; end if;
 if tg_op='UPDATE' and (old.group_id<>new.group_id or exists(select 1 from public.preset_group_items where parent_item_id=new.id and (new.parent_item_id is not null or position<=new.position))) then raise exception 'Invalid group hierarchy'; end if;
 update public.preset_groups set revision=revision+1 where id=g; return coalesce(new,old);
end $$;
create trigger guard_group_item before insert or update or delete on public.preset_group_items for each row execute function public.guard_group_item();
create function public.apply_preset(p_project_id uuid,p_preset_type text,p_preset_id uuid,p_intake_answers jsonb default '{}') returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid; app uuid:=gen_random_uuid(); src jsonb; items jsonb; fields jsonb; snap jsonb; it jsonb; f jsonb; req jsonb; mapping jsonb:='{}'; taskid uuid; parentid uuid; rev integer; begin
 actor:=public.require_active_staff(); perform 1 from public.projects where id=p_project_id and archived_at is null for update;
 if not found then raise exception 'Active project not found'; end if;
 if p_preset_type='task' then
  select to_jsonb(t),t.revision into src,rev from public.preset_tasks t where id=p_preset_id and archived_at is null for share;
  items:=jsonb_build_array(jsonb_build_object('id',p_preset_id,'parent_item_id',null,'position',0,'task',src)); fields:=src->'intake_fields';
 elsif p_preset_type='group' then
  select to_jsonb(g),g.revision into src,rev from public.preset_groups g where id=p_preset_id and archived_at is null for update;
  fields:=src->'intake_fields';
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'parent_item_id',i.parent_item_id,'position',i.position,'task',to_jsonb(t)) order by i.position),'[]') into items from public.preset_group_items i join public.preset_tasks t on t.id=i.preset_task_id where i.group_id=p_preset_id;
  for it in select value from jsonb_array_elements(items) loop
   if (it->'task'->>'archived_at') is not null then raise exception 'Group contains archived task'; end if;
   for f in select value from jsonb_array_elements(it->'task'->'intake_fields') loop fields:=fields || jsonb_build_array(jsonb_set(f,'{id}',to_jsonb((it->>'id') || ':' || (f->>'id')))); end loop;
  end loop;
 else raise exception 'Preset type must be task or group'; end if;
 if src is null then raise exception 'Preset not found'; end if;
 perform public.validate_intake(fields,p_intake_answers,false);
 snap:=jsonb_build_object('source',src,'items',items,'intake_fields',fields);
 insert into public.project_preset_applications(id,project_id,preset_type,source_preset_id,source_revision,definition_snapshot,intake_answers,applied_by) values(app,p_project_id,p_preset_type,p_preset_id,rev,snap,p_intake_answers,actor);
 for it in select value from jsonb_array_elements(items) loop
  taskid:=gen_random_uuid(); parentid:=(mapping->>(it->>'parent_item_id'))::uuid;
  insert into public.tasks(id,project_id,parent_task_id,title,description,category,position,is_required,requires_proposal,application_id,source_snapshot)
  values(taskid,p_project_id,parentid,it->'task'->>'name',it->'task'->>'description',it->'task'->>'category',(it->>'position')::integer,(it->'task'->>'is_required')::boolean,(it->'task'->>'requires_proposal')::boolean,app,it->'task');
  mapping:=mapping || jsonb_build_object(it->>'id',taskid);
  for req in select value from jsonb_array_elements(it->'task'->'document_requirements') loop
   insert into public.document_requirements(project_id,task_id,application_id,label,category,is_required,requires_signed) values(p_project_id,taskid,app,req->>'label',req->>'category',coalesce((req->>'is_required')::boolean,true),coalesce((req->>'requires_signed')::boolean,true));
  end loop;
 end loop; return app;
end $$;
-- Upload authorization is generated, never a caller-supplied object path.
create function public.begin_document_upload(p_document_id uuid,p_original_filename text,p_media_type text,p_byte_size bigint,p_date_events jsonb default '[]') returns public.document_versions language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid; v public.document_versions; ext text; ev jsonb; pid uuid; begin
 actor:=public.require_active_staff(); select project_id into pid from public.documents where id=p_document_id and archived_at is null;
 if pid is null then raise exception 'Active document not found'; end if; perform 1 from public.projects where id=pid for update;
 ext:=lower(substring(p_original_filename from '\.([^.]+)$'));
 if ext is null or ext not in ('pdf','docx','xlsx','jpg','jpeg','png','dwg','dxf','zip') or p_original_filename ~ '[/\\]' then raise exception 'Unsupported filename'; end if;
 if jsonb_typeof(p_date_events)<>'array' then raise exception 'Date events must be a list'; end if;
 for ev in select value from jsonb_array_elements(p_date_events) loop
  if coalesce(ev->>'type','') not in ('hearing','filing','issuance','closure') or coalesce(ev->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid document date event'; end if; perform (ev->>'date')::date;
 end loop;
 insert into public.document_versions(document_id,object_path,original_filename,media_type,byte_size,date_events,uploaded_by)
 values(p_document_id,pid::text || '/' || p_document_id::text || '/' || gen_random_uuid()::text || '.' || ext,p_original_filename,p_media_type,p_byte_size,p_date_events,actor) returning * into v;
 return v;
end $$;
create function public.guard_document_version() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin
 if (to_jsonb(new)-'upload_state'-'available_at') is distinct from (to_jsonb(old)-'upload_state'-'available_at') then raise exception 'Document versions are immutable'; end if;
 if old.upload_state='invalid' or (old.upload_state='available' and new.upload_state<>'invalid') then raise exception 'Invalid document version transition'; end if;
 return new;
end $$;
create trigger guard_document_version before update on public.document_versions for each row execute function public.guard_document_version();
create function public.finalize_document_upload(p_version_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.document_versions; actual bigint; pid uuid; begin
 perform public.require_active_staff(); select * into v from public.document_versions where id=p_version_id;
 if v.id is null or v.upload_state<>'pending' then raise exception 'Pending upload not found'; end if;
 select project_id into pid from public.documents where id=v.document_id and archived_at is null;
 if pid is null then raise exception 'Document is archived'; end if; perform 1 from public.projects where id=pid for update;
 select (metadata->>'size')::bigint into actual from storage.objects where bucket_id='project-documents' and name=v.object_path;
 if actual is null or actual<>v.byte_size or actual not between 1 and 25000000 then raise exception 'Stored object size does not match authorized upload'; end if;
 update public.document_versions set upload_state='available',available_at=now() where id=v.id and upload_state='pending';
 if not found then raise exception 'Upload state changed'; end if;
 update public.documents set current_version_id=v.id where id=v.document_id;
end $$;
create function public.clear_invalid_evidence() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if tg_table_name='documents' then
  if new.archived_at is not null or old.current_version_id is distinct from new.current_version_id then
   update public.document_requirements set verified_version_id=null,verified_by=null,verified_at=null where verified_version_id in(select id from public.document_versions where document_id=new.id) and (new.archived_at is not null or verified_version_id is distinct from new.current_version_id);
  end if;
 elsif new.upload_state='invalid' then update public.document_requirements set verified_version_id=null,verified_by=null,verified_at=null where verified_version_id=new.id;
 end if; return new;
end $$;
create trigger clear_invalid_evidence after update on public.documents for each row execute function public.clear_invalid_evidence();
create trigger clear_invalid_evidence after update on public.document_versions for each row execute function public.clear_invalid_evidence();
create function public.invalidate_document_version(p_version_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare pid uuid; begin
 perform public.require_active_staff(); select d.project_id into pid from public.documents d join public.document_versions v on v.document_id=d.id where v.id=p_version_id;
 if pid is null then raise exception 'Version not found'; end if; perform 1 from public.projects where id=pid for update;
 update public.document_versions set upload_state='invalid' where id=p_version_id and upload_state<>'invalid';
 update public.documents set current_version_id=null where current_version_id=p_version_id;
end $$;
-- Call/project references cannot silently cross client boundaries.
create function public.guard_call_links() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if new.project_id is not null and new.client_id is not null and not exists(select 1 from public.projects where id=new.project_id and client_id=new.client_id) then raise exception 'Call project belongs to another client'; end if; return new;
end $$;
create trigger guard_call_links before insert or update on public.call_logs for each row execute function public.guard_call_links();
-- Seed exactly the office's nine stages and simple subtasks, never a workflow builder.
do $$
declare gid uuid:=gen_random_uuid(); tid uuid; parentid uuid; childid uuid; stage jsonb; child text; pos integer:=0; n integer:=0; cat text; gate boolean; begin
 insert into public.preset_groups(id,name,description) values(gid,'Property Staking','Ordered property staking work, including proposal acceptance and signed paperwork.');
 for stage in select value from jsonb_array_elements('[
 {"name":"Research","children":["Pull deeds and plans"]},
 {"name":"Proposal","children":["Send contract","Receive returned signed contract"]},
 {"name":"Initial Comps","children":["Correct plans","Gather additional surveys","Build survey network","Prepare points"]},
 {"name":"Initial Fieldwork","children":["Upload points","Visit site","Recover monuments with GPS / Total Station"]},
 {"name":"Comps","children":["Process initial fieldwork"]},
 {"name":"Fieldwork","children":["Prepare adjusted points","Stake corners and lines"]},
 {"name":"Final comps","children":["Process and update working drawing"]},
 {"name":"Sketch","children":["Send sketch plan to client"]},
 {"name":"Invoice","children":["Send sketch and invoice"]}
 ]'::jsonb) loop
  n:=n+1; gate:=n>2; cat:=case when n in (4,6) then 'fieldwork' when n in (2,8,9) then 'paperwork' else 'other' end;
  tid:=gen_random_uuid(); parentid:=gen_random_uuid();
  insert into public.preset_tasks(id,name,category,requires_proposal,document_requirements) values(tid,stage->>'name',cat,gate,case when n=2 then '[{"label":"Returned signed proposal / contract","category":"Proposal","requires_signed":true}]'::jsonb else '[]'::jsonb end);
  insert into public.preset_group_items(id,group_id,preset_task_id,position) values(parentid,gid,tid,pos); pos:=pos+1;
  for child in select jsonb_array_elements_text(stage->'children') loop
   childid:=gen_random_uuid(); insert into public.preset_tasks(id,name,category,requires_proposal) values(childid,child,cat,gate);
   insert into public.preset_group_items(group_id,preset_task_id,parent_item_id,position) values(gid,childid,parentid,pos); pos:=pos+1;
  end loop;
 end loop;
end $$;
create function public.save_preset_group(p_group_id uuid,p_name text,p_description text,p_intake_fields jsonb,p_items jsonb) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare gid uuid; item jsonb; begin
 perform public.require_active_staff();
 if nullif(btrim(p_name),'') is null or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Group name and ordered items are required'; end if;
 perform public.validate_intake(p_intake_fields,'{}',false);
 if p_group_id is null then
  insert into public.preset_groups(name,description,intake_fields) values(btrim(p_name),p_description,p_intake_fields) returning id into gid;
 else
  select id into gid from public.preset_groups where id=p_group_id for update;
  if gid is null then raise exception 'Group not found'; end if;
 end if;
 -- Delete children first for restrictive FKs. This entire function is one transaction;
 -- any invalid replacement restores all originals including revisions and audit rows.
 delete from public.preset_group_items where group_id=gid and parent_item_id is not null;
 delete from public.preset_group_items where group_id=gid;
 for item in select value from jsonb_array_elements(p_items) order by (value->>'position')::integer loop
  if jsonb_typeof(item)<>'object' or nullif(item->>'id','') is null or not exists(select 1 from public.preset_tasks where id=(item->>'preset_task_id')::uuid and archived_at is null) then raise exception 'Each group item needs a stable UUID and an active preset task'; end if;
  insert into public.preset_group_items(id,group_id,preset_task_id,parent_item_id,position)
  values((item->>'id')::uuid,gid,(item->>'preset_task_id')::uuid,(item->>'parent_item_id')::uuid,(item->>'position')::integer);
 end loop;
 update public.preset_groups set name=btrim(p_name),description=p_description,intake_fields=p_intake_fields where id=gid;
 return gid;
end $$;
do $$ declare f record; begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['after_project_evidence_change','apply_preset','audit_change','begin_document_upload','clear_invalid_evidence','complete_project','current_staff_id','finalize_document_upload','guard_application','guard_call_history','guard_call_links','guard_deadline','guard_document_version','guard_group_item','guard_preset','guard_project_completion','guard_project_links','invalidate_document_version','is_active_staff','project_completion_errors','reopen_project_if_needed','require_active_staff','satisfy_deadline','save_preset_group','touch_updated_at','update_preset_intake','validate_intake','verify_document_requirement']) loop execute format('revoke execute on function %s from public,anon,authenticated',f.signature); end loop; end $$;
grant execute on function public.current_staff_id(),public.is_active_staff(),public.require_active_staff() to authenticated;
grant execute on function public.save_preset_group(uuid,text,text,jsonb,jsonb),public.apply_preset(uuid,text,uuid,jsonb),public.update_preset_intake(uuid,jsonb),public.verify_document_requirement(uuid,uuid),public.complete_project(uuid),public.satisfy_deadline(uuid),public.begin_document_upload(uuid,text,text,bigint,jsonb),public.finalize_document_upload(uuid),public.invalidate_document_version(uuid) to authenticated;
do $$ declare f record; begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['after_project_evidence_change','apply_preset','audit_change','begin_document_upload','clear_invalid_evidence','complete_project','current_staff_id','finalize_document_upload','guard_application','guard_call_history','guard_call_links','guard_deadline','guard_document_version','guard_group_item','guard_preset','guard_project_completion','guard_project_links','invalidate_document_version','is_active_staff','project_completion_errors','reopen_project_if_needed','require_active_staff','satisfy_deadline','save_preset_group','touch_updated_at','update_preset_intake','validate_intake','verify_document_requirement']) loop execute format('grant execute on function %s to service_role',f.signature); end loop; end $$;
commit;
