#!/usr/bin/env bash
# Bring up a local backend and point the portal at it.
#
#   ./scripts/dev-stack.sh up       keys → containers → schema → first owner
#   ./scripts/dev-stack.sh down     stop and delete everything
#
# Afterwards:  npm run dev  → http://localhost:3000
#
# Writes two files, both ignored by git:
#   deploy/.env.local   the stack's secrets (Postgres, JWT, service key)
#   .env.local          what `next dev` reads
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose --env-file "$ROOT/deploy/.env.local" -f "$ROOT/deploy/docker-compose.local.yml")
OWNER_EMAIL="${OWNER_EMAIL:-owner@example.com}"
OWNER_NAME="${OWNER_NAME:-Portal Owner}"

case "${1:-up}" in
  down)
    "${COMPOSE[@]}" down -v
    exit 0
    ;;
  up) ;;
  *) echo "usage: $0 up|down" >&2; exit 1 ;;
esac

if [[ ! -f "$ROOT/deploy/.env.local" ]]; then
  echo "→ generating keys"
  node "$ROOT/deploy/gen-keys.mjs" > "$ROOT/deploy/.env.local"
fi
set -a; source "$ROOT/deploy/.env.local"; set +a

echo "→ starting postgres, auth, rest, gateway"
"${COMPOSE[@]}" up -d --wait postgres
psql_run() { "${COMPOSE[@]}" exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "→ roles"
psql_run -v "authenticator_password=${AUTHENTICATOR_PASSWORD}" \
         -v "auth_admin_password=${AUTH_ADMIN_PASSWORD}" < "$ROOT/deploy/01-roles.sql"

"${COMPOSE[@]}" up -d auth
for i in $(seq 1 60); do
  if psql_run -tAc "select to_regclass('auth.users') is not null" 2>/dev/null | grep -q t; then break; fi
  [[ $i -eq 60 ]] && { echo "!! GoTrue never created auth.users" >&2; exit 1; }
  sleep 1
done

echo "→ auth helpers and migrations"
psql_run < "$ROOT/deploy/02-auth-helpers.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do psql_run < "$f"; done
psql_run <<'SQL'
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
SQL

"${COMPOSE[@]}" up -d rest gateway
sleep 2
docker kill -s SIGUSR1 "$("${COMPOSE[@]}" ps -q rest)" >/dev/null 2>&1 || true

echo "→ writing .env.local for next dev"
cat > "$ROOT/.env.local" <<ENV
NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_AGENCY_NAME=${AGENCY_NAME:-Demo Agency}
SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
TOKEN_ENCRYPTION_KEY=${TOKEN_ENCRYPTION_KEY}
SYNC_SECRET=local-dev-sync-secret-not-for-production
ENV

echo "→ creating the first owner ($OWNER_EMAIL)"
PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')"
node -e '
const [base, key, email, name, password] = process.argv.slice(1)
fetch(base + "/auth/v1/admin/users", {
  method: "POST",
  headers: { "content-type": "application/json", apikey: key, authorization: "Bearer " + key },
  body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: name } }),
}).then(async (r) => { const j = await r.json(); if (!r.ok) { console.error(j); process.exit(1) } })
' "http://localhost:8000" "$SERVICE_ROLE_KEY" "$OWNER_EMAIL" "$OWNER_NAME" "$PASSWORD"

echo
echo "✓ local stack is up"
echo "  sign in at http://localhost:3000/login"
echo "  email:    $OWNER_EMAIL"
echo "  password: $PASSWORD"
echo
echo "  npm run dev"
