-- ============================================================================
-- 0015_activity_views.sql — a readable activity trail, per chat and overall
-- ============================================================================
-- activity_log has been collecting entries since migration 0003, but it was
-- only readable by staff and successful sends were never tagged with the room
-- they belonged to. Both are fixed here so "who replied to this client?" can be
-- answered from the conversation itself.
-- ============================================================================

create index if not exists activity_log_room_idx
  on public.activity_log (target_type, target_id, created_at desc)
  where target_type = 'room';

-- ---------------------------------------------------------------------------
-- Visibility
-- ---------------------------------------------------------------------------
-- Previously staff-only, or your own actions. Anyone who can see a conversation
-- should also see what happened in it — that is the point of a shared inbox,
-- and it does not widen access to anything they could not already read.
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log
  for select to authenticated
  using (
    public.is_staff()
    or actor_id = auth.uid()
    or (target_type = 'room' and public.can_see_target('room', target_id))
  );

-- Still no insert/update/delete policy for anyone: the trail is written by the
-- server with the service-role key and cannot be rewritten from a browser.

-- ---------------------------------------------------------------------------
-- Readable projection — names instead of uuids
-- ---------------------------------------------------------------------------
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
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
    -- Conversation name, when the entry belongs to one
    r.room_name,
    r.topic                                             as room_topic,
    a.payload,
    a.succeeded,
    a.error,
    a.created_at
  from public.activity_log a
  left join public.app_users u on u.id = a.actor_id
  left join public.up_rooms  r on a.target_type = 'room' and r.room_id = a.target_id;

comment on view public.v_activity is
  'activity_log with actor and conversation names resolved. Inherits activity_log RLS.';
