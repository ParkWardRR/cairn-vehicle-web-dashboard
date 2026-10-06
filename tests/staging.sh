#!/usr/bin/env bash
# Staged acceptance for the web layer: nothing here touches a real store or a real host.
#
#   tests/staging.sh             run the staged acceptance suite
#   tests/staging.sh --capture   also rewrite deploy/required-queries.json from the SQL
#                                the web layer sent the demo store during the suite
#
# 1. builds the production web bundle (unless CAIRN_STAGING_NO_BUILD=1 and .output exists);
# 2. builds the synthetic demo store (cairn-tsdb-demo) from the exact vehicle-server commit
#    pinned in server.lock, so the web layer is checked against the store it is claimed to
#    work with (CAIRN_SERVER_DIR=<checkout> uses a local server checkout instead);
# 3. starts, on spare loopback ports, the demo store with data, the demo store with no rows,
#    and three web instances: over the data, over the empty store, over a store that is not
#    there;
# 4. runs tests/acceptance against them; 5. stops everything.
#
# Ports: CAIRN_STAGING_PORT_BASE (default 18480): stores at +0 and +1, web at +10000.. .
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
CAPTURE=0; [ "${1:-}" = "--capture" ] && CAPTURE=1
BASE="${CAIRN_STAGING_PORT_BASE:-18480}"
STORE_DATA=$BASE; STORE_EMPTY=$((BASE + 1)); STORE_NONE=$((BASE + 9))
WEB_DATA=$((BASE - 5380)); WEB_EMPTY=$((BASE - 5379)); WEB_DOWN=$((BASE - 5378))   # 13100..13102 by default

STAGE="$ROOT/.staging"
mkdir -p "$STAGE/bin"
RUN="$(mktemp -d)"
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$RUN"
}
trap cleanup EXIT

# ─── the demo store, from the pinned server commit ───────────────────────────
if [ -n "${CAIRN_SERVER_DIR:-}" ]; then
  SERVER="$CAIRN_SERVER_DIR"
  echo "==> demo store from $SERVER (override)"
else
  repo="$(sed -n 's/.*"repo": *"\([^"]*\)".*/\1/p' server.lock | head -1)"
  commit="$(sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' server.lock | head -1)"
  [ -n "$repo" ] && [ -n "$commit" ] || { echo "server.lock has no repo or commit" >&2; exit 1; }
  SERVER="$STAGE/server"
  if [ ! -d "$SERVER/.git" ] || [ "$(git -C "$SERVER" rev-parse HEAD)" != "$commit" ]; then
    echo "==> fetching the vehicle server at $commit"
    rm -rf "$SERVER"; mkdir -p "$SERVER"
    git -C "$SERVER" init -q
    git -C "$SERVER" fetch -q --depth 1 "$repo" "$commit"
    git -C "$SERVER" checkout -q FETCH_HEAD
  fi
  [ "$(git -C "$SERVER" rev-parse HEAD)" = "$commit" ] || { echo "fetched the wrong commit" >&2; exit 1; }
  echo "==> demo store from the pinned server commit $commit"
fi
(cd "$SERVER" && go build -o "$STAGE/bin/cairn-tsdb-demo" ./cmd/cairn-tsdb-demo)

# ─── the web bundle ──────────────────────────────────────────────────────────
if [ "${CAIRN_STAGING_NO_BUILD:-0}" != 1 ] || [ ! -f .output/server/index.mjs ]; then
  echo "==> building the web bundle"
  npm run build >/dev/null
fi

wait_for() { # url
  for _ in $(seq 1 120); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.5; done
  echo "timed out waiting for $1" >&2; return 1
}

echo "==> starting the staged instances"
"$STAGE/bin/cairn-tsdb-demo" -addr "127.0.0.1:$STORE_DATA" >"$RUN/store-data.log" 2>&1 & pids+=($!)
"$STAGE/bin/cairn-tsdb-demo" -empty -addr "127.0.0.1:$STORE_EMPTY" >"$RUN/store-empty.log" 2>&1 & pids+=($!)

SQL_LOG="$RUN/sql.log"
web() { # port store-port places-dir
  CAIRN_SQL_LOG="$([ "$CAPTURE" = 1 ] && [ "$1" = "$WEB_DATA" ] && echo "$SQL_LOG")" \
  NITRO_PORT="$1" NITRO_HOST=127.0.0.1 NUXT_TSDB_URL="http://127.0.0.1:$2" \
    NUXT_PLACES_EXTERNAL=false NUXT_PLACES_DATA_DIR="$3" \
    node .output/server/index.mjs >"$RUN/web-$1.log" 2>&1 &
  pids+=($!)
}
web "$WEB_DATA"  "$STORE_DATA"  "$RUN/places-data"
web "$WEB_EMPTY" "$STORE_EMPTY" "$RUN/places-empty"
web "$WEB_DOWN"  "$STORE_NONE"  "$RUN/places-down"   # nothing listens on STORE_NONE

wait_for "http://127.0.0.1:$STORE_DATA/healthz"
wait_for "http://127.0.0.1:$STORE_EMPTY/healthz"
wait_for "http://127.0.0.1:$WEB_DATA/api/vehicles"
wait_for "http://127.0.0.1:$WEB_EMPTY/api/vehicles"
curl -sS -o /dev/null "http://127.0.0.1:$WEB_DOWN/api/device/tsdb-status" || { echo "the web instance over the missing store did not start" >&2; exit 1; }

echo "==> running the acceptance suite"
set +e
CAIRN_WEB_DATA="http://127.0.0.1:$WEB_DATA" \
CAIRN_WEB_EMPTY="http://127.0.0.1:$WEB_EMPTY" \
CAIRN_WEB_DOWN="http://127.0.0.1:$WEB_DOWN" \
CAIRN_WEB_PLACES="$RUN/places-data" \
  npm run test:acceptance
rc=$?
set -e
if [ "$rc" -eq 0 ] && [ "$CAPTURE" = 1 ]; then
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)
    const sql = [...new Set(lines.map(l => JSON.parse(l)))].sort()
    require("fs").writeFileSync(process.argv[2], JSON.stringify(sql, null, 1) + "\n")
    console.log("==> captured " + sql.length + " distinct statements into deploy/required-queries.json")
  ' "$SQL_LOG" deploy/required-queries.json
fi
if [ "$rc" -ne 0 ]; then
  echo "==> the suite failed; the instances' logs:" >&2
  for f in "$RUN"/*.log; do echo "--- $f" >&2; tail -n 20 "$f" >&2; done
fi
exit "$rc"
