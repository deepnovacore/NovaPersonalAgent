# Space Host/Client native build evidence — 2026-10-23

The final source revision `0fa8c70bbba8496eedf48f0e5848cf374f437823` passed the complete unsigned Flutter iPhone build, including the embedded notification service extension and actual iSH/Alpine runtime.

- [Successful GitHub Actions run 39984894779](https://github.com/FishWoWater/NovaAudioAgent/actions/runs/39984894779), attempt 1, branch `codex/space-host-client-acceptance-20261023`.
- [Native build job 120521405577](https://github.com/FishWoWater/NovaAudioAgent/actions/runs/39984894779/job/120521405577), successful in 5m17s.
- Workflow: [flutter-ios.yml](../../.github/workflows/flutter-ios.yml); build procedure: [build_ios.sh](../../clients/flutter/tool/ci/build_ios.sh).

## Environment and result

| Item | Observed value |
| --- | --- |
| Runner | GitHub-hosted `macos-15-arm64`, image `20260907.0337.1` |
| Operating system | macOS 15.7.9, build 24G830 |
| Xcode | 16.4, build 16F6 |
| Device SDK | iPhoneOS 18.5 |
| Flutter | 3.47.7, checked out from the release tag |
| Build | `Runner` scheme, Debug, `iphoneos`, `generic/platform=iOS`, ARM64 |
| Signing | `CODE_SIGNING_ALLOWED=NO`, `CODE_SIGNING_REQUIRED=NO` |
| Result | `** BUILD SUCCEEDED **` at 2026-10-23 16:24:01 UTC |

The log reports both `Runner.app/Runner` and `Runner.app/PlugIns/NovaNotificationService.appex/NovaNotificationService` as `Mach-O 64-bit executable arm64`. The build script additionally requires a nonempty `App.framework/App`, its `flutter_assets` directory, and the bundled `NovaAlpine/meta.db` and `NovaAlpine/data` before the job can succeed.

The pinned iSH ARM64 libraries were built for `iphoneos`; the log records `Runtime ready` at 16:22:02 UTC. Alpine was converted using the real fakefs converter and copied into the app by its resource phase. Dependency hashes and runtime patches are documented in the [runtime build instructions](../../clients/flutter/tool/linux/ios/README.md). This run used the existing SwiftPM integration and Flutter's dependency preparation, with no stub runtime, asset exclusion or replacement of the Flutter client by `clients/ios`.

Build outputs, source copies, SDK and caches were isolated below the run/attempt namespace in `RUNNER_TEMP`. The workflow uploaded `xcodebuild.log`, `FlutterRunner.xcresult` and the runtime `manifest.json` as [artifact 12516086220](https://github.com/FishWoWater/NovaAudioAgent/actions/runs/39984894779/artifacts/12516086220), named `flutter-ios-build-39984894779-1`. GitHub reported artifact SHA-256 `388888ee4f5e9a3612fb4a6eceabd427a4c4044ca3f67bdb8274533f41e2042a`; its configured retention is 14 days.

## Acceptance boundary

This proves a complete unsigned device build and packaging for that exact source revision. It does not prove installation or execution on an iPhone, provisioning/entitlement validity under a publisher's signing identity, APNs arrival, NSE delivery/decryption on a locked device, or background lifecycle behavior. Those require the signed-device checks in the [push gateway guide](../../push-gateway/README.md).

The same guide records the final-source [Android FCM and MiPush APK builds, SHA-256 hashes and 65/65 native tests](../../push-gateway/README.md#native-space-isolation). Neither Android APK was launched for real push delivery. Any following documentation-only commit leaves the tested client source unchanged; a later client/native change requires new build evidence.
