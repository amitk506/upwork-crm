-- ============================================================================
-- 0002_upwork_mirror.sql — ZONE 1: revalidating cache of Upwork-owned data
-- ============================================================================
-- Upwork's ToS: "Caching API responses for more than 24 hours is not allowed."
--   → every table here carries fetched_at
--   → nothing is served to the UI past its TTL without a refetch
--   → expire_upwork_mirror() hard-deletes stale rows, run hourly
-- This is a CACHE, not an archive. Anything you want to keep forever
-- (notes, assignments, drafts, audit) belongs in ZONE 2 — see 0003.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Rooms — the inbox spine.
-- The room list carries latest_story_id, so ONE call detects new activity
-- across every conversation. Never poll rooms individually to discover change.
-- ---------------------------------------------------------------------------
create table if not exists public.up_rooms (
  room_id          text primary key,
  org_uid          text        not null,
  room_name        text,
  topic            text,
  room_type        text,
  num_users        integer,
  num_unread       integer     not null default 0,
  is_favorite      boolean     not null default false,
  latest_story_id  text,
  latest_story_at  timestamptz,
  latest_snippet   text,
  created_at_upwork timestamptz,
  fetched_at       timestamptz not null default now()
);

create index if not exists up_rooms_org_activity_idx
  on public.up_rooms (org_uid, latest_story_at desc nulls last);
create index if not exists up_rooms_fetched_idx on public.up_rooms (fetched_at);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
create table if not exists public.up_messages (
  story_id     text primary key,
  room_id      text        not null references public.up_rooms(room_id) on delete cascade,
  author_id    text,
  author_name  text,
  -- true when the message came from our side (agency), false for the client
  is_outbound  boolean     not null default false,
  body         text,
  attachments  jsonb       not null default '[]'::jsonb,
  sent_at      timestamptz,
  edited_at    timestamptz,
  fetched_at   timestamptz not null default now()
);

create index if not exists up_messages_room_time_idx
  on public.up_messages (room_id, sent_at desc);
create index if not exists up_messages_fetched_idx on public.up_messages (fetched_at);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
-- NOTE: the marketplace API has NO server-side date filter and does NOT return
-- proposal counts in search results. published_at is used for client-side
-- recency filtering; proposals_count is only populated by a single-job get.
create table if not exists public.up_jobs (
  job_id            text primary key,
  ciphertext        text,
  title             text        not null,
  description       text,
  job_type          text,
  experience_level  text,
  workload          text,
  budget_amount     numeric(12,2),
  budget_currency   text,
  hourly_min        numeric(12,2),
  hourly_max        numeric(12,2),
  skills            text[]      not null default '{}',
  category          text,
  client_country    text,
  client_total_spend numeric(14,2),
  client_total_hires integer,
  client_rating     numeric(3,2),
  client_payment_verified boolean,
  proposals_count   integer,
  connects_cost     integer,
  published_at      timestamptz,
  created_at_upwork timestamptz,
  raw               jsonb,
  fetched_at        timestamptz not null default now()
);

create index if not exists up_jobs_published_idx on public.up_jobs (published_at desc nulls last);
create index if not exists up_jobs_fetched_idx on public.up_jobs (fetched_at);

-- ---------------------------------------------------------------------------
-- Contracts
-- ---------------------------------------------------------------------------
create table if not exists public.up_contracts (
  contract_id   text primary key,
  org_uid       text        not null,
  title         text,
  client_name   text,
  status        text,
  contract_type text,
  hourly_rate   numeric(12,2),
  currency      text,
  started_at    timestamptz,
  ended_at      timestamptz,
  fetched_at    timestamptz not null default now()
);

create index if not exists up_contracts_status_idx on public.up_contracts (org_uid, status);
create index if not exists up_contracts_fetched_idx on public.up_contracts (fetched_at);

-- ---------------------------------------------------------------------------
-- Milestones — the money-at-risk view is built on this
-- ---------------------------------------------------------------------------
-- state is free text, NOT an enum: Upwork can add states without warning.
-- Known values: NotFunded, Active, Submitted, Paid.
create table if not exists public.up_milestones (
  milestone_id     text primary key,
  contract_id      text        not null references public.up_contracts(contract_id) on delete cascade,
  title            text,
  description      text,
  state            text        not null,
  state_label      text,
  deposit_amount   numeric(12,2),
  funded_amount    numeric(12,2),
  paid_amount      numeric(12,2),
  currency         text,
  submission_count integer     not null default 0,
  due_at           timestamptz,
  submitted_at     timestamptz,
  deliverables     jsonb       not null default '[]'::jsonb,
  fetched_at       timestamptz not null default now()
);

create index if not exists up_milestones_contract_idx on public.up_milestones (contract_id);
create index if not exists up_milestones_state_idx on public.up_milestones (state);
create index if not exists up_milestones_fetched_idx on public.up_milestones (fetched_at);

-- ---------------------------------------------------------------------------
-- TTL enforcement — the ToS compliance mechanism
-- ---------------------------------------------------------------------------
create or replace function public.expire_upwork_mirror(p_max_age interval default interval '24 hours')
returns table (table_name text, deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - p_max_age;
  n bigint;
begin
  -- messages before rooms: the FK cascade would remove them anyway, but
  -- deleting explicitly keeps the reported counts honest
  delete from public.up_messages where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_messages'; deleted := n; return next;

  delete from public.up_rooms where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_rooms'; deleted := n; return next;

  delete from public.up_jobs where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_jobs'; deleted := n; return next;

  delete from public.up_milestones where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_milestones'; deleted := n; return next;

  delete from public.up_contracts where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_contracts'; deleted := n; return next;
end;
$$;

comment on function public.expire_upwork_mirror is
  'Deletes mirrored Upwork rows older than the ToS 24h cache ceiling. Run hourly from the sync worker.';

-- ---------------------------------------------------------------------------
-- Staleness view — lets the UI grey out anything approaching its TTL
-- ---------------------------------------------------------------------------
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
drop view if exists public.v_mirror_freshness;

create view public.v_mirror_freshness as
  select 'up_rooms'      as source, count(*) as rows, min(fetched_at) as oldest, max(fetched_at) as newest from public.up_rooms
  union all
  select 'up_messages',  count(*), min(fetched_at), max(fetched_at) from public.up_messages
  union all
  select 'up_jobs',      count(*), min(fetched_at), max(fetched_at) from public.up_jobs
  union all
  select 'up_contracts', count(*), min(fetched_at), max(fetched_at) from public.up_contracts
  union all
  select 'up_milestones',count(*), min(fetched_at), max(fetched_at) from public.up_milestones;
