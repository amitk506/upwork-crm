-- ============================================================================
-- 0007_team_lead_role.sql — the team_lead role, and capability-based access
-- ============================================================================
-- A team lead sees EVERY conversation and can reply, but has no administrative
-- access: no roster, no role changes, no jobs, no milestones, no ops.
--
-- That does not fit a linear hierarchy — a team lead outranks a bidder on
-- conversation visibility while ranking below a manager on everything else. So
-- the checks below are named after what they permit rather than who holds them.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that creates
-- it, which is why this runs as separate autocommitted statements (psql without
-- --single-transaction). Keep the ADD VALUE first.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'app_role' and e.enumlabel = 'team_lead'
  ) then
    alter type public.app_role add value 'team_lead' after 'manager';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- Capability predicates
-- ---------------------------------------------------------------------------

-- Sees every conversation in the agency inbox.
create or replace function public.can_read_all_conversations()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.app_user_role() in ('owner', 'manager', 'team_lead'), false);
$$;

comment on function public.can_read_all_conversations is
  'Full inbox visibility: owner, manager, team_lead. A bidder sees only assigned or unassigned rooms.';

-- Jobs, contracts and milestones. A team lead is deliberately excluded — their
-- remit is conversations only.
create or replace function public.can_use_delivery_data()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.app_user_role() in ('owner', 'manager', 'bidder'), false);
$$;

-- is_staff() keeps its original meaning: administrative access. team_lead is
-- NOT staff, so assignment writes, the budget ledger and the full audit trail
-- stay closed to them.

-- ---------------------------------------------------------------------------
-- Room visibility now keys off the capability, not the staff flag
-- ---------------------------------------------------------------------------
create or replace function public.can_see_target(p_type public.assignment_target, p_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.can_read_all_conversations()
    or not exists (
      select 1 from public.assignments a
      where a.target_type = p_type and a.target_id = p_id
    )
    or exists (
      select 1 from public.assignments a
      where a.target_type = p_type and a.target_id = p_id and a.assigned_to = auth.uid()
    );
$$;

-- ---------------------------------------------------------------------------
-- Delivery data is no longer readable by everyone
-- ---------------------------------------------------------------------------
-- Previously `using (true)`, which would have let a team lead read jobs and
-- contracts through the API even with the nav hidden. Enforced in the database
-- so the UI is not the only thing standing in the way.
drop policy if exists up_jobs_select on public.up_jobs;
create policy up_jobs_select on public.up_jobs
  for select to authenticated using (public.can_use_delivery_data());

drop policy if exists up_contracts_select on public.up_contracts;
create policy up_contracts_select on public.up_contracts
  for select to authenticated using (public.can_use_delivery_data());

drop policy if exists up_milestones_select on public.up_milestones;
create policy up_milestones_select on public.up_milestones
  for select to authenticated using (public.can_use_delivery_data());

drop policy if exists job_scores_select on public.job_scores;
create policy job_scores_select on public.job_scores
  for select to authenticated using (public.can_use_delivery_data());

-- A team lead has no business reading proposal drafts either.
drop policy if exists proposal_drafts_select on public.proposal_drafts;
create policy proposal_drafts_select on public.proposal_drafts
  for select to authenticated
  using ((public.is_staff() or author_id = auth.uid()) and public.can_use_delivery_data());
