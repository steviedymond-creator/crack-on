-- Crack On: Supabase tables. Run once in the Supabase SQL editor of a new project.
-- The server holds the private service key and the browser never talks to Supabase,
-- so row security is on with no policies and only the service role has access.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  surface text,
  user_id text,
  created_at timestamptz not null default now()
);
create table if not exists public.context_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  companion text not null,
  role text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists context_entries_session_idx on public.context_entries (session_id, created_at);
-- New tables are not exposed to the Data API automatically, so grant access explicitly.
grant select, insert, update, delete on public.sessions to service_role;
grant select, insert, update, delete on public.context_entries to service_role;
-- No policies and no grants for anon: only the service role can read or write.
alter table public.sessions enable row level security;
alter table public.context_entries enable row level security;
