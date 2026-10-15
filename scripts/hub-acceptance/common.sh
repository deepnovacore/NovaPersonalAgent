#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HUB_DIR="$HOME/.nova/hub"
TOKEN_DIR="$HOME/.nova/hub-tokens"
CLI="$ROOT/runtime/dist/src/hub/cli.js"
fail() { printf '%s\n' "$*" >&2; exit 1; }
private_dir() {
  [[ ! -L "$1" ]] || fail "Refusing symlink: $1"
  mkdir -p "$1"
  chmod 700 "$1"
}
prepare() {
  private_dir "$HOME/.nova"
  private_dir "$HUB_DIR"
  for file in hub.db hub.db-wal hub.db-shm hub.log hub.pid; do
    [[ ! -L "$HUB_DIR/$file" ]] || fail "Refusing symlink: $HUB_DIR/$file"
  done
}
build_if_missing() {
  command -v node >/dev/null || fail 'Node >=22.13 required'
  if [[ ! -f "$CLI" ]]; then (cd "$ROOT/runtime" && npm run build); fi
}
lock() {
  mkdir "$HUB_DIR/lifecycle.lock" 2>/dev/null || fail 'Lifecycle busy (or stale lock): inspect before removing ~/.nova/hub/lifecycle.lock'
  trap 'rmdir "$HUB_DIR/lifecycle.lock"' EXIT
}
# Match both creation time and full command before signalling a recorded PID.
owned_pid() {
  [[ -f "$HUB_DIR/hub.pid" ]] || return 1
  { read -r pid; IFS= read -r fingerprint; } < "$HUB_DIR/hub.pid"
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && -n "$fingerprint" ]] || fail 'Invalid PID file; inspect manually'
  kill -0 "$pid" 2>/dev/null || return 1
  current=$(ps -p "$pid" -o lstart= -o command=)
  [[ "$current" == "$fingerprint" && "$current" == *"$CLI serve $HUB_DIR/hub.db 127.0.0.1 8787" ]] || fail 'PID identity mismatch; refusing to signal or overwrite'
}
