#!/bin/sh
# Standalone host checks, NOT an app build or device/URLSession verification.
set -eu
cd "$(dirname "$0")/.."
: "${NOVA_CHECK_OUTPUT:?Set NOVA_CHECK_OUTPUT to an isolated scratch directory for this chat}"
mkdir -p "$NOVA_CHECK_OUTPUT/modules" "$NOVA_CHECK_OUTPUT/cache"
files=$(mktemp -d "$NOVA_CHECK_OUTPUT/files.XXXXXX")
checks=tool/native_transfer_checks
for module in Flutter UIKit; do
  swiftc -module-cache-path "$NOVA_CHECK_OUTPUT/cache" -emit-library -emit-module \
    -module-name "$module" "$checks/$module.swift" \
    -emit-module-path "$NOVA_CHECK_OUTPUT/modules/$module.swiftmodule" \
    -o "$NOVA_CHECK_OUTPUT/modules/lib$module.dylib"
done
swiftc -module-cache-path "$NOVA_CHECK_OUTPUT/cache" -I "$NOVA_CHECK_OUTPUT/modules" \
  -D REAL_SCOPE -D REAL_MODEL -typecheck ios/Runner/NativeModelTransfer.swift \
  ios/Runner/ModelTransferFiles.swift ios/Runner/ModelTransferAuthority.swift ios/Runner/PrivateSpaceDirectory.swift ios/Runner/ModelStreamParser.swift \
  ios/Runner/NovaSpaceScope.swift ios/Runner/LocalNativeModel.swift "$checks/HostDoubles.swift"
swiftc -module-cache-path "$NOVA_CHECK_OUTPUT/cache" -I "$NOVA_CHECK_OUTPUT/modules" \
  -L "$NOVA_CHECK_OUTPUT/modules" -lFlutter -lUIKit \
  -Xlinker -rpath -Xlinker "$NOVA_CHECK_OUTPUT/modules" \
  ios/Runner/NativeModelTransfer.swift ios/Runner/ModelTransferFiles.swift ios/Runner/ModelTransferAuthority.swift ios/Runner/PrivateSpaceDirectory.swift \
  ios/Runner/ModelStreamParser.swift "$checks/HostDoubles.swift" "$checks/PrivateSpaceDirectoryChecks.swift" "$checks/ModelTransferAuthorityChecks.swift" "$checks/main.swift" \
  -o "$NOVA_CHECK_OUTPUT/native-transfer-checks"
"$NOVA_CHECK_OUTPUT/native-transfer-checks" "$files"
