#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
[[ $# == 0 ]] || fail 'Usage: start-hub.sh'
prepare
lock
if owned_pid; then printf 'Hub already running (PID %s)\n' "$pid"; exit 0; fi
build_if_missing
# Fail rather than accidentally treating another listener as our Hub.
node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.on("error",()=>{console.error("127.0.0.1:8787 is occupied");process.exitCode=1}); s.listen(8787,"127.0.0.1",()=>s.close())'
nohup node "$CLI" serve "$HUB_DIR/hub.db" 127.0.0.1 8787 >> "$HUB_DIR/hub.log" 2>&1 < /dev/null &
pid=$!
sleep 0.2
kill -0 "$pid" 2>/dev/null || fail "Hub failed; inspect $HUB_DIR/hub.log"
fingerprint=$(ps -p "$pid" -o lstart= -o command=)
printf '%s\n%s\n' "$pid" "$fingerprint" > "$HUB_DIR/hub.pid"
chmod 600 "$HUB_DIR/hub.pid" "$HUB_DIR/hub.log"
for ((i=0; i<30; i++)); do
  if ! owned_pid; then fail "Hub exited; inspect $HUB_DIR/hub.log"; fi
  if node --input-type=module -e 'const r=await fetch("http://127.0.0.1:8787/hub/v1/state",{signal:AbortSignal.timeout(500)}); if(r.status!==401||(await r.json()).error!=="unauthorized")process.exitCode=1' 2>/dev/null; then
    printf 'Hub ready on 127.0.0.1:8787 (PID %s); log: %s/hub.log\n' "$pid" "$HUB_DIR"
    exit 0
  fi
  sleep 0.2
done
fail 'Hub readiness failed; inspect log and run stop-hub.sh before retrying'
