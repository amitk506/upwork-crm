#!/usr/bin/env bash
# Deploys the portal + its self-hosted Supabase-compatible stack.
# Run ON THE VPS from /docker/upwork-portal.
#
#   ./deploy.sh              first run and every redeploy
#   ./deploy.sh --branded    also serve the branded hostname (needs the A record)
#
# Ordering matters and is the whole reason this is a script rather than one
# `docker compose up`: GoTrue must create auth.users before the portal's
# migrations, which have a foreign key to it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Only one deploy at a time. Migrations are replayed in full on every run, so two
# overlapping loops interleave: the slower one carries on applying EARLY files
# after the faster one has finished, and the database ends up with whatever the
# straggler happened to write last. That is not theoretical — it silently undid
# 0020 and left five views readable without authentication, because 0003/0009
# re-create the unguarded versions the later migrations exist to replace.
exec 9>/tmp/upwork-portal-deploy.lock
if ! flock -n 9; then
  echo "!! another deploy is already running (holding /tmp/upwork-portal-deploy.lock)." >&2
  echo "   Wait for it to finish. Two migration loops must never overlap." >&2
  exit 1
fi

COMPOSE=(docker compose --env-file .env -f docker-compose.yml)
if [[ "${1:-}" == "--branded" ]]; then
  COMPOSE+=(-f docker-compose.branded.yml)
  echo "→ including the branded hostname overlay"
fi

if [[ ! -f .env ]]; then
  echo "!! .env is missing. Generate secrets first:  node gen-keys.mjs > .secrets.env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

psql_run() {
  docker exec -i upwork-postgres psql -U postgres -v ON_ERROR_STOP=1 "$@"
}

echo "→ [1/7] starting postgres"
"${COMPOSE[@]}" up -d postgres
for _ in $(seq 1 60); do
  docker exec upwork-postgres pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo "→ [2/7] roles and schema grants"
psql_run \
  -v "authenticator_password=${AUTHENTICATOR_PASSWORD}" \
  -v "auth_admin_password=${AUTH_ADMIN_PASSWORD}" \
  -q < 01-roles.sql

echo "→ [3/7] starting GoTrue (creates auth.users)"
"${COMPOSE[@]}" up -d auth
for i in $(seq 1 60); do
  if docker exec upwork-postgres psql -U postgres -tAc \
      "select to_regclass('auth.users') is not null" 2>/dev/null | grep -q t; then
    echo "   auth.users present after ${i}s"
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "!! GoTrue never created auth.users. Logs:" >&2
    docker logs --tail 40 upwork-auth >&2
    exit 1
  fi
  sleep 1
done

echo "→ [4/7] auth helper functions"
psql_run -q < 02-auth-helpers.sql

# Before the schema is touched. Migrations replay in full on every deploy, and a
# single mistargeted statement in any of them can delete rows that only exist
# here — which is not hypothetical: a one-off cleanup in 0024 lacked a one-time
# guard and removed a reconnected Upwork profile on every deploy for a day.
echo "→ [5/7] backing up portal data"
if ! bash backup.sh; then
  echo "!! backup failed — refusing to run migrations without one." >&2
  exit 1
fi

echo "→ [5/7] portal migrations"
for f in migrations/*.sql; do
  echo "   $(basename "$f")"
  psql_run -q < "$f"
done

# Migrations create tables AFTER the default privileges were set, so tables made
# by earlier runs are already covered — this catches anything created before the
# defaults existed, and is harmless to repeat.
psql_run -q <<'SQL'
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
SQL

echo "→ [6/7] starting PostgREST"
"${COMPOSE[@]}" up -d rest
sleep 2

# PostgREST caches the schema at BOOT. A migration that adds a table is
# invisible to it until this reload, and the resulting 404s arrive with no
# error message at all — which cost a debugging round once already. Always
# reload, and verify a known table actually resolves before moving on.
echo "   reloading PostgREST schema cache"
docker kill -s SIGUSR1 upwork-rest >/dev/null 2>&1 || true
sleep 3

# Verify a TABLE and every VIEW the app reads. Views are the ones that actually
# go stale: a migration that drops and recreates one leaves PostgREST answering
# 404 with no error message, and the page above it renders an empty state instead
# of an error — which is exactly how "no profiles are connected" appeared on a
# portal holding five of them.
verify_rest() {
  curl -sf -o /dev/null \
    -H "apikey: ${SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    "${PUBLIC_URL}/rest/v1/$1?select=*&limit=1"
}

REST_CHECKS=(
  upwork_profiles
  room_reply_state
  v_profiles
  v_room_wait
  v_room_profiles
  v_profile_room_counts
  v_room_participants
  v_activity
  v_upwork_health
  v_mirror_freshness
  v_sync_gaps
)

missing=()
for rel in "${REST_CHECKS[@]}"; do
  verify_rest "$rel" || missing+=("$rel")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "   !! PostgREST cannot see: ${missing[*]} — restarting it" >&2
  "${COMPOSE[@]}" restart rest
  sleep 6

  missing=()
  for rel in "${REST_CHECKS[@]}"; do
    verify_rest "$rel" || missing+=("$rel")
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "!! still unreachable after a restart: ${missing[*]}" >&2
    echo "   the app will render empty states rather than errors, so this is fatal." >&2
    exit 1
  fi
fi
echo "   PostgREST sees all ${#REST_CHECKS[@]} relations"

echo "→ [7/7] building and starting the portal"
"${COMPOSE[@]}" up -d --build portal

echo
echo "→ waiting for the portal to answer"
for i in $(seq 1 90); do
  if docker exec upwork-portal node -e \
      "fetch('http://127.0.0.1:3050/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    echo "   healthy after ${i}s"
    break
  fi
  if [[ $i -eq 90 ]]; then
    echo "!! portal did not become healthy. Logs:" >&2
    docker logs --tail 40 upwork-portal >&2
    exit 1
  fi
  sleep 1
done

echo
"${COMPOSE[@]}" ps
echo
echo "✓ deployed → ${PUBLIC_URL}"
