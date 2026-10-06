#!/usr/bin/env bash
# Builds the web UI and installs it on the server.
#
#   deploy/deploy-ui.sh            build the committed code (HEAD) and deploy it
#   deploy/deploy-ui.sh --dirty    build the working tree, uncommitted changes and all
#   deploy/deploy-ui.sh --with-fsq also build and install tools/cairn-fsq on the host
#                                  (deploy/install-fsq.sh does only that)
#
# The default builds from a clean export of HEAD so that what is deployed is what
# is committed. Building the working tree ships anything half-finished in it, and
# the UI talks to a server whose schema may not have caught up with that work.
set -euo pipefail

UI_DIR="/srv/cairn-ui"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# The target comes from the environment or a gitignored deploy.env. No real host name
# is stored in this repository.
[ -f "$ROOT/deploy.env" ] && . "$ROOT/deploy.env"
HOST="${CAIRN_DEPLOY_HOST:?set CAIRN_DEPLOY_HOST (user@host), or put it in deploy.env}"

DIRTY=0; WITH_FSQ=0
for a in "$@"; do
  case "$a" in
    --dirty) DIRTY=1 ;;
    --with-fsq) WITH_FSQ=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ "$DIRTY" = 1 ]; then
  echo "==> Building Nuxt UI from the working tree (uncommitted changes included)..."
  BUILD_DIR="$ROOT"
  (cd "$BUILD_DIR" && npm run build)
else
  echo "==> Building Nuxt UI from $(git -C "$ROOT" rev-parse --short HEAD)..."
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  git -C "$ROOT" archive HEAD | tar -x -C "$TMP"
  BUILD_DIR="$TMP"
  # Reuse the installed dependencies. A copy (cloned where the filesystem can),
  # not a symlink, which the build does not resolve correctly.
  cp -Rc "$ROOT/node_modules" "$BUILD_DIR/node_modules" 2>/dev/null || cp -R "$ROOT/node_modules" "$BUILD_DIR/node_modules"
  (cd "$BUILD_DIR" && npx nuxt prepare >/dev/null && npm run build)
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "    note: the working tree has uncommitted changes; they are NOT in this deploy"
  fi
fi

echo "==> Uploading build to $HOST:$UI_DIR..."
ssh "$HOST" "sudo mkdir -p $UI_DIR && sudo chown cairn:cairn $UI_DIR"
rsync -az --delete --rsync-path="sudo -u cairn rsync" "$BUILD_DIR/.output/" "$HOST:$UI_DIR/.output/"
rsync -az --rsync-path="sudo -u cairn rsync" "$BUILD_DIR/package.json" "$HOST:$UI_DIR/package.json"

echo "==> Installing systemd service..."
# The unit is only installed when absent: the live one carries host-specific
# settings (map keys) that are not in the repo, so a deploy must not replace it.
scp "$SCRIPT_DIR/systemd/cairn-ui.service" "$HOST:/tmp/cairn-ui.service"
ssh "$HOST" "test -f /etc/systemd/system/cairn-ui.service && rm /tmp/cairn-ui.service || sudo mv /tmp/cairn-ui.service /etc/systemd/system/cairn-ui.service"
scp "$SCRIPT_DIR/systemd/cairn-ui-places.conf" "$HOST:/tmp/places.conf"
ssh "$HOST" "sudo mkdir -p /etc/systemd/system/cairn-ui.service.d && sudo mv /tmp/places.conf /etc/systemd/system/cairn-ui.service.d/places.conf && sudo systemctl daemon-reload"

echo "==> Restarting cairn-ui..."
ssh "$HOST" "sudo systemctl enable --now cairn-ui && sudo systemctl restart cairn-ui"

if [ -f "$SCRIPT_DIR/caddy/Caddyfile" ]; then
  echo "==> Updating Caddy config..."
  scp "$SCRIPT_DIR/caddy/Caddyfile" "$HOST:/tmp/Caddyfile"
  ssh "$HOST" "sudo mv /tmp/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"
else
  echo "==> No deploy/caddy/Caddyfile here (copy Caddyfile.example and set your site); leaving Caddy alone"
fi

echo "==> Walking every GET route on the host..."
sleep 4
# tests/walk-routes.sh needs only bash and curl and reads tests/routes.json, so it is
# copied to the host and run there against the service itself (localhost:3000). A store
# with no trips answers 400/404/503 on the trip routes by design, so --empty is used
# only then.
WALK_DIR="$(ssh "$HOST" 'mktemp -d')"
trap 'ssh "$HOST" "rm -rf $WALK_DIR" 2>/dev/null || true; [ -z "${TMP:-}" ] || rm -rf "$TMP"' EXIT
scp -q "$BUILD_DIR/tests/walk-routes.sh" "$BUILD_DIR/tests/routes.json" "$HOST:$WALK_DIR/"
EMPTY=""
if ! ssh "$HOST" "curl -fsS localhost:3000/api/trips" | grep -q '"boot_id"'; then
  EMPTY="--empty"
  echo "    the store lists no trips; walking with --empty"
fi
if ! ssh "$HOST" "bash $WALK_DIR/walk-routes.sh $EMPTY http://localhost:3000"; then
  echo "==> The deploy is up but the routes listed above failed (each FAIL line names its route)."
  exit 1
fi

if [ "$WITH_FSQ" = 1 ]; then "$SCRIPT_DIR/install-fsq.sh"; fi

echo "==> Done."
