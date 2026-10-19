#!/bin/sh
set -eu
: "${NOVA_LINUX_ROOT:?Set NOVA_LINUX_ROOT to the prepared external iOS build directory}"
case "$NOVA_LINUX_ROOT" in /Volumes/*/*) ;; *) echo 'Linux build outputs must be on an external volume' >&2; exit 1;; esac
volume="/Volumes/$(printf '%s' "$NOVA_LINUX_ROOT" | cut -d/ -f3)"
mount | grep -F " on $volume (" >/dev/null || { echo 'External build volume is not mounted' >&2; exit 1; }
for item in libish.a libish_emu.a libfakefs.a; do
  test -s "$NOVA_LINUX_ROOT/build-$PLATFORM_NAME/$item"
done
test -s "$NOVA_LINUX_ROOT/resources/NovaAlpine/meta.db"
mkdir -p "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
# Ditto copies fakefs metadata and regular-file payloads; only this build's app is changed.
ditto "$NOVA_LINUX_ROOT/resources/NovaAlpine" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/NovaAlpine"
