-- Historical bootstrap retired. Apply supabase/migrations/001_schema.sql through 004_reminders.sql.
-- Never recreate the former anonymous read policy or seed disposable test clients.
revoke all on public.clients from anon;
drop policy if exists "anyone can read clients for now" on public.clients;
