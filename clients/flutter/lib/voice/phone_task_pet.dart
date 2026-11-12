import 'dart:async';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter/widgets.dart'
    show AppLifecycleState, WidgetsBinding, WidgetsBindingObserver;
import '../agent/phone_run.dart';
import '../ui/pet_avatar.dart';
import 'voice_companion.dart';

/// Mirrors the virtual-tier phone run on the Android floating pet
/// (packages/nova_audio/FLOATING_PET.md "Integration contract").
///
/// Status: a running run is `running`, a requested or active takeover
/// `needs_user`, a `completed` run `done`, a `failed`/`interrupted` run
/// `failed`. A cancelled run (the user stopped it) or a run that ended without
/// a `done` event releases the overlay at once. Pet actions are executed here:
/// `task_stop` through [onStop] (the PiP Stop path), `open` through [onOpen]
/// (native has already brought Nova forward); takeover stays in the app. A
/// task whose overlay could not be shown is not retried until Nova is resumed
/// again, so a blocked overlay never turns into a retry loop.
///
/// While the pet carries an active run, its stop covers the run:
/// [onStopCoverChanged] reports it so native hides its own stop button, and
/// reports the loss when the overlay fails or disappears so the button returns.
class PhoneTaskPet with WidgetsBindingObserver {
  PhoneTaskPet({
    required this.tracker,
    required this.companion,
    required Stream<String> actions,
    required this.onStop,
    this.onOpen,
    this.onOverlayPermissionNeeded,
    this.onStopCoverChanged,
  }) : _actionSource = actions;

  final PhoneRunTracker tracker;
  final TaskCompanion companion;
  final Stream<String> _actionSource;

  /// Stops the run [taskId] natively and cancels the turn that owns it.
  final void Function(String taskId) onStop;

  /// The user tapped the pet; Nova is already being brought to the front.
  final void Function()? onOpen;

  /// The overlay needs the display-over-other-apps permission. Called at most
  /// once per lifetime, so the hint never nags.
  final void Function()? onOverlayPermissionNeeded;

  /// Whether the pet's stop covers the active run [taskId]. Must not throw.
  final void Function(String taskId, bool covered)? onStopCoverChanged;

  /// The active run mirrored on the pet.
  String? _runId;

  /// The task the overlay currently carries (a finished run keeps it during
  /// its three-second terminal state).
  String? _overlayId;
  (String, String, String, int?)? _sent;
  final _blocked = <String>{};
  final _stopRequested = <String>{};

  /// Native's cover is a lease (eight seconds); it is renewed this often while
  /// the pet covers the run, so a dead Flutter engine brings native's stop back.
  static const renewCoverEvery = Duration(seconds: 3);

  /// The run whose stop the pet covers.
  String? _covered;
  Timer? _renewal;
  bool _started = false, _disposed = false, _hinted = false;
  bool _previewHeld = false;
  final _subscriptions = <StreamSubscription<Object?>>[];
  void Function()? _unbindAvatar;

  /// Starts mirroring. [avatar] is bound to the pet portrait until [dispose].
  void start({
    PetAvatarStore? avatar,
    void Function(Object, StackTrace)? onAvatarError,
  }) {
    if (_started || _disposed) return;
    _started = true;
    tracker.addListener(_sync);
    WidgetsBinding.instance.addObserver(this);
    _subscriptions
      ..add(_actionSource.listen(_onAction))
      ..add(companion.taskDisappearances.listen(_onGone))
      ..add(companion.previewChanges.listen((_) => _syncPreview()));
    if (avatar != null) {
      final report = onAvatarError ?? (Object _, StackTrace _) {};
      unawaited(
        bindTaskAvatar(companion, avatar, onError: report).then((unbind) {
          if (_disposed) {
            unbind();
          } else {
            _unbindAvatar = unbind;
          }
        }, onError: report),
      );
    }
    _sync();
  }

  void _sync() {
    if (_disposed) return;
    final id = _runId;
    if (id != null) {
      final run = tracker.run(id);
      if (run == null) {
        _runId = null;
        _hide(id);
      } else if (!run.active) {
        _runId = null;
        if (_covered == id) _dropCover();
        _finish(run);
      }
    }
    final next = tracker.activeVirtual;
    // A newer run replaces the overlay's task in place; no hide in between, so
    // the task service is never restarted from the background.
    if (next != null && next.taskId != _runId) _runId = next.taskId;
    final current = _runId == null ? null : tracker.run(_runId!);
    if (current != null) {
      _show(current, current.needsUser ? 'needs_user' : 'running');
    }
    _syncPreview();
  }

  void _finish(PhoneRun run) {
    final outcome = run.done?.outcome;
    if (outcome == null || outcome == 'cancelled') {
      _hide(run.taskId);
    } else {
      // Native holds done/failed for three seconds, then releases the task.
      _show(run, outcome == 'completed' ? 'done' : 'failed');
    }
  }

