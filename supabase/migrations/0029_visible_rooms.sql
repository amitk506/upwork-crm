-- ============================================================================
-- 0029_visible_rooms.sql — stop asking the same question 471 times
-- ============================================================================
-- Measured against the live instance, per navigation:
--
--   v_room_wait           985ms
--   v_room_participants  1195ms
--   v_room_profiles      1204ms
--
-- Three and a half seconds, on every page load AND every 20-second auto-refresh,
-- for views that returned nothing at all.
--
-- The cause is the scoping predicate. Each of those views filters with
-- can_see_target('room', room_id), which is SECURITY DEFINER — so Postgres cannot
-- inline it and calls it once PER ROW. Inside, it reaches profiles_for_room(),
-- which is itself two joins and a UNION. At 471 rooms that is 471 invocations of
-- a multi-join function to answer one question: which rooms may this person see.
--
-- The fix is to ask once. visible_room_ids() returns the whole set, is STABLE so
-- Postgres evaluates it a single time per statement, and `room_id in (select …)`
-- becomes a hash semi-join. Same rule, same answer — this deliberately mirrors
-- can_see_target() branch for branch — but computed set-wise instead of row-wise.
--
-- can_see_target() is left exactly as it is: the RLS policies on the base tables
-- still use it, and there it is asked about one row at a time, which is what it
-- is good at.
-- ============================================================================

create or replace function public.visible_room_ids(p_user_id uuid default auth.uid())
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  -- An explicit grant always wins, whatever the role's scope. Mirrors the first
  -- branch of can_see_target().
  select rp.room_id
  from public.room_profiles rp
  join public.profile_grants pg on pg.profile_id = rp.profile_id
  join public.app_users u on u.id = pg.user_id and u.is_active
  where pg.user_id = p_user_id

  union

  select rg.room_id
  from public.room_grants rg
  join public.app_users u on u.id = rg.user_id and u.is_active
  where rg.user_id = p_user_id

  union

  -- Then the role's own reach.
  select r.room_id
  from public.up_rooms r
  where public.inbox_scope() = 'all'

  union

  select a.target_id
  from public.assignments a
  where a.target_type = 'room'
    and a.assigned_to = p_user_id
    and public.inbox_scope() in ('assigned', 'assigned_or_unassigned')

  union

  -- Bidders also see whatever nobody has claimed, so nothing sits unseen.
  select r.room_id
  from public.up_rooms r
  where public.inbox_scope() = 'assigned_or_unassigned'
    and not exists (
      select 1 from public.assignments a
      where a.target_type = 'room' and a.target_id = r.room_id
    );
$$;

comment on function public.visible_room_ids is
  'Every conversation this member may see, as a set. The set-wise twin of can_see_target(''room'', …) — same rule, evaluated once per statement instead of once per row.';

-- The joins above deserve indexes. profile_grants was only indexed by user, and
-- room_grants only by user, so both were scanned when driven from the room side.
create index if not exists profile_grants_profile_idx on public.profile_grants (profile_id);
create index if not exists room_grants_room_idx on public.room_grants (room_id);
create index if not exists assignments_target_idx on public.assignments (target_type, target_id);

-- ---------------------------------------------------------------------------
-- The three hot views, rewritten to filter set-wise
-- ---------------------------------------------------------------------------
drop view if exists public.v_room_wait;

create view public.v_room_wait as
  select
    s.room_id,
    s.awaiting_since                          as last_inbound_at,
    s.last_outbound_at,
    s.message_count,
    (s.awaiting_since is not null)             as awaiting_reply,
    s.awaiting_since                           as waiting_since,
    s.attribution                              as waiting_source,
    s.all_unknown                              as direction_unknown,
    s.observed_at,
    (
      s.awaiting_since is not null
      and s.waived_for is not null
      and s.waived_for = s.awaiting_since
    )                                          as waived,
    s.waived_by,
    s.waived_at
  from public.room_reply_state s
  where s.room_id in (select public.visible_room_ids());

drop view if exists public.v_room_profiles;

create view public.v_room_profiles as
  select
    rp.room_id,
    p.id    as profile_id,
    p.label as profile_label,
    p.org_role,
    rp.last_seen_at,
    p.send_requires_approval
  from public.room_profiles rp
  join public.upwork_profiles p on p.id = rp.profile_id
  where p.revoked_at is null
    and rp.room_id in (select public.visible_room_ids());

drop view if exists public.v_room_participants;

create view public.v_room_participants as
  select
    rp.room_id, pg.user_id, u.full_name, u.email, u.role, pg.can_send,
    p.id as profile_id, p.label as profile_label, rp.last_seen_at
  from public.room_profiles rp
  join public.upwork_profiles p on p.id = rp.profile_id
  join public.profile_grants pg on pg.profile_id = p.id
  join public.app_users u on u.id = pg.user_id
  where p.revoked_at is null
    and u.is_active
    and rp.room_id in (select public.visible_room_ids());

drop view if exists public.v_followups;

create view public.v_followups as
  select
    f.id, f.room_id, r.room_name, r.topic, f.due_at, f.for_user,
    coalesce(u.full_name, u.email) as for_name,
    f.note, f.created_by, f.created_at, f.done_at,
    (f.done_at is null and f.due_at <= now()) as is_due
  from public.room_followups f
  left join public.up_rooms  r on r.room_id = f.room_id
  left join public.app_users u on u.id = f.for_user
  where f.room_id in (select public.visible_room_ids());

grant select on
  public.v_room_wait, public.v_room_profiles,
  public.v_room_participants, public.v_followups
  to authenticated, anon;
