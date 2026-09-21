-- ============================================================================
-- 02-auth-helpers.sql — applied AFTER GoTrue has created auth.users
-- ============================================================================
-- auth.uid() is a Supabase convention, not something GoTrue ships. PostgREST
-- puts the verified JWT claims into request settings; this reads the subject
-- out of them. Every RLS policy in supabase/migrations depends on it.
-- ============================================================================

\set ON_ERROR_STOP on

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    -- PostgREST >= 9 exposes the whole claims object
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    -- older/simpler deployments expose individual claims
    nullif(current_setting('request.jwt.claim.sub', true), '')
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    nullif(current_setting('request.jwt.claim.email', true), '')
  );
$$;

grant execute on function auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;

-- The portal's trigger on auth.users runs as its definer (postgres), but the
-- API roles still need to read the table for joins and admin listings.
grant select on auth.users to anon, authenticated, service_role;

-- GoTrue creates tables as supabase_auth_admin after this file first runs, so
-- re-running it later picks up anything new.
do $$
begin
  execute 'grant select on all tables in schema auth to service_role';
exception when others then
  raise notice 'auth schema grants skipped: %', sqlerrm;
end$$;
