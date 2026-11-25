begin;
-- Offset / date / recipient edits make pending requests stale, never rewrite send history.
create function public.revise_deadline_schedule() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if (new.due_date,new.notice_offsets,new.label,new.kind) is distinct from (old.due_date,old.notice_offsets,old.label,old.kind) then
  new.revision:=old.revision+1;
 else new.revision:=old.revision; end if;
 if new.revision<>old.revision or new.satisfied_at is not null or new.archived_at is not null then
  update public.reminder_deliveries set state='cancelled',last_error='Deadline changed, archived, or satisfied' where deadline_id=new.id and state in ('pending','leased','retry','deferred');
 end if;
 return new;
end $$;
create trigger revise_deadline_schedule before update on public.deadlines for each row execute function public.revise_deadline_schedule();
create function public.guard_deadline_recipient() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare did uuid; pid uuid; begin
 did:=case when tg_op='DELETE' then old.deadline_id else new.deadline_id end;
 select project_id into pid from public.deadlines where id=did; perform 1 from public.projects where id=pid for update;
 if tg_op<>'DELETE' and not exists(select 1 from public.staff where id=new.staff_id and is_active and nullif(btrim(email),'') is not null) then raise exception 'Recipients must be active staff with an email address'; end if;
 if tg_op='UPDATE' and (new.deadline_id,new.staff_id) is distinct from (old.deadline_id,old.staff_id) then raise exception 'Remove then add recipient'; end if;
 -- Explicit revision bump separate from field-edit trigger (which otherwise preserves revision).
 update public.reminder_deliveries set state='cancelled',last_error='Recipients changed' where deadline_id=did and state in ('pending','leased','retry','deferred');
 return coalesce(new,old);
end $$;
create trigger guard_deadline_recipient before insert or update or delete on public.deadline_recipients for each row execute function public.guard_deadline_recipient();
-- Recipient list fingerprint is included in delivery uniqueness by incrementing the deadline revision.
create function public.bump_recipient_revision() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare did uuid; begin
 did:=case when tg_op='DELETE' then old.deadline_id else new.deadline_id end;
 -- Changing a schedule label to itself cannot cause a revision; preserve supplied +1 only for nested recipient trigger.
 update public.deadlines set revision=revision+1 where id=did;
 return coalesce(new,old);
end $$;
create or replace function public.revise_deadline_schedule() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if (new.due_date,new.notice_offsets,new.label,new.kind) is distinct from (old.due_date,old.notice_offsets,old.label,old.kind) or (pg_trigger_depth()>1 and new.revision=old.revision+1) then new.revision:=old.revision+1;
 else new.revision:=old.revision; end if;
 if new.revision<>old.revision or new.satisfied_at is not null or new.archived_at is not null then
  update public.reminder_deliveries set state='cancelled',last_error='Deadline changed, archived, or satisfied' where deadline_id=new.id and state in ('pending','leased','retry','deferred');
 end if; return new;
end $$;
create trigger bump_recipient_revision after insert or delete on public.deadline_recipients for each row execute function public.bump_recipient_revision();
create function public.enqueue_reminder_delivery(p_deadline_id uuid,p_revision integer,p_stage text,p_occurrence_date date,p_recipient_email text,p_recipient_staff_ids uuid[],p_payload jsonb) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare d public.deadlines; v_id uuid; sid uuid; begin
 select * into d from public.deadlines where id=p_deadline_id for update;
 if d.id is null or d.revision<>p_revision or d.satisfied_at is not null or d.archived_at is not null then return null; end if;
 if cardinality(p_recipient_staff_ids)=0 or p_recipient_staff_ids is null then raise exception 'Delivery recipients required'; end if;
 foreach sid in array p_recipient_staff_ids loop
  if not exists(select 1 from public.deadline_recipients r join public.staff s on s.id=r.staff_id where r.deadline_id=d.id and s.id=sid and s.is_active and nullif(btrim(s.email),'') is not null and (lower(btrim(s.email))=lower(btrim(p_recipient_email)) or p_recipient_email='revisa@rpi.edu')) then raise exception 'Invalid or inactive delivery recipient'; end if;
 end loop;
 if jsonb_typeof(p_payload)<>'object' or p_payload->>'to' is distinct from p_recipient_email then raise exception 'Payload must freeze this exact effective recipient'; end if;
 insert into public.reminder_deliveries(deadline_id,deadline_revision,stage,occurrence_date,recipient_email,recipient_staff_ids,payload,idempotency_key)
 values(d.id,d.revision,p_stage,p_occurrence_date,lower(btrim(p_recipient_email)),p_recipient_staff_ids,p_payload,'complyete/' || gen_random_uuid()::text)
 on conflict(deadline_id,deadline_revision,stage,occurrence_date,recipient_email) do nothing returning id into v_id;
 if v_id is null then select id into v_id from public.reminder_deliveries where deadline_id=d.id and deadline_revision=d.revision and stage=p_stage and occurrence_date=p_occurrence_date and recipient_email=lower(btrim(p_recipient_email)); end if;
 return v_id;
