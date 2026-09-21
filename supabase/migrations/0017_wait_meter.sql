-- ============================================================================
-- 0017_wait_meter.sql — how long has this client been waiting on us?
-- ============================================================================
-- The inbox has sorted by latest_story_at since 0002, which answers "what moved
-- most recently" and not "what is going wrong". Those diverge in exactly the
-- case that costs an agency a client: someone opens a message, reads it, means
-- to come back to it, and never does. num_unread clears the moment it is
-- opened, so from that point on the row is indistinguishable from a resolved
-- one — and it drops down the list as other conversations move.
--
-- So: a conversation is AWAITING REPLY when its newest message is inbound.
-- Independent of read state, on purpose. The elapsed time since that message is
-- the number the whole product now organises around.
--
-- What this view deliberately does NOT do is turn that into a severity level.
-- The ramp discounts overnight hours in IST (a 2 AM Chicago message must not
-- read as a breach by the time Delhi logs in), and that arithmetic belongs in
-- src/lib/wait.ts where it is unit-tested against real timestamps rather than
-- buried in SQL. The view supplies facts; the app decides what they mean.
--
-- Direction comes from 0014, which infers it because Upwork's MCP returns no
-- author. Rooms where every message is 'unknown' report awaiting_reply = false
-- and unresolved = true, so the UI can say "we cannot tell" instead of
-- inventing a wait time it has no basis for.
-- ============================================================================

-- Scoping note, learned the hard way in 0016: a view's base tables are read
-- with the VIEW OWNER's privileges, so RLS on up_messages does NOT apply here.
-- Every row must be filtered by can_see_target() explicitly.
drop view if exists public.v_room_wait;

create view public.v_room_wait as
  with tallies as (
    select
      r.room_id,
      max(m.sent_at) filter (where m.direction = 'inbound')  as last_inbound_at,
      max(m.sent_at) filter (where m.direction = 'outbound') as last_outbound_at,
      count(m.story_id)                                      as message_count,
      count(m.story_id) filter (where m.direction <> 'unknown') as decided_count
    from public.up_rooms r
    left join public.up_messages m on m.room_id = r.room_id
    where public.can_see_target('room', r.room_id)
    group by r.room_id
  )
  select
    room_id,
    last_inbound_at,
    last_outbound_at,
    message_count,
    -- The client spoke last: nobody has answered them.
    (
      last_inbound_at is not null
      and (last_outbound_at is null or last_outbound_at < last_inbound_at)
    ) as awaiting_reply,
    -- The clock starts at the message that went unanswered, not at the first
    -- of a burst: a client who sends three messages in a row is waiting from
    -- the last one, which is when they actually stopped and expected a reply.
    case
      when last_inbound_at is not null
       and (last_outbound_at is null or last_outbound_at < last_inbound_at)
      then last_inbound_at
    end as waiting_since,
    -- We hold messages but could not tell which side any of them came from.
    (message_count > 0 and decided_count = 0) as direction_unknown
  from tallies;

comment on view public.v_room_wait is
  'Per-room reply state: is the client waiting, and since when. Scoped to rooms the caller can see. Severity is computed in src/lib/wait.ts, not here.';

-- The filter in the view is a function call, so plan for the join being driven
-- from up_messages rather than a room-at-a-time lookup.
create index if not exists up_messages_room_direction_time_idx
  on public.up_messages (room_id, direction, sent_at desc);

grant select on public.v_room_wait to authenticated, anon;
