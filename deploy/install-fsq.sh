#!/usr/bin/env bash
# Builds tools/cairn-fsq on the host and installs it as /usr/local/bin/cairn-fsq.
#
#   deploy/install-fsq.sh        build the committed code (HEAD) on the host and install it
#
# DuckDB links through cgo, so the tool is built where it runs (the host needs go and
# gcc), the same way cairn-tsdb is. The binary it replaces is kept as cairn-fsq.prev.
# deploy-ui.sh --with-fsq runs this after the UI deploy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$ROOT/deploy.env" ] && . "$ROOT/deploy.env"
HOST="${CAIRN_DEPLOY_HOST:?set CAIRN_DEPLOY_HOST (user@host), or put it in deploy.env}"
BIN=/usr/local/bin/cairn-fsq

echo "==> Building cairn-fsq from $(git -C "$ROOT" rev-parse --short HEAD) on $HOST..."
SRC="$(ssh "$HOST" 'mktemp -d')"
trap 'ssh "$HOST" "rm -rf $SRC" 2>/dev/null || true' EXIT
git -C "$ROOT" archive HEAD tools/cairn-fsq | ssh "$HOST" "tar -x -C $SRC"
ssh "$HOST" "export PATH=\$PATH:/usr/local/go/bin; command -v go gcc >/dev/null || { echo 'the host needs go and gcc' >&2; exit 1; }
  cd $SRC/tools/cairn-fsq && CGO_ENABLED=1 go build -o $SRC/cairn-fsq . && $SRC/cairn-fsq -h 2>&1 | head -1"

echo "==> Installing $BIN (previous kept as .prev)..."
ssh "$HOST" "if [ -f $BIN ]; then sudo cp -p $BIN $BIN.prev; fi && sudo install -m 0755 $SRC/cairn-fsq $BIN.new && sudo mv $BIN.new $BIN"
ssh "$HOST" "$BIN -h 2>&1 | head -1"
echo "==> Done."
