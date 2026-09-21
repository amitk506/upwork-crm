-- ============================================================================
-- 0030_reply_misses.sql — end-of-day check on client replies
-- ============================================================================
-- The owner wants a person's unanswered conversations logged against their
-- record in the HR system. This is the half that decides WHETHER something
-- should be logged; nothing here talks to HR.
--
-- It is a review queue, not an automatic record, and the reason is in the data.
-- Of 167 conversations currently awaiting a reply, 14 have an assignee and NONE
-- is attributed with certainty — 155 rest on `visit_window`, the same rule that
-- filed a message the agency sent from Upwork's own app as the client's. A
-- disciplinary note generated from that would be an allegation, not a record.
--
-- So each miss is captured with the evidence that produced it, including how
-- confident the attribution was, and a manager confirms or dismisses it. Once
-- assignment coverage improves and the API key makes direction factual, the same
-- rows can flow onward without changing how they are detected.
--
-- Holidays are NOT stored here. They live in the HR system, which is where
-- someone already maintains them, and are read from its open /api/holidays
-- endpoint — see src/lib/holidays.ts. One list, one owner.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'reply_miss_status') then
    create type public.reply_miss_status as enum ('pending', 'confirmed', 'dismissed');
  end if;
end$$;

create table if not exists public.reply_misses (
  id           bigserial   primary key,
  -- The IST day the miss belongs to, so one conversation yields at most one
  -- entry per day however many times the job runs.
  miss_date    date        not null,
  room_id      text        not null,
  room_name    text,
  -- Who owned it at midnight. Kept as a snapshot: reassigning a conversation
  -- afterwards must not move an existing miss onto somebody else's record.
  employee_id  uuid        not null references public.app_users(id) on delete cascade,
  employee_name text       not null,

  -- The evidence, frozen at detection time.
  awaiting_since   timestamptz not null,
  waited_seconds   integer     not null,
  attribution      text,
  -- False when the only reason we believe the client spoke last is a guess.
  attribution_certain boolean  not null default false,

  status       public.reply_miss_status not null default 'pending',
  reviewed_by  uuid        references public.app_users(id) on delete set null,
  reviewed_at  timestamptz,
  review_note  text,
  -- Set once the confirmed miss reaches the HR system.
  exported_at  timestamptz,

  created_at   timestamptz not null default now(),
  unique (miss_date, room_id)
);

comment on table public.reply_misses is
  'Conversations that ended a working day unanswered. A review queue: a manager confirms before anything becomes an HR note, because most attributions are inferred rather than known.';

create index if not exists reply_misses_pending_idx
  on public.reply_misses (status, miss_date desc);
create index if not exists reply_misses_employee_idx
  on public.reply_misses (employee_id, miss_date desc);

alter table public.reply_misses enable row level security;

-- Seniority, not room access: this is about a colleague's record, and
-- can_see_activity_of() already encodes who may see whose work (0016).
drop policy if exists reply_misses_select on public.reply_misses;
create policy reply_misses_select on public.reply_misses
  for select to authenticated
  using (public.can_see_activity_of(employee_id));

-- Only the people who route work may confirm or dismiss a miss.
drop policy if exists reply_misses_update on public.reply_misses;
create policy reply_misses_update on public.reply_misses
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

grant select, update on public.reply_misses to authenticated;
grant all on public.reply_misses to service_role;
grant usage, select on sequence public.reply_misses_id_seq to service_role;
