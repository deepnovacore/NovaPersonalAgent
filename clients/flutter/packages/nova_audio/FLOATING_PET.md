# Android floating pet

`NativeVoiceCompanion` (`lib/voice/voice_companion.dart`) implements the existing
`VoiceCompanion` and independent `TaskCompanion` API. Use **one instance** for both
lifetimes: the MethodChannel has one callback handler. Task APIs are Android-only.

## Integration contract

M5 supplies the bridge, not production phone-event or avatar-store wiring. The app
integration must bind its loaded `PetAvatarStore`, map phone events to `showTask`,
and execute action requests. No task or selected portrait is automatically wired
by constructing a companion.

- `setAvatar(pngBytes: ...)` or `setAvatar(filePath: ...)` accepts a portrait;
  omitting both restores the generic orb. **A null customPath is not the default
  pet.** Use the helper below to load the already-approved `petAvatarAsset` via
  `rootBundle` for the default, and reapply on store changes. No new media is added.
- `showTask(taskId:, status:, label:, step:)` retains `Future<bool>` for source
  compatibility and returns `true` on success. Failures now throw
  `PlatformException` with these codes (rather than a misleading bare `false`):

  | Code | Integration response |
  | --- | --- |
  | `overlay_permission` | Explain display-over-other-apps permission; offer `requestOverlayPermission()`. |
  | `foreground_blocked` | Return to Nova and retry the explicit task lifetime; Android rejected FGS startup. |
  | `timeout` | Startup did not finish in 4.5 seconds; retry from Nova. |
  | `overlay_blocked` | WindowManager/OEM restriction, cancellation before ready, or another overlay failure; do not present it as a permission grant failure. |

  Concurrent shows awaiting startup all receive the final service/window result;
  a newer update does not manufacture a denial for an older caller. The latest
  state wins. This API never requests microphone permission or starts a phone task.
  Start while Nova is foregrounded. In particular, a chained background task
  after terminal auto-hide may fail with `foreground_blocked`.
- `requestOverlayPermission()` opens Android settings from the attached activity;
  it does not report a grant. Retry `showTask` after returning to Nova.
- Status remains `running`, `needs_user`, `done`, or `failed`. Running has one
  animator-driven arc; needs-user breathes orange. Done/failed hold a green/red
  ring for three seconds then release the task service. During a call the live
  microphone ring takes precedence, and the accessibility description always
  includes microphone state. Needs-user/status changes use polite live regions.
- `previewWanted` and `previewChanges` report whether the current task's preview
  is expanded, visible and running. **Subscribe/unsubscribe from frame capture
  and JPEG encoding using this signal**, not just `showTask` completion.
  `taskFrame(Uint8List jpeg)` skips the bridge while unwanted, throttles to 5fps,
  and drops sends while another send is in flight. Native independently gates
  frames. Never forward secure/takeover frames. Frames clear on task replacement,
  needs-user, terminal status, collapse and foreground hiding.
- Native file reads and bitmap decode run on a single worker, never the UI thread.
  Inputs are bounded to 4MiB; decoding samples without undershooting 256px, then
  scales the longest edge to at most 256px. Only one preview decode is in flight;
  invalidated results and replaced bitmaps are recycled.
- `hideTask(taskId: id)` releases only that task's overlay lifetime, not the phone
  task or call. A mismatched id is a no-op in both Dart and native. The no-argument
  `hideTask()` remains available to hide the current task; **asynchronous cleanup
  should always supply its captured taskId**. `stop()` releases only the call.
- `taskDisappearances` emits `TaskOverlayGone(taskId, reason)` for native expiry,
  unexpected service/window loss, notification stop or task removal. Stale IDs
  are ignored; Dart clears the current task/preview without dropping call actions.
  Typical reasons: `expired`, `service_destroyed`, `task_removed`,
  `notification_stop`, `overlay_permission`, `overlay_blocked`, `timeout`,
  `foreground_blocked`, `hidden`. Engine/process death cannot deliver an event to
  a dead Dart isolate; rebuild state after engine creation.
- `actions` emits `task_stop`, `task_takeover`, and `open` for the current task,
  plus call controls. IDs are filtered by Dart. Native opens Nova for `open`;
  stop/takeover are **requests**, executed idempotently by integration over the
  task channels. The task notification also sends `task_stop`, then releases the
  overlay lifetime. If notification permission is denied, that shade affordance
  is unavailable; keep in-app task controls reachable.

```dart
await store.load();
final unbindAvatar = await bindTaskAvatar(
  companion, store,
  onError: reportAvatarError,
);
// On integration teardown, before disposing the store:
unbindAvatar();
await companion.hideTask(taskId: capturedTaskId);
```

Phone events retain their existing contract: integration maps `step` to running,
requested/active `takeover` to needs-user, returned to running, and `done` outcomes
to done/failed. The overlay makes no takeover decisions itself.

## Android lifetime and window

`VoicePetHost` owns one window. Started/stopped activity tracking (seeded on plugin
attachment, with a 150ms stop debounce) hides it while Nova is visible, without
flashing over permission dialogs or between activities. Minimize probes the real
WindowManager add before moving Nova to the background; a grant alone is not proof
that an OEM allows overlays. Later failures are reported for tasks.

The 48dp-minimum buttons grow with large fonts; controls scroll on short screens.
Step/label and running/needs-user updates change existing views in place, preserving
button gestures and scroll position. Rebuilds occur only on task identity/nullity,
terminal-control state, call-mode changes or explicit expansion. Light/dark themed
widgets use explicit text/surface colours. Task-only configuration changes also
relayout/clamp the dock using current density and screen dimensions.

The window is non-focusable and non-touch-modal. It has **FLAG_SECURE whenever a
task is present**, even collapsed: screenshots, casting and screen recording cannot
capture the preview or the pet card. This restriction is an intentional privacy
trade-off, not a replacement for filtering secure phone frames.

The existing `VoiceCallService` retains microphone FGS ownership and wake lock.
`VoicePetService` uses `specialUse`, without microphone access or a wake lock, and
promotes every start command before checking stale/cancelled ownership. Keeping the
services independent avoids ending one lifetime with the other. Both may have
notifications but only one overlay. Neither restores work after process death.
A task FGS can outlive a stopped activity, **not a detached Flutter engine**: engine
detach releases its owned task. Root Back with a non-cached engine therefore ends
this overlay. No claim of engine-independent task execution is made.

## Validation and device acceptance

JVM tests cover the library manifest's specialUse permission/type/subtype, pending
show completion/hide ordering and scoped hide, sampling, and state/ownership.
Robolectric tests exercise startForeground on cancelled/owned commands, scoped
notification stop, and actual button identity/click retention across step updates.
Dart channel tests cover errors with a concurrent call, native preview/disappearance,
scoped hide, default/custom avatar binding and deterministic-clock frame throttling.

Real-device acceptance remains required on Android 14+ and supported 12/13 devices:
permission revocation/OEM pop-up restrictions, Home/return, dialogs and rotation,
landscape/density/200% font/TalkBack, dark mode, microphone privacy ring, screen
capture exclusion, dragging and touches outside the window, rapid hide/restart,
notification denial/stop, root Back, and preview CPU/memory at 5fps. Robolectric
cannot prove WindowManager/FGS policy, physical rendering, or audio continuity.
