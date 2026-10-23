#!/bin/sh
set -eu
: "${NOVA_LINUX_ROOT:?Set NOVA_LINUX_ROOT to the prepared external iOS build directory}"
if [ "${NOVA_CI_RUNNER_TEMP:-}" = 1 ]; then
  python3 - <<'PYCI'
import os, pathlib
root = pathlib.Path(os.environ['NOVA_LINUX_ROOT']).resolve()
temporary = os.environ.get('RUNNER_TEMP')
if os.environ.get('GITHUB_ACTIONS') != 'true' or not temporary:
    raise SystemExit('CI runtime packaging requires GitHub Actions RUNNER_TEMP')
parent = pathlib.Path(temporary).resolve()
if root == parent or not root.is_relative_to(parent):
    raise SystemExit('CI runtime must stay under RUNNER_TEMP')
PYCI
else
  case "$NOVA_LINUX_ROOT" in /Volumes/*/*) ;; *) echo 'Linux build outputs must be on an external volume' >&2; exit 1;; esac
  volume="/Volumes/$(printf '%s' "$NOVA_LINUX_ROOT" | cut -d/ -f3)"
  mount | grep -F " on $volume (" >/dev/null || { echo 'External build volume is not mounted' >&2; exit 1; }
fi
for item in libish.a libish_emu.a libfakefs.a; do
  test -s "$NOVA_LINUX_ROOT/build-$PLATFORM_NAME/$item"
done
test -s "$NOVA_LINUX_ROOT/resources/NovaAlpine/meta.db"
mkdir -p "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
# Ditto copies fakefs metadata and regular-file payloads; only this build's app is changed.
ditto "$NOVA_LINUX_ROOT/resources/NovaAlpine" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/NovaAlpine"
