-- ============================================================================
-- 0018_wait_confidence.sql — say how sure we are that someone is waiting
-- ============================================================================
-- 0017 gave the inbox a wait meter. On real data it fired on 4 of 423 rooms,
-- because Upwork returns no message author and the per-message signals in 0014
-- resolve only about a quarter of traffic: `visit_window` can never classify a
-- message as inbound once the team has read the conversation, since nothing in
-- it is newer than the last visit.
--
-- src/lib/upwork/alternation.ts now fills the gaps by reading a room as a whole:
-- messages seconds apart are the same person still typing ('burst'), and past a
-- real pause the turn probably changed ('alternation'). The second of those is a
-- guess, and it is wrong in exactly the case that matters — a client sending two
-- messages an hour apart with nobody replying in between.
--
-- So the view now reports WHICH signal attributed the unanswered message. The
-- meter renders a guess differently from a fact. Showing an inference as
-- certain would be worse than showing nothing, and a ramp that cries wolf gets
-- ignored, which costs more than the feature is worth.
-- ============================================================================

-- Same scoping rule as 0016 and 0017: a view reads its base tables with the
-- OWNER's privileges, so RLS on up_messages does not apply and every row has to
-- be filtered by can_see_target() here.
drop view if exists public.v_room_wait;

create view public.v_room_wait as
  with last_inbound as (
    select distinct on (m.room_id)
      m.room_id,
      m.sent_at,
      m.direction_source
    from public.up_messages m
    where m.direction = 'inbound' and not m.is_system
    order by m.room_id, m.sent_at desc nulls last
  ),
  last_outbound as (
    select m.room_id, max(m.sent_at) as sent_at
    from public.up_messages m
    where m.direction = 'outbound' and not m.is_system
    group by m.room_id
  ),
  tallies as (
    select
      m.room_id,
      count(*)                                        as message_count,
      count(*) filter (where m.direction <> 'unknown') as decided_count
    from public.up_messages m
    where not m.is_system
    group by m.room_id
  )
  select
    r.room_id,
    li.sent_at                     as last_inbound_at,
    lo.sent_at                     as last_outbound_at,
    coalesce(t.message_count, 0)   as message_count,
    -- The client spoke last: nobody has answered them.
    (
      li.sent_at is not null
      and (lo.sent_at is null or lo.sent_at < li.sent_at)
    ) as awaiting_reply,
    -- The clock starts at the message that went unanswered, not at the first of
    -- a burst: a client who sends three in a row is waiting from the last one,
    -- which is when they stopped and expected a reply.
    case
      when li.sent_at is not null
       and (lo.sent_at is null or lo.sent_at < li.sent_at)
      then li.sent_at
    end as waiting_since,
    -- How that message was attributed. 'alternation' means the wait is a guess.
    case
      when li.sent_at is not null
       and (lo.sent_at is null or lo.sent_at < li.sent_at)
      then li.direction_source
    end as waiting_source,
    -- We hold messages but could not attribute a single one.
    (coalesce(t.message_count, 0) > 0 and coalesce(t.decided_count, 0) = 0) as direction_unknown
  from public.up_rooms r
  left join last_inbound  li on li.room_id = r.room_id
  left join last_outbound lo on lo.room_id = r.room_id
  left join tallies       t  on t.room_id  = r.room_id
  where public.can_see_target('room', r.room_id);

comment on view public.v_room_wait is
  'Per-room reply state: is the client waiting, since when, and how confidently we know who spoke last. Scoped to rooms the caller can see. Severity is computed in src/lib/wait.ts because the ramp discounts overnight IST hours.';

grant select on public.v_room_wait to authenticated, anon;
