# Nova Flutter mobile client

Migration of the public native iOS client, targeting iOS 17+ and Android 24+.
Implementation is in progress and this client is not part of the 0.3.0 release:
signed-device, Android, live-service and physical-audio acceptance are still open.
See docs/acceptance.md, docs/parity.md and docs/environment.md for actual evidence
and missing gates. The supported iPhone app remains the native one in clients/ios/Nova.
No Apple development team is committed; select yours in Xcode or pass `DEVELOPMENT_TEAM`.

Run `flutter pub get`, `flutter test`, and `flutter analyze` from this directory.
Use external SDK/cache/build storage as documented in the approved migration design.
No production endpoint or token is embedded. Development app identity is separate
from the original native application so both can coexist during comparison.

## Device connections

The Flutter app runs chat, dictation, voice and authorized Feishu collection on
this phone. Cross-device discovery, data synchronization and task delegation use
the configured Hub. Open **Devices** for device presence, connection settings and
tasks. Direct computer Runtime URLs, QR pairing and computer-chat switching have
been retired; the native iOS client is a separate implementation.

Existing local conversation messages are retained; legacy `computer` backend
metadata is migrated to `local` on load. Old Runtime keychain credentials and
snapshot caches remain untouched for recovery, but are no longer read or used.
These remote snapshot caches are not imported into local conversation history.

Build and test only in an isolated copy/output directory on the selected external
disk, namespaced by canonical worktree path and chat ID, including `TMPDIR`.

## Local agent tools

Mobile file and shell tools use a persistent `/workspace` backed by on-device Linux.
See [general agent tools](docs/general-agent-tools.md) for tool contracts, migration,
voice ownership, browser limits, and required native runtime build steps.
