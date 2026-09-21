#!/usr/bin/env bash
# Snapshot the data that cannot be recreated, before anything touches the schema.
#
#   ./backup.sh            take one now
#   ./backup.sh --list     show what is held
#
# WHAT THIS PROTECTS
#
# upwork_profiles holds the OAuth tokens for every connected Upwork account.
# Lose those rows and every profile has to be reconnected by hand, by the person
# who owns each account — OAuth offers no other route. Everything else here is
# portal-owned and equally unrecoverable from Upwork: who has access to what, who
# is assigned where, the derived reply state, follow-ups, corrections, and the
# audit trail.
#
# The Zone 1 mirror (up_rooms, up_messages, up_proposals) is deliberately NOT
# included. It is a cache Upwork's terms cap at 24 hours; it rebuilds itself on
# the next sync, and keeping copies of it in a dated file is exactly what that
# rule forbids.
#
# THE TOKENS ARE ENCRYPTED. Restoring is useless without the TOKEN_ENCRYPTION_KEY
# from .env — the same key, not a new one. Back that up separately, somewhere
# this file is not.
#
# REFRESH TOKENS ROTATE. Upwork issues a new refresh token each time one is used,
# so a snapshot from last week may restore a token Upwork has already retired.
# This is most useful taken immediately before a change, which is why deploy.sh
# runs it automatically.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

DIR=./backups
KEEP=20
CONTAINER=upwork-postgres

TABLES=(
  upwork_profiles
  app_users
  profile_grants
  room_grants
  room_profiles
  assignments
  internal_notes
  outbound_drafts
  sent_messages
  room_reply_state
  room_followups
  message_directions
  activity_log
)

if [[ "${1:-}" == "--list" ]]; then
  ls -lh "$DIR" 2>/dev/null || echo "no backups yet"
  exit 0
fi

mkdir -p "$DIR"
chmod 700 "$DIR"

STAMP=$(date -u +%Y%m%d-%H%M%S)
FILE="$DIR/portal-$STAMP.sql"

args=()
for t in "${TABLES[@]}"; do args+=(-t "public.$t"); done

# --data-only: the schema comes from the migrations, which are in git. What is
# irreplaceable is the rows.
# --column-inserts: survives a column being added later, where COPY would not.
docker exec "$CONTAINER" pg_dump -U postgres --data-only --column-inserts \
  --no-owner --no-privileges "${args[@]}" > "$FILE"

chmod 600 "$FILE"

profiles=$(grep -c "INSERT INTO public.upwork_profiles" "$FILE" || true)
if [[ "$profiles" -eq 0 ]]; then
  echo "!! the dump contains no upwork_profiles rows — refusing to keep it" >&2
  echo "   a backup that would not restore your connections is worse than none." >&2
  mv "$FILE" "$FILE.suspect"
  exit 1
fi

echo "✓ backed up $(du -h "$FILE" | cut -f1) → $FILE"
echo "  profiles: $profiles"

# Keep the most recent few. Old snapshots hold retired refresh tokens and are of
# decreasing use, so they are not worth accumulating indefinitely.
ls -1t "$DIR"/portal-*.sql 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "  pruned $(basename "$old")"
done
