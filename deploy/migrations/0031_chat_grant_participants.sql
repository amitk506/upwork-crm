-- ============================================================================
-- 0031_chat_grant_participants.sql — per-chat grants were invisible
-- ============================================================================
-- The portal grants access two ways: a whole profile, or a single conversation.
-- v_room_participants only ever joined profile_grants, so the second kind did
-- not exist as far as the interface was concerned.
--
-- Observed: a conversation whose "Who can see this chat" panel listed four
-- people, while a fifth held a per-chat grant on that very room and was absent.
-- Worse than a cosmetic gap — the thread page derives canSend from this view, so
-- somebody granted a single chat could not reply to it. They could only write a
-- draft for someone else to approve, which is precisely the workaround the panel
-- was offering them.
--
-- The database was never confused: can_see_target() honours room_grants and
-- always has. Only this view disagreed, and every screen that asks "who can act
-- here" reads it.
--
-- A member can hold both kinds of grant on the same room. UNION (not UNION ALL)
-- collapses the duplicate, and can_send is taken as the more permissive of the
-- two: an explicit chat grant with send should not be cancelled out by a
-- read-only profile grant.
-- ============================================================================

drop view if exists public.v_room_participants;

create view public.v_room_participants as
  select
    room_id,
    user_id,
    full_name,
    email,
    role,
    bool_or(can_send) as can_send,
    profile_id,
    profile_label,
    max(last_seen_at) as last_seen_at
  from (
    -- Access to every conversation the profile reaches.
    select
      rp.room_id, pg.user_id, u.full_name, u.email, u.role, pg.can_send,
      p.id as profile_id, p.label as profile_label, rp.last_seen_at
    from public.room_profiles rp
    join public.upwork_profiles p on p.id = rp.profile_id
    join public.profile_grants pg on pg.profile_id = p.id
    join public.app_users u on u.id = pg.user_id
    where p.revoked_at is null and u.is_active

    union all

    -- Access to this one conversation. The half that was missing.
    select
      rg.room_id, rg.user_id, u.full_name, u.email, u.role, rg.can_send,
      p.id as profile_id, p.label as profile_label, rp.last_seen_at
    from public.room_grants rg
    join public.upwork_profiles p on p.id = rg.profile_id
    join public.app_users u on u.id = rg.user_id
    left join public.room_profiles rp
      on rp.room_id = rg.room_id and rp.profile_id = rg.profile_id
    where p.revoked_at is null and u.is_active
  ) grants
  where room_id in (select public.visible_room_ids())
  group by room_id, user_id, full_name, email, role, profile_id, profile_label;

comment on view public.v_room_participants is
  'Everyone who may act in a conversation, by profile grant OR per-chat grant, with the more permissive can_send of the two.';

grant select on public.v_room_participants to authenticated, anon;