  void _show(PhoneRun run, String status) {
    final id = run.taskId;
    if (_blocked.contains(id)) return;
    final events = run.stepEvents;
    final last = events.isEmpty ? null : events.last;
    final state = (id, status, last?.label ?? '', last?.step);
    if (state == _sent) return;
    _sent = state;
    _overlayId = id;
    unawaited(
      companion
          .showTask(taskId: id, status: status, label: state.$3, step: state.$4)
          .then<void>(
            (_) => _cover(id),
            onError: (Object error) => _failed(id, error),
          ),
    );
  }

  void _cover(String id) {
    if (_disposed || _covered == id || _overlayId != id || !_isActive(id)) {
      return;
    }
    _covered = id;
    onStopCoverChanged?.call(id, true);
    _renewal?.cancel();
    _renewal = Timer.periodic(renewCoverEvery, (_) {
      final covered = _covered;
      if (covered == null || _overlayId != covered || !_isActive(covered)) {
        _dropCover();
      } else {
        onStopCoverChanged?.call(covered, true);
      }
    });
  }

  /// The overlay no longer carries the run [id]: native's stop takes over.
  void _uncover(String id) {
    if (_covered == id) _dropCover();
    if (_isActive(id)) onStopCoverChanged?.call(id, false);
  }

  /// Forgets the cover without telling native; its lease then lapses.
  void _dropCover() {
    _covered = null;
    _renewal?.cancel();
    _renewal = null;
  }

  bool _isActive(String id) {
    final run = tracker.run(id);
    return run != null && run.active && run.isVirtual;
  }

  void _failed(String id, Object error) {
    if (_disposed) return;
    _uncover(id);
    _blocked.add(id);
    // A timed-out start may still bring the overlay up late: keep its id so
    // the run's end still hides it. Other failures mean nothing is shown.
    final timedOut = error is PlatformException && error.code == 'timeout';
    if (_overlayId == id) {
      if (!timedOut) _overlayId = null;
      _sent = null; // allow one retry after resume either way
    }
    if (error is PlatformException && error.code == 'overlay_permission') {
      _hint();
    }
    // foreground_blocked, overlay_blocked, timeout: silent; the in-app
    // picture and controls still work.
    _syncPreview();
  }

  void _hide(String id) {
    if (_covered == id) _dropCover();
    if (_overlayId != id) return;
    _overlayId = null;
    _sent = null;
    unawaited(companion.hideTask(taskId: id).catchError((Object _) {}));
  }

  void _onGone(TaskOverlayGone gone) {
    if (_disposed || gone.taskId != _overlayId) return;
    _overlayId = null;
    _sent = null;
    // `expired` ends a terminal state and `hidden` is our own hide; anything
    // else (permission revoked, OEM block, notification stop) is not re-shown
    // for this task until Nova is resumed.
    if (gone.reason != 'expired' && gone.reason != 'hidden') {
      _blocked.add(gone.taskId);
      _uncover(gone.taskId);
    }
    if (gone.reason == 'overlay_permission') _hint();
    _syncPreview();
  }

  void _onAction(String action) {
    if (_disposed) return;
    switch (action) {
      case 'task_stop':
        final id = _runId ?? _overlayId;
        final run = id == null ? null : tracker.run(id);
        if (id == null || run == null || !run.active) return;
        // Dedupe repeated taps while one stop is in flight; if the run is
        // still active afterwards (the stop failed), allow another try.
        if (!_stopRequested.add(id)) return;
        onStop(id);
        Timer(const Duration(seconds: 5), () => _stopRequested.remove(id));
      case 'open':
        // Call-only `open` arrives here too; it is ours only while the
        // overlay carries a task.
        if (_overlayId != null) onOpen?.call();
    }
  }

  void _hint() {
    if (_hinted) return;
    _hinted = true;
    onOverlayPermissionNeeded?.call();
  }

  /// Frames go to the pet only while its preview is expanded and the run is
  /// working on the virtual screen; never during a takeover.
  void _syncPreview() {
    final id = _runId;
    final run = id == null ? null : tracker.run(id);
    final wanted =
        !_disposed &&
        companion.previewWanted &&
        run != null &&
        run.active &&
        !run.needsUser &&
        _overlayId == id;
    if (wanted == _previewHeld) return;
    _previewHeld = wanted;
    if (wanted) {
      tracker.preview.retain();
      tracker.preview.frame.addListener(_forwardFrame);
      _forwardFrame();
    } else {
      tracker.preview.frame.removeListener(_forwardFrame);
      tracker.preview.release();
    }
  }

  void _forwardFrame() {
    final frame = tracker.preview.frame.value;
    final id = _runId;
    final run = id == null ? null : tracker.run(id);
    if (frame == null || run == null || run.needsUser) return;
    unawaited(companion.taskFrame(frame).catchError((Object _) {}));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || _blocked.isEmpty) return;
    // Back in Nova: a permission may have been granted and the task service
    // may start again. One retry per resume.
    _blocked.clear();
    _sync();
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    if (_started) {
      tracker.removeListener(_sync);
      WidgetsBinding.instance.removeObserver(this);
    }
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    _syncPreview();
    _unbindAvatar?.call();
    final covered = _covered;
    if (covered != null) _uncover(covered);
    final id = _overlayId;
    _overlayId = null;
    if (id != null) {
      unawaited(companion.hideTask(taskId: id).catchError((Object _) {}));
    }
  }
}
