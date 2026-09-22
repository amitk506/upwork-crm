-- ============================================================================
-- 0006_message_authorship.sql — what Upwork will not tell us, tracked locally
-- ============================================================================
-- Upwork's MCP message payload carries only { actionVerb, createdDateTime, id,
-- message }. There is NO sender field on list_messages or get_message, so a
-- thread cannot be attributed from the API alone.
--
-- Two things we can do honestly:
--   1. actionVerb distinguishes a human post from a system event
--   2. anything sent THROUGH this portal has a known author, so record it
-- Everything else stays explicitly unattributed rather than guessed.
-- ============================================================================

alter table public.up_messages
  add column if not exists action_verb text;

-- 'posted' is a human message; 'invited', 'accepted', 'sent' and friends are
-- system events that should not look like someone talking.
alter table public.up_messages
  add column if not exists is_system boolean not null default false;

comment on column public.up_messages.action_verb is
  'Upwork actionVerb. "posted" = a person wrote it; anything else is a system event.';

-- ---------------------------------------------------------------------------
-- Outbound messages we sent ourselves
-- ---------------------------------------------------------------------------
-- Recorded at send time, then matched back on the next sync so the thread can
-- show a real author for our own replies. Matching on a body digest rather than
-- the text keeps the message out of a second table.
create table if not exists public.sent_messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    text        not null,
  author_id  uuid        not null references public.app_users(id) on delete cascade,
  body_sha   text        not null,
  sent_at    timestamptz not null default now(),
  story_id   text,                       -- filled in once we spot it on Upwork
  unique (room_id, body_sha)
);

create index if not exists sent_messages_room_idx on public.sent_messages (room_id, sent_at desc);

comment on table public.sent_messages is
  'Messages sent through this portal. Upwork does not return authorship, so this is the only reliable record of which replies are ours.';

alter table public.sent_messages enable row level security;

drop policy if exists sent_messages_select on public.sent_messages;
create policy sent_messages_select on public.sent_messages
  for select to authenticated
  using (public.can_see_target('room', room_id));

-- Written only by the server, at send time.
