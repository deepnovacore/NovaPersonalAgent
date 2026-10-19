#!/bin/bash
set -euo pipefail
: "${NOVA_LINUX_ROOT:?Set the mounted external iOS runtime directory}"
case "$NOVA_LINUX_ROOT" in /Volumes/*/*) ;; *) echo 'External volume required' >&2; exit 1;; esac
volume="/Volumes/$(printf '%s' "$NOVA_LINUX_ROOT" | cut -d/ -f3)"
mount | grep -F " on $volume (" >/dev/null || exit 1
flutter_root="$(cd "$(dirname "$0")/../../.." && pwd)"
export TMPDIR="$NOVA_LINUX_ROOT/tmp"
export CLANG_MODULE_CACHE_PATH="$NOVA_LINUX_ROOT/clang-cache"
export SWIFT_MODULECACHE_PATH="$NOVA_LINUX_ROOT/swift-cache"
mkdir -p "$TMPDIR" "$CLANG_MODULE_CACHE_PATH" "$SWIFT_MODULECACHE_PATH"
swiftc -module-cache-path "$SWIFT_MODULECACHE_PATH" "$flutter_root/ios/Runner/NovaWorkspaceRequest.swift" "$flutter_root/ios/RunnerTests/NovaWorkspaceRequestChecks.swift" -o "$NOVA_LINUX_ROOT/request-checks"
"$NOVA_LINUX_ROOT/request-checks"
clang -fobjc-arc -fblocks -Wno-incomplete-implementation -framework Foundation -I "$flutter_root/ios/Runner" -I "$flutter_root/ios/Vendor/OpenMinis" "$flutter_root/ios/RunnerTests/NovaShellRuntimeChecks.m" "$flutter_root/ios/Runner/NovaShellRuntime.m" -o "$NOVA_LINUX_ROOT/wrapper-checks"
"$NOVA_LINUX_ROOT/wrapper-checks" "$NOVA_LINUX_ROOT/wrapper-$(date +%s)"
clang -std=gnu11 -fobjc-arc -fblocks -DGUEST_ARM64=1 -DENGINE_ASBESTOS=1 -DISH_INTERNAL=1 -I "$flutter_root/ios/Runner" -I "$flutter_root/ios/Vendor/OpenMinis" -I "$NOVA_LINUX_ROOT/include" -I "$NOVA_LINUX_ROOT/include/ish" -I "$NOVA_LINUX_ROOT/build-macosx" -framework Foundation -framework SystemConfiguration "$flutter_root/ios/RunnerTests/NovaShellGuestChecks.m" "$flutter_root/ios/Runner/NovaShellRuntime.m" "$flutter_root/ios/Vendor/OpenMinis/ISHKernel.m" "$flutter_root/ios/Vendor/OpenMinis/ISHShellExecutor.m" "$flutter_root/ios/Vendor/OpenMinis/CurrentRoot.m" -L "$NOVA_LINUX_ROOT/build-macosx" -lish -lish_emu -lfakefs -lsqlite3 -lresolv -o "$NOVA_LINUX_ROOT/guest-checks"
"$NOVA_LINUX_ROOT/guest-checks" "$NOVA_LINUX_ROOT/resources/NovaAlpine" "$NOVA_LINUX_ROOT/guest-check-workspace"
