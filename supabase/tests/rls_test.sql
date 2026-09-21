-- Behavioural tests for roles, RLS and the TTL/budget helpers.
-- Run against a throwaway Postgres with the Supabase auth shim: see
-- scripts/test-db.sh, or the "Verifying the schema" section of the README.
\set ON_ERROR_STOP on
\pset pager off

create or replace function pg_temp.check(label text, got anyelement, want anyelement)
returns void language plpgsql as $$
begin
  if got is not distinct from want then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  % (got %, want %)', label, got, want;
  end if;
end$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111','owner@agency.com','{"full_name":"Ada Owner"}'),
  ('22222222-2222-2222-2222-222222222222','bidder@agency.com','{"full_name":"Bo Bidder"}'),
  ('33333333-3333-3333-3333-333333333333','mgr@agency.com','{"full_name":"Cy Manager"}');

select pg_temp.check('first signup becomes owner',
  (select role::text from public.app_users where email='owner@agency.com'), 'owner');
select pg_temp.check('later signups become bidder',
  (select role::text from public.app_users where email='bidder@agency.com'), 'bidder');

-- runs as postgres, i.e. the service-side path
update public.app_users set role='manager' where email='mgr@agency.com';
select pg_temp.check('service-side role repair allowed',
  (select role::text from public.app_users where email='mgr@agency.com'), 'manager');

insert into public.up_rooms (room_id, org_uid, room_name) values
  ('room_bo','org1','Client A'), ('room_free','org1','Client B'), ('room_ada','org1','Client C');
insert into public.assignments (target_type, target_id, assigned_to, assigned_by) values
  ('room','room_bo','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111'),
  ('room','room_ada','11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111');
insert into public.upwork_connections
  (user_id, upwork_user_id, org_uid, access_token_ct, access_token_iv, access_token_tag,
   refresh_token_ct, refresh_token_iv, refresh_token_tag)
values ('11111111-1111-1111-1111-111111111111','up_1','org1','ct','iv','tag','ct','iv','tag');

-- ---------------------------------------------------------------- as bidder
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select pg_temp.check('bidder sees assigned + unassigned rooms only',
  (select count(*) from public.up_rooms), 2::bigint);
select pg_temp.check('bidder cannot read the token vault',
  (select count(*) from public.upwork_connections), 0::bigint);
select pg_temp.check('bidder sees only their own assignment',
  (select count(*) from public.assignments), 1::bigint);

do $$ begin
  update public.app_users set role='owner' where id=auth.uid();
  raise exception 'FAIL  bidder self-promotion was NOT blocked';
exception when sqlstate 'P0001' then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'PASS  bidder self-promotion blocked (%)', sqlerrm;
end $$;

update public.app_users set full_name='Bo Renamed' where id=auth.uid();
select pg_temp.check('bidder may edit own profile',
  (select full_name from public.app_users where id=auth.uid()), 'Bo Renamed');
reset role;

-- --------------------------------------------------------------- as manager
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.check('manager sees every room', (select count(*) from public.up_rooms), 3::bigint);
select pg_temp.check('manager is staff', public.is_staff(), true);
select pg_temp.check('manager is not owner', public.is_owner(), false);

-- A manager's UPDATE matches no rows under RLS (neither the self policy nor the
-- owner policy applies), so this is a silent no-op rather than an exception —
-- the trigger never even fires. What matters is that nothing changed.
with attempt as (
  update public.app_users set role='bidder' where email='owner@agency.com' returning 1
)
select pg_temp.check('manager role change affects no rows',
  (select count(*) from attempt), 0::bigint);
select pg_temp.check('owner still owner after manager attempt',
  (select role::text from public.app_users where email='owner@agency.com'), 'owner');
reset role;

-- ----------------------------------------------------------------- as owner
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('owner sees every room', (select count(*) from public.up_rooms), 3::bigint);

do $$ begin
  update public.app_users set role='bidder' where id=auth.uid();
  raise exception 'FAIL  last-owner demotion was NOT blocked';
exception when sqlstate 'P0001' then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'PASS  last owner cannot demote themselves (%)', sqlerrm;
end $$;
reset role;

-- ------------------------------------------------------------ team_lead role
insert into auth.users (id, email, raw_user_meta_data) values
  ('44444444-4444-4444-4444-444444444444','lead@agency.com','{"full_name":"Dee Lead"}');
