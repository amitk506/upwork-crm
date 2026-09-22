-- ============================================================================
-- 0009_room_access.sql — which member can actually act in which conversation
-- ============================================================================
-- Every member sends from their OWN Upwork account, which means a reply can
-- only go out if that person is a participant in that Upwork conversation.
-- Different accounts see different rooms, and the portal's mirror is shared, so
-- "the room is in the list" does NOT imply "I can post to it".
--
-- Rather than guessing Upwork's participation rules, this records what each
-- member's own sync actually returned. Empirical, and correct regardless of how
-- Upwork decides visibility.
-- ============================================================================

create table if not exists public.room_access (
  room_id       text        not null,
  user_id       uuid        not null references public.app_users(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_access_user_idx on public.room_access (user_id);

comment on table public.room_access is
  'A row means: this member''s own Upwork account returned this room on their last sync, so they can read and reply in it.';

alter table public.room_access enable row level security;

-- Everyone who can see a conversation can see who is able to act in it — that
-- is what makes assignment a sensible decision rather than a guess.
drop policy if exists room_access_select on public.room_access;
create policy room_access_select on public.room_access
  for select to authenticated
  using (public.can_see_target('room', room_id));

-- ---------------------------------------------------------------------------
-- Who can reply here?
-- ---------------------------------------------------------------------------
create or replace function public.can_act_in_room(p_room_id text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_access ra
    where ra.room_id = p_room_id and ra.user_id = p_user_id
  );
$$;

comment on function public.can_act_in_room is
  'True when this member''s own Upwork account has seen the room, and can therefore post to it.';

-- Convenience view for the assignment picker: who is connected AND has access.
-- Drop first, don't replace. deploy.sh replays every migration on each run, and
-- 0016 gives this view more columns than the statement below does — CREATE OR
-- REPLACE VIEW cannot drop a column, so a replay failed here with "cannot drop
-- columns from view". Dropping makes the whole chain re-runnable: this recreates
-- the 0009 shape, and 0013/0016 reshape it again further down.
drop view if exists public.v_room_participants;

create view public.v_room_participants as
  select
    ra.room_id,
    ra.user_id,
    u.full_name,
    u.email,
    u.role,
    ra.last_seen_at
  from public.room_access ra
  join public.app_users u on u.id = ra.user_id
  where u.is_active;
