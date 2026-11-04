# iOS Linux runtime

`build_runtime.py` builds the actual ARM64 iSH kernel/emulator and converts Alpine into fakefs (`meta.db` plus `data`). No unavailable-runtime implementation is shipped. `NovaLinux.xcconfig` links the libraries; the Xcode resource phase bundles `NovaAlpine` and fails if they are absent.

Dependencies:

- OpenMinis iSH ARM64 `e6521d9cfe9cd48f19917fc3b23aea622ba358b4`, archive SHA-256 `48fea8b9d713c79581148b19f17d828b79e487adf7058d998aa08ef9d06fa07c`. Upstream iSH is GPL-3.0; the fetched source includes its license. Build applies the Darwin `posix_spawn_file_actions_addchdir_np` compatibility spelling and adds an inherited `nova_execution_id` field to each task group. Rebuild all platform libraries after this ABI change; the script does so through Ninja dependency tracking.
- Alpine minirootfs 3.21.0 aarch64, SHA-256 `f31202c4070c4ef7de9e157e1bd01cb4da3a2150035d74ea5372c5e86f1efac1`. Package licenses and installed versions are recorded in the Alpine package database. Additional packages use Alpine's signed APK repositories.
- Vendored Objective-C glue is OpenMinis `b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c`; exact original files/hashes and modifications are recorded in `ios/Vendor/OpenMinis/UPSTREAM.json`, with its GPL-3.0 license alongside.
- Build tooling uses Meson 1.7.2 and Ninja 1.11.1.4. LLVM `ld.lld` is required for the ARM64 VDSO; an installed Android NDK linker can supply it. The build-time fakefs converter also requires libarchive.

Run from the repository root, with `NOVA_LINUX_ROOT` on internal storage in the canonical-worktree/chat namespace:

```sh
python3 clients/flutter/tool/linux/ios/build_runtime.py --output-root "$NOVA_LINUX_ROOT" --sdk iphoneos
python3 clients/flutter/tool/linux/ios/build_runtime.py --output-root "$NOVA_LINUX_ROOT" --sdk macosx
NOVA_LINUX_ROOT="$NOVA_LINUX_ROOT" bash clients/flutter/tool/linux/ios/check_runtime.sh
```

All generated libraries, rootfs resources, virtual environments, temporary files and compiler caches stay under that explicit internal directory. No shared output directory is selected automatically. Set Xcode `NOVA_LINUX_ROOT`, `FLUTTER_BUILD_DIR`, derived data and compiler cache locations to the same namespace; use iOS 17 or newer and ARM64. C11 is required by iSH headers. Device builds must use the `iphoneos` libraries, simulator builds `iphonesimulator`.

`check_runtime.sh` runs standalone Swift channel validation, the hostile log-directory symlink regression, and real iSH Linux commands on a macOS ARM64 host. Guest checks cover Unicode paths shared with native files, pipelines, separate stderr, exit status, timeout, cancellation, stubborn descendants, unrelated concurrent commands, UTF-8 truncation and real log paths. Set `NOVA_TEST_INSTALL_PYTHON=1` to additionally install Python using APK and execute it; this requires working guest network access. `NOVA_TEST_APK_REPOSITORY` can select a signed Alpine v3.21 repository for this optional host check without changing the shipped repository configuration. Host harness success does not replace the app/device acceptance fixture at `test/support/workspace_device_acceptance.dart`.

The process owns one immutable runtime/workspace mapping. Each Flutter engine owns a separate execution ID namespace, and disposing a headless engine cancels only its commands. The scheduled engine installs the same workspace and browser hosts. Background-task expiration cancels the affected command; iOS suspension/force termination cannot guarantee an observed exit. Results remain `outcome_unknown` when exit cannot be confirmed.

The only writable application-content mount is the selected workspace. DNS mounts one dedicated runtime file, never an application database or credential directory. The host environment is not inherited: native execution supplies fixed Linux defaults plus the validated browser bridge URL/token. Host-side logs use descriptor-relative operations with `O_NOFOLLOW`, and cancellation and successful completion clean up tasks by their inherited execution token, including reparented or detached descendants. Exit notifications carry that token so a recycled PID cannot retire another command.

Development verification on 2026-10-19: full unsigned iOS Debug app build succeeded with actual libraries/resources; host guest lifecycle checks passed. The host check also installed Python with APK and executed the JSON read/write check using the signed Tsinghua Alpine v3.21 mirror after the default repository connection timed out; package signature verification remained enabled. The isolated signed iPhone fixture passed all six checks: shared workspace file/shell access, browser DOM commands, exit/stderr reporting, timeout, cancellation, and signed APK installation of Python followed by script execution. The Python check used the test-only Tsinghua Alpine mirror override. Initial device DNS sends failed with `Host is unreachable`; a test-only URLSession/NWPath probe recorded the app network permission restriction and a subsequent HTTP 200, and all six checks passed after network access was allowed. Native probes are compiled only with `NOVA_WORKSPACE_ACCEPTANCE`; raw device diagnostics remain outside the repository. No simulator or diagnostic asset-exclusion build is a substitute for that evidence.

