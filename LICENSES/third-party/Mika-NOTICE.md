# Mika

- Project: https://github.com/wangzan101/Mika
- Upstream revision: `5f630d9` (imported 2026-11)
- License: Apache-2.0 (text: `LICENSES/Apache-2.0.txt`)
- Upstream NOTICE:

```
Mika
Copyright 2026 wangzan101
```

Nova reuses, with modifications, parts of Mika's Android phone-control stack, its provider setup and some interface
copy. Every derived source file carries a header naming Mika, the upstream revision and a one-line description of
Nova's changes. What was derived, by area (paths relative to `clients/flutter`):

| Area | Mika source (upstream) | Nova files |
| --- | --- | --- |
| ADB client: SPAKE2 pairing, TLS connection, identity, connect-port discovery, local port scan (with tests and SPAKE2 vectors) | `core/adb/*` | `android/phone-core/src/{main,test}/kotlin/com/nova/phone/core/adb/*`, `android/phone-core/src/test/resources/adb/spake2-vectors.txt` |
| Shell helper handoff: handoff gate, helper link, built-in shell engine, pairing screen and setup-flow projection (with tests) | `core/shell/*` | `android/phone-core/src/{main,test}/kotlin/com/nova/phone/core/shell/*` |
| Element locator and relocation | `core/uistate/Accuracy.kt` | `android/phone-core/.../uistate/Accuracy.kt` (and tests) |
| Shell helper process, hub/provider handoff, shell context (keeps the scrcpy attribution), Android ADB and NSD discovery | `cap/phone/shell/*`, `shell/HelperMain.kt` | `android/app/.../phone/shell/{HelperMain,HelperProcess,HelperHub,ShellContext}.kt`, `phone/shell/adb/*` |
| Helper Binder service (reduced subset, explicit transaction ids) | `ShellService.kt`, `IMikaShell.aidl` | `android/app/.../phone/shell/NovaShellService.kt`, `android/app/src/main/aidl/.../INovaShell.aidl`, `test/.../shell/DisplayFlagsTest.kt` |
| Virtual display: agent display, lazy display, frame math | `cap/phone/display/*` | `android/app/.../phone/display/{AgentDisplay,LazyDisplay,FrameMath}.kt` (and tests) |
| Accessibility on the virtual display: node ids, numbered snapshot reader, display-scoped windows/gestures/events, screen actions subset | `cap/phone/a11y/*`, `AndroidScreen.kt` | `android/app/.../phone/a11y/{NodeIds,SnapshotReader,VirtualScreen}.kt`, the virtual-display section of `LocalGuiService.kt`, `phone/Snapshot.kt` (shape) |
| Takeover state machine (single-task rewrite) and self-check | `takeover/Takeover.kt`, `selfcheck/AndroidSelfCheck.kt` | `android/app/.../phone/{Takeover,VirtualSelfCheck}.kt` |
| Pairing: coordinator, pairing-code reader, notifier, built-in shell manager (watchdog), sliding deadline, developer-settings pages, setup copy | `cap/phone/setup/*`, `PhoneSetupCopy` | `android/app/.../phone/setup/*` (and tests) |
| Provider presets, model catalog/listing, tool-call probe and setup copy | `settings/ProviderPresets.kt`, `core/model/ModelCatalog.kt`, `ProviderStore.probe`, `ModelSetupCopy` | `lib/agent_core/{model_presets,model_catalog,model_probe}.dart`, `lib/ui/provider_setup_copy.dart` |
| Flutter reimplementations of layout, interaction rules and copy (no Mika code or assets) | `ModelSetupScreen.kt`, `PhoneOpsScreen`/`SelfCheckScreen.kt`, `PhoneSetupScreen`, `AgentPip.kt`, `RunTimelineScreen`/chat step rows | `lib/ui/{provider_setup_page,phone_control_page,phone_setup_copy,phone_setup_wizard,virtual_screen_pip,tool_timeline}.dart` |

Not derived from Mika: the floating pet (`packages/nova_audio`, an extension of Nova's own call overlay), the Dart
phone channel and run tracking (`lib/agent/phone_*.dart`, `lib/voice/phone_task_pet.dart`), the native bridge
(`phone/PhoneBridge.kt`), the agent loop, journal and approval code. Apache-2.0 material is combined into Nova under
GPL-3.0-or-later; the Apache-2.0 attribution and NOTICE obligations above continue to apply to that material.
Mika's name, logo, images and release binaries are not redistributed. Tests for derived units that have no Mika
counterpart (for example `NodeIdsTest`, `SnapshotReaderTest`, `NovaShellServiceTest`) were written by Nova and carry
no Mika header; tests copied from Mika keep it.

## scrcpy (via Mika)

- Project: https://github.com/Genymobile/scrcpy — Apache-2.0, Copyright (C) Genymobile / Romain Vimont.
- Mika's shell-context technique (system Context obtained as the shell user) follows scrcpy; the derived Nova file keeps
  that attribution in its header. Nova took this code from Mika revision `5f630d9`, not directly from a scrcpy release,
  so the applicable scrcpy revision is the one Mika consulted.
