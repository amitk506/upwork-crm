-- ============================================================================
-- 0004_rls.sql — Row Level Security
-- ============================================================================
-- Model:
--   owner   — everything, plus the only role that can change roles
--   manager — reads all agency data, assigns work, cannot change roles
--   bidder  — reads what is assigned to them + anything unassigned
--
-- The token vault (upwork_connections) gets RLS enabled and NO policies at
-- all, which denies every authenticated client. Only the service_role key —
-- held server-side, never shipped to the browser — bypasses RLS to reach it.
-- ============================================================================

alter table public.app_users          enable row level security;
alter table public.upwork_connections enable row level security;
alter table public.assignments        enable row level security;
alter table public.internal_notes     enable row level security;
alter table public.job_scores         enable row level security;
alter table public.proposal_drafts    enable row level security;
alter table public.activity_log       enable row level security;
alter table public.sync_budget        enable row level security;
alter table public.up_rooms           enable row level security;
alter table public.up_messages        enable row level security;
alter table public.up_jobs            enable row level security;
alter table public.up_contracts       enable row level security;
alter table public.up_milestones      enable row level security;

-- ---------------------------------------------------------------------------
-- app_users
-- ---------------------------------------------------------------------------
-- Everyone in the agency can see the roster (needed to render assignee names).
drop policy if exists app_users_select on public.app_users;
create policy app_users_select on public.app_users
  for select to authenticated
  using (true);

-- You may edit your own profile. The role column is protected by the trigger
-- below, so this cannot be used to self-promote.
drop policy if exists app_users_update_self on public.app_users;
create policy app_users_update_self on public.app_users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists app_users_update_owner on public.app_users;
create policy app_users_update_owner on public.app_users
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- Belt and braces: only an owner may change role or is_active, and an owner
-- may not demote themselves if they are the last one standing.
-- Deliberately SECURITY INVOKER (the default): inside a SECURITY DEFINER
-- function current_user resolves to the function's OWNER, not the caller, so
-- the service-role check below would match for everyone and wave through every
-- role change. It needs no elevated rights anyway — is_owner() is already
-- SECURITY DEFINER, and app_users is readable by all authenticated users.
create or replace function public.guard_role_changes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Server-side roles bypass the guard. service_role is never exposed to the
  -- browser, and without this an agency whose only owner loses access could
  -- not be repaired by anyone, including an admin script.
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if (new.role is distinct from old.role) or (new.is_active is distinct from old.is_active) then
    if not public.is_owner() then
      raise exception 'Only an owner can change roles or deactivate members';
    end if;

    if old.role = 'owner' and new.role <> 'owner'
       and (select count(*) from public.app_users where role = 'owner' and is_active) <= 1 then
      raise exception 'Cannot demote the last remaining owner';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists app_users_guard_role on public.app_users;
create trigger app_users_guard_role
  before update on public.app_users
  for each row execute function public.guard_role_changes();

-- ---------------------------------------------------------------------------
-- upwork_connections — intentionally NO policies. service_role only.
-- ---------------------------------------------------------------------------
-- Read connection state through v_connection_status instead, which exposes no
-- ciphertext. (Views run with the definer's rights, so it stays readable.)

-- ---------------------------------------------------------------------------
-- Zone 1 mirror — read-only to clients; only the worker (service_role) writes.
-- ---------------------------------------------------------------------------
drop policy if exists up_rooms_select on public.up_rooms;
create policy up_rooms_select on public.up_rooms
  for select to authenticated
  using (public.can_see_target('room', room_id));

drop policy if exists up_messages_select on public.up_messages;
create policy up_messages_select on public.up_messages
  for select to authenticated
  using (public.can_see_target('room', room_id));

-- Jobs, contracts and milestones are agency-wide context: visible to all staff
-- roles including bidders, since they need them to bid and to track their work.
drop policy if exists up_jobs_select on public.up_jobs;
create policy up_jobs_select on public.up_jobs
  for select to authenticated using (true);

drop policy if exists up_contracts_select on public.up_contracts;
create policy up_contracts_select on public.up_contracts
  for select to authenticated using (true);

drop policy if exists up_milestones_select on public.up_milestones;
create policy up_milestones_select on public.up_milestones
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- assignments
-- ---------------------------------------------------------------------------
drop policy if exists assignments_select on public.assignments;
create policy assignments_select on public.assignments
  for select to authenticated
  using (public.is_staff() or assigned_to = auth.uid());

-- Only owners/managers hand out work.
drop policy if exists assignments_write on public.assignments;
create policy assignments_write on public.assignments
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- internal_notes
-- ---------------------------------------------------------------------------
drop policy if exists internal_notes_select on public.internal_notes;
create policy internal_notes_select on public.internal_notes
  for select to authenticated
  using (public.can_see_target(target_type, target_id));

drop policy if exists internal_notes_insert on public.internal_notes;
create policy internal_notes_insert on public.internal_notes
  for insert to authenticated
  with check (author_id = auth.uid() and public.can_see_target(target_type, target_id));

-- Authors edit their own notes; owners can clean up anything.
drop policy if exists internal_notes_update on public.internal_notes;
create policy internal_notes_update on public.internal_notes
  for update to authenticated
  using (author_id = auth.uid() or public.is_owner())
  with check (author_id = auth.uid() or public.is_owner());

drop policy if exists internal_notes_delete on public.internal_notes;
create policy internal_notes_delete on public.internal_notes
  for delete to authenticated
  using (author_id = auth.uid() or public.is_owner());

-- ---------------------------------------------------------------------------
-- job_scores — readable by all, written by the worker
-- ---------------------------------------------------------------------------
drop policy if exists job_scores_select on public.job_scores;
create policy job_scores_select on public.job_scores
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- proposal_drafts
-- ---------------------------------------------------------------------------
drop policy if exists proposal_drafts_select on public.proposal_drafts;
create policy proposal_drafts_select on public.proposal_drafts
  for select to authenticated
  using (public.is_staff() or author_id = auth.uid());

drop policy if exists proposal_drafts_insert on public.proposal_drafts;
create policy proposal_drafts_insert on public.proposal_drafts
  for insert to authenticated
  with check (author_id = auth.uid());

-- A submitted draft is a historical record — freeze it.
drop policy if exists proposal_drafts_update on public.proposal_drafts;
create policy proposal_drafts_update on public.proposal_drafts
  for update to authenticated
  using ((author_id = auth.uid() or public.is_staff()) and status <> 'submitted')
  with check (author_id = auth.uid() or public.is_staff());

drop policy if exists proposal_drafts_delete on public.proposal_drafts;
create policy proposal_drafts_delete on public.proposal_drafts
  for delete to authenticated
  using (author_id = auth.uid() and status = 'draft');

-- ---------------------------------------------------------------------------
-- activity_log — append-only from the client's point of view.
-- ---------------------------------------------------------------------------
-- Staff read everything; a bidder reads only their own actions. No update or
-- delete policy exists for anyone, so the trail cannot be rewritten.
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log
  for select to authenticated
  using (public.is_staff() or actor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- sync_budget — operational visibility for staff only
-- ---------------------------------------------------------------------------
drop policy if exists sync_budget_select on public.sync_budget;
create policy sync_budget_select on public.sync_budget
  for select to authenticated
  using (public.is_staff());
