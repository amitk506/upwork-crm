-- ============================================================================
-- 0012_member_lifecycle.sql — deactivation must actually remove access
-- ============================================================================
-- Two holes closed:
--
-- 1. profiles_for_room() resolved grants without checking whether the member is
--    still active. Deactivating someone blocked their LOGIN, but their grants
--    still satisfied the RLS predicate — so the database layer, which is meant
--    to be the real boundary, would have let a deactivated account read rooms.
--
-- 2. The deactivate path deleted from upwork_connections, which migration 0011
--    superseded. Grants in profile_grants / room_grants were left untouched.
--    That is fixed in the application; this makes the database refuse anyway.
-- ============================================================================

create or replace function public.profiles_for_room(p_room_id text, p_user_id uuid default auth.uid())
returns table (profile_id uuid, can_send boolean)
language sql
stable
security definer
set search_path = public
as $$
  -- An inactive member holds no access, whatever grants remain on their row.
  select pg.profile_id, pg.can_send
  from public.profile_grants pg
  join public.room_profiles rp on rp.profile_id = pg.profile_id
  join public.app_users u on u.id = pg.user_id and u.is_active
  where pg.user_id = p_user_id and rp.room_id = p_room_id
  union
  select rg.profile_id, rg.can_send
  from public.room_grants rg
  join public.app_users u on u.id = rg.user_id and u.is_active
  where rg.user_id = p_user_id and rg.room_id = p_room_id;
$$;

-- ---------------------------------------------------------------------------
-- Removing a member cleanly
-- ---------------------------------------------------------------------------
-- Wrapped in a function so the whole revocation happens in one transaction —
-- half-removed access is worse than none.
create or replace function public.revoke_member_access(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.profile_grants where user_id = p_user_id;
  delete from public.room_grants    where user_id = p_user_id;
  delete from public.assignments    where assigned_to = p_user_id;

  -- Pending drafts they wrote can never be sent by them now.
  update public.outbound_drafts
     set status = 'withdrawn'
   where author_id = p_user_id and status = 'pending';

  -- Any profile they personally connected stays, but is flagged so an owner
  -- can decide whether to keep or re-authorize it.
  update public.upwork_profiles
     set connect_error = 'Connected by a member who has since been removed — review this profile.'
   where connected_by = p_user_id;
end;
$$;

comment on function public.revoke_member_access is
  'Strips every grant and assignment from a member. Called when deactivating or deleting them.';
