-- ============================================================================
-- 0025_approval_opt_in.sql — approval becomes opt-in, not the default
-- ============================================================================
-- send_requires_approval has defaulted TRUE since 0011. That default came from a
-- real concern raised at the time: a team lead working under Gayatri's profile
-- messages the client as Gayatri, so should she not see it first?
--
-- In practice the default inverts what the portal is for. The agency's model is
-- that the team messages on behalf of agency profiles — that IS the intended
-- arrangement, not an exception needing sign-off. With approval on by default,
-- every profile the owner holds blocks every reply from everyone else, so an
-- eleven-person team working four profiles cannot answer a client without the
-- owner clearing a queue. The feature meant to protect the work prevented it.
--
-- The control that actually matters already exists and is narrower:
-- profile_grants.can_send / room_grants.can_send decide who may reply at all,
-- per profile or per conversation. If someone has been granted send on a chat,
-- being told to write a draft instead adds a step without adding a decision.
-- Attribution is not lost either: every outbound message is stamped internally
-- with who typed it and which profile it left under, and the thread shows both.
--
-- So: default FALSE, and the existing profiles are switched off. The mechanism
-- stays, per profile, for the case it is genuinely good at — a new bidder whose
-- first few replies an owner wants to read before they go out.
-- ============================================================================

-- One-shot, guarded on the old default still being in place. Without the guard
-- this would run on every deploy — deploy.sh replays every migration — and would
-- silently switch approval back off for any owner who had deliberately turned it
-- on for a new starter.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'upwork_profiles'
      and column_name = 'send_requires_approval'
      and column_default = 'true'
  ) then
    update public.upwork_profiles set send_requires_approval = false;
    raise notice '0025: approval switched off for existing profiles';
  end if;
end$$;

alter table public.upwork_profiles
  alter column send_requires_approval set default false;

comment on column public.upwork_profiles.send_requires_approval is
  'Opt-in review gate. OFF by default: a grant with can_send is the access decision, and the team messaging under agency profiles is the intended arrangement. Turn ON per profile when an owner wants to read someone''s replies before they go out.';

-- ---------------------------------------------------------------------------
-- The composer needs to know before it offers a Send button
-- ---------------------------------------------------------------------------
-- Until now the flag was only checked inside sendReply(), so the interface showed
-- an enabled "Send reply", took the click, and then refused — presenting a
-- deliberate policy as if it were a failure. Exposing it on the room view lets
-- the thread offer the draft flow up front instead.
--
-- CREATE OR REPLACE can append columns but not reorder them, so this stays at the
-- end of the select list. Scoping is unchanged from 0016: the filter lives in the
-- view because a view reads its base tables as the OWNER.
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
drop view if exists public.v_room_profiles;

create view public.v_room_profiles as
  select
    rp.room_id,
    p.id    as profile_id,
    p.label as profile_label,
    p.org_role,
    rp.last_seen_at,
    p.send_requires_approval
  from public.room_profiles rp
  join public.upwork_profiles p on p.id = rp.profile_id
  where p.revoked_at is null
    and public.can_see_target('room', rp.room_id);

grant select on public.v_room_profiles to authenticated, anon;
