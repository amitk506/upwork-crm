-- ============================================================================
-- 0023_waive_reply.sql — "this one doesn't need an answer"
-- ============================================================================
-- Not every last-word-from-the-client needs a reply. "Thanks, that's perfect",
-- "great, talk next week", an automated Upwork notice — the meter counts all of
-- them, and a board full of waits nobody intends to answer is how the ramp stops
-- being believed. That is the failure mode this whole feature was built to avoid,
-- so it needs a way out.
--
-- The dangerous way to build this is a boolean: mark the room resolved and hide
-- the timer. Then the client writes again three days later with something urgent,
-- the flag is still set, and the conversation stays silent forever. A dismissal
-- that outlives its reason is worse than no dismissal.
--
-- So the waiver is pinned to the MESSAGE it was granted for. waived_for stores the
-- awaiting_since it applied to, and the wait is suppressed only while the two
-- still match. A new inbound message moves awaiting_since, the waiver stops
-- matching, and the timer comes back by itself — no expiry job, no cleanup, and
-- nothing to remember.
-- ============================================================================

alter table public.room_reply_state
  add column if not exists waived_for timestamptz,
  add column if not exists waived_by  uuid references public.app_users(id) on delete set null,
  add column if not exists waived_at  timestamptz;

comment on column public.room_reply_state.waived_for is
  'The awaiting_since this waiver was granted for. The wait is hidden only while the two match, so a newer client message automatically revives the timer.';

-- ---------------------------------------------------------------------------
-- The meter reports the waiver rather than hiding it
-- ---------------------------------------------------------------------------
-- awaiting_reply stays TRUTHFUL: the client did speak last, and pretending
-- otherwise would make the database disagree with itself. The view reports the
-- waiver as its own fact and src/lib/wait.ts decides what the interface does
-- with it — the same split as the severity ramp, which is computed there because
-- it discounts overnight hours.
drop view if exists public.v_room_wait;

create view public.v_room_wait as
  select
    s.room_id,
    s.awaiting_since                                   as last_inbound_at,
    s.last_outbound_at,
    s.message_count,
    (s.awaiting_since is not null)                      as awaiting_reply,
    s.awaiting_since                                    as waiting_since,
    s.attribution                                       as waiting_source,
    s.all_unknown                                       as direction_unknown,
    s.observed_at,
    -- Only a waiver still pinned to the current unanswered message counts.
    (
      s.awaiting_since is not null
      and s.waived_for is not null
      and s.waived_for = s.awaiting_since
    )                                                   as waived,
    s.waived_by,
    s.waived_at
  from public.room_reply_state s
  where public.can_see_target('room', s.room_id);

comment on view public.v_room_wait is
  'Per-room reply state for the wait meter, scoped to rooms the caller can see. Severity and the effect of a waiver are computed in src/lib/wait.ts.';

grant select on public.v_room_wait to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Granting and revoking a waiver
-- ---------------------------------------------------------------------------
-- A function rather than an RLS policy because the rule is per-COLUMN — anyone
-- who can see a conversation may waive its timer, but nobody may hand-edit
-- awaiting_since or the attribution, which are derived from Upwork data. RLS
-- grants or denies whole rows, so the narrow permission has to live here.
--
-- SECURITY DEFINER, so it checks can_see_target() itself rather than relying on
-- privileges it has deliberately bypassed.
create or replace function public.waive_room_reply(p_room_id text, p_waive boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_awaiting timestamptz;
begin
  if not public.can_see_target('room', p_room_id) then
    raise exception 'no access to this conversation' using errcode = '42501';
  end if;

  select awaiting_since into v_awaiting
  from public.room_reply_state where room_id = p_room_id;

  if v_awaiting is null then
    -- Nothing is waiting, so there is nothing to waive. Not an error: two people
    -- clicking at once, or a reply landing first, should not raise.
    return false;
  end if;

  if p_waive then
    update public.room_reply_state
      set waived_for = v_awaiting,
          waived_by  = auth.uid(),
          waived_at  = now()
      where room_id = p_room_id;
  else
    update public.room_reply_state
      set waived_for = null, waived_by = null, waived_at = null
      where room_id = p_room_id;
  end if;

  return p_waive;
end;
$$;

comment on function public.waive_room_reply is
  'Mark a conversation as not needing a reply, or undo that. Pinned to the current unanswered message, so a newer one revives the timer on its own.';

revoke all on function public.waive_room_reply(text, boolean) from public;
grant execute on function public.waive_room_reply(text, boolean) to authenticated, service_role;
