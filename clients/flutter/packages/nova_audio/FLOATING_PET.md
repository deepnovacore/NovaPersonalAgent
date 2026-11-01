# Android floating pet

`NativeVoiceCompanion` (`lib/voice/voice_companion.dart`) implements both the existing
`VoiceCompanion` and the independent `TaskCompanion` API. Use **one instance** for
both lifetimes: the MethodChannel has one callback handler. This is Android-only;
other platforms should not call the task API.

- `setAvatar(pngBytes: ...)` or `setAvatar(filePath: ...)` sets the selected portrait;
  pass `PetAvatarStore.customPath` after loading the store, or pass rendered PNG
  bytes. Omit both to restore the existing orb. Invalid/missing images fall back
  to the orb. Native bounds decoded images to 512px and input to 4MiB. No new
  bundled character assets are introduced.
- `showTask(taskId:, status:, label:, step:)` returns `false` when overlay
  permission or foreground-service startup is denied. The caller can show its
  permission hint. It never requests microphone permission or starts a phone
  task. Start this lifetime while Nova is foregrounded, before leaving the app;
  Android may reject starting a foreground service from the background.
- Status is `running`, `needs_user`, `done`, or `failed`. A running task has a
  rotating progress arc; needs-user breathes orange. Done/failed hold a green/red
  ring for three seconds then release the task service. An active call remains.
- `taskFrame(Uint8List jpeg)` throttles to five frames/second and never queues
  behind an unfinished send. Native drops frames unless the pet is expanded,
  background-visible and running. Integration owns the phone-frame subscription;
  do not forward secure/takeover frames. Frames are cleared on task replacement,
  needs-user, terminal status, and foreground hiding.
- `hideTask()` releases only the pet's task lifetime, not the phone task or call.
  `stop()` releases only the call lifetime. Integration should hide the task on
  teardown even after a terminal status has auto-hidden it.
- `actions` emits `task_stop`, `task_takeover`, and `open` for the current task,
  in addition to existing call controls. Task IDs are filtered inside the Dart
  companion; dispatch the action to the task you most recently showed. Native
  opens Nova itself for `open`; stop/takeover are **requests**, executed by the
  integration over the phone/task channels. Old task/call callbacks are ignored.

Phone events retain their existing contract. Integration maps `step` to running,
`takeover` requested/active to needs-user, returned to running, and `done` outcomes
to done/failed as appropriate. The overlay does not subscribe to phone events or
make takeover decisions itself.

## Android lifetime

`VoicePetHost` owns one `VoiceCallOverlay` for both modes. Application activity
callbacks hide it whenever any Nova activity is resumed (including during calls).
A tap expands the preview/step/buttons, with call mute/end controls when applicable.
All controls are at least 48dp, and the card scrolls on short screens. The window
is non-focusable and non-touch-modal; dragging the portrait docks to an edge.

The existing `VoiceCallService` retains microphone FGS ownership and wake lock.
The small `VoicePetService` uses `specialUse` for explicit task lifetime, without
microphone access or a wake lock. A foreground service is needed so a task-only
background overlay does not depend on an Activity/cached process staying alive.
Keeping the services independent avoids promoting a non-call task to microphone
FGS or stopping one lifetime when the other ends. Both may have notifications
while active, but there is only one overlay. Neither service restores work after
process death. Engine ownership prevents a headless engine from clearing another
engine's task; engine detach, explicit hide, and terminal expiry release the UI.

## Device acceptance still required

Exercise task-only and call+task on Android 14+, permission revocation/denial,
Home/return, activity transitions/rotation, landscape and large font/TalkBack,
drag/docking and touches in the underlying app, rapid hide/restart, task removal,
and OEM foreground-service restrictions. Verify selected portrait changes,
preview CPU cost at 5fps, orange breathing, and terminal expiry on real devices.
JVM state/ownership tests and mocked-channel tests cannot validate WindowManager,
foreground-service policy, accessibility rendering, or audio continuity.
