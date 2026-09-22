-- ============================================================================
-- 0026_followups.sql — "chase this one on Tuesday"
-- ============================================================================
-- The wait meter answers "who is waiting on us". It cannot answer "who did we
-- promise to come back to", because that promise leaves no trace in the
-- conversation: the last message is ours, so the room is answered and correctly
-- drops off the list. A client we said we would update on the 25th looks
-- identical to one that is finished.
--
-- So a follow-up is a portal-owned intention with a date on it. It lives here
-- rather than being inferred from messages for the same reason room_reply_state
-- does — Upwork's 24h caching rule means the conversation it refers to will not
-- be in the mirror by the time the date arrives.
--
-- One OPEN follow-up per conversation, enforced by a partial unique index.
-- Several would need a list and a UI to manage the list, and "the next thing I
-- owe this client" is one fact, not a queue.
-- ============================================================================

create table if not exists public.room_followups (
  id          bigserial   primary key,
  room_id     text        not null,
  -- When it comes due. Stored as a timestamp so "tomorrow morning" is expressible,
  -- but the UI sets a date at 10:00 IST, which is what people actually mean.
  due_at      timestamptz not null,
  -- Who owes the message. Defaults to the conversation's assignee at the time it
  -- was set; kept explicit rather than derived so reassigning a chat cannot
  -- silently move somebody's commitments onto someone else's dashboard.
  for_user    uuid        not null references public.app_users(id) on delete cascade,
  note        text,
  created_by  uuid        references public.app_users(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- Set when the follow-up is honoured or dismissed. Kept, not deleted, so the
  -- activity trail and any later "did we actually chase them" question survive.
  done_at     timestamptz,
  done_by     uuid        references public.app_users(id) on delete set null
);

-- No foreign key to up_rooms on purpose: that table is Zone 1 and expires on the
-- 24h caching rule, and a cascade would delete the reminder along with the cache.
comment on table public.room_followups is
  'A dated intention to message a client again. Portal-owned, so it outlives the message mirror it refers to.';

create unique index if not exists room_followups_one_open_idx
  on public.room_followups (room_id)
  where done_at is null;

create index if not exists room_followups_due_idx
  on public.room_followups (for_user, due_at)
  where done_at is null;

alter table public.room_followups enable row level security;

-- Same rule as everywhere else: you deal with a follow-up if you can see the
-- conversation it belongs to.
drop policy if exists room_followups_select on public.room_followups;
create policy room_followups_select on public.room_followups
  for select to authenticated
  using (public.can_see_target('room', room_id));

drop policy if exists room_followups_insert on public.room_followups;
create policy room_followups_insert on public.room_followups
  for insert to authenticated
  with check (public.can_see_target('room', room_id) and created_by = auth.uid());

drop policy if exists room_followups_update on public.room_followups;
create policy room_followups_update on public.room_followups
  for update to authenticated
  using (public.can_see_target('room', room_id))
  with check (public.can_see_target('room', room_id));

grant select, insert, update on public.room_followups to authenticated;
grant all on public.room_followups to service_role;
grant usage, select on sequence public.room_followups_id_seq to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What each person owes, with the conversation named
-- ---------------------------------------------------------------------------
-- Scoped in the view body, not by the policy above: a view reads its base tables
-- with the OWNER's privileges, so RLS on room_followups does not apply here.
-- That oversight left five views public in 0020; it is not repeated.
drop view if exists public.v_followups;

create view public.v_followups as
  select
    f.id,
    f.room_id,
    r.room_name,
    r.topic,
    f.due_at,
    f.for_user,
    coalesce(u.full_name, u.email)  as for_name,
    f.note,
    f.created_by,
    f.created_at,
    f.done_at,
    (f.done_at is null and f.due_at <= now()) as is_due
  from public.room_followups f
  left join public.up_rooms  r on r.room_id = f.room_id
  left join public.app_users u on u.id = f.for_user
  where public.can_see_target('room', f.room_id);

comment on view public.v_followups is
  'Open and completed follow-ups with the conversation named, scoped to rooms the caller can see.';

grant select on public.v_followups to authenticated, anon;
