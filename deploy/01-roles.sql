-- ============================================================================
-- 01-roles.sql — Supabase-compatible roles, applied BEFORE GoTrue starts
-- ============================================================================
-- Managed Supabase provisions these for you. Self-hosting means creating them
-- by hand, and getting them right is what makes the RLS policies written for
-- Supabase work unchanged here.
--
--   authenticator        — the role PostgREST connects as; can switch to the
--                          three below and nothing else
--   anon                 — unauthenticated requests
--   authenticated        — a signed-in user (RLS policies target this)
--   service_role         — bypasses RLS; used only by the server
--   supabase_auth_admin  — owns the auth schema, used only by GoTrue
-- ============================================================================

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------------
-- Roles
-- --------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls so the server can reach the token vault, which grants no policies
    create role service_role nologin noinherit bypassrls;
  end if;
end$$;

-- Passwords come from the environment via psql variables.
--
-- These use \gexec rather than a DO block on purpose: psql does NOT substitute
-- :'variables' inside dollar-quoted strings, so `execute format(..., :'pw')`
-- inside DO $$ ... $$ is a syntax error. Building the statement as a value and
-- executing it with \gexec keeps the substitution outside the quoting.
select format('create role authenticator login noinherit password %L', :'authenticator_password')
where not exists (select 1 from pg_roles where rolname = 'authenticator')
\gexec

select format('alter role authenticator password %L', :'authenticator_password')
\gexec

select format('create role supabase_auth_admin login createrole password %L', :'auth_admin_password')
where not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
\gexec

select format('alter role supabase_auth_admin password %L', :'auth_admin_password')
\gexec

grant anon, authenticated, service_role to authenticator;

-- --------------------------------------------------------------------------
-- Auth schema, owned by GoTrue
-- --------------------------------------------------------------------------
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;
alter role supabase_auth_admin set search_path = auth;

-- --------------------------------------------------------------------------
-- Public schema defaults
-- --------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

-- Anything created later in public is reachable by the API roles, mirroring
-- Supabase's default privileges. RLS is what actually restricts access.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
