#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/common.sh"
[[ $# == 2 && "$1" =~ ^[A-Za-z0-9_-]+$ && ( "$2" == phone || "$2" == mac ) ]] || fail 'Usage: enroll.sh <account: letters/digits/_/-> phone|mac'
prepare
private_dir "$TOKEN_DIR"
build_if_missing
file="$TOKEN_DIR/$1-$2.json"
# Reserve before enrollment: never overwrite the only copy of an existing token.
(set -o noclobber; : > "$file") 2>/dev/null || fail "Already exists: $file (reuse it; revoke before replacing)"
chmod 600 "$file"
if ! node "$CLI" enroll "$HUB_DIR/hub.db" "$1" "$2" > "$file"; then
  fail "Enrollment failed; inspect $file locally before retrying (may contain recovery data)"
fi
printf 'Saved credentials (0600): %s\nToken is issued only once. The script does not print it; read this file privately to pair the device. Never paste it into logs/chat/screenshots.\n' "$file"
