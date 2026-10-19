# Android Linux runtime

The app packages ARM64 PRoot, its ELF loader, a process-session launcher, and a pinned Alpine minirootfs. It executes `/bin/sh -c` inside Alpine with the app support `nova-workspace` directory bound to `/workspace`. Android's app UID is the security boundary; PRoot is a compatibility layer, not an additional sandbox.

`LinuxWorkspaceHost` shares one runtime and rootfs installer across foreground and scheduler engines. A host registers an execution before dispatching it to a worker, so immediate cancellation cannot be lost. Cancellation kills only that command's process group. Teardown cancels only commands owned by that host. Log capture opens each directory through a pinned file descriptor and refuses symlinks; cleanup never recursively walks guest-controlled paths. Output previews are capped at 128 KiB per stream; truncated output remains in `.nova/logs/<execution-id>/`.

Commands are limited to 64 KiB and one hour. Working directories must be under `/workspace`. Only `NOVA_BROWSER_URL` and `NOVA_BROWSER_TOKEN` may enter through the channel's environment map. `PATH` includes `/workspace/.nova/bin` for the generated browser helper.

PRoot uses its default seccomp-order detection. Forcing `PROOT_NO_SECCOMP` can turn missing-path errors into `ENOSYS` under Android app-inherited filters, breaking shared-library lookup. Android host library paths are not exported into the guest.

The packaged archive uses `.tgz` because AAPT automatically expands and renames `.gz` assets. The initial Alpine archive is verified against its pinned SHA-256 and extracted into staging before an atomic rename. Existing installed filesystems and packages persist across app updates, even when the packaged base image changes. No automatic destructive base-image migration is implemented. A malformed existing installation returns `existing_rootfs_requires_recovery` rather than deleting data.

## Build

Use a mounted external disk and a session directory namespaced by canonical worktree path and chat ID. Set the Flutter build directory, `.dart_tool`, `GRADLE_USER_HOME`, temporary directory, compiler caches, and the included Flutter Gradle plugin build directory to that session before building. A Gradle init script can set `layout.buildDirectory` for the included `packages/flutter_tools/gradle` project; do not clean the shared SDK plugin output. Never run a shared clean command.

```sh
python3 tool/linux/android/build_runtime.py \
  --external-root "$NOVA_EXTERNAL_DISK" \
  --session-root "$NOVA_SESSION_ROOT" \
  --ndk "$ANDROID_SDK_ROOT/ndk/28.2.13676358"
export NOVA_ANDROID_LINUX_RUNTIME="$NOVA_SESSION_ROOT/android/linux-runtime"
flutter build apk --debug --target-platform android-arm64
```

The runtime script refuses an unmounted external root, verifies pinned downloads, builds native executables from source, and writes binaries, source archives, licenses, and a provenance manifest only beneath the supplied session root. `preBuild` fails if runtime files are missing. See `THIRD_PARTY.md` for source and distribution obligations.

## Verification

`run_unit_tests.py` compiles the Android-independent supervisor and runs its JUnit tests using the existing Gradle dependency cache. Supply `--output`, `--java-home`, and `--gradle-cache` explicitly, with output on the external disk.

`LinuxWorkspaceDeviceTest` runs against the installed APK's actual PRoot and Alpine. It covers strict root selection, file persistence, cwd, pipeline output, stderr and nonzero exit, truncation logs, timeout, cancellation, and multiple hosts sharing one runtime.

Build acceptance APKs using `-PnovaAutonomyTest=true` to isolate them as `com.nova.nova_mobile.autonomy`. The Flutter fixture `test/support/workspace_device_acceptance.dart` additionally runs the real four-tool registry, Unicode file exchange, `nova-browser` DOM evaluation, and `apk add python3` followed by script execution. Use a dedicated emulator and explicit adb serial; it prints `WORKSPACE_ACCEPTANCE_JSON` with results. Package installation needs network access to the Alpine repositories. Where the official CDN is too slow, pass the fixture-only define `NOVA_ACCEPTANCE_APK_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/alpine` (or another HTTPS Alpine mirror). The fixture writes a temporary repository list under its workspace, preserves the pinned Alpine release and package signature validation, and leaves the runtime repository defaults unchanged.

Development verification on 2026-10-19: the ARM64 APK built successfully; 7 JVM supervisor tests and 5 native instrumentation tests passed. On a dedicated ARM64 Android emulator, all 6 Flutter acceptance checks passed, including file/shell exchange, real WebView DOM execution, exit status, timeout, cancellation, and signed APK installation of Python followed by script output `45`. The package-installation check used the fixture-only Tsinghua mirror override because the default Alpine CDN was slow. This is emulator evidence, not physical Android device acceptance.
