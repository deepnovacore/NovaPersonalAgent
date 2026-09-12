# Terminal pairing acceptance — 2026-09-12

## Automated checks

- Runtime TypeScript build passed.
- macOS, Node 24.8.0: `node --test runtime/scripts/pair-device.test.mjs runtime/dist/test/client-pairing.test.js` — 14 passed, 2 platform-specific skips, no failures.
- Linux x86_64, Node 24.8.0: `node --test runtime/scripts/pair-device.test.mjs` — 9 passed, 1 macOS-only skip, no failures.
- Linux execution had no DISPLAY or WAYLAND_DISPLAY. The real CLI ran inside a PTY, displayed its invitation, and cancelled it after Ctrl+C. The tests used the production pairing store and loopback WebSockets, without models or Electron.
- macOS CoreImage decoded the actual ANSI terminal glyphs into the expected v1 invitation, independently of the QR encoder.
- Coverage includes silent polling, one-time redemption, replacement-code safety, interruption during creation, input closure, non-TTY/narrow terminals, authentication/connection errors, five-second timeout, and populated device lists exceeding 4 KB.

## iPhone acceptance

The user ran the terminal command against the existing macOS host, scanned with the updated iPhone Nova, confirmed the host, completed a conversation, and disconnected/reconnected. The user reported “done，没问题”. This is user-confirmed physical-device acceptance; computer-use could not control terminal applications.

## Boundaries

- Linux pairing/CLI integration passed on an alternate Linux host. The originally requested development host was unreachable by SSH; that specific host was not validated.
- Linux testing does not establish Linux model/audio deployment acceptance.
- Native Windows hosting remains unsupported; its credential-store guard is unchanged.
- The test transfer contained only pairing code, tests and dependencies, not live credentials or user data. It used a temporary Node installation without changing system services.