## GitHub Actions compile verification

`.github/workflows/flutter-ios.yml` builds the Flutter `Runner` scheme and embedded
`NovaNotificationService` on a disposable macOS 15 ARM64 runner with Flutter
3.47.7, the project's SwiftPM integration (CocoaPods fallback when needed) and
the real pinned iSH/Alpine runtime. It checks the resulting
main executable, NSE executable, Flutter assets and fakefs payload. This is an
unsigned device build, not an APNs delivery or physical-device acceptance test.

CI explicitly passes `--ci-runner-temp` to the runtime builder and
`NOVA_CI_RUNNER_TEMP=1` to its packaging phase. Both enforce `GITHUB_ACTIONS=true`
and a canonical path strictly below `RUNNER_TEMP`; local builds use an explicit isolated directory on internal storage. Build sources, outputs and caches are namespaced by
Actions run ID and attempt. Flutter uses a relative `.build` symlink into that
namespace because its build-dir setting rejects absolute paths. No shared build
cache is restored. The workflow
uploads the Xcode log, result bundle and dependency manifest even on failure.

After the workflow is available on an authorized remote branch, run:

```sh
gh workflow run flutter-ios.yml --ref <branch>
gh run list --workflow flutter-ios.yml --branch <branch>
gh run watch <run-id> --exit-status
```

Only a successful run for the exact revision provides compile evidence. Merely
adding or statically validating this workflow does not prove an iOS build passed.

## Baked document base set

New installations include Python 3.12.16, py3-pip, openpyxl 3.1.5, pypdf 6.1.1,
ReportLab 4.4.4, Pillow 13.0.0, charset-normalizer 3.5.2 and et_xmlfile 2.0.0.
The owner-approved static-400 common-character TrueType font is at
`/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf`; OFL text/copyright remain
beside it, under `/usr/share/licenses/nova-document-font/`, and in the Flutter
application licence registry. This is a GB2312-oriented subset, not all CJK.
Check glyph coverage; if the font is absent, explain the limitation rather than
produce garbled PDFs. See [locks and reproducible build](../documents/README.md).

The build now requires a running Docker daemon with internal VM storage and the
two digest-pinned ARM64 Alpine images pulled as described there. All rootfs
installation/smoke steps use `--network=none`; fetching fixed-hash inputs happens
on the host beforehand. Use `--docker /opt/homebrew/bin/docker` if needed and
`--verify-reproducible` to build twice and compare file/archive/package hashes.
`--without-font` is a size-comparison option, not the production default.

**Upgrade path:** existing installed filesystems are never replaced or merged.
An upgraded app with an old bare rootfs still uses its existing packages and
**does not automatically gain this offline base set**. Detect via
`/usr/share/nova/document-base.json` (outside `/workspace`) and verify imports.
Those users retain the documented authorized on-demand install/download path,
which requires network; report missing dependencies honestly. No automatic
migration, user-data deletion, or reset is introduced. A fresh app installation
gets the baked image. Do not recommend uninstalling without backing up user data.

The default `workspace_device_acceptance.dart` uses the baked Python/font smoke
and blocks Python socket connections; it runs no APK/pip/download commands or
network diagnostics. Legacy network-install measurements require explicit
`--dart-define=NOVA_ACCEPTANCE_ON_DEMAND=true`. Acceptance reports include import,
XLSX, PDF and CJK round-trip timings and RSS when implemented by the guest.
App Review 2.5.2 and Apple's policy on executable code inside the rootfs remain
**unverified**; preinstallation does not establish approval.

The builder bakes a canonical tar first, then runs `fakefsify` on that tar.
`resources/NovaAlpine.sha256` ties the fakefs to the exact baked archive. A stale
existing fakefs fails instead of silently being reused: select a new isolated
output root. The package phase requires the marker and document manifest.
`meta.db` and data size are recorded in the runtime manifest. Simulator ARM64
libraries still require a separate `--sdk iphonesimulator` build.

CI note: the existing macOS GitHub Actions job now also needs a Docker daemon
and these pinned images. Its previous native-only toolchain setup is not enough: **the CI build will fail
without that dependency**. The workflow is intentionally unchanged; a follow-up
task must supply a Docker-capable runner or a lock-driven prebuilt rootfs
artifact/cache stage. No successful CI run for this change has been claimed.
