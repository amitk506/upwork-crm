-- ============================================================================
-- 0022_sync_gaps.sql — say out loud when conversations have gone dark
-- ============================================================================
-- Found while chasing why 22 conversations had no reply state. They were not
-- stale cache rows, which was the first guess: all 23 were fetched in the same
-- instant and 14 had client activity within 30 days. They are live
-- conversations belonging to a profile whose OAuth refresh token expired:
--
--   Acme Marketing Solutions — rooms claimed: 0
--   connect_error: invalid_grant — Refresh token is expired or revoked
--
-- So no working profile can read them, no sync can fetch their messages, and the
-- wait meter cannot tell whether anyone is waiting in any of them. Deleting them
-- would have been the wrong fix and would have destroyed the only evidence.
--
-- The actual defect is that none of this was visible. The failure was recorded on
-- upwork_profiles.connect_error and mentioned in the sync tick's `failures`
-- array, and that is all — nobody working the inbox had any way to know a
-- twenty-third of the agency's conversations had stopped updating. A broken
-- connection is exactly the kind of silent failure this portal exists to prevent,
-- so it gets a number on the board.
-- ============================================================================

drop view if exists public.v_sync_gaps;

create view public.v_sync_gaps as
  select
    -- Profiles the portal can no longer act as.
    (
      select count(*) from public.upwork_profiles
      where revoked_at is null and connect_error is not null
    ) as profiles_broken,
    -- Conversations no live profile claims, so nothing can refresh them.
    (
      select count(*) from public.up_rooms r
      where not exists (
        select 1
        from public.room_profiles rp
        join public.upwork_profiles p on p.id = rp.profile_id
        where rp.room_id = r.room_id and p.revoked_at is null
      )
    ) as rooms_unreachable,
    -- The labels, so the banner can name them rather than just count them.
    (
      select coalesce(array_agg(label order by label), '{}')
      from public.upwork_profiles
      where revoked_at is null and connect_error is not null
    ) as broken_labels
  -- Staff only: it names profiles, and 0020 established that a view has to
  -- filter for itself because RLS on its base tables does not apply.
  where public.is_staff();

comment on view public.v_sync_gaps is
  'Where the sync has stopped working: profiles that need reconnecting, and conversations no live profile can reach. Staff only.';

grant select on public.v_sync_gaps to authenticated, anon;
