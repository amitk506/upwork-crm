-- ============================================================================
-- 0014_message_direction.sql — work out which side a message came from
-- ============================================================================
-- Upwork's MCP returns no sender on a message: list_messages and get_message
-- both yield only { actionVerb, createdDateTime, id, message }. Labelling every
-- message "sender not shown" is honest but useless to read.
--
-- Three signals get us most of the way, and each records HOW it was decided so
-- the UI can be honest about certainty rather than presenting a guess as fact:
--
--   portal_send  — we sent it ourselves and recorded it. Certain.
--   mention      — it @-mentions or greets the other participant by name.
--                  People do not address themselves, so it is ours. Strong.
--   visit_window — it arrived after our profile last opened the room, so it
--                  came in while we were away. Theirs. Strong.
--   (null)       — genuinely unknown; the UI says so rather than inventing.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'message_direction') then
    create type public.message_direction as enum ('outbound', 'inbound', 'unknown');
  end if;
end$$;

alter table public.up_messages
  add column if not exists direction public.message_direction not null default 'unknown';

alter table public.up_messages
  add column if not exists direction_source text;

comment on column public.up_messages.direction is
  'outbound = from the agency profile, inbound = from the other participant, unknown = Upwork gave us nothing to go on.';

comment on column public.up_messages.direction_source is
  'How direction was decided: portal_send (certain), mention, visit_window. Null when unknown.';

-- The room list carries when our profile last opened the conversation; anything
-- newer than that arrived while we were away.
alter table public.up_rooms
  add column if not exists last_visited_at timestamptz;

create index if not exists up_messages_direction_idx
  on public.up_messages (room_id, direction);
