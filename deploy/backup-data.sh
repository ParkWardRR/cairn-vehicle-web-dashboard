#!/usr/bin/env bash
# Pulls a copy of everything a person has made in the web layer off the server (saved and learned
# places, and the marks on trips), so it exists somewhere other than the machine that serves it.
# Safe to run any time and to schedule (cron, launchd): it only reads.
#
#   deploy/backup-data.sh [destination]    default: ~/cairn-backups/data
#
# What is copied: the always-current JSON mirrors (saved-places.json, annotations.json) and the
# app's dated copies of the saved places (backups/). To restore, use Import on the Places page, or
# POST a file from `GET /api/data/export` to /api/data/import; see "Your data" in the README.
#
# The files contain real locations (home included). Keep them out of the repo.
set -euo pipefail

[ -f "$(dirname "$0")/../deploy.env" ] && . "$(dirname "$0")/../deploy.env"
HOST="${CAIRN_HOST:-${CAIRN_DEPLOY_HOST:?set CAIRN_HOST (user@host), or CAIRN_DEPLOY_HOST in deploy.env}}"
STATE="/var/lib/cairn-ui"
DEST="${1:-$HOME/cairn-backups/data}"

mkdir -p "$DEST/backups"
# The files belong to the service user, so read them through sudo.
for f in saved-places.json annotations.json; do
  # annotations.json exists only once something has been marked
  if ssh "$HOST" "sudo test -f $STATE/$f"; then
    rsync -az --rsync-path="sudo rsync" "$HOST:$STATE/$f" "$DEST/$f"
  fi
done
rsync -az --rsync-path="sudo rsync" "$HOST:$STATE/backups/" "$DEST/backups/"
chmod -R go-rwx "$DEST"
echo "copied to $DEST: $(ls "$DEST" | grep -c '\.json$') store(s), $(ls "$DEST/backups" | wc -l | tr -d ' ') dated copies"
