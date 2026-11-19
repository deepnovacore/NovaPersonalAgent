#!/usr/bin/env bash
# Run on a disposable GitHub Actions macOS ARM64 runner; never bypass real assets.
set -euo pipefail
: "${NOVA_CI_ROOT:?Set the isolated RUNNER_TEMP build namespace}"
: "${NOVA_LINUX_ROOT:?Set the iSH build namespace}"
[[ "${GITHUB_ACTIONS:-}" == true && "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]
repo_root="$(cd "$(dirname "$0")/../../../.." && pwd)"
mkdir -p "$NOVA_CI_ROOT/source"
# Keep CocoaPods, Flutter ephemeral files and all generated sources out of checkout.
rsync -a --exclude=.git --exclude=build --exclude=.dart_tool --exclude=Pods \
  "$repo_root/clients/flutter/" "$NOVA_CI_ROOT/source/flutter/"
cd "$NOVA_CI_ROOT/source/flutter"
# Flutter requires build-dir and Generated.xcconfig's FLUTTER_BUILD_DIR to
# be relative to FLUTTER_APPLICATION_PATH. The link keeps outputs isolated.
mkdir -p "$NOVA_CI_ROOT/flutter-build"
ln -s "$NOVA_CI_ROOT/flutter-build" .build
flutter config --enable-swift-package-manager --build-dir=.build
flutter precache --ios
flutter pub get --enforce-lockfile
flutter build ios --debug --no-codesign --config-only
# --config-only already resolves SwiftPM and installs any CocoaPods fallback.
# Confirm Flutter emitted the expected relative setting before invoking Xcode.
grep -qx 'FLUTTER_BUILD_DIR=.build' ios/Flutter/Generated.xcconfig
python3 tool/linux/ios/build_runtime.py --output-root "$NOVA_LINUX_ROOT" --sdk iphoneos --ci-runner-temp
xcodebuild build -workspace ios/Runner.xcworkspace -scheme Runner \
  -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$NOVA_CI_ROOT/derived" \
  -resultBundlePath "$NOVA_CI_ROOT/FlutterRunner.xcresult" \
  NOVA_LINUX_ROOT="$NOVA_LINUX_ROOT" NOVA_CI_RUNNER_TEMP=1 \
  RUNNER_TEMP="$RUNNER_TEMP" GITHUB_ACTIONS=true \
  FLUTTER_BUILD_DIR=.build \
  CLANG_MODULE_CACHE_PATH="$NOVA_CI_ROOT/clang-cache" \
  COMPILATION_CACHE_CAS_PATH="$NOVA_CI_ROOT/compilation-cache" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  2>&1 | tee "$NOVA_CI_ROOT/xcodebuild.log"
app="$NOVA_CI_ROOT/derived/Build/Products/Debug-iphoneos/Runner.app"
test -s "$app/Runner"
test -s "$app/PlugIns/NovaNotificationService.appex/NovaNotificationService"
test -s "$app/NovaAlpine/meta.db"
test -d "$app/NovaAlpine/data"
test -s "$app/Frameworks/App.framework/App"
test -d "$app/Frameworks/App.framework/flutter_assets"
file "$app/Runner" "$app/PlugIns/NovaNotificationService.appex/NovaNotificationService"
# A successful job proves both the main executable and embedded extension built.
printf 'Verified Runner, NSE, Flutter assets and real Alpine fakefs.\n' >> "$GITHUB_STEP_SUMMARY"
