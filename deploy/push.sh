#!/usr/bin/env bash
# Push this working tree to the VPS and run the deploy there.
#
#   ./deploy/push.sh          from the repo root, or from anywhere
#
# Run this rather than rsyncing by hand. Two things on the server exist ONLY on
# the server and a careless copy destroys them:
#
#   deploy/.env       the production secrets, including TOKEN_ENCRYPTION_KEY.
#                     Lose that key and every connected Upwork profile has to be
#                     reconnected by its owner — the tokens in the database are
#                     encrypted with it and there is no other route back.
#   deploy/backups/   the pre-migration snapshots deploy.sh takes.
#
# So every .env is excluded, and --delete is scoped to src/ alone. The rest of
# the tree is copied additively: a stale file there is a nuisance, a deleted
# .env is an outage.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. root@your.server.ip}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
DIR="${DEPLOY_DIR:-/docker/upwork-portal}"
SSH=(ssh -i "$KEY" "$HOST")
RSH="ssh -i $KEY"

cd "$ROOT"

echo "→ checking the tree before shipping it"
npm run typecheck
npm run lint

echo
echo "→ syncing application source to $HOST:$DIR"
# --delete here only: src/ is entirely ours, and a file removed locally must not
# keep compiling on the server.
rsync -az --delete -e "$RSH" \
  --exclude='.DS_Store' \
  src/ "$HOST:$DIR/src/"

# Everything the build needs, additively.
rsync -az -e "$RSH" \
  --exclude='.DS_Store' \
  public/ "$HOST:$DIR/public/"

rsync -az -e "$RSH" \
  package.json package-lock.json next.config.ts tsconfig.json postcss.config.mjs \
  eslint.config.mjs Dockerfile README.md AGENTS.md next-env.d.ts \
  "$HOST:$DIR/"

# Migrations live in supabase/migrations here and deploy/migrations there, which
# is the copy deploy.sh actually replays. Never --delete: a migration that
# vanished from the server would silently stop being applied.
echo "→ syncing migrations"
rsync -az -e "$RSH" supabase/migrations/ "$HOST:$DIR/deploy/migrations/"

# The deploy machinery itself, minus every secret and snapshot.
echo "→ syncing deploy scripts (never .env, never backups)"
rsync -az -e "$RSH" \
  --exclude='.env' --exclude='.env.*' --exclude='backups' --exclude='push.sh' \
  deploy/ "$HOST:$DIR/deploy/"

echo
echo "→ running the deploy on the server"
# `bash deploy.sh` rather than ./deploy.sh: a mode bit that did not survive a
# copy is not worth a failed deploy.
"${SSH[@]}" "cd $DIR/deploy && bash deploy.sh"