update public.app_users set role='team_lead' where email='lead@agency.com';

insert into public.up_jobs (job_id, title) values ('job_1', 'Test job');
insert into public.up_contracts (contract_id, org_uid, title) values ('c_1','org1','Test contract');

set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';

-- Strictly assigned-only: not the unassigned room, not anyone else's.
select pg_temp.check('team_lead inbox scope is assigned-only',
  public.inbox_scope(), 'assigned');
select pg_temp.check('team_lead with nothing assigned sees NO rooms',
  (select count(*) from public.up_rooms), 0::bigint);
select pg_temp.check('team_lead cannot read all conversations',
  public.can_read_all_conversations(), false);
reset role;

-- Assign one room to the lead, and only that room becomes visible.
insert into public.assignments (target_type, target_id, assigned_to, assigned_by)
values ('room','room_free','44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111');

set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('team_lead sees exactly the one room assigned to them',
  (select count(*) from public.up_rooms), 1::bigint);
select pg_temp.check('…and it is the right one',
  (select room_id from public.up_rooms), 'room_free');
select pg_temp.check('team_lead still cannot see an unassigned room',
  (select count(*) from public.up_rooms where room_id = 'room_ada'), 0::bigint);

-- …but LESS than a manager everywhere else.
select pg_temp.check('team_lead is NOT staff', public.is_staff(), false);
select pg_temp.check('team_lead cannot use delivery data',
  public.can_use_delivery_data(), false);
select pg_temp.check('team_lead sees no jobs',
  (select count(*) from public.up_jobs), 0::bigint);
select pg_temp.check('team_lead sees no contracts',
  (select count(*) from public.up_contracts), 0::bigint);
select pg_temp.check('team_lead cannot read the token vault',
  (select count(*) from public.upwork_connections), 0::bigint);
select pg_temp.check('team_lead cannot read the budget ledger',
  (select count(*) from public.sync_budget), 0::bigint);

do $$ begin
  update public.app_users set role='owner' where id=auth.uid();
  raise exception 'FAIL  team_lead self-promotion was NOT blocked';
exception when sqlstate 'P0001' then
  if sqlerrm like 'FAIL%' then raise; end if;
  raise notice 'PASS  team_lead self-promotion blocked (%)', sqlerrm;
end $$;

-- Assignment writes are staff-only. Unlike a filtered UPDATE (which silently
-- matches zero rows), a blocked INSERT violates the policy's WITH CHECK and
-- raises — so expect an exception, not a no-op.
do $$ begin
  insert into public.assignments (target_type, target_id, assigned_to)
  values ('room','room_ada','44444444-4444-4444-4444-444444444444');
  raise exception 'FAIL  team_lead assignment write was NOT blocked';
exception
  when insufficient_privilege or check_violation then
    raise notice 'PASS  team_lead cannot assign rooms (%)', sqlerrm;
  when sqlstate 'P0001' then
    raise;  -- our own FAIL above
  when others then
    -- RLS INSERT denials surface as 42501; accept any denial but name it.
    raise notice 'PASS  team_lead cannot assign rooms (% / %)', sqlstate, sqlerrm;
end $$;
reset role;

-- A bidder is still scoped to their own work.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update public.app_users set role='bidder' where id='22222222-2222-2222-2222-222222222222';
reset role;
update public.app_users set role='bidder' where id='22222222-2222-2222-2222-222222222222';
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
-- room_free was just assigned to the team lead, so it is no longer unclaimed:
-- the bidder is left with only their own room_bo.
select pg_temp.check('bidder sees their own room once nothing is unclaimed',
  (select count(*) from public.up_rooms), 1::bigint);
select pg_temp.check('bidder CAN use delivery data',
  public.can_use_delivery_data(), true);
reset role;

-- ------------------------------------------- central profiles + grants
-- The agency's Upwork profiles belong to the PORTAL. Members are granted a
-- whole profile or a single chat, and never authenticate to Upwork themselves.
insert into public.upwork_profiles
  (id, label, upwork_user_id, org_uid,
   access_token_ct, access_token_iv, access_token_tag,
   refresh_token_ct, refresh_token_iv, refresh_token_tag)
