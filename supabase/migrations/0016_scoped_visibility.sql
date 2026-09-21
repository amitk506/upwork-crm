-- ============================================================================
-- 0016_scoped_visibility.sql — a member sees only their own slice
-- ============================================================================
-- Two leaks, one cause: a view's underlying tables are evaluated with the VIEW
-- OWNER's privileges, not the caller's, so every RLS policy the base tables
-- carry was being bypassed. The views therefore have to filter by the caller
-- explicitly.
--
-- 1. The inbox filter listed every Upwork profile with its full conversation
--    count. A team lead assigned two chats could read off that the agency runs
--    five identities and that one of them has 190 conversations. None of that is
--    theirs to know.
--
-- 2. Activity showed everyone's actions to anyone who could see the room. The
--    trail should follow seniority: an owner sees everything, a manager sees
--    their own plus the people below them, a lead or bidder sees their own.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Which profiles may a member even know exist?
-- ---------------------------------------------------------------------------
create or replace function public.visible_profile_ids(p_user_id uuid default auth.uid())
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.upwork_profiles p
  where p.revoked_at is null
    and (
      -- Owners and managers run the agency; they see the whole estate.
      public.is_staff()
      -- Everyone else: only profiles they hold, whole or per-chat.
      or exists (
        select 1 from public.profile_grants pg
        where pg.profile_id = p.id and pg.user_id = p_user_id
      )
      or exists (
        select 1 from public.room_grants rg
        where rg.profile_id = p.id and rg.user_id = p_user_id
      )
    );
$$;

comment on function public.visible_profile_ids is
  'Profiles this member may see named at all. A grant on one profile reveals nothing about the others.';

-- ---------------------------------------------------------------------------
-- Counts are per-viewer too
-- ---------------------------------------------------------------------------
-- An INNER join on purpose: a profile with no conversations this member can see
-- disappears from their filter entirely rather than appearing with a zero.
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
drop view if exists public.v_profile_room_counts;

create view public.v_profile_room_counts as
  select
    p.id    as profile_id,
    p.label as profile_label,
    count(rp.room_id)                                  as room_count,
    count(rp.room_id) filter (where r.num_unread > 0)  as unread_rooms
  from public.upwork_profiles p
  join public.room_profiles rp on rp.profile_id = p.id
  join public.up_rooms r       on r.room_id = rp.room_id
  where p.revoked_at is null
    and p.id in (select public.visible_profile_ids())
    and public.can_see_target('room', rp.room_id)
  group by p.id, p.label;

-- Same treatment for the per-room profile badge.
-- Same reason as above: drop, then create.
drop view if exists public.v_room_profiles;

create view public.v_room_profiles as
  select
    rp.room_id,
    p.id    as profile_id,
    p.label as profile_label,
    p.org_role,
    rp.last_seen_at
  from public.room_profiles rp
  join public.upwork_profiles p on p.id = rp.profile_id
  where p.revoked_at is null
    and public.can_see_target('room', rp.room_id);

-- And for "who can reply here" — it names colleagues, so it is scoped to rooms
-- the caller can actually see.
drop view if exists public.v_room_participants;

create view public.v_room_participants as
  select
    rp.room_id, pg.user_id, u.full_name, u.email, u.role, pg.can_send,
    p.id as profile_id, p.label as profile_label, rp.last_seen_at
  from public.room_profiles rp
  join public.upwork_profiles p on p.id = rp.profile_id and p.revoked_at is null
  join public.profile_grants pg on pg.profile_id = p.id
  join public.app_users u       on u.id = pg.user_id and u.is_active
  where public.can_see_target('room', rp.room_id)

  union

  select
    rg.room_id, rg.user_id, u.full_name, u.email, u.role, rg.can_send,
    p.id, p.label, rg.created_at
  from public.room_grants rg
  join public.upwork_profiles p on p.id = rg.profile_id and p.revoked_at is null
  join public.app_users u       on u.id = rg.user_id and u.is_active
  where public.can_see_target('room', rg.room_id);

-- ---------------------------------------------------------------------------
-- Activity follows seniority
-- ---------------------------------------------------------------------------
create or replace function public.can_see_activity_of(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- Your own actions, always.
    when p_actor = auth.uid() then true

    -- The owner sees the whole trail, including unattributed system entries
    -- such as the background sync.
    when public.app_user_role() = 'owner' then true

    -- A manager sees the people they are responsible for, not their peers or
    -- the owner. System entries are operational, so they see those too.
    when public.app_user_role() = 'manager' then
      p_actor is null
      or exists (
        select 1 from public.app_users a
        where a.id = p_actor and a.role in ('team_lead', 'bidder', 'manager')
      )

    -- Leads and bidders see their own work only.
    else false
  end;
$$;

comment on function public.can_see_activity_of is
  'Activity visibility by seniority: owner sees all, manager sees managers and below, everyone else sees their own.';

-- Previously any member could read activity for a conversation they had access
-- to, which exposed colleagues' actions. Seniority decides instead.
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log
  for select to authenticated
  using (public.can_see_activity_of(actor_id));
