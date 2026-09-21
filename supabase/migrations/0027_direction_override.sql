-- ============================================================================
-- 0027_direction_override.sql — let a human correct the attribution
-- ============================================================================
-- Upwork returns no sender, so direction is inferred (0014, and the room-wide
-- pass in alternation.ts). The inference is usually right and always labelled,
-- but it has a blind spot it cannot escape on its own: a reply the agency sends
-- from Upwork's own app rather than through the portal.
--
-- Observed exactly that. A message the team sent from the Upwork website landed
-- after the profile's last_visited_at, so the visit_window rule read "arrived
-- while we were away" and filed it as the client's. It appeared in the thread
-- under the client's name, left-aligned, as though they had thanked themselves.
--
-- No signal available to the portal fixes this. The person reading the thread
-- knows the answer immediately, and until now had no way to say so — the
-- interface asked them to trust a guess it would not let them correct.
--
-- A correction is portal-owned truth. It outranks every inferred source and is
-- re-applied on every sync, because resolveDirections() recomputes direction
-- from scratch each time a room is fetched and would otherwise overwrite it on
-- the next tick.
-- ============================================================================

create table if not exists public.message_directions (
  story_id   text        primary key,
  room_id    text        not null,
  direction  public.message_direction not null,
  set_by     uuid        references public.app_users(id) on delete set null,
  set_at     timestamptz not null default now()
);

-- No foreign key to up_messages: that table is Zone 1 and expires on Upwork's
-- 24h caching rule. The correction has to outlive the message it corrects, or it
-- would be lost exactly when the message is refetched and re-guessed.
comment on table public.message_directions is
  'Human corrections to inferred message direction. Outranks every inferred source and survives the message mirror expiring.';

create index if not exists message_directions_room_idx on public.message_directions (room_id);

alter table public.message_directions enable row level security;

drop policy if exists message_directions_select on public.message_directions;
create policy message_directions_select on public.message_directions
  for select to authenticated
  using (public.can_see_target('room', room_id));

-- Anyone who can see the conversation can correct it: the people who know are
-- the people reading the thread, and a correction is cheap to reverse.
drop policy if exists message_directions_write on public.message_directions;
create policy message_directions_write on public.message_directions
  for all to authenticated
  using (public.can_see_target('room', room_id))
  with check (public.can_see_target('room', room_id));

grant select, insert, update, delete on public.message_directions to authenticated;
grant all on public.message_directions to service_role;
