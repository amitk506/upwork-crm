-- ============================================================================
-- 0008_inbox_scope.sql — three inbox scopes instead of two
-- ============================================================================
-- A team lead handles their own conversations and nothing else, so visibility
-- is no longer a boolean.
--
--   all                     owner, manager  — every conversation
--   assigned_or_unassigned  bidder          — theirs, plus anything unclaimed
--   assigned                team_lead       — strictly what is assigned to them
--
-- Note the operational consequence of 'assigned': a brand new conversation is
-- unassigned, so a team lead cannot see it until someone with a wider scope
-- routes it to them. That is deliberate here, but it means somebody with
-- 'all' has to be watching the unassigned queue.
-- ============================================================================

create or replace function public.inbox_scope()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case public.app_user_role()
    when 'owner'     then 'all'
    when 'manager'   then 'all'
    when 'team_lead' then 'assigned'
    when 'bidder'    then 'assigned_or_unassigned'
    else 'none'
  end;
$$;

comment on function public.inbox_scope is
  'How much of the inbox this user may see: all | assigned_or_unassigned | assigned | none.';

-- Kept for the delivery-data policies, which still key off it.
create or replace function public.can_read_all_conversations()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.inbox_scope() = 'all';
$$;

create or replace function public.can_see_target(p_type public.assignment_target, p_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case public.inbox_scope()
    when 'all' then true

    when 'assigned' then exists (
      select 1 from public.assignments a
      where a.target_type = p_type and a.target_id = p_id and a.assigned_to = auth.uid()
    )

    when 'assigned_or_unassigned' then
      not exists (
        select 1 from public.assignments a
        where a.target_type = p_type and a.target_id = p_id
      )
      or exists (
        select 1 from public.assignments a
        where a.target_type = p_type and a.target_id = p_id and a.assigned_to = auth.uid()
      )

    else false
  end;
$$;

-- A team lead must still be able to see WHO a room is assigned to for their own
-- rooms; assignments_select already covers that via assigned_to = auth.uid().
