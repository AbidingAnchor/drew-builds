-- Run this in the Supabase SQL editor to create the contacts table.

create table if not exists drew_builds_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  message text not null,
  status text not null default 'New',
  created_at timestamptz not null default now()
);

alter table drew_builds_contacts enable row level security;

create policy "Allow anonymous inserts"
  on drew_builds_contacts for insert
  to anon
  with check (true);

create policy "Allow anonymous read"
  on drew_builds_contacts for select
  to anon
  using (true);

create policy "Allow anonymous updates"
  on drew_builds_contacts for update
  to anon
  using (true)
  with check (true);

alter table drew_builds_contacts
  add column if not exists business text,
  add column if not exists business_type text,
  add column if not exists service_needed text,
  add column if not exists referral text;