end $$;
create function public.claim_reminder_deliveries(p_limit integer default 25,p_now timestamptz default now()) returns setof public.reminder_deliveries language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if p_limit not between 1 and 100 then raise exception 'Claim limit must be 1..100'; end if;
 update public.reminder_deliveries r set state='cancelled',last_error='Deadline or recipient no longer eligible' where state in ('pending','leased','retry','deferred') and (
 not exists(select 1 from public.deadlines d where d.id=r.deadline_id and d.revision=r.deadline_revision and d.satisfied_at is null and d.archived_at is null)
 or exists(select 1 from unnest(r.recipient_staff_ids) sid where not exists(select 1 from public.deadline_recipients dr join public.staff s on s.id=dr.staff_id where dr.deadline_id=r.deadline_id and s.id=sid and s.is_active and nullif(btrim(s.email),'') is not null and (lower(btrim(s.email))=r.recipient_email or r.recipient_email='revisa@rpi.edu'))));
 update public.reminder_deliveries set state='ambiguous',last_error='Provider idempotency window nearly expired; manual review required',lease_token=null,leased_until=null
 where state in ('pending','retry','deferred','leased') and first_attempt_at<=p_now-interval '23 hours' and (state<>'leased' or leased_until<=p_now);
 return query with candidates as (
 select id from public.reminder_deliveries where ((state in ('pending','retry','deferred') and available_at<=p_now) or (state='leased' and leased_until<=p_now))
 order by available_at,created_at for update skip locked limit p_limit
 ) update public.reminder_deliveries r set state='leased',lease_token=gen_random_uuid(),leased_until=p_now+interval '5 minutes',attempt_count=attempt_count+1,first_attempt_at=coalesce(first_attempt_at,p_now)
 from candidates c where r.id=c.id returning r.*;
