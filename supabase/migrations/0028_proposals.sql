-- ============================================================================
-- 0028_proposals.sql — the only bridge from a conversation to a job post
-- ============================================================================
-- A room from Upwork carries exactly this and nothing more:
--
--   id, roomName, topic, numUsers, numUnread, favorite,
--   createdAtDateTime, lastVisitedDateTime, latestStory
--
-- No job id, no contract id. So "what was this client's job post" cannot be
-- answered from the conversation itself. What CAN answer it is a proposal:
-- list_freelancer_proposals returns marketplaceJobPosting with the posting's id
-- and title, alongside what we bid and where the proposal stands.
--
-- The join is on TITLE, because Upwork exposes no shared key — room.topic is the
-- job title. That is reliable where a title is distinctive and ambiguous where it
-- is not (six rooms here share the topic "SEO Specialist"), so the matcher in
-- src/lib/upwork/job-match.ts only reports a match when exactly one proposal
-- fits, and the interface says nothing rather than guessing.
--
-- ZONE 1: this is Upwork's data, so it carries fetched_at and expires with the
-- rest of the mirror under their 24-hour caching rule.
-- ============================================================================

create table if not exists public.up_proposals (
  proposal_id   text        primary key,
  org_uid       text        not null,
  job_id        text,
  job_title     text,
  status        text,
  status_label  text,
  rate_amount   numeric(12,2),
  rate_currency text,
  created_at_upwork timestamptz,
  fetched_at    timestamptz not null default now()
);

create index if not exists up_proposals_title_idx on public.up_proposals (lower(job_title));
create index if not exists up_proposals_fetched_idx on public.up_proposals (fetched_at);

alter table public.up_proposals enable row level security;

-- Readable by anyone signed in: a proposal names a job posting and what we bid,
-- which is agency-wide context rather than per-conversation. It reveals nothing
-- about a conversation the reader cannot already see.
drop policy if exists up_proposals_select on public.up_proposals;
create policy up_proposals_select on public.up_proposals
  for select to authenticated using (true);

grant select on public.up_proposals to authenticated;
grant all on public.up_proposals to service_role;

comment on table public.up_proposals is
  'Proposals we sent and the job postings they were for. Zone 1 cache — expires with the mirror. Matched to conversations by job title, since Upwork exposes no shared id.';

-- expire_upwork_mirror() predates this table, so teach it to sweep here too.
-- Same 24h ceiling as everything else in Zone 1.
create or replace function public.expire_upwork_mirror(p_max_age interval default '24 hours')
returns table (table_name text, deleted bigint)
language plpgsql
as $$
declare
  cutoff timestamptz := now() - p_max_age;
  n bigint;
begin
  delete from public.up_messages where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_messages'; deleted := n; return next;

  delete from public.up_rooms where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_rooms'; deleted := n; return next;

  delete from public.up_jobs where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_jobs'; deleted := n; return next;

  delete from public.up_proposals where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_proposals'; deleted := n; return next;

  delete from public.up_milestones where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_milestones'; deleted := n; return next;

  delete from public.up_contracts where fetched_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'up_contracts'; deleted := n; return next;
end;
$$;
