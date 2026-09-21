-- ============================================================================
-- 0013_inbox_by_profile.sql — coverage on the profile model, and per-profile views
-- ============================================================================
-- v_room_participants still read room_access, the per-user table that central
-- profiles (0011) replaced. Nothing writes to it any more, so the inbox
-- reported "nobody connected can reply" for every conversation — alarming, and
-- wrong. Coverage is now derived from grants against the profile that actually
-- reaches the room.
-- ============================================================================

-- Who can act in a room, and through which profile.
--
-- Dropped first: CREATE OR REPLACE VIEW cannot rename or reorder columns, and
-- this adds can_send / profile_id / profile_label to the old shape.
drop view if exists public.v_room_participants;

create view public.v_room_participants as
  -- via a grant on the whole profile
  select
    rp.room_id,
    pg.user_id,
    u.full_name,
    u.email,
    u.role,
    pg.can_send,
    p.id    as profile_id,
    p.label as profile_label,
    rp.last_seen_at
  from public.room_profiles rp
  join public.upwork_profiles p on p.id = rp.profile_id and p.revoked_at is null
  join public.profile_grants pg on pg.profile_id = p.id
  join public.app_users u       on u.id = pg.user_id and u.is_active

  union

  -- via a grant on this one conversation
  select
    rg.room_id,
    rg.user_id,
    u.full_name,
    u.email,
    u.role,
    rg.can_send,
    p.id    as profile_id,
    p.label as profile_label,
    rg.created_at as last_seen_at
  from public.room_grants rg
  join public.upwork_profiles p on p.id = rg.profile_id and p.revoked_at is null
  join public.app_users u       on u.id = rg.user_id and u.is_active;

comment on view public.v_room_participants is
  'Members who can act in a room, and the profile they act through. Derived from grants, not from the retired per-user room_access table.';

-- ---------------------------------------------------------------------------
-- Which profile each conversation belongs to — the inbox filter
-- ---------------------------------------------------------------------------
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
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
  where p.revoked_at is null;

-- Conversation counts per profile, for the filter chips.
-- Same reason as above: drop, then create.
drop view if exists public.v_profile_room_counts;

create view public.v_profile_room_counts as
  select
    p.id    as profile_id,
    p.label as profile_label,
    count(rp.room_id)                                            as room_count,
    count(rp.room_id) filter (where r.num_unread > 0)            as unread_rooms
  from public.upwork_profiles p
  left join public.room_profiles rp on rp.profile_id = p.id
  left join public.up_rooms r       on r.room_id = rp.room_id
  where p.revoked_at is null
  group by p.id, p.label;

-- ---------------------------------------------------------------------------
-- room_access is retired
-- ---------------------------------------------------------------------------
-- Kept (empty) rather than dropped so an older deployment mid-rollout does not
-- error, but nothing reads it now. Safe to drop once every instance is on 0013.
comment on table public.room_access is
  'RETIRED by migration 0011 — superseded by room_profiles. Nothing reads or writes this.';
