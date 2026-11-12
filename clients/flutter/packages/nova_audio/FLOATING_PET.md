# Android floating pet

`NativeVoiceCompanion` (`lib/voice/voice_companion.dart`) implements the existing
`VoiceCompanion` and independent `TaskCompanion` API. Use **one instance** for both
lifetimes: the MethodChannel has one callback handler. Task APIs are Android-only.

## Integration contract

This package supplies the bridge; constructing a companion wires no task or portrait.
The app wiring is `PhoneTaskPet` (`lib/voice/phone_task_pet.dart`), created by the
standalone workbench shell on Android with the native phone bridge. It shares the
call's `NativeVoiceCompanion` instance, follows the app-lifetime `PhoneRunTracker`
and mirrors only virtual-tier runs:

| Run | Pet |
| --- | --- |
| step events, takeover `returned` | `running`, label/step of the latest step |
| takeover `requested`/`active` | `needs_user` |
| `done` `completed` | `done` (native expires it after three seconds) |
| `done` `failed`/`interrupted` | `failed` |
| `done` `cancelled`, or the run's result arrived without `done` | `hideTask(taskId:)` at once |

A newer run replaces the task in place (no hide in between). `task_stop` runs the
same path as the in-app picture's Stop (native `stop` by task id, then the owning
chat turn or voice delegate is cancelled), once per task; the overlay no longer
offers takeover (Dart handling of a `task_takeover` action is legacy); `open` restores an active call's screen (native has already
brought Nova forward). `bindTaskAvatar` binds the shell's `PetAvatarStore` and is
unbound on teardown before the store is disposed. `overlay_permission` (as a
`showTask` error or a disappearance) shows one in-app hint per session with a
`requestOverlayPermission()` action; `foreground_blocked`, `overlay_blocked` and
`timeout` are silent. A task whose overlay failed or was taken away is not shown
again until Nova is next resumed (one retry per resume), so there is no retry loop.

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
  `PhoneTaskPet` holds the shared `PhonePreview` (the same `nova/phone/frames`
  subscription and `setPreview` count as the in-app picture) only while this is
  true and the run is not waiting for the user, and forwards those frames.
  `taskFrame(Uint8List jpeg)` skips the bridge while unwanted, throttles to 5fps,
  and drops sends while another send is in flight. Native independently gates
  frames. Never forward secure/takeover frames. Frames clear on task replacement,
  needs-user, terminal status, collapse and foreground hiding.
- Native file reads and bitmap decode run on a single worker, never the UI thread.
  Inputs are bounded to 4MiB; decoding samples without undershooting the cap, then
  scales the longest edge to at most the cap (512px for preview frames, 256px for
  portraits). Only one preview decode is in flight;
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
- `actions` emits `task_stop` and `open` for the current task, plus call controls
  (`mute`, `end`). IDs are filtered by Dart. Native opens Nova for `open`;
  stop is a **request**, executed idempotently by integration over the
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

Expanded with a task, the card is the orb (kept on the docked edge) above the
virtual-screen preview and one centred row of icon-only circular buttons: Stop
(red glyph) and Open Nova, plus Mute/Unmute and End call while a call is active.
The preview is 288dp tall with width from the latest decoded frame's aspect
(the 1200×2670 virtual display before the first frame), rounded and without
letterboxing; frames wider than tall cap the width at 240dp and derive the
height. The card wraps the preview with 4dp padding, widening only so the row
fits. Aspect changes under ~2px are ignored; larger ones resize the preview and
window width in place and re-clamp the dock. Visual buttons are 40dp (two) or
30dp (four); each touch target is 44dp tall and an equal share of the row width,
so targets never overlap. Every control has an accessible label. Stop is
disabled (dimmed) for done/failed. There is no step text: step/label and status
are part of the orb's description, announced through its polite live region.
Without a task, expansion shows the vertical 48dp Return/Mute/End controls.
Controls scroll on short screens.
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
notification stop, actual button identity/click retention across step updates, and
the card: label-based controls in one row (2 or 4), no takeover control or step
text, expand/task ordering, in-place aspect resize with hysteresis, right dock and
terminal Stop.
Dart channel tests cover errors with a concurrent call, native preview/disappearance,
scoped hide, default/custom avatar binding and deterministic-clock frame throttling.

Real-device acceptance remains required on Android 14+ and supported 12/13 devices:
permission revocation/OEM pop-up restrictions, Home/return, dialogs and rotation,
landscape/density/200% font/TalkBack, dark mode, microphone privacy ring, screen
capture exclusion, dragging and touches outside the window, rapid hide/restart,
notification denial/stop, root Back, and preview CPU/memory at 5fps. Robolectric
cannot prove WindowManager/FGS policy, physical rendering, or audio continuity.
