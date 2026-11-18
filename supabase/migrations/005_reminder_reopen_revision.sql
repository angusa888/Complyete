begin;
-- A newly eligible deadline starts a new reminder cycle without rewriting history.
create or replace function public.revise_deadline_schedule() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$ begin
 if (new.due_date,new.notice_offsets,new.label,new.kind) is distinct from (old.due_date,old.notice_offsets,old.label,old.kind)
  or (pg_trigger_depth()>1 and new.revision=old.revision+1)
  or ((old.satisfied_at is not null or old.archived_at is not null) and new.satisfied_at is null and new.archived_at is null) then
  new.revision:=old.revision+1;
 else new.revision:=old.revision; end if;
 if new.revision<>old.revision or new.satisfied_at is not null or new.archived_at is not null then
  update public.reminder_deliveries set state='cancelled',last_error='Deadline changed, archived, or satisfied' where deadline_id=new.id and state in ('pending','leased','retry','deferred');
 end if; return new;
end $$;
-- CREATE OR REPLACE preserves the existing trigger and function privileges.
revoke execute on function public.revise_deadline_schedule() from public,anon,authenticated;
commit;
