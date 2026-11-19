# Android Linux runtime

The app packages ARM64 PRoot, its ELF loader, a process-session launcher, and a pinned Alpine minirootfs. It executes `/bin/sh -c` inside Alpine with the app support `nova-workspace` directory bound to `/workspace`. Android's app UID is the security boundary; PRoot is a compatibility layer, not an additional sandbox.

`LinuxWorkspaceHost` shares one runtime and rootfs installer across foreground and scheduler engines. A host registers an execution before dispatching it to a worker, so immediate cancellation cannot be lost. Cancellation kills only that command's process group. Teardown cancels only commands owned by that host. Log capture opens each directory through a pinned file descriptor and refuses symlinks; cleanup never recursively walks guest-controlled paths. Output previews are capped at 128 KiB per stream; truncated output remains in `.nova/logs/<execution-id>/`.

Commands are limited to 64 KiB and one hour. Working directories must be under `/workspace`. Only `NOVA_BROWSER_URL` and `NOVA_BROWSER_TOKEN` may enter through the channel's environment map. `PATH` includes `/workspace/.nova/bin` for the generated browser helper.

PRoot uses its default seccomp-order detection. Forcing `PROOT_NO_SECCOMP` can turn missing-path errors into `ENOSYS` under Android app-inherited filters, breaking shared-library lookup. Android host library paths are not exported into the guest.

The packaged archive uses `.tgz` because AAPT automatically expands and renames `.gz` assets. The baked archive is verified against its generated SHA-256 (the base archive and added inputs are separately locked) and extracted into staging before an atomic rename. Existing installed filesystems and packages persist across app updates, even when the packaged base image changes. No automatic destructive base-image migration is implemented. A malformed existing installation returns `existing_rootfs_requires_recovery` rather than deleting data.

## Build

Use internal storage and a session directory namespaced by canonical worktree path and chat ID. Never write to or require an external disk. Set the Flutter build directory, `.dart_tool`, `GRADLE_USER_HOME`, temporary directory, compiler caches, and the included Flutter Gradle plugin build directory to that session before building. A Gradle init script can set `layout.buildDirectory` for the included `packages/flutter_tools/gradle` project; do not clean the shared SDK plugin output. Never run a shared clean command.

```sh
python3 tool/linux/android/build_runtime.py \
  --session-root "$NOVA_SESSION_ROOT" \
  --ndk "$ANDROID_SDK_ROOT/ndk/28.2.13676358"
export NOVA_ANDROID_LINUX_RUNTIME="$NOVA_SESSION_ROOT/android/linux-runtime"
flutter build apk --debug --target-platform android-arm64
```

The runtime script requires an explicit absolute internal session root (not `/Volumes`), verifies pinned downloads, builds native executables from source, and writes binaries, source archives, licenses, and a provenance manifest only beneath the supplied session root. `preBuild` fails if runtime files are missing. See `THIRD_PARTY.md` for source and distribution obligations.

## Verification

`run_unit_tests.py` compiles the Android-independent supervisor and runs its JUnit tests using the existing Gradle dependency cache. Supply `--output`, `--java-home`, and `--gradle-cache` explicitly, with output in the same isolated internal namespace.

`LinuxWorkspaceDeviceTest` runs against the installed APK's actual PRoot and Alpine. It covers strict root selection, file persistence, cwd, pipeline output, stderr and nonzero exit, truncation logs, timeout, cancellation, and multiple hosts sharing one runtime.

Build acceptance APKs using `-PnovaAutonomyTest=true` to isolate them as `com.nova.nova_mobile.autonomy`. The Flutter fixture `test/support/workspace_device_acceptance.dart` additionally runs the real four-tool registry, Unicode file exchange, `nova-browser` DOM evaluation, and baked offline Python/document execution. Use a dedicated emulator and explicit adb serial; it prints `WORKSPACE_ACCEPTANCE_JSON` with results. The opt-in legacy `NOVA_ACCEPTANCE_ON_DEMAND=true` mode needs network access to the Alpine repositories. Where the official CDN is too slow, pass the fixture-only define `NOVA_ACCEPTANCE_APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine` (or another HTTPS Alpine mirror). The fixture writes a temporary repository list under its workspace, preserves the pinned Alpine release and package signature validation, and leaves the runtime repository defaults unchanged.

Development verification on 2026-10-19: the ARM64 APK built successfully; 7 JVM supervisor tests and 5 native instrumentation tests passed. On a dedicated ARM64 Android emulator, all 6 Flutter acceptance checks passed, including file/shell exchange, real WebView DOM execution, exit status, timeout, cancellation, and signed APK installation of Python followed by script output `45`. The package-installation check used the fixture-only Tsinghua mirror override because the default Alpine CDN was slow. This is emulator evidence, not physical Android device acceptance.

## Baked document base set

New installations include Python 3.12.16, py3-pip, openpyxl 3.1.5, pypdf 6.1.1,
ReportLab 4.4.4, Pillow 13.0.0, charset-normalizer 3.5.2, et_xmlfile 2.0.0,
python-docx 1.2.0, lxml 6.1.3 and typing_extensions 4.15.0. DOCX creation/readback
is checked with Chinese text extracted from a PDF, without network access.
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
