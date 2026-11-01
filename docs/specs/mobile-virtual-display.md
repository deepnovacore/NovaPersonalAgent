# Android native phone control: virtual display contract

Status: contract (phase 0). Code that implements it lives on the M2/M3 branches. Changing anything in
this file, `INovaShell.aidl` or `clients/flutter/android/app/src/main/kotlin/com/nova/nova_mobile/phone/{PhoneControl,PhoneEvents,Snapshot,PhoneAction}.kt`
is a contract change and needs supervisor approval. Pairing, helper and virtual-display code is derived
from Mika (Apache-2.0, commit `5f630d9`); the scrcpy attribution in `ShellContext.kt` is kept.

Scope: Android Flutter client, standalone Space only. Hub/client mode and `clients/ios/Nova` are unchanged.

## Architecture

```
Flutter ── nova/phone/v1 (MethodChannel, JSON strings) ───────┐
        ◄─ nova/phone/events (JSON) / nova/phone/frames (JPEG) ┤  app process (uid = Nova)
                                                               │
 PairingCoordinator ─ AdbPairing(SPAKE2) ─► local adbd ◄─ AdbConnection(TLS) ─ BuiltinShellManager (watchdog)
                                              │ exec: "read n; (echo $n | CLASSPATH=<base.apk> setsid app_process
                                              │        /system/bin --nice-name=<pkg>:helper <HelperMain> <pkg> <uid> <certPin> &); read _"
                                              ▼
        helper process (uid 2000) HelperProcess ─ NovaShellService : INovaShell.Stub
                                              │ getContentProviderExternal("<pkg>.helper").call("attach", {nonce, binder, uid, pid, apk})
                                              ▼
 HandoffProvider (exported) ─► HelperHub.offer ─► ShellProvider.shell : INovaShell?
                                                     │ createDisplay(ImageReader.surface) / startApp / inject* / moveTask
 AgentDisplay (ImageReader) ◄── frames ──────────────┘
 LocalGuiService (one a11y service) ─ windowsOnAllDisplays[displayId] ─► numbered PhoneSnapshot ─► LocalToolLoop
```

1. **Pairing**: user opens Developer options > Wireless debugging > Pair with code. NSD finds `_adb-tls-pairing._tcp`; the
   code is read from the settings window through accessibility, or entered via `submitCode` / a RemoteInput notification.
   The ADB identity key is wrapped with Android Keystore AES-GCM in `noBackupFilesDir`.
2. **Self-ADB**: the connect port comes from `service.adb.tls.port`, cache, mDNS or a local port scan; TLS 1.3 to `127.0.0.1`.
3. **Helper**: `exec:` runs the command above. `HelperMain` is `com.nova.nova_mobile.phone.shell.HelperMain`; it must stay in
   `base.apk` and be kept by R8 together with `HelperProcess.main`, `NovaShellService` and the AIDL stub.
