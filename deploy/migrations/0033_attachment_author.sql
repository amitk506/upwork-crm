-- ============================================================================
-- 0033_attachment_author.sql — Upwork finally names a sender, on attachments
-- ============================================================================
-- The messaging API has never said who sent a message, which is why direction is
-- inferred and why clients' messages sometimes appear as the agency's. The Aug
-- 2026 payload change added `userId` to attachment metadata: not the message's
-- author, but the uploader of a file on it — which is the same person.
--
-- Measured on the live data before this ran:
--
--   314 messages carry an uploader id
--   314 of those uploads belong to a client, none to a connected profile
--   153 of them were being displayed as OURS
--
-- So a client would send a screenshot, the portal would show it on the agency's
-- side, and the conversation read as already answered. Exactly the confusion
-- reported.
--
-- This corrects the stored rows in one pass. Sync applies the same rule to new
-- messages, ahead of every inferred signal.
--
-- Human corrections still win: a row in message_directions is somebody who
-- looked at the conversation, and that outranks anything derived.
-- ============================================================================

with uploader as (
  select
    m.story_id,
    trim(both from replace(replace(kv->>'value',
      '<untrusted_participant_content>', ''), '</untrusted_participant_content>', '')) as upwork_user_id
  from public.up_messages m,
       lateral jsonb_array_elements(m.attachments) a,
       lateral jsonb_array_elements(a->'metadata') kv
  where jsonb_typeof(m.attachments) = 'array'
    and kv->>'key' like '%userId%'
),
decided as (
  select distinct on (u.story_id)
    u.story_id,
    (exists (
      select 1 from public.upwork_profiles p
      where p.upwork_user_id = u.upwork_user_id and p.revoked_at is null
    )) as is_ours
  from uploader u
  order by u.story_id
)
update public.up_messages m
   set direction = case when d.is_ours then 'outbound' else 'inbound' end::public.message_direction,
       direction_source = 'attachment_author',
       is_outbound = d.is_ours
  from decided d
 where d.story_id = m.story_id
   -- Never overrule a person who told us themselves.
   and not exists (select 1 from public.message_directions o where o.story_id = m.story_id);

-- The reply state is derived from direction, so rooms whose last message just
-- flipped sides need recomputing. Cheapest correct approach: clear the pass
-- marker so the existing attribution sweep revisits them on the next tick.
update public.room_reply_state s
   set attribution_pass_at = null
 where exists (
   select 1 from public.up_messages m
   where m.room_id = s.room_id and m.direction_source = 'attachment_author'
 );
