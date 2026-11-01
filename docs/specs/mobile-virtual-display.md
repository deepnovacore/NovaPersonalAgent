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
   `serviceInfo` only while a virtual run or the self-check holds a lease on it, so the main-tier tree and fingerprint stay
   byte-for-byte unchanged. Acquiring the lease is transactional (a failed `serviceInfo` write leaves no lease); the run's
   lease is released synchronously when the run ends, before another run is admitted (the display itself may be released
   later). No run starts while the self-check holds the flag. On a service reconnect every lease owner is stopped first
   (a run ends `interrupted`/`accessibility_unavailable`), then the saved flags are restored; releases from before the
   reconnect are no-ops. If restoring the flags fails, the restoration stays owed: it is retried on every run admission
   and self-check, and until it succeeds no run of either tier starts (`start`/`run` fail with
   `accessibility_flags_failed`; the self-check reports `create_display` `accessibility_flags_failed`).
   **Main-tier admission** changes only in these two cases: a main run is refused while the self-check holds the flag
   (`another_task_is_active`) or while a restoration is owed (`accessibility_flags_failed`). Otherwise main-tier
   admission, prompt, schema, `observe` and `perform` are unchanged. Only a gesture the system *refused* before dispatch falls back to `injectTap`/`injectStroke`; a
   cancelled, timed-out or interrupted gesture may have acted, is journaled `unknown` and is never injected again. Keys
   always use `injectKey`.
7. **Effect admission**: every effect on the display (each a11y action, gesture, injection or `startApp`, and each
   fallback separately) is admitted immediately before it runs: the run must still be active (stop, fence, time limit)
   and no takeover may have started since the observation the action was planned on. A takeover waits for an effect in
   progress and then invalidates every prepared action; a refused effect dispatched nothing and is journaled `rejected`
   (`execution_stopped`, or `screen_changed` → observe again). Stop never waits: an effect admitted before it counts as
   earlier than the stop.

## Capability tiers

`PhoneTier` is chosen once when a run starts and is fixed for that run.

| Tier | Condition | Behaviour |
|---|---|---|
| `virtual` | api >= 31, accessibility on, helper `running` | Apps run on the helper display; user keeps the main screen. |
| `virtual` + `experimental` | as above with api 31..33 **and** the user acknowledged the warning | Same, with a settings warning: main-screen focus may be taken briefly. Without the acknowledgement the run stays `main`. |
| `main` | anything else | Existing main-screen path (`LocalGuiService.observe/perform`), unchanged, legacy action set. |

The acknowledgement is the boolean `phone.experimental_ack` in the native SharedPreferences file `nova_phone`
(`PHONE_PREFERENCES`/`PHONE_EXPERIMENTAL_ACK` in `phone/a11y/VirtualScope.kt`); the bridge writes it when the user
accepts the Android 12/13 warning. api >= 34 needs no acknowledgement.

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
- `secret` elements: `type` into them fails with `private_input_requires_user`. Editable and secret elements are named
  only by their hint or their label view (`labelFor`), never by their text or description, which may be typed input.
- `secure_frame` (FLAG_SECURE): true only when the frame is (near-)black **and** application windows on the display still
  have visible elements (elements of system windows such as the status bar do not count); a dark splash, video or
  switched-off screen without readable app elements is not secure. While the
  observation is secure, only `back` and `hand_to_user` run (and the `observe`/`wait` decisions); any other action is not
  dispatched and starts a takeover (`by:"model"`, `reason:"secure_page"`), after which the loop observes again. If the
  takeover cannot start, the run ends `interrupted`/`secure_page`.
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
| `submit` | (none) | virtual | `injectKey(KEYCODE_ENTER)` on the run's display (the keyboard's action key: search, send); `type` never submits |
| `hand_to_user` | `reason` | virtual | trimmed string 1..500 chars; needs no ActionApproval; starts a takeover |

Parse errors (IllegalArgumentException, reported as `model_<code>`): `unsupported_action` (unknown type or wrong tier),
`invalid_action_fields`, `invalid_coordinate`, `invalid_input`, `invalid_ref`, `invalid_snapshot_id`, `invalid_direction`,
`invalid_package`, `invalid_reason`. Execution errors (IllegalStateException, reported as `tool_<code>`): `ref_expired`,
`ref_not_editable`, `ref_not_scrollable`, `no_focused_input`, `private_input_requires_user`, `app_not_launchable`,
`app_in_use_on_main` (START_IN_USE_ON_MAIN), `app_not_allowed`, `display_unavailable`, `helper_unavailable`,
`takeover_unavailable`, `takeover_timeout`. M3 adds the new codes to the `LocalToolLoop` safe-code sets; `RunFence`,
`ActionApproval` and `LocalAgentJournal` semantics are unchanged.

