-- ============================================================================
-- 0010_outbound_drafts.sql — one teammate writes, the profile owner sends
-- ============================================================================
-- The agency reality: a client contracted with Gayatri, so the thread should
-- carry Gayatri's name — but Vansh does the work and writes the replies.
--
-- The reply is composed by Vansh and queued against a member who is actually a
-- participant in that Upwork conversation. That member approves, and the
-- message goes out from THEIR account, under their name. The client's
-- experience is unchanged.
--
-- The approval click matters: it is the difference between someone sending
-- their own message and someone else operating their account, which Upwork
-- prohibits outright. It is deliberately one click and batchable.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'outbound_draft_status') then
    create type public.outbound_draft_status as enum (
      'pending',    -- waiting on the profile owner
      'approved',   -- sent to Upwork
      'declined',   -- owner rejected it
      'withdrawn'   -- author pulled it back
    );
  end if;
end$$;

create table if not exists public.outbound_drafts (
  id            uuid primary key default gen_random_uuid(),
  room_id       text not null,

  -- who wrote it
  author_id     uuid not null references public.app_users(id) on delete cascade,
  -- whose Upwork profile it should go out from; must be able to act in the room
  owner_id      uuid not null references public.app_users(id) on delete cascade,

  body          text not null check (length(trim(body)) > 0 and length(body) <= 10240),
  status        public.outbound_draft_status not null default 'pending',

  note          text,            -- optional context from the author
  decline_reason text,

  decided_by    uuid references public.app_users(id) on delete set null,
  decided_at    timestamptz,
  sent_at       timestamptz,
  error         text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists outbound_drafts_owner_idx
  on public.outbound_drafts (owner_id, status, created_at desc);
create index if not exists outbound_drafts_room_idx
  on public.outbound_drafts (room_id, created_at desc);
create index if not exists outbound_drafts_author_idx
  on public.outbound_drafts (author_id, status);

drop trigger if exists outbound_drafts_touch on public.outbound_drafts;
create trigger outbound_drafts_touch
  before update on public.outbound_drafts
  for each row execute function public.touch_updated_at();

comment on table public.outbound_drafts is
  'Replies written by one member and sent from another member''s Upwork account after that member approves. The approval is what makes this the owner sending, not account sharing.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.outbound_drafts enable row level security;

-- Visible to the author, the approver, and anyone who can see the conversation.
drop policy if exists outbound_drafts_select on public.outbound_drafts;
create policy outbound_drafts_select on public.outbound_drafts
  for select to authenticated
  using (
    author_id = auth.uid()
    or owner_id = auth.uid()
    or public.can_see_target('room', room_id)
  );

-- Anyone who can see the conversation may draft into it, but only ever in their
-- own name, and only addressed to someone who can actually send there.
drop policy if exists outbound_drafts_insert on public.outbound_drafts;
create policy outbound_drafts_insert on public.outbound_drafts
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.can_see_target('room', room_id)
    and public.can_act_in_room(room_id, owner_id)
  );

-- The author may withdraw their own pending draft; the owner decides on it.
-- Neither may edit a draft that has already been acted on.
drop policy if exists outbound_drafts_update on public.outbound_drafts;
create policy outbound_drafts_update on public.outbound_drafts
  for update to authenticated
  using ((author_id = auth.uid() or owner_id = auth.uid()) and status = 'pending')
  with check (author_id = auth.uid() or owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Pending count, for the nav badge
-- ---------------------------------------------------------------------------
create or replace function public.pending_approvals_for(p_user_id uuid default auth.uid())
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.outbound_drafts
  where owner_id = p_user_id and status = 'pending';
$$;
