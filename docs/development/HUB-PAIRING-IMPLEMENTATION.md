# Hub pairing implementation

Approved scope: macOS + Android, Tailscale only for new QR pairing, 5-minute single-use invites, multiple devices (32 active/account), protect existing account binding. Existing manual configuration remains advanced compatibility.

Independent worktree: feature/hub-tailscale-pairing, based on 1.0dev at 72b06d78. No other feature branches imported.

## Tasks

- [x] Persistent hash-only invitations, transactional redemption and HTTP limits.
- [x] Private Unix-socket administration and restart-safe managed Hub entry.
- [x] macOS LaunchAgent lifecycle, Tailscale Serve 8443 and desktop pairing panel.
- [x] Android scanner, confirmation, credential exchange and precise errors.
- [x] Security regression, daemon/desktop/mobile integration and automated acceptance evidence.
- [ ] Physical Android camera, live Tailscale/VPN and login/logout acceptance.

## Runtime contracts

QR: `{type:"nova.hub",version:1,url,code,expires_at,hub_id,account_id}`; expiry is epoch milliseconds.
POST `/hub/v1/pairing/redeem`: `{code,device_name,hub_id,account_id}` returns `{account_id,hub_id,device_id,device_name,device_epoch,token}`. All other public API routes remain device authenticated.
Private HTTP over `admin.sock`: POST `/admin` with `{action:"status"|"invite"|"cancel"|"devices"|"revoke",url?,device_id?}`. No management bearer token is exposed to renderers.

LaunchAgent runs after app exit, restarts on failure, starts at login. Logout/sleep availability is not promised. Data survives disable/unregister. CLI-managed Hubs are not adopted.

## Validation

All generated outputs and caches use `/Volumes/sqxh-junjie/DeveloperStorage/Builds/nova-hub-pairing-9bfa96587b-01a1530f`. Never clean shared outputs. Automated checks and real device acceptance are recorded separately. No publication is part of this task.

## Implementation notes

- Managed Hub startup invalidates outstanding invitations, while preserving Hub/account/device identities. Store-level invitation persistence is still tested independently.
- Startup restore and user lifecycle actions share one queue; stopping works even if Tailscale is down.
- First-time QR pairing validates the actual state identity against the scanned identity before storing credentials.
- New phone dependencies: mobile_scanner 7.4.2 (BSD-3-Clause, Flutter generated license registry); Android minimum SDK remains 24. Desktop qrcode 1.5.4 was already locked by runtime and is now an explicit desktop dependency (MIT).
- macOS has no automatic updater integration. Manual app replacement requires stopping Hub first; next app launch restores the registered path/version.

## Evidence, 2026-10-19

- Runtime: TypeScript compile and targeted ESLint passed; 65 Hub tests passed (`hub-test.log`).
- Desktop: final selected suite passed 100 tests (`desktop-final-test.log`), including phone compatibility, IPC restrictions and cyclic package staging.
- Flutter: 38 affected tests passed across 9 files, including 9 real HTTPS transport tests and managed-Hub Todo/Idea/Goal sync with revocation. The separately gated legacy two-client roundtrip also passed with `--dart-define=NOVA_HUB_TEST=true` (`verify-hub_roundtrip-enabled.log`).
- Flutter analyze: no issues (`flutter-analyze-final.log`).
- Android debug APK built successfully (`flutter-build/app/outputs/flutter-apk/app-debug.apk`), SHA-256 `f0256aee0eb98f4ea86eb02785658344f8250f2e913d1be1ec44b3fef55df188`.
- macOS arm64 directory package built at `desktop-dist/mac-arm64/Nova Personal Agent Desktop.app`, ad-hoc signed, not notarized or published. All 156 desktop source files and 381 runtime JavaScript files were compared with the archive. `app.asar` SHA-256: `51c0fa4f35e9b2b5f354007ea9c546603d6679e172fd0cfb1cfebc2eac8558ec`.
- Actual packaged Electron/LaunchAgent smoke passed: private socket mode, QR PNG, single use, crash restart, restart cancels invitations, stable identity and devices, revocation, version restore, persistent stop, and removal preserving data. Temporary jobs cleaned up; evidence: `desktop-evidence/packaged/launchagent-result.json` and `desktop-evidence/package-result.json`.
- Settings panel rendered with the final copy; UI evidence: `desktop-evidence/hub-panel-fixture.png`.
- Earlier full Flutter attempts stalled; a later compiler run explicitly reported internal temporary disk ENOSPC. Compiler scratch now uses the isolated external `flutter-tmp` directory, in addition to external build and package caches. Final full-suite rerun passed: 772 tests, 4 explicitly skipped (`flutter-full-final.log`, exit 0).
- Physical Android camera, live tailnet/VPN conflict, macOS login/logout and a production application upgrade are not yet verified. Automated native tests use unique development LaunchAgents, random ports and temporary data; no personal databases or production network mappings were used.
