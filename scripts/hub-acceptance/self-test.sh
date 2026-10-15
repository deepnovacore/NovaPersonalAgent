#!/usr/bin/env bash
set -euo pipefail
# Isolated fakes: never starts a listener, contacts Tailscale, or issues real tokens.
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPTS/../.." && pwd)
REAL_NODE=$(command -v node)
TEST_DIR=$(mktemp -d)
export HOME="$TEST_DIR/home" TEST_DIR REAL_NODE ROOT
mkdir -p "$HOME" "$TEST_DIR/bin"
cleanup() {
  if [[ -f "$HOME/.nova/hub/hub.pid" ]]; then
    read -r child < "$HOME/.nova/hub/hub.pid"
    kill "$child" 2>/dev/null || true
  fi
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT
[[ -f "$ROOT/runtime/dist/src/hub/cli.js" ]] || { echo 'Build runtime before self-test'; exit 1; }
cat > "$TEST_DIR/bin/node" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${2:-}" == serve ]]; then exec sleep 60; fi
if [[ "${2:-}" == enroll ]]; then printf '{"account_id":"test","device_id":"fake","token":"not-a-real-token"}\n'; exit; fi
if [[ "${1:-}" == --input-type=module ]]; then exit 0; fi
exec "$REAL_NODE" "$@"
MOCK
cat > "$TEST_DIR/bin/ps" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'Thu Oct 15 00:00:00 2026 node %s/runtime/dist/src/hub/cli.js serve %s/.nova/hub/hub.db 127.0.0.1 8787\n' "$ROOT" "$HOME"
MOCK
cat > "$TEST_DIR/bin/tailscale" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'status --json' ]]; then echo '{"BackendState":"Running","Self":{"DNSName":"test.example.ts.net."}}'; exit; fi
if [[ "$*" == 'serve status --json' ]]; then cat "$TEST_DIR/status.json"; exit; fi
printf '%s\n' "$*" >> "$TEST_DIR/mutations"
MOCK
chmod +x "$TEST_DIR/bin/"*
export PATH="$TEST_DIR/bin:$PATH"
echo '{}' > "$TEST_DIR/status.json"
expect_fail() { if "$@" > "$TEST_DIR/rejected" 2>&1; then echo "Expected failure: $*" >&2; exit 1; fi; }
bash "$SCRIPTS/start-hub.sh" > "$TEST_DIR/start"
bash "$SCRIPTS/start-hub.sh" | grep -q 'already running'
bash "$SCRIPTS/stop-hub.sh" | grep -q 'stopped'
bash "$SCRIPTS/stop-hub.sh" | grep -q 'not running'
echo 'PASS lifecycle: start, idempotent start, stop, idempotent stop (mock process)'
bash "$SCRIPTS/enroll.sh" test phone > "$TEST_DIR/enroll"
! grep -q 'not-a-real-token' "$TEST_DIR/enroll"
"$REAL_NODE" -e 'const fs=require("fs"),p=process.env.HOME+"/.nova/hub-tokens/test-phone.json";if((fs.statSync(p).mode&511)!==384)throw Error("mode");if(!JSON.parse(fs.readFileSync(p)).token)throw Error("missing token")'
expect_fail bash "$SCRIPTS/enroll.sh" test phone
ln -s "$TEST_DIR/victim" "$HOME/.nova/hub-tokens/test-mac.json"
expect_fail bash "$SCRIPTS/enroll.sh" test mac
[[ ! -e "$TEST_DIR/victim" ]]
echo 'PASS enrollment: private 0600 file, no stdout token, overwrite/symlink refused'
bash "$SCRIPTS/expose-tailscale.sh" | grep -q 'https://test.example.ts.net:8443'
[[ ! -e "$TEST_DIR/mutations" ]]
HUB_HOST=manual.example.ts.net bash "$SCRIPTS/expose-tailscale.sh" --undo | grep -q 'Dry run'
[[ ! -e "$TEST_DIR/mutations" ]]
bash "$SCRIPTS/expose-tailscale.sh" --yes > /dev/null
grep -qx 'serve --bg --https=8443 http://127.0.0.1:8787' "$TEST_DIR/mutations"
echo '{"TCP":{"8443":{"HTTPS":true}}}' > "$TEST_DIR/status.json"
expect_fail bash "$SCRIPTS/expose-tailscale.sh" --yes
echo '{"AllowFunnel":{"test.example.ts.net:8443":true}}' > "$TEST_DIR/status.json"
expect_fail bash "$SCRIPTS/expose-tailscale.sh" --yes
echo 'not json' > "$TEST_DIR/status.json"
expect_fail bash "$SCRIPTS/expose-tailscale.sh" --yes
echo '{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true}},"Web":{"test.example.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}' > "$TEST_DIR/status.json"
bash "$SCRIPTS/expose-tailscale.sh" --undo --yes > /dev/null
grep -qx 'serve --bg --https=8443 http://127.0.0.1:8787 off' "$TEST_DIR/mutations"
[[ $(wc -l < "$TEST_DIR/mutations") -eq 2 ]]
echo '{}' > "$TEST_DIR/status.json"
expect_fail bash "$SCRIPTS/expose-tailscale.sh" --undo --yes
echo 'PASS exposure: dry-run, DNS discovery/manual override, occupied/Funnel/malformed refusal, scoped undo (mock CLI)'
