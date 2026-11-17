-- clients table with test clients (already in cloud Supabase project)

create table clients (
  id bigint primary key generated always as identity,
  name text not null,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

insert into clients (name, phone) values
  ('Test Client A', '508-555-0101'),
  ('Test Client B', '508-555-0102');

grant select on public.clients to anon;
alter table clients enable row level security;
create policy "anyone can read clients for now"
  on clients for select to anon using (true);