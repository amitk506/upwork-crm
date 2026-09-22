-- ============================================================================
-- 0020_view_leaks.sql — close four views that were readable by anyone
-- ============================================================================
-- 0016 named the root cause exactly: "a view's underlying tables are evaluated
-- with the VIEW OWNER's privileges, not the caller's, so every RLS policy the
-- base tables carry was being bypassed." It then fixed three views and put a
-- seniority policy on activity_log — but the policy went on the TABLE, and the
-- app reads activity through v_activity, which bypasses it. The same oversight
-- covered three older views nobody revisited.
--
-- Measured against the deployed instance with an anonymous key, no login:
--
--   v_activity            100 rows — the whole audit trail, actor names included
--   v_connection_status     7 rows — every member's EMAIL, name, role
--   v_profiles              5 rows — every connected Upwork profile and org
--   v_upwork_health         1 row  — request and error counters
--   v_mirror_freshness      5 rows — cache row counts and ages (found by the
--                                    new test, not by inspection — see below)
--
-- Every base table correctly returned nothing. Only the views were open, and
-- they were open to the public internet, not merely to under-privileged members.
--
-- Fixed the way the rest of this schema does it: the guard goes in the view's
-- own WHERE clause. Setting security_invoker on the views would be the more
-- elegant mechanism, but it would also apply app_users and upwork_profiles RLS
-- to the joins inside views a bidder legitimately reads, and those tables grant
-- nothing to non-staff — the inbox would lose its profile labels. Explicit
-- filtering keeps the change surgical and matches 0016/0017/0019.
--
-- supabase/tests/rls_test.sql now asserts that anon reads zero rows from EVERY
-- view, so the next one added is caught by a test rather than by inspection.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- v_connection_status — deleted, not guarded
-- ---------------------------------------------------------------------------
-- Nothing in the application reads it. It predates central profiles (0011),
-- which moved Upwork credentials off individual members entirely, so it also
-- describes a model the portal no longer has. A dead view exposing staff email
-- addresses should not be carried forward with a policy bolted on.
drop view if exists public.v_connection_status;

-- ---------------------------------------------------------------------------
-- v_activity — seniority, the same rule 0016 intended
-- ---------------------------------------------------------------------------
drop view if exists public.v_activity;

create view public.v_activity as
  select
    a.id,
    a.actor_id,
    coalesce(u.full_name, u.email, 'system')            as actor_name,
    u.role                                              as actor_role,
    a.action,
    a.target_type,
    a.target_id,
    r.room_name,
    r.topic                                             as room_topic,
    a.payload,
    a.succeeded,
    a.error,
    a.created_at
  from public.activity_log a
  left join public.app_users u on u.id = a.actor_id
  left join public.up_rooms  r on a.target_type = 'room' and r.room_id = a.target_id
  -- An owner sees everything, a manager sees their own plus the people below
  -- them, a lead or bidder sees their own. Identical to the activity_log policy,
  -- which this view was quietly stepping around.
  where public.can_see_activity_of(a.actor_id);

comment on view public.v_activity is
  'Audit trail, scoped by seniority. The filter is in the view because a view reads its base tables as the OWNER, so activity_log''s RLS policy does not apply here.';

-- ---------------------------------------------------------------------------
-- v_profiles — the estate, for the people who run it
-- ---------------------------------------------------------------------------
-- Both readers (/profiles and /team) already require the team:manage
-- capability, so staff-only matches what the app asks for. Members who need a
-- profile's name for a conversation get it from v_room_profiles, which is
-- scoped per viewer by 0016.
drop view if exists public.v_profiles;

create view public.v_profiles as
  select
    p.id,
    p.label,
    p.upwork_user_name,
    p.org_name,
    p.org_role,
    p.send_requires_approval,
    (p.revoked_at is null) as is_active,
    p.connect_error,
    p.last_used_at,
    p.refreshed_at,
    (select count(*) from public.room_profiles rp where rp.profile_id = p.id) as room_count,
    (select count(*) from public.profile_grants pg where pg.profile_id = p.id) as member_count
  from public.upwork_profiles p
  where public.is_staff();

comment on view public.v_profiles is
  'Every Upwork profile the portal holds. Staff only — a team lead learns which profile a conversation belongs to from v_room_profiles instead.';

-- ---------------------------------------------------------------------------
-- v_upwork_health — operational counters
-- ---------------------------------------------------------------------------
-- No FROM clause, so the guard is the whole WHERE: it returns one row for staff
-- and no rows for anyone else.
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
      where day = current_date)                                        as errors_today
  where public.is_staff();

comment on view public.v_upwork_health is
  'Budget and connection health for the ops page. Staff only.';

-- ---------------------------------------------------------------------------
-- v_mirror_freshness — cache staleness, for the ops page it was built for
-- ---------------------------------------------------------------------------
-- Nothing reads it yet; it was written in 0002 to let the UI grey out data
-- approaching its TTL, which the ops page will want. Worth keeping, but it
-- counts rows across the whole mirror and so belongs to staff.
--
-- This one was NOT found by reading the code. The generic pg_views loop added to
-- rls_test.sql found it on the first run, after four had already been fixed by
-- hand — which is the argument for the loop over an assertion per view.
drop view if exists public.v_mirror_freshness;

create view public.v_mirror_freshness as
  select * from (
    select 'up_rooms'      as source, count(*) as rows, min(fetched_at) as oldest, max(fetched_at) as newest from public.up_rooms
    union all
    select 'up_messages',  count(*), min(fetched_at), max(fetched_at) from public.up_messages
    union all
    select 'up_jobs',      count(*), min(fetched_at), max(fetched_at) from public.up_jobs
    union all
    select 'up_contracts', count(*), min(fetched_at), max(fetched_at) from public.up_contracts
    union all
    select 'up_milestones',count(*), min(fetched_at), max(fetched_at) from public.up_milestones
  ) t
  where public.is_staff();

comment on view public.v_mirror_freshness is
  'How stale each mirrored Upwork table is, for the ops page. Staff only.';

grant select on
  public.v_activity,
  public.v_profiles,
  public.v_upwork_health,
  public.v_mirror_freshness
  to authenticated, anon;
