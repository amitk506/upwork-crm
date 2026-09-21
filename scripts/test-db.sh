#!/usr/bin/env bash
# Apply the migrations to a throwaway Postgres and run the behavioural tests.
#
#   ./scripts/test-db.sh
#
# Supabase provides no local-free way to test RLS, so this stands up plain
# Postgres plus a minimal `auth` shim (auth.users, auth.uid(), the authenticated
# and service_role roles) and mimics Supabase's default grants.
set -euo pipefail

CONTAINER=upwork-portal-test-db
IMAGE=postgres:16-alpine
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "→ starting $IMAGE"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pw "$IMAGE" >/dev/null
# pg_isready reports the server is up during init, before it reliably accepts
# connections — so waiting on it alone made 0001 fail intermittently on a cold
# machine. Wait for a query to actually succeed instead.
ready=""
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  echo "!! postgres never accepted a connection" >&2
  docker logs --tail 30 "$CONTAINER" >&2
  exit 1
fi

psql_run() { docker exec -i "$CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 "$@"; }

echo "→ installing Supabase auth shim"
psql_run <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fn$;
create role authenticated;
create role service_role;
-- anon exists on the real deployment (deploy/01-roles.sql) and is what an
-- unauthenticated PostgREST request runs as. Without it here, the test suite
-- could not check what the public internet can read — which is exactly the gap
-- that let four views leak until 0020.
create role anon;
SQL

# Applied TWICE, on purpose.
#
# deploy.sh replays every migration on every deploy, so the chain has to be
# re-runnable — and it silently was not. 0025 appended a column to a view that
# 0013 recreates, CREATE OR REPLACE VIEW cannot drop a column, and from then on
# every deploy died at 0013. Everything after it stopped being applied, including
# the migration that closes five views to anonymous readers. The deploy reported
# failure, but nothing here would have caught it.
#
# A second pass turns that class of bug into a failing test on the first run.
for pass in 1 2; do
  echo "→ applying migrations (pass $pass)"
  for f in "$ROOT"/supabase/migrations/*.sql; do
    docker cp "$f" "$CONTAINER:/tmp/m.sql" >/dev/null
    if ! docker exec "$CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 -f /tmp/m.sql >/dev/null; then
      echo "!! $(basename "$f") failed on pass $pass — migrations must be re-runnable" >&2
      exit 1
    fi
    [[ $pass -eq 1 ]] && echo "   applied $(basename "$f")"
  done

done

echo "→ granting like Supabase does"
psql_run <<'SQL'
grant usage on schema public, auth to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
SQL

echo "→ running tests"
docker cp "$ROOT/supabase/tests/rls_test.sql" "$CONTAINER:/tmp/t.sql" >/dev/null

# Run ONCE and keep the status.
#
# This used to run the suite a second time purely to get an exit code, which was
# wrong twice over: the file seeds rows, so the second execution hit duplicate
# keys and assertions like "manager sees every profile" failed against data the
# first run had already inserted — and `set -e` then killed the script AFTER it
# had printed "All checks passed". So the command exited non-zero while claiming
# success, which is the worst possible combination and hid real failures behind
# a green-looking log.
set +e
docker exec "$CONTAINER" psql -U postgres -q -f /tmp/t.sql > /tmp/rls_out.log 2>&1
status=$?
set -e

grep -E "PASS|FAIL|ERROR|All checks" /tmp/rls_out.log || true

if [[ $status -ne 0 ]] || grep -qE "^psql.*(ERROR|FAIL)" /tmp/rls_out.log; then
  echo >&2
  echo "!! schema verification FAILED (psql exit $status)" >&2
  exit 1
fi

echo "✓ schema verified"
