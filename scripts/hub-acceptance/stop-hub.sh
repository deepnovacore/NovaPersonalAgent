#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
[[ $# == 0 ]] || fail 'Usage: stop-hub.sh'
prepare
lock
if ! owned_pid; then rm -f "$HUB_DIR/hub.pid"; echo 'Hub not running'; exit 0; fi
kill -TERM "$pid"
for ((i=0; i<50; i++)); do
  if ! kill -0 "$pid" 2>/dev/null; then rm -f "$HUB_DIR/hub.pid"; echo 'Hub stopped'; exit 0; fi
  sleep 0.2
done
fail 'Hub still stopping; PID retained. Inspect manually; no SIGKILL sent.'