values
  ('aaaaaaaa-0000-0000-0000-000000000001','Gayatri','up_g','org1','c','i','t','c','i','t'),
  ('aaaaaaaa-0000-0000-0000-000000000002','Shivam','up_s','org1','c','i','t','c','i','t');

-- Gayatri's profile reaches room_ada; Shivam's reaches room_bo.
insert into public.room_profiles (room_id, profile_id) values
  ('room_ada','aaaaaaaa-0000-0000-0000-000000000001'),
  ('room_bo','aaaaaaaa-0000-0000-0000-000000000002');

select pg_temp.check('a member with no grant cannot reach a room',
  public.has_room_grant('room_ada','44444444-4444-4444-4444-444444444444'), false);

-- Grant the lead the whole Gayatri profile.
insert into public.profile_grants (profile_id, user_id, can_send)
values ('aaaaaaaa-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444', true);

select pg_temp.check('profile grant reaches that profile''s rooms',
  public.has_room_grant('room_ada','44444444-4444-4444-4444-444444444444'), true);
select pg_temp.check('profile grant does NOT reach another profile''s rooms',
  public.has_room_grant('room_bo','44444444-4444-4444-4444-444444444444'), false);
select pg_temp.check('the grant resolves to the right profile',
  (select profile_id::text from public.profiles_for_room('room_ada','44444444-4444-4444-4444-444444444444')),
  'aaaaaaaa-0000-0000-0000-000000000001');

-- Grant a single chat from a different profile.
insert into public.room_grants (room_id, user_id, profile_id, can_send)
values ('room_bo','44444444-4444-4444-4444-444444444444',
        'aaaaaaaa-0000-0000-0000-000000000002', false);

select pg_temp.check('a per-chat grant reaches just that chat',
  public.has_room_grant('room_bo','44444444-4444-4444-4444-444444444444'), true);
select pg_temp.check('a read-only chat grant does not permit sending',
  (select can_send from public.profiles_for_room('room_bo','44444444-4444-4444-4444-444444444444')),
  false);

-- The participant view now derives from grants, and is scoped to rooms the
-- CALLER can see — so it needs a session, and returns nothing without one.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('participant view names the member who can reply',
  (select count(*) from public.v_room_participants
    where room_id='room_ada'
      and user_id='44444444-4444-4444-4444-444444444444'), 1::bigint);

-- The participant view must show BOTH kinds of grant.
--
-- It only ever joined profile_grants, so anyone given a single conversation was
-- invisible in "Who can see this chat" — and because the thread derives canSend
-- from this view, they could not reply to a chat the database had granted them.
-- The suite passed throughout, because every earlier assertion used a member who
-- also held a profile grant.
select pg_temp.check('a member holding only a per-chat grant appears as a participant',
  (select count(*) from public.v_room_participants
   where room_id = 'room_bo' and user_id = '44444444-4444-4444-4444-444444444444'),
  1::bigint);

-- …and the grant's own can_send is what governs, not the profile's.
select pg_temp.check('a read-only chat grant shows as read-only in the view',
  (select bool_and(can_send) from public.v_room_participants
   where room_id = 'room_bo' and user_id = '44444444-4444-4444-4444-444444444444'),
  false);

reset role;
-- `reset role` does NOT clear request.jwt.claim.sub, so auth.uid() would still
-- return the last user. Clear the claim to genuinely test "no session".
set request.jwt.claim.sub = '';
select pg_temp.check('participant view leaks nothing without a session',
  (select count(*) from public.v_room_participants), 0::bigint);

-- A granted chat is visible even though the lead is scoped to assigned-only.
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('a granted chat becomes visible despite assigned-only scope',
  (select count(*) from public.up_rooms where room_id='room_ada'), 1::bigint);
reset role;

-- Approval is OPT-IN as of 0025. The old default was ON, which meant every
-- profile blocked every reply from anyone but its holder — the review step
-- prevented the work the portal exists to do. The access decision is
-- profile_grants.can_send; this is a review preference on top of it.
select pg_temp.check('new profiles do NOT require approval — it is opt-in per profile',
  (select bool_or(send_requires_approval) from public.upwork_profiles), false);

-- And it can still be turned on where an owner wants it, which is the whole
-- point of it being per profile rather than a global setting.
do $$
declare v_id uuid;
begin
  select id into v_id from public.upwork_profiles limit 1;
  update public.upwork_profiles set send_requires_approval = true where id = v_id;