Step labels: the model's summary for most actions, the fixed `输入文字` for every `type` and `提交` for every `submit`
(summaries and field names can carry typed text), the package for `open_app`, the reason for `hand_to_user`.

The journal record of a `native_model` task carries `tier: "virtual"|"main"` next to `target_package`; virtual-tier
actions are journaled with the observation's `snapshot_id` as evidence (main tier: the fingerprint).

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
| `selfCheck` | `{}` | `{checks:[{id, ok, detail?}]}`; ids `helper`, `create_display`, `start_app`, `read_tree`, `tap`, `type`, `back`, `main_focus`. Fails with `run_active` while an agent run is active. |
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
  (task_id, step) is sent as `running` and then once with its final status. `label` never contains typed text. An
  `observe` decision is its own step (`tool:"observe"`, label = the model's summary, no `ref`/`changed`), sent `running`
  then `completed`.
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
and the run ends `interrupted`/`takeover_unavailable`. Locked screen, payment, login and FLAG_SECURE pages all go through takeover
(`secure_page`, see `secure_frame`). Takeover moves are serialized with effects: a `takeover` call waits for an effect in
progress, and nothing planned before it is dispatched afterwards. `takeover`/`handBack` fail with `task_not_running` when
the task is not the current virtual run, and `handBack` with `no_takeover` before any takeover.
The bridge must call `takeover` and `handBack` off the main thread (`PhoneBridge` runs them on `Dispatchers.IO`): the
effect a takeover waits for can be a gesture, and Android delivers gesture results through the main thread even when a
callback handler is given. `RunTakeover.request` on the main thread therefore fails at once with
`takeover_on_main_thread` and changes nothing. Inside M3 only the run's loop worker requests takeovers; service
callbacks (stop button, interrupt, reconnect) only end the run and never reach `request`.

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
| 31–32 | 12/12L | virtual, experimental (needs `phone.experimental_ack`) | No trusted or `TOUCH_FEEDBACK_DISABLED` flags. Launching on the display can take main-screen focus. Event display is found from the window id. |
| 33 | 13 | virtual, experimental (needs `phone.experimental_ack`) | Trusted flags if shell has `ADD_TRUSTED_DISPLAY`. No `OWN_FOCUS`. `AccessibilityEvent.displayId` is available. |
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
- `VirtualSelfCheck(context, shells, runs)` implements `PhoneSelfCheck`; `runs` is the current `LocalAgentController`
  (`RunIdleGate`). Call `run()` off the main thread. It drives system
  Settings on a temporary display: `tap` goes to a point outside every clickable node, `back` uses `injectKey`, and `type`
  passes only when Settings shows an editable field (otherwise `{ok:false, detail:"no_text_field"}`). `main_focus` reads
  `displayFlags & FLAG_OWN_FOCUS`.
- M3 serializes `step`/`takeover`/`done` events (`phone/PhoneEventJson.kt`) and emits them only for virtual-tier runs; the
  bridge serializes and emits `status`.

## Helper constants

`INovaShell` constants beyond `START_OK`/`START_IN_USE_ON_MAIN`/`START_NOT_FOUND`/`START_ERROR`:

| Constant | Value | Meaning |
|---|---|---|
| `START_IN_USE_BY_OTHER` | 7 | `startApp`: the package already runs on another own display; nothing was started. Reported like `START_ERROR` as `display_unavailable`. |
| `FLAG_TRUSTED` | 1024 | `displayFlags` bit: the display was created trusted (`VIRTUAL_DISPLAY_FLAG_TRUSTED`). Informational; the self-check reads only `FLAG_OWN_FOCUS`. |
| `FLAG_OWN_FOCUS` | 16384 | `displayFlags` bit read by the self-check row `main_focus`. |

## Self-check details

`detail` codes per row (`ok:false` unless noted). A row that did not run is `{ok:false, detail:"not_run"}`. A service
reconnect during the self-check cancels it before its next effect (display creation, `startApp`, tap, each typing
action, each back key): that row reports `accessibility_unavailable` and later rows `not_run`.

| Row | Details |
|---|---|
| `helper` | `unsupported` (api < 31), `not_running` (also asks the watchdog to start it), `helper_unavailable` |
| `create_display` | `accessibility_flags_failed` (runtime a11y flag could not be set, or an owed restoration still fails), `create_failed` |
| `start_app` | `app_in_use_on_main`, `app_not_launchable`, `display_unavailable`, `helper_unavailable`, `accessibility_required`, `not_on_display` |
| `read_tree` | `empty_tree`, `no_frame`, `black_frame` |
| `tap` | `no_free_point`, `gesture_uncertain` (never followed by an injection), `tap_refused`; `injection_only` with `ok:true` |
| `type` | `no_text_field`, `text_not_set` |
| `back` | `injection_refused`, `no_effect` |
| `main_focus` | `unknown` (flags unreadable), `shared_focus` |

## Run reasons

`reason` of an `interrupted` task (journal `reason`, `done` event `reason`). `cancelled` (user stop) and `completed`
carry no reason. `<stage>` is the loop stage: `observation`, `model` or `tool`.

| Reason | Tier | When |
|---|---|---|
| `time_limit` | both | Budget (main 5 min, virtual 15 min) ran out. |
| `space_changed` | both | The Space was switched or closed. |
| `accessibility_unavailable` | both | The accessibility service was interrupted, destroyed or reconnected. |
| `virtual_setup_failed` | virtual | The run's display objects or the runtime a11y flag could not be set up. |
| `launch_<code>` | virtual | The run's own `open_app` was refused before any effect: `launch_execution_stopped`, `launch_screen_changed`, `launch_app_in_use_on_main`, `launch_app_not_launchable`, `launch_display_unavailable`, `launch_helper_unavailable`, `launch_app_not_allowed`. |
| `launch_failed` | virtual | The run's own `open_app` failed otherwise. |
| `launch_outcome_<outcome>` | both | The launch attempt was journaled `rejected` or `unknown`. |
| `native_loop_failed` | both | Unexpected failure outside the loop's own error mapping. |
| `execution_interrupted` | both | The loop ended without finishing or interrupting the run. |
| `secure_page` | virtual | A non-allowed action met a secure frame and no takeover could start. |
| `model_needs_user` | both | The model chose `wait`. |
| `model_observation_limit` | both | More than 3 consecutive `observe` decisions. |
| `approval_declined` | both | The single-use permit could not be issued. |
| `action_outcome_<outcome>` | both | An action was journaled `rejected` or `unknown`; it is never retried. |
| `step_limit` | both | The loop used all its turns. |
| `model_http_<status>`, `model_dns_failed`, `model_timeout`, `model_tls_failed`, `model_invalid_response` | both | Model transport failures. |
| `model_<code>` | both | Invalid model output; `<code>` is a parse code (`invalid_model_decision`, `unexpected_action`, `unsupported_action`, `invalid_action_fields`, `invalid_coordinate`, `invalid_input`, `one_model_choice_required`, `one_tool_call_required`, `function_required`, `unsupported_model_tool`, `invalid_model_response`, `invalid_ref`, `invalid_snapshot_id`, `invalid_direction`, `invalid_package`, `invalid_reason`). |
| `<stage>_<code>` | both | A safe execution code, e.g. `observation_outside_target_app`, `observation_takeover_timeout`, `tool_ref_not_editable`, `tool_screen_changed` (stale-plan budget used up), `tool_helper_unavailable`, `tool_takeover_unavailable`. |
| `<stage>_timeout`, `<stage>_screenshot_unavailable_<n>` | both | A blocking call timed out; main-tier screenshot failure. |
| `<stage>_failed` | both | Any other failure (no detail, so no screen content or provider body leaks). |

Method error codes of `nova/phone/v1` that are not run reasons: `task_not_running` and `no_takeover` (`takeover`,
`handBack`), `takeover_on_main_thread` (`takeover` called on the main thread, a bridge bug), `run_active` (`selfCheck`).
Method error code of `nova/local_agent/v1` `start`/`run`: `accessibility_flags_failed` (a failed restoration of the runtime
a11y flag is still owed; no run starts until a retry succeeds).