end $$;
create function public.record_reminder_result(p_delivery_id uuid,p_lease_token uuid,p_result text,p_provider_id text default null,p_error text default null,p_metadata jsonb default '{}',p_now timestamptz default now()) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.reminder_deliveries; delay integer; retry_time timestamptz; begin
 select * into r from public.reminder_deliveries where id=p_delivery_id for update;
 if r.id is null or r.lease_token is distinct from p_lease_token or r.state not in ('leased','cancelled') then raise exception 'Lease token is no longer valid'; end if;
 if p_result not in ('sent','transient','quota','ambiguous','permanent') then raise exception 'Invalid delivery result'; end if;
 retry_time:=p_now+interval '60 minutes';
 if p_result='quota' and p_metadata ? 'retry_at' then
  if jsonb_typeof(p_metadata->'retry_at')<>'string' then raise exception 'Invalid quota retry_at'; end if;
  begin retry_time:=(p_metadata->>'retry_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid quota retry_at'; end;
  if retry_time is null or not isfinite(retry_time) or retry_time<=p_now or retry_time>p_now+interval '366 days' then raise exception 'Invalid quota retry_at'; end if;
 end if;
 insert into public.reminder_attempts(delivery_id,attempted_at,result,error,provider_id,metadata) values(r.id,p_now,p_result,p_error,p_provider_id,p_metadata);
 delay:=case r.attempt_count when 1 then 5 when 2 then 15 else 60 end;
 update public.reminder_deliveries set
 state=case when p_result='sent' then 'sent' when r.state='cancelled' then 'cancelled' when p_result='ambiguous' then 'ambiguous' when p_result='permanent' or (p_result='transient' and r.attempt_count>=4) then 'failed' when p_result='quota' then 'deferred' else 'retry' end,
 available_at=case when p_result='quota' then retry_time else p_now+make_interval(mins=>delay) end,
 sent_at=case when p_result='sent' then p_now end,provider_id=coalesce(p_provider_id,r.provider_id),last_error=p_error,lease_token=null,leased_until=null where id=r.id;
end $$;
create function public.guard_delivery_payload() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin
 if (new.deadline_id,new.deadline_revision,new.stage,new.occurrence_date,new.recipient_email,new.recipient_staff_ids,new.payload,new.idempotency_key,new.created_at) is distinct from (old.deadline_id,old.deadline_revision,old.stage,old.occurrence_date,old.recipient_email,old.recipient_staff_ids,old.payload,old.idempotency_key,old.created_at) then raise exception 'Reminder request and occurrence identity are immutable'; end if; return new;
end $$;
create trigger guard_delivery_payload before update on public.reminder_deliveries for each row execute function public.guard_delivery_payload();
-- Offline importer transaction: idempotent source identity, no implicit project/client merging.
create function public.import_tracker_row(p_run_id uuid,p_row jsonb) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare pid uuid; cid bigint; label text; mapped jsonb; rid uuid; person text; sid uuid; begin
 perform 1 from public.import_runs where id=p_run_id for update;
 if not found then raise exception 'Import run not found'; end if;
 select project_id into pid from public.import_rows where import_run_id=p_run_id and source_sheet=p_row->>'source_sheet' and source_row=(p_row->>'source_row')::integer;
 if pid is not null then return pid; end if;
 mapped:=p_row->'mapped_values'; label:=nullif(btrim(mapped->>'client_name'),'');
 if label is not null then
  -- Serialize client grouping across all imports. Only exact trimmed labels match.
  perform pg_advisory_xact_lock(hashtextextended('import-client:' || label,0));
  select id into cid from public.clients where name=label and archived_at is null order by id limit 1;
  if cid is null then insert into public.clients(name) values(label) returning id into cid; end if;
 end if;
 insert into public.projects(client_id,title,project_number,property_address,details,status,original_status,notes,first_contact_date,proposal_sent_date,proposal_accepted_date,filed_date,meeting_date,legacy_assignment,historical_completed_unverified,import_run_id,source_sheet,source_row)
 values(cid,coalesce(nullif(mapped->>'title',''),'Imported project'),mapped->>'project_number',mapped->>'property_address',mapped->>'details','Active',mapped->>'original_status',mapped->>'notes',
 (mapped->>'first_contact_date')::date,(mapped->>'proposal_sent_date')::date,(mapped->>'proposal_accepted_date')::date,(mapped->>'filed_date')::date,(mapped->>'meeting_date')::date,mapped->>'legacy_assignment',coalesce((mapped->>'historical_completed_unverified')::boolean,false),p_run_id,p_row->>'source_sheet',(p_row->>'source_row')::integer) returning id into pid;
 -- Historical display-only staff entries, never activation/Auth provisioning.
 for person in select jsonb_array_elements_text(coalesce(mapped->'staff_names','[]')) loop
  if lower(btrim(person)) in ('field','office','tbd','n/a','') then continue; end if;
  perform pg_advisory_xact_lock(hashtextextended('import-staff:' || person,0));
  select id into sid from public.staff where display_name=person and auth_user_id is null order by created_at limit 1;
  if sid is null then insert into public.staff(display_name,is_active,is_admin) values(person,false,false) returning id into sid; end if;
  insert into public.project_staff(project_id,staff_id) values(pid,sid) on conflict do nothing;
 end loop;
 insert into public.import_rows(import_run_id,source_sheet,source_row,source_cells,mapped_values,validation_flags,project_id) values(p_run_id,p_row->>'source_sheet',(p_row->>'source_row')::integer,p_row->'source_cells',mapped,coalesce(p_row->'validation_flags','[]'),pid);
 update public.import_runs set imported_rows=(select count(*) from public.import_rows where import_run_id=p_run_id) where id=p_run_id;
 return pid;
end $$;
-- Deliberately no scheduled job / HTTP call here. Deployment configures vault secrets and
-- the five-minute Supabase Cron invocation only after preview + explicit enablement.
revoke execute on function public.enqueue_reminder_delivery(uuid,integer,text,date,text,uuid[],jsonb),public.claim_reminder_deliveries(integer,timestamptz),public.record_reminder_result(uuid,uuid,text,text,text,jsonb,timestamptz),public.import_tracker_row(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_reminder_delivery(uuid,integer,text,date,text,uuid[],jsonb),public.claim_reminder_deliveries(integer,timestamptz),public.record_reminder_result(uuid,uuid,text,text,text,jsonb,timestamptz),public.import_tracker_row(uuid,jsonb) to service_role;
revoke execute on function public.revise_deadline_schedule(),public.guard_deadline_recipient(),public.bump_recipient_revision(),public.guard_delivery_payload() from public,anon,authenticated;
commit;
