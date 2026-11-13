-- Daily usage counter for the "Ask AI" tutor on topical papers.
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
create table if not exists public.ai_chat_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (user_id, day)
);

-- Only the server (service role) reads and writes this table.
alter table public.ai_chat_usage enable row level security;
