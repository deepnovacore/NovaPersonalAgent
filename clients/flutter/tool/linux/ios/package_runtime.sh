#!/bin/sh
set -eu
: "${NOVA_LINUX_ROOT:?Set NOVA_LINUX_ROOT to the isolated prepared iOS build directory}"
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
  python3 - <<'PYLOCAL'
import os, pathlib
configured = pathlib.Path(os.environ['NOVA_LINUX_ROOT'])
root = configured.resolve()
if not configured.is_absolute() or root == pathlib.Path(root.anchor) or root.is_relative_to('/Volumes'):
    raise SystemExit('Linux build outputs require an explicit isolated directory on internal storage')
PYLOCAL
fi
for item in libish.a libish_emu.a libfakefs.a; do
  test -s "$NOVA_LINUX_ROOT/build-$PLATFORM_NAME/$item"
done
test -s "$NOVA_LINUX_ROOT/resources/NovaAlpine/meta.db"
test -s "$NOVA_LINUX_ROOT/resources/NovaAlpine.sha256"
test -s "$NOVA_LINUX_ROOT/documents-ios/manifest.json"
mkdir -p "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
# Ditto copies fakefs metadata and regular-file payloads; only this build's app is changed.
ditto "$NOVA_LINUX_ROOT/resources/NovaAlpine" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/NovaAlpine"
