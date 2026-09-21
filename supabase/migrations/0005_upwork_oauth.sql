-- ============================================================================
-- 0005_upwork_oauth.sql — Phase 2 support: token lifecycle + budget reads
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Token lifecycle
-- ---------------------------------------------------------------------------
-- Upwork's docs say access tokens "never expire once created", but the token
-- response still carries expires_in. Trusting the doc over the wire would be a
-- silent outage waiting to happen, so we record what the server actually says
-- and refresh on it.
alter table public.upwork_connections
  add column if not exists access_token_expires_at timestamptz;

-- Refresh tokens must be exercised at least every two weeks.
alter table public.upwork_connections
  add column if not exists refresh_after timestamptz;

comment on column public.upwork_connections.refresh_after is
  'When the weekly refresh job should next touch this connection. Upwork requires refresh tokens be exercised at least every two weeks.';

-- ---------------------------------------------------------------------------
-- Read today's spend WITHOUT incrementing it
-- ---------------------------------------------------------------------------
-- The limiter must check the daily budget before deciding to make a request.
-- bump_sync_budget() both writes and returns, which is wrong for a pre-check.
create or replace function public.sync_budget_today()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(request_count), 0)::integer
  from public.sync_budget
  where day = current_date;
$$;

comment on function public.sync_budget_today is
  'Requests spent against Upwork today. Read-only; use bump_sync_budget to record spend.';

-- ---------------------------------------------------------------------------
-- Circuit breaker state, per connection
-- ---------------------------------------------------------------------------
-- Kept in the database rather than in process memory so that a restart cannot
-- silently reset a tripped breaker, and so every instance sees the same state.
alter table public.upwork_connections
  add column if not exists consecutive_failures smallint not null default 0;

alter table public.upwork_connections
  add column if not exists circuit_open_until timestamptz;

comment on column public.upwork_connections.circuit_open_until is
  'Set when Upwork returns repeated 429/5xx for this user. No calls are made for this connection until it passes.';

-- ---------------------------------------------------------------------------
-- Health view for the ops screen
-- ---------------------------------------------------------------------------
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
drop view if exists public.v_upwork_health;

create view public.v_upwork_health as
  select
    (select public.sync_budget_today())                                as requests_today,
    (select count(*) from public.upwork_connections
      where revoked_at is null)                                        as connections_active,
    (select count(*) from public.upwork_connections
      where circuit_open_until > now())                                as connections_circuit_open,
    (select count(*) from public.upwork_connections
      where revoked_at is null and refresh_after < now())              as connections_needing_refresh,
    (select coalesce(sum(throttled_count), 0) from public.sync_budget
      where day = current_date)                                        as throttled_today,
    (select coalesce(sum(error_count), 0) from public.sync_budget
      where day = current_date)                                        as errors_today;

-- ---------------------------------------------------------------------------
-- RLS for the new surface
-- ---------------------------------------------------------------------------
-- upwork_connections still grants no policies to authenticated users; the new
-- columns inherit that. Only service_role reaches them.