end$$;
select pg_temp.check('approval can be switched on for one profile',
  (select count(*) from public.upwork_profiles where send_requires_approval), 1::bigint);
update public.upwork_profiles set send_requires_approval = false;

-- --------------------------------------------------- member deactivation
-- The lead currently holds a profile grant and a per-chat grant.
select pg_temp.check('active member resolves their grants',
  public.has_room_grant('room_ada','44444444-4444-4444-4444-444444444444'), true);

-- Deactivating must remove access at the DATABASE layer, not just at login.
update public.app_users set is_active = false
  where id = '44444444-4444-4444-4444-444444444444';

select pg_temp.check('a deactivated member resolves NO grants',
  public.has_room_grant('room_ada','44444444-4444-4444-4444-444444444444'), false);
select pg_temp.check('…and none via a per-chat grant either',
  public.has_room_grant('room_bo','44444444-4444-4444-4444-444444444444'), false);

-- revoke_member_access strips the rows outright.
select public.revoke_member_access('44444444-4444-4444-4444-444444444444');
select pg_temp.check('revoke_member_access clears profile grants',
  (select count(*) from public.profile_grants
    where user_id='44444444-4444-4444-4444-444444444444'), 0::bigint);
select pg_temp.check('revoke_member_access clears chat grants',
  (select count(*) from public.room_grants
    where user_id='44444444-4444-4444-4444-444444444444'), 0::bigint);
select pg_temp.check('revoke_member_access clears assignments',
  (select count(*) from public.assignments
    where assigned_to='44444444-4444-4444-4444-444444444444'), 0::bigint);

update public.app_users set is_active = true
  where id = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('reactivating does NOT restore removed grants',
  public.has_room_grant('room_ada','44444444-4444-4444-4444-444444444444'), false);

-- ------------------------------------------- scoped profile + activity visibility
-- The deactivation block above stripped this lead's grants, so re-grant one
-- profile: the point here is what a member with ONE grant can see.
insert into public.profile_grants (profile_id, user_id, can_send)
values ('aaaaaaaa-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444', true)
on conflict (profile_id, user_id) do update set can_send = true;

-- A lead granted one profile must not learn that the others exist.
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('lead sees only profiles they hold',
  (select count(*) from public.visible_profile_ids()), 1::bigint);
select pg_temp.check('…and the filter lists only that one',
  (select count(*) from public.v_profile_room_counts), 1::bigint);
reset role;

-- A manager runs the estate and sees every profile.
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.check('manager sees every profile',
  (select count(*) from public.visible_profile_ids()), 2::bigint);
reset role;

-- Activity follows seniority.
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.check('lead sees their own activity',
  public.can_see_activity_of('44444444-4444-4444-4444-444444444444'), true);
select pg_temp.check('lead cannot see the owner''s activity',
  public.can_see_activity_of('11111111-1111-1111-1111-111111111111'), false);
select pg_temp.check('lead cannot see a bidder''s activity',
  public.can_see_activity_of('22222222-2222-2222-2222-222222222222'), false);
select pg_temp.check('lead cannot see system activity',
  public.can_see_activity_of(null), false);
reset role;

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.check('manager sees a lead''s activity',
  public.can_see_activity_of('44444444-4444-4444-4444-444444444444'), true);
select pg_temp.check('manager sees system activity',
  public.can_see_activity_of(null), true);
select pg_temp.check('manager cannot see the owner''s activity',
  public.can_see_activity_of('11111111-1111-1111-1111-111111111111'), false);
reset role;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('owner sees everyone''s activity',
  public.can_see_activity_of('44444444-4444-4444-4444-444444444444'), true);
select pg_temp.check('owner sees system activity',
  public.can_see_activity_of(null), true);
reset role;

-- ------------------------------------------------------- TTL + budget ledger
update public.up_rooms set fetched_at = now() - interval '30 hours' where room_id='room_free';
select pg_temp.check('expire_upwork_mirror drops rows past the 24h ToS ceiling',
  (select deleted from public.expire_upwork_mirror() where table_name='up_rooms'), 1::bigint);

select pg_temp.check('sync_budget_today starts at zero', public.sync_budget_today(), 0);
select pg_temp.check('bump_sync_budget accumulates',
  public.bump_sync_budget('rooms.list', 5), 5);
