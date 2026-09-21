-- ============================================================================
-- 0021_sync_coverage.sql — two sync bugs that hid conversations
-- ============================================================================
-- Both were found by checking numbers that had stopped moving rather than by
-- reading code, and both silently reduced what the wait meter could see.
--
-- 1. HYDRATION COULD NOT REACH OLD ROOMS.
--    syncAllProfiles picks rooms to top up from `page.items` — the current
--    listRooms page, capped at Upwork's maximum of 100 and sorted newest-first.
--    up_rooms holds 423 rooms accumulated over time, so a conversation that has
--    slipped past position 100 is no longer in any page the sync sees, and could
--    never be selected. 22 rooms were stuck with no reply state, permanently
--    invisible to the inbox. The candidate list has to come from the database,
--    which knows about every room, not from one page of a live response.
--
-- 2. THE ATTRIBUTION BACKFILL STARVED.
--    backfillDirections selects rooms holding unknown messages and takes the
--    first 15. PostgREST returns them in a stable order, so it took the SAME 15
--    every tick. Those 15 have anchors but their remaining unknowns sit past
--    alternation.ts's flip cap, so nothing changed, so they stayed at the front
--    of the queue forever. Measured: 81 rooms needed attribution, 15 were
--    attempted repeatedly and 66 were never reached.
--
--    Fixing the ordering alone would not hold — any room whose unknowns cannot be
--    resolved returns to the front. It needs a marker recording that the room was
--    ATTEMPTED, so the queue rotates whether or not the attempt achieved
--    anything.
-- ============================================================================

alter table public.room_reply_state
  add column if not exists attribution_pass_at timestamptz;

comment on column public.room_reply_state.attribution_pass_at is
  'When the room-wide attribution pass last ran here. Stamped even when nothing changed — that is what stops rooms whose messages cannot be resolved from blocking the queue forever.';

create index if not exists room_reply_state_attribution_idx
  on public.room_reply_state (attribution_pass_at nulls first);

-- ---------------------------------------------------------------------------
-- Which rooms still need a reply state at all
-- ---------------------------------------------------------------------------
-- Scoped to one profile because the caller needs an Upwork identity that can
-- actually read the conversation, and room_profiles is what records that.
-- Newest first: if the budget stops the loop, stop on the conversations least
-- likely to have somebody waiting.
create or replace function public.rooms_needing_reply_state(
  p_profile_id uuid,
  p_limit int default 4
)
returns table (room_id text, room_name text, last_visited_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.room_id, r.room_name, r.last_visited_at
  from public.up_rooms r
  join public.room_profiles rp on rp.room_id = r.room_id and rp.profile_id = p_profile_id
  where r.latest_story_id is not null
    and not exists (
      select 1 from public.room_reply_state s where s.room_id = r.room_id
    )
  order by r.latest_story_at desc nulls last
  limit greatest(p_limit, 0);
$$;

comment on function public.rooms_needing_reply_state is
  'Conversations this profile can read that have never had a reply state established. Reads up_rooms rather than a live listRooms page, so rooms past position 100 are reachable.';

-- ---------------------------------------------------------------------------
-- Which rooms are worth another attribution attempt
-- ---------------------------------------------------------------------------
-- Two conditions, both load-bearing:
--   · the room still holds unknown messages, so there is something to do
--   · it has at least one attributed message, because alternation propagates
--     outward from anchors and a room with none cannot be resolved at all
-- Ordered oldest-attempt-first so the queue rotates.
create or replace function public.rooms_needing_attribution(p_limit int default 15)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select t.room_id
  from (
    select
      m.room_id,
      count(*) filter (where m.direction = 'unknown')  as unknowns,
      count(*) filter (where m.direction <> 'unknown') as anchors
    from public.up_messages m
    where not m.is_system
    group by m.room_id
  ) t
  left join public.room_reply_state s on s.room_id = t.room_id
  where t.unknowns > 0 and t.anchors > 0
  order by s.attribution_pass_at asc nulls first, t.unknowns desc
  limit greatest(p_limit, 0);
$$;

comment on function public.rooms_needing_attribution is
  'Rooms with unattributed messages AND at least one anchor to propagate from, oldest attempt first. Rotation is what stops the 15 hardest rooms monopolising every pass.';

revoke all on function public.rooms_needing_reply_state(uuid, int) from public;
revoke all on function public.rooms_needing_attribution(int) from public;
grant execute on function public.rooms_needing_reply_state(uuid, int) to service_role;
grant execute on function public.rooms_needing_attribution(int) to service_role;