4. **Handoff**: the helper calls the provider `attach` method; `HelperHub` accepts after the checks in [Security invariants](#security-invariants)
   and replies with the next nonce and an app token Binder used by the helper for death notification.
5. **Virtual display**: `AgentDisplay` owns an `ImageReader` (RGBA_8888, 2 buffers) whose surface goes to `createDisplay`.
   The same reader feeds model screenshots (no `takeScreenshot`, no 500 ms throttle) and preview frames. Flags:
   `PUBLIC|OWN_CONTENT_ONLY|SUPPORTS_TOUCH|ROTATES_WITH_CONTENT|DESTROY_CONTENT_ON_REMOVAL`, plus API 33+ `TOUCH_FEEDBACK_DISABLED`,
   API 33+ trusted `TRUSTED|OWN_DISPLAY_GROUP|ALWAYS_UNLOCKED`, API 34+ trusted `OWN_FOCUS|STEAL_TOP_FOCUS_DISABLED`. IME policy LOCAL.
   The display is created lazily on the first `open_app` (the run's own launch of `target_package` is that first `open_app`)
   and released when the run ends.
6. **Accessibility on displayId**: `LocalGuiService` (no second service) reads `windowsOnAllDisplays[displayId]`, dispatches
   gestures with `GestureDescription.Builder().setDisplayId(displayId)`, finds input focus inside that display's window tree
   (never `rootInActiveWindow`), and filters events by `AccessibilityEvent.displayId` (API 33+) or window id. The XML config
   adds only `typeWindowsChanged`; notification events stay off. `flagIncludeNotImportantViews` is set at runtime through
   `serviceInfo` only while a virtual run is active and the original flags are restored when it ends, so the main-tier
   tree and fingerprint stay byte-for-byte unchanged. Gesture failure falls back to `injectTap`/`injectStroke`; keys always use `injectKey`.

## Capability tiers

`PhoneTier` is chosen once when a run starts and is fixed for that run.

| Tier | Condition | Behaviour |
|---|---|---|
| `virtual` | api >= 31, accessibility on, helper `running` | Apps run on the helper display; user keeps the main screen. |
| `virtual` + `experimental` | as above with api 31..33 | Same, with a settings warning: main-screen focus may be taken briefly. |
| `main` | anything else | Existing main-screen path (`LocalGuiService.observe/perform`), unchanged, legacy action set. |

Helper loss during a virtual run interrupts it with `helper_unavailable`; it never switches to `main` mid-run, because
that would take over the user's screen. Reasons keep the loop's stage prefix (`observation_helper_unavailable`,
`tool_helper_unavailable`). A main run keeps its 5 min budget; a virtual run gets 15 min (5 min of agent time plus up to
10 min of takeover). `RunFence` itself is unchanged.

### App scope (virtual tier)

The user consents to one app, the run's `target_package`. `open_app` accepts only `target_package` (anything else, and
always Nova's own package, fails with `app_not_allowed`). Observations and actions are allowed while the display's
foreground package is `target_package` or a system mediator: `android`, `com.android.permissioncontroller`,
`com.google.android.permissioncontroller`, `com.android.systemui`, `com.android.documentsui`,
`com.android.intentresolver` or the default IME package. Any other foreground package stops acting and starts a takeover
(`by:"model"`, `reason:"outside_target_app"`); if the takeover cannot start, the run is interrupted with
`observation_outside_target_app`. The first observation after launch keeps the existing launch grace (it waits for an
allowed package). Nova's own package is never allowed. Chat, workbench `device.run_task` and voice delegation all reach
`NativeChatTaskRunner` → `nova/local_agent/v1 run`; native code picks the tier.

## Numbered snapshots

Virtual-tier observations are `PhoneSnapshot` (`Snapshot.kt`):
`{snapshot_id:"ph-<uuid>", tier:"virtual", package?, width, height, elements:[...], image:<base64 JPEG>, changed_during_read, secure_frame}`;
element `{ref:"@eN", role, name, bounds:[l,t,r,b] 0..999, resource_id?, clickable, editable, scrollable, focused, secret}`.

- Elements are visible nodes at least 5 px in size that have a name or are clickable/editable/scrollable, deduplicated by `role|name|bounds`, numbered from `@e1` in reading order.
- `NodeIds` keeps the last `SNAPSHOT_KEEP = 4` snapshots. Lookup: current snapshot and the node still `refresh()`es with
  the same locator → use it; old snapshot or a changed node → `relocate()` (role+name+resourceId unique before and after, bounded move,
  same preceding label; semantic name changes do not match) → found → act on the new node; otherwise `ref_expired`.
- `ref_expired` is handled like `screen_changed`: observe again and ask the model (shares the `stalePlans < 3` budget). The old action is never retried.
- `secret` elements: `type` into them fails with `private_input_requires_user`. Their names carry only the hint or label.
- `secure_frame` (FLAG_SECURE): the image is black. The model should call `hand_to_user`.
- Main tier keeps the existing `{package, tree, fingerprint, width, height, image}` observation.

## Action schema

`ToolDecision` keeps `{kind: action|complete|wait|observe, summary, action}`. `action` is parsed by a pure
`PhoneActionParser.parse(action, tier)` (`PhoneAction.kt`): exact key sets, no extra keys, deterministic, no I/O.

| `type` | Keys (exact) | Tiers | Rules |
|---|---|---|---|
| `tap` | `ref, snapshot_id` | virtual | ref matches `^@e[1-9][0-9]{0,3}$`; snapshot_id 1..64 chars, prefix `ph-` |
| `tap` | `x, y` | both | finite numbers in 0.0..1.0 (unchanged) |
| `swipe` | `x, y, to_x, to_y` | both | as today |
| `type` | `text` [+ `ref, snapshot_id`] | both (ref: virtual) | text string <= 4000; ref and snapshot_id both present or both absent |
| `scroll` | `direction` [+ `ref, snapshot_id`] | virtual | direction in `up|down|left|right` |
| `open_app` | `package` | virtual | `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$`, <= 255; anything but the run's `target_package` (and always Nova's own package) → `app_not_allowed` at execution |
| `back` | (none) | both | |
| `hand_to_user` | `reason` | virtual | trimmed string 1..500 chars; needs no ActionApproval; starts a takeover |

Parse errors (IllegalArgumentException, reported as `model_<code>`): `unsupported_action` (unknown type or wrong tier),
`invalid_action_fields`, `invalid_coordinate`, `invalid_input`, `invalid_ref`, `invalid_snapshot_id`, `invalid_direction`,
`invalid_package`, `invalid_reason`. Execution errors (IllegalStateException, reported as `tool_<code>`): `ref_expired`,
`ref_not_editable`, `ref_not_scrollable`, `no_focused_input`, `private_input_requires_user`, `app_not_launchable`,
`app_in_use_on_main` (START_IN_USE_ON_MAIN), `app_not_allowed`, `display_unavailable`, `helper_unavailable`,
`takeover_unavailable`, `takeover_timeout`. M3 adds the new codes to the `LocalToolLoop` safe-code sets; `RunFence`,
`ActionApproval` and `LocalAgentJournal` semantics are unchanged.

## Channels

### MethodChannel `nova/phone/v1`

Arguments and results are JSON strings, as in `nova/local_agent/v1`. Errors use `result.error("phone_error", <safe code>, null)`.
Android-only; Dart guards with `Platform.isAndroid`.

| Method | Args | Result |
|---|---|---|
| `status` | `{}` | `PhoneStatus` |
| `openSettings` | `{kind: accessibility\|overlay\|battery\|developer\|wireless_debugging\|wifi}` | `{opened: bool}` |
| `startPairing` | `{}` | `PhoneStatus` (pairing `searching`; idempotent, restarts the 10 min sliding window) |
| `submitCode` | `{code: "123456", port?: int}` | `PhoneStatus` after the pairing attempt (failure in `helper_failure`) |
| `ensureHelper` | `{}` | `PhoneStatus` immediately; progress arrives as `status` events |
| `unpair` | `{}` | `PhoneStatus` (nonces cleared, shell dropped, key forgotten) |
| `selfCheck` | `{}` | `{checks:[{id, ok, detail?}]}`; ids `helper`, `create_display`, `start_app`, `read_tree`, `tap`, `type`, `back`, `main_focus` |
| `setPreview` | `{visible: bool}` | `{}` |
| `takeover` | `{task_id}` | `{state: TakeoverState}` |
| `handBack` | `{task_id}` | `{state: TakeoverState}` |

`PhoneStatus` = `{schema_version:1, api_level, tier:"virtual"|"main", experimental, accessibility, overlay, battery_whitelisted,
pairing:"unpaired"|"searching"|"paired", pairing_port?, helper:"unsupported"|"not_paired"|"wireless_debugging_off"|"connecting"|"running"|"failed",
helper_failure?:"wrong_code"|"pairing_window_closed"|"no_wifi"|"wifi_not_allowed"|"connect_failed"|"authorization_revoked"|"key_unreadable"|"helper_start_failed"|"unknown",
helper_fix?:"retry"|"re_pair"|"open_wifi"|"open_wireless_debugging"}`.

### EventChannel `nova/phone/events`

Each event is a JSON string object:

- `{type:"status", status: PhoneStatus}`
- `{type:"step", task_id, step, tool, label, status:"running"|"completed"|"failed"|"unknown", changed?, ref?, tier}`. Each
  (task_id, step) is sent as `running` and then once with its final status. `label` never contains typed text.
- `{type:"takeover", task_id, state:"requested"|"active"|"returned"|"timed_out"|"failed", by:"model"|"user", reason?}`
- `{type:"done", task_id, outcome:"completed"|"failed"|"cancelled"|"interrupted", reason?, summary?, steps, duration_ms}`

### EventChannel `nova/phone/frames`

Binary JPEG per event (`Uint8List`), shown with `Image.memory(gaplessPlayback: true)`. Frames are sent only when there is a listener,
the last `setPreview` was `visible:true` and a virtual display exists. Limits: at most 8 fps, width 360..480, quality 65, identical frames skipped.
No frames are sent during takeover or for secure (black) frames; Dart shows a placeholder. `Texture`/`SurfaceProducer` is a later optimization.

## Takeover

`hand_to_user` or a `takeover` call → `requested` → `moveTask(topTaskId(display), 0)` → `active` (loop paused, app audible
on the main screen) → `handBack` → `moveTask(task, display)` → `returned` → loop resumes with a new observation (all refs are stale).
`active` longer than 10 min → `timed_out` and the run ends `interrupted`/`takeover_timeout`. If `moveTask` fails, the state is `failed`
and the run ends `interrupted`/`takeover_unavailable`. Locked screen, payment, login and FLAG_SECURE pages all go through takeover.

## Security invariants

None of these may be weakened. Each must have a JVM or device test where practical.

1. The nonce is 32 random bytes as hex from `SecureRandom`, written to the `exec:` stream stdin and never put in argv. The helper reads one line and closes stdin.
2. The helper launch command uses `setsid` and shell-quoted arguments. APK path, package and uid come from the runtime `ApplicationInfo`; nothing is hard-coded (the `.autonomy` suffix must work).
3. Before every delivery the helper checks that the installed package still has `appUid` and that its signing certificate SHA-256 equals the pinned `certPin`. On mismatch it calls `releaseAll()` and exits.
4. The helper checks that the provider holder's `info.packageName == package` and `applicationInfo.uid == appUid` before calling it.
5. `HandoffProvider` is exported with `android:permission="android.permission.INTERACT_ACROSS_USERS_FULL"`. It handles only `call("attach")`; query/insert/update/delete do nothing.
6. `HelperHub.offer` is `@Synchronized`. The checks run in this order: `callingUid == 2000`, reported uid/pid equal to the caller, reported APK path equal to the current `sourceDir` (otherwise `StaleApk`), Binder present, nonce matches (constant-time comparison; the launch nonce expires after 30 s) before the Binder is touched, then `identity()` equals `[callingUid, callingPid]` (otherwise `BinderElsewhere`). Only then is the nonce consumed: all slots are cleared, a new resume nonce is persisted with `commit()`, `linkToDeath` is set and the app token is returned.
7. `unpair` clears all nonces and drops the shell. The helper's next handoff is rejected and the helper exits.
8. `NovaShellService.onTransact` throws SecurityException for codes `FIRST..LAST_CALL_TRANSACTION` unless `getCallingUid() == appUid`.
9. Every display-scoped method works only on own displays: `releaseDisplay`, `displayFlags`, `startApp`, `topTaskId`, `topActivity` and all `inject*` (stricter than Mika, where `injectKey` and `injectTap` were not checked). `moveTask` works only own display → 0, or back to an own display for tasks this binding moved out.
10. `injectKey` allows only the navigation and editing whitelist (Mika `PressKeys`). Volume, power, home, recents, assist, camera and media keys are refused.
11. `startApp` refuses a package that is visible on the main display (`START_IN_USE_ON_MAIN`) and fails closed (`START_ERROR`) when the main display cannot be inspected.
12. Trusted display flags are dropped only after a SecurityException. Displays always use `OWN_CONTENT_ONLY|DESTROY_CONTENT_ON_REMOVAL`.
13. When the app dies, the helper calls `releaseAll()` and stays alive. It exits only when the handoff is rejected or the package is uninstalled. `killOtherInstances` kills only processes whose argv0 equals `<pkg>:helper`.
14. The ADB key is Keystore-wrapped and is never logged, exported or backed up. If it cannot be read, the user re-pairs (`key_unreadable`); the key is never silently regenerated.
15. The Nova AIDL has no command execution, clipboard, devtools or credential methods. Adding any of them is a contract change.
16. Frames, snapshots, element names and typed text are never logged or put into error codes.

## Android versions

| API | Android | Tier | Notes |
|---|---|---|---|
| 24–30 | 7–11 | main | Helper path not offered (`helper: unsupported`). Screenshots need API 30, as today. |
| 31–32 | 12/12L | virtual, experimental | No trusted or `TOUCH_FEEDBACK_DISABLED` flags. Launching on the display can take main-screen focus. Event display is found from the window id. |
| 33 | 13 | virtual, experimental | Trusted flags if shell has `ADD_TRUSTED_DISPLAY`. No `OWN_FOCUS`. `AccessibilityEvent.displayId` is available. |
| 34+ | 14+ | virtual | `OWN_FOCUS|STEAL_TOP_FOCUS_DISABLED` when trusted. Untrusted fallback → self-check `main_focus` fails and a warning is shown. |

## OEM and FLAG_SECURE limits

- FLAG_SECURE windows show black on the display and in frames. The a11y tree may still be readable. Payment, login and lock pages need takeover.
- Some ROMs (for example MIUI/HyperOS "USB debugging (Security settings)") block shell input injection. a11y gestures still work, but keys and fallbacks fail. Self-check `tap`/`back` reports this. Not yet verified on devices.
- Wireless debugging turns off when Wi-Fi changes or the device reboots, and adb authorizations can expire after about 7 days unused. The watchdog retries (backoff 0/2/4/8/16 s, capped at 30 s, at most 5 attempts), then reports `wireless_debugging_off`, `no_wifi` or `authorization_revoked`.
- Hidden-API reflection (`DisplayManager`, `IActivityTaskManager.startActivityAsUser`/`moveRootTaskToDisplay`, `InputManager.injectInputEvent`) has `am`/`input` command fallbacks. Fully failing devices stay on `main`.
- Some apps refuse to run on secondary displays or relaunch onto the main display. That is detected through `displayOfTask` and the run is interrupted with `display_unavailable`.

## Module ownership

| Owner | Files |
|---|---|
| Contract (this doc) | `docs/specs/mobile-virtual-display.md`, `app/src/main/aidl/com/nova/nova_mobile/phone/shell/INovaShell.aidl`, `phone/{PhoneControl,PhoneEvents,Snapshot,PhoneAction}.kt`, `app/build.gradle.kts` `aidl = true` |
| M2 native helper/pairing | new `phone-core/**` (adb, shell, `uistate/Accuracy.kt` only; no second `UiElement`), `settings.gradle.kts`, `app/build.gradle.kts` dependencies, `app/proguard-rules.pro`, `phone/shell/**` (HelperMain, HelperProcess, HelperHub, HandoffProvider, ShellContext, NovaShellService, adb/*), `phone/setup/**`, `phone/PhoneBridge.kt` (registers all three channels and implements `ShellProvider` and `PhoneEventSink`), the one-line hook in `MainActivity.kt`, `AndroidManifest.xml` provider/receiver/service entries |
| M3 display/agent | `phone/display/**` (AgentDisplay, LazyDisplay, FrameMath), `phone/a11y/**` (NodeIds, snapshot reader, VirtualScreen), `phone/Takeover.kt` (`PhoneTakeover`), `phone/PhoneSelfCheck` implementation, `LocalGuiService.kt`, `res/xml/local_gui_service.xml`, `LocalToolLoop.kt`, `LocalGuiModel.kt`, `LocalAgentController.kt` |
| UI lanes (Flutter) | `lib/agent/phone_channel.dart` (Dart client of the three channels), `lib/ui/{phone_control_page,phone_setup_wizard,virtual_screen_pip,tool_timeline}.dart`, the settings/chat/voice integration points |
| Integration | `LICENSES/README.md`, NOTICE, `clients/flutter/android/THIRD_PARTY.md`, `docs/guides/mobile.md` |

Lanes do not edit files they don't own. If a lane needs a seam that isn't here, it asks for a contract change.

### Wiring between M2 and M3

- `LocalAgentController(context, spaceId, shells: ShellProvider?, events: PhoneEventSink?)`: `MainActivity` passes the
  `PhoneBridge` for both (null keeps every run on `main`). The controller implements `PhoneTakeover`; the bridge routes
  `takeover`/`handBack` to the current controller.
- `VirtualSelfCheck(context, shells)` implements `PhoneSelfCheck`; call `run()` off the main thread. It drives system
  Settings on a temporary display: `tap` goes to a point outside every clickable node, `back` uses `injectKey`, and `type`
  passes only when Settings shows an editable field (otherwise `{ok:false, detail:"no_text_field"}`). `main_focus` reads
  `displayFlags & FLAG_OWN_FOCUS`.
- M3 serializes `step`/`takeover`/`done` events (`phone/PhoneEventJson.kt`) and emits them only for virtual-tier runs; the
  bridge serializes and emits `status`.
