-- ============================================================================
-- 0003_portal_data.sql — ZONE 2: data the portal owns. No TTL, keep forever.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- upwork_connections — the encrypted token vault
-- ---------------------------------------------------------------------------
-- One row per portal user who has completed their OWN Upwork OAuth consent.
-- Tokens are encrypted APPLICATION-SIDE with AES-256-GCM (see src/lib/crypto.ts)
-- before they ever reach Postgres. The key lives only in the worker's env.
--
-- Deliberately NOT using pgcrypto here: passing the key as a SQL parameter
-- risks leaking it into query logs, pg_stat_statements, and error traces.
-- Postgres never sees plaintext tokens or the key.
--
-- RLS: no policies are granted to authenticated users at all (see 0004) —
-- only the service_role key, held by the server, can read this table.
create table if not exists public.upwork_connections (
  user_id            uuid primary key references public.app_users(id) on delete cascade,

  upwork_user_id     text not null,
  upwork_user_name   text,
  -- the agency org this connection operates within
  org_uid            text not null,
  org_name           text,
  org_role           text,          -- TALENT | FL_AGENCY

  access_token_ct    text not null, -- base64 AES-256-GCM ciphertext
  access_token_iv    text not null,
  access_token_tag   text not null,
  refresh_token_ct   text not null,
  refresh_token_iv   text not null,
  refresh_token_tag  text not null,
  key_version        smallint not null default 1,

  scopes             text[] not null default '{}',
  -- Upwork access tokens do not expire, but refresh tokens must be exercised
  -- at least every two weeks. A weekly job keeps every seat warm.
  refreshed_at       timestamptz,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  connect_error      text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists upwork_connections_refresh_idx
  on public.upwork_connections (refreshed_at) where revoked_at is null;

drop trigger if exists upwork_connections_touch on public.upwork_connections;
create trigger upwork_connections_touch
  before update on public.upwork_connections
  for each row execute function public.touch_updated_at();

comment on table public.upwork_connections is
  'Per-user Upwork OAuth grants. Never a shared token — Upwork prohibits account sharing.';

-- A safe projection the UI can read: who is connected, without any secrets.
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
drop view if exists public.v_connection_status;

create view public.v_connection_status as
  select
    u.id            as user_id,
    u.email,
    u.full_name,
    u.role,
    u.is_active,
    (c.user_id is not null and c.revoked_at is null) as is_connected,
    c.upwork_user_name,
    c.org_name,
    c.refreshed_at,
    c.last_used_at,
    c.connect_error
  from public.app_users u
  left join public.upwork_connections c on c.user_id = u.id;

-- ---------------------------------------------------------------------------
-- assignments — who owns a room or a job. The core of the portal's value.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'assignment_target') then
    create type public.assignment_target as enum ('room', 'job');
  end if;
end$$;

create table if not exists public.assignments (
  id            uuid primary key default gen_random_uuid(),
  target_type   public.assignment_target not null,
  target_id     text not null,
  assigned_to   uuid not null references public.app_users(id) on delete cascade,
  assigned_by   uuid references public.app_users(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now(),
  unique (target_type, target_id)
);

create index if not exists assignments_user_idx on public.assignments (assigned_to);

-- ---------------------------------------------------------------------------
-- internal_notes — private layer per thread. Never leaves the portal.
-- ---------------------------------------------------------------------------
create table if not exists public.internal_notes (
  id          uuid primary key default gen_random_uuid(),
  target_type public.assignment_target not null,
  target_id   text not null,
  author_id   uuid not null references public.app_users(id) on delete cascade,
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists internal_notes_target_idx
  on public.internal_notes (target_type, target_id, created_at desc);

drop trigger if exists internal_notes_touch on public.internal_notes;
create trigger internal_notes_touch
  before update on public.internal_notes
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- job_scores — AI triage output
-- ---------------------------------------------------------------------------
create table if not exists public.job_scores (
  job_id     text primary key,
  score      smallint not null check (score between 0 and 100),
  reasoning  text,
  signals    jsonb not null default '{}'::jsonb,
  model      text not null,
  scored_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- proposal_drafts — human-in-the-loop. Nothing auto-submits.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'draft_status') then
    create type public.draft_status as enum ('draft', 'in_review', 'submitted', 'discarded');
  end if;
end$$;

create table if not exists public.proposal_drafts (
  id            uuid primary key default gen_random_uuid(),
  job_id        text not null,
  author_id     uuid not null references public.app_users(id) on delete cascade,
  cover_letter  text not null default '',
  bid_amount    numeric(12,2),
  boost_connects integer,
  status        public.draft_status not null default 'draft',
  ai_generated  boolean not null default false,
  upwork_proposal_id text,
  submitted_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Upwork caps cover letters at 5000 chars; reject early rather than truncate
  constraint cover_letter_len check (length(cover_letter) <= 5000)
);

create index if not exists proposal_drafts_job_idx on public.proposal_drafts (job_id);
create index if not exists proposal_drafts_author_idx on public.proposal_drafts (author_id, status);

drop trigger if exists proposal_drafts_touch on public.proposal_drafts;
create trigger proposal_drafts_touch
  before update on public.proposal_drafts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- activity_log — full audit trail. Every write to Upwork lands here first.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_log (
  id          bigserial primary key,
  actor_id    uuid references public.app_users(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  payload     jsonb not null default '{}'::jsonb,
  succeeded   boolean,
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists activity_log_actor_idx on public.activity_log (actor_id, created_at desc);
create index if not exists activity_log_target_idx on public.activity_log (target_type, target_id, created_at desc);

comment on table public.activity_log is
  'Append-only audit trail. Per-user OAuth means every Upwork action is attributable to a real person.';

-- ---------------------------------------------------------------------------
-- sync_budget — our own ledger against Upwork's 40k/day, 10 req/s-per-IP caps
-- ---------------------------------------------------------------------------
create table if not exists public.sync_budget (
  day           date not null,
  endpoint      text not null,
  request_count integer not null default 0,
  error_count   integer not null default 0,
  throttled_count integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (day, endpoint)
);

create or replace function public.bump_sync_budget(
  p_endpoint text,
  p_requests integer default 1,
  p_errors integer default 0,
  p_throttled integer default 0
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  day_total integer;
begin
  insert into public.sync_budget (day, endpoint, request_count, error_count, throttled_count)
  values (current_date, p_endpoint, p_requests, p_errors, p_throttled)
  on conflict (day, endpoint) do update
    set request_count   = public.sync_budget.request_count + excluded.request_count,
        error_count     = public.sync_budget.error_count + excluded.error_count,
        throttled_count = public.sync_budget.throttled_count + excluded.throttled_count,
        updated_at      = now();

  select coalesce(sum(request_count), 0) into day_total
  from public.sync_budget where day = current_date;

  return day_total;  -- caller hard-stops non-essential polling at ~35k
end;
$$;

-- ---------------------------------------------------------------------------
-- Room visibility: bidders see assigned + unassigned; staff see everything.
-- ---------------------------------------------------------------------------
create or replace function public.can_see_target(p_type public.assignment_target, p_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_staff()
    or not exists (
      select 1 from public.assignments a
      where a.target_type = p_type and a.target_id = p_id
    )
    or exists (
      select 1 from public.assignments a
      where a.target_type = p_type and a.target_id = p_id and a.assigned_to = auth.uid()
    );
$$;
