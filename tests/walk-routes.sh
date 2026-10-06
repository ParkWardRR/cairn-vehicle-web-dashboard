#!/usr/bin/env bash
# Walks every GET route in tests/routes.json against a running web layer and reports
# the status of each. Used by the staging run (web on spare ports against the demo
# tsdb) and by the production cutover check.
#
#   ui/tests/walk-routes.sh [--empty | --detect-empty] http://localhost:3100
#
# --empty is for a store with no trips: 400, 404 and 503 (no boot to ask about, nothing to show, no snapshot)
# then count as answered as designed. Against a populated store they are failures.
# --detect-empty is --empty only when /api/trips lists no trip (and says so), for a deploy that
# does not know whether the store has data.
# A 404 that is the server saying it has no such route at all ("Page not found: ")
# is never as designed: a route that went missing must not hide behind an empty store.
#
# Every route needs an identity. The read-only service token comes from CAIRN_TOKEN_FILE (or
# CAIRN_TOKEN) and is sent as a bearer header through curl's config input, so it never appears in
# a process listing.
#
# Exit 0 only if every route answered 2xx. Routes with a parameter other than :bootId
# are skipped (they need a place id the caller owns); POST/PATCH/DELETE are not walked.
set -euo pipefail

EMPTY=0; DETECT=0
case "${1:-}" in
  --empty) EMPTY=1; shift ;;
  --detect-empty) DETECT=1; shift ;;
esac
BASE="${1:?usage: walk-routes.sh [--empty] <base-url>}"
BASE="${BASE%/}"
DIR="$(cd "$(dirname "$0")" && pwd)"

TOKEN="${CAIRN_TOKEN:-}"
[ -z "${CAIRN_TOKEN_FILE:-}" ] || TOKEN="$(tr -d '\n' < "$CAIRN_TOKEN_FILE")"
# curl, with the credential when there is one
c() { if [ -n "$TOKEN" ]; then printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -K - "$@"; else curl "$@"; fi; }

boot="$(c -fsS "$BASE/api/trips" | sed -n 's/.*"boot_id": *"\([0-9a-f]*\)".*/\1/p' | head -1)"
[ -n "$boot" ] || echo "note: /api/trips lists no trip, so the :bootId routes are skipped" >&2
if [ "$DETECT" = 1 ] && [ -z "$boot" ]; then EMPTY=1; echo "note: walking as an empty store" >&2; fi

ok=0; bad=0; skipped=0
while read -r method path; do
  [ "$method" = GET ] || continue
  case "$path" in
    *:bootId*) [ -n "$boot" ] || { skipped=$((skipped+1)); continue; }; path="${path//:bootId/$boot}" ;;
    *:*) skipped=$((skipped+1)); continue ;;
  esac
  # boot_id is ignored by routes that do not read it
  out="$(mktemp)"
  code="$(c -sS -o "$out" -w '%{http_code}' --max-time 60 "$BASE$path?boot_id=$boot" || echo 000)"
  noroute=0; grep -q 'Page not found: ' "$out" 2>/dev/null && noroute=1
  rm -f "$out"
  case "$path" in
    # for people only: the read-only service token must be refused, and a 2xx here would be the failure
    /api/auth/passkeys|/api/auth/audit)
      if [ "$code" = 403 ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "FAIL $code $path (expected 403 for the service token)"; fi
      continue ;;
  esac
  case "$code" in
    2??) ok=$((ok+1)) ;;
    400|404|503) if [ "$EMPTY" = 1 ] && [ "$noroute" = 0 ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "FAIL $code $path"; fi ;;
    *) bad=$((bad+1)); echo "FAIL $code $path" ;;
  esac
done < <(sed -n 's/.*"method": "\([A-Z]*\)", "path": "\([^"]*\)".*/\1 \2/p' "$DIR/routes.json")

echo "$ok ok, $bad failed, $skipped skipped"
[ "$bad" -eq 0 ]