select pg_temp.check('bump_sync_budget sums across endpoints',
  public.bump_sync_budget('messages.list', 3), 8);
select pg_temp.check('sync_budget_today reads without incrementing',
  public.sync_budget_today(), 8);
select pg_temp.check('sync_budget_today is still 8 on a second read',
  public.sync_budget_today(), 8);

-- ---------------------------------------------------- circuit breaker fields
update public.upwork_connections
  set consecutive_failures = 3,
      circuit_open_until = now() + interval '5 minutes'
  where user_id = '11111111-1111-1111-1111-111111111111';

select pg_temp.check('health view counts open circuits',
  (select connections_circuit_open from public.v_upwork_health), 1::bigint);
select pg_temp.check('health view counts active connections',
  (select connections_active from public.v_upwork_health), 1::bigint);

-- ------------------------------------------------- nothing is public (0020)
-- The generic net. Four views were readable by anyone with the anon key because
-- a view reads its base tables with the OWNER's privileges, so the RLS policies
-- on those tables never applied: v_activity exposed the whole audit trail,
-- v_connection_status every member's email, v_profiles the connected Upwork
-- accounts, v_upwork_health the request counters.
--
-- Written as a loop over pg_views rather than one assertion per view, so a view
-- added next year is covered without anyone remembering to extend this file.
do $$
declare
  v record;
  n bigint;
  leaked text[] := '{}';
begin
  -- No session, no claim: exactly what an unauthenticated request looks like.
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;

  for v in select viewname from pg_views where schemaname = 'public' order by viewname loop
    execute format('select count(*) from public.%I', v.viewname) into n;
    if n > 0 then
      leaked := leaked || format('%s (%s rows)', v.viewname, n);
    end if;
  end loop;

  reset role;

  if array_length(leaked, 1) > 0 then
    raise exception 'readable without authentication: %', array_to_string(leaked, ', ');
  end if;

  raise notice 'PASS  no view is readable without authentication';
end$$;

-- And the same for tables, which were already sound — asserted so they stay so.
do $$
declare
  t record;
  n bigint;
  leaked text[] := '{}';
begin
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;

  for t in
    select tablename from pg_tables
    where schemaname = 'public' and rowsecurity
    order by tablename
  loop
    execute format('select count(*) from public.%I', t.tablename) into n;
    if n > 0 then
      leaked := leaked || format('%s (%s rows)', t.tablename, n);
    end if;
  end loop;

  reset role;

  if array_length(leaked, 1) > 0 then
    raise exception 'readable without authentication: %', array_to_string(leaked, ', ');
  end if;

  raise notice 'PASS  no RLS table is readable without authentication';
end$$;

-- v_profiles and v_upwork_health are staff-only now; prove a lead cannot read
-- them, and that an owner still can.
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
set role authenticated;
select pg_temp.check('a team lead cannot enumerate the agency profiles',
  (select count(*) from public.v_profiles), 0::bigint);
select pg_temp.check('a team lead cannot read operational counters',
  (select count(*) from public.v_upwork_health), 0::bigint);
reset role;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set role authenticated;
select pg_temp.check('an owner still sees the agency profiles',
  (select count(*) > 0 from public.v_profiles), true);
select pg_temp.check('an owner still sees operational counters',
  (select count(*) from public.v_upwork_health), 1::bigint);
reset role;

-- ------------------------------------- staff-only views and the service role
-- The service role has no auth.uid(), so is_staff() is false for it and the
-- staff-only views return NOTHING. That is correct and deliberate — but it means
-- a page reading them through the admin client sees zero rows and renders an
-- empty state, which is how "no profiles connected" appeared on a portal holding
-- four of them.
--
-- Asserted here so the behaviour is documented rather than surprising. The fix is
-- for pages to read these views with the MEMBER's client and let RLS decide, not
-- to add a service-role bypass to the view.
set request.jwt.claim.sub = '';
set role service_role;
select pg_temp.check('service role reads no rows from v_profiles — pages must use the member client',
  (select count(*) from public.v_profiles), 0::bigint);
select pg_temp.check('service role reads no rows from v_upwork_health',
  (select count(*) from public.v_upwork_health), 0::bigint);
reset role;

\echo ''
\echo 'All checks passed.'
