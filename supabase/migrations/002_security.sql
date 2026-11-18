begin;
revoke create on schema public from public,anon,authenticated;
create function public.current_staff_id() returns uuid language sql stable security definer set search_path=public,pg_temp as $$
 select id from public.staff where auth_user_id=auth.uid() and is_active limit 1
$$;
create function public.is_active_staff() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select public.current_staff_id() is not null $$;
create function public.require_active_staff() returns uuid language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v uuid; begin v:=public.current_staff_id(); if v is null then raise exception 'Active staff access required' using errcode='42501'; end if; return v; end $$;
-- Default deny. RLS is enabled even on service-owned tables, with no user write policy.
do $$ declare t text; begin
 foreach t in array array['staff','clients','projects','project_staff','call_logs','call_updates','preset_tasks','preset_groups','preset_group_items','project_preset_applications','tasks','task_staff','documents','document_versions','document_requirements','deadlines','deadline_recipients','reminder_deliveries','reminder_attempts','import_runs','import_rows','audit_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy staff_read on public.%I for select to authenticated using (public.is_active_staff())',t);
 end loop;
end $$;
drop policy if exists "anyone can read clients for now" on public.clients;
revoke all on all sequences in schema public from anon,authenticated;
grant usage,select on all sequences in schema public to authenticated,service_role;
-- Operational editing. No staff, version, audit, import, or send-ledger writes.
do $$ declare t text; begin
 foreach t in array array['clients','projects','project_staff','call_logs','call_updates','preset_tasks','preset_groups','preset_group_items','tasks','task_staff','document_requirements','deadlines','deadline_recipients'] loop
  execute format('grant insert,update on public.%I to authenticated',t);
  execute format('create policy staff_insert on public.%I for insert to authenticated with check (public.is_active_staff())',t);
  execute format('create policy staff_update on public.%I for update to authenticated using (public.is_active_staff()) with check (public.is_active_staff())',t);
 end loop;
 foreach t in array array['project_staff','task_staff','preset_group_items','deadline_recipients'] loop
  execute format('grant delete on public.%I to authenticated',t);
  execute format('create policy staff_delete on public.%I for delete to authenticated using (public.is_active_staff())',t);
 end loop;
end $$;
grant insert(project_id,title,category,subtype),update(title,category,subtype,archived_at,archived_by) on public.documents to authenticated;
create policy staff_insert on public.documents for insert to authenticated with check(public.is_active_staff());
create policy staff_update on public.documents for update to authenticated using(public.is_active_staff()) with check(public.is_active_staff());
create function public.audit_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare obj jsonb; begin
 obj:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 insert into public.audit_events(actor_id,action,entity_type,entity_id,metadata)
 values(public.current_staff_id(),lower(tg_op),tg_table_name,coalesce(obj->>'id',obj->>'project_id',obj->>'task_id',obj->>'deadline_id'),
 jsonb_build_object('old',case when tg_op<>'INSERT' then to_jsonb(old) end,'new',case when tg_op<>'DELETE' then to_jsonb(new) end));
 return coalesce(new,old);
end $$;
create function public.touch_updated_at() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin new.updated_at:=now(); return new; end $$;
create function public.guard_call_history() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='INSERT' then
  if tg_table_name='call_updates' then new.author_id:=public.current_staff_id(); else new.recorded_by:=public.current_staff_id(); end if;
  new.created_at:=now(); new.deleted_at:=null; new.deleted_by:=null;
 else
  if old.deleted_at is not null then raise exception 'Deleted calls and follow-ups are retained tombstones'; end if;
  if tg_table_name='call_updates' and (to_jsonb(new)-'deleted_at'-'deleted_by') is distinct from (to_jsonb(old)-'deleted_at'-'deleted_by') then raise exception 'Follow-ups are append-only; add another update'; end if;
  if new.deleted_at is not null then new.deleted_at:=now(); new.deleted_by:=public.current_staff_id(); end if;
 end if;
 return new;
end $$;
create trigger call_history before insert or update on public.call_logs for each row execute function public.guard_call_history();
create trigger call_history before insert or update on public.call_updates for each row execute function public.guard_call_history();
-- Bucket limits are enforced independently from the browser. Immutable object names only.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('project-documents','project-documents',false,25000000,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/jpeg','image/png','application/acad','application/x-acad','image/vnd.dwg','image/x-dwg','application/dxf','image/vnd.dxf','application/zip','application/x-zip-compressed','application/octet-stream'])
on conflict(id) do update set public=false,file_size_limit=25000000,allowed_mime_types=excluded.allowed_mime_types;
create policy project_document_read on storage.objects for select to authenticated using (
 bucket_id='project-documents' and public.is_active_staff() and exists(
 select 1 from public.document_versions v join public.documents d on d.id=v.document_id
 where v.object_path=name and v.upload_state='available' and d.archived_at is null));
create policy project_document_upload on storage.objects for insert to authenticated with check(
 bucket_id='project-documents' and public.is_active_staff() and exists(
 select 1 from public.document_versions v join public.documents d on d.id=v.document_id
 where v.object_path=name and v.upload_state='pending' and v.uploaded_by=public.current_staff_id() and d.archived_at is null));
-- No authenticated UPDATE/DELETE storage policy: replacements always use a fresh version.
do $$ declare t text; begin
 foreach t in array array['staff','clients','projects','project_staff','call_logs','call_updates','preset_tasks','preset_groups','preset_group_items','project_preset_applications','tasks','task_staff','documents','document_versions','document_requirements','deadlines','deadline_recipients','import_runs','import_rows'] loop
  execute format('create trigger audit_change after insert or update or delete on public.%I for each row execute function public.audit_change()',t);
 end loop;
 foreach t in array array['staff','clients','projects','preset_tasks','preset_groups','tasks','documents','deadlines'] loop
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()',t);
 end loop;
end $$;
do $$ declare f record; begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array['audit_change','current_staff_id','guard_call_history','is_active_staff','require_active_staff','touch_updated_at']) loop execute format('revoke execute on function %s from public,anon,authenticated',f.signature); end loop; end $$;
grant execute on function public.current_staff_id(),public.is_active_staff() to authenticated,service_role;
commit;
