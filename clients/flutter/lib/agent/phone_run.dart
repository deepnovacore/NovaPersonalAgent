import 'dart:async';
import 'dart:collection' show SplayTreeMap;
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart'
    show AppLifecycleState, WidgetsBinding, WidgetsBindingObserver;
import 'phone_channel.dart';

/// One phone task as the UI sees it, folded from `step`, `takeover` and
/// `done` events.
class PhoneRun {
  PhoneRun(this.taskId, this.tier);
  final String taskId;
  PhoneTier tier;
  final _steps = SplayTreeMap<int, PhoneStepEvent>();
  TakeoverState? takeover;
  bool takeoverByModel = true;
  String? takeoverReason;
  PhoneDoneEvent? done;

  /// The run's result reached the app before (or without) its `done` event.
  bool endedByResult = false;

  bool get active => done == null && !endedByResult;
  bool get isVirtual => tier == PhoneTier.virtual;

  /// The user has to act: the model asked for help or the user took over.
  bool get needsUser =>
      active &&
      (takeover == TakeoverState.requested || takeover == TakeoverState.active);
  bool get takeoverActive => active && takeover == TakeoverState.active;
  List<PhoneStepEvent> get stepEvents => _steps.values.toList();

  void apply(PhoneEvent event) {
    switch (event) {
      case PhoneStepEvent():
        tier = event.tier;
        _steps[event.step] = event;
      case PhoneTakeoverEvent():
        takeover = event.state;
        takeoverByModel = event.byModel;
        takeoverReason = event.reason ?? takeoverReason;
      case PhoneDoneEvent():
        done = event;
      case PhoneStatusEvent():
        break;
    }
  }
}

/// Counts the widgets that show the live screen. Frames and `setPreview`
/// follow it: the first holder turns the preview on, the last one off.
class PhonePreview {
  PhonePreview(this.channel);
  final PhoneChannel channel;

  /// The newest frame; null before the first one and after the preview stops.
  final frame = ValueNotifier<Uint8List?>(null);

  /// Width / height of the newest frame.
  final aspect = ValueNotifier<double?>(null);
  int _holders = 0;
  StreamSubscription<Uint8List>? _frames;

  int get holders => _holders;

  void retain() {
    if (++_holders != 1) return;
    unawaited(_send(true));
    _frames = channel.frames.listen((bytes) {
      final size = jpegSize(bytes);
      if (size != null && size.$2 > 0) aspect.value = size.$1 / size.$2;
      frame.value = bytes;
    }, onError: (Object _) {});
  }

  void release() {
    if (_holders == 0 || --_holders != 0) return;
    unawaited(_send(false));
    unawaited(_frames?.cancel());
    _frames = null;
    frame.value = null;
  }

  Future<void> _send(bool visible) async {
    try {
      await channel.setPreview(visible);
    } catch (_) {
      // Without a bridge there are simply no frames.
    }
  }

  void dispose() {
    unawaited(_frames?.cancel());
    frame.dispose();
    aspect.dispose();
  }
}

/// Pixel size of a JPEG from its first frame header, without decoding.
(int, int)? jpegSize(Uint8List bytes) {
  var i = 2;
  if (bytes.length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8) return null;
  while (i + 9 < bytes.length) {
    if (bytes[i] != 0xff) {
      i++;
      continue;
    }
    final marker = bytes[i + 1];
    if (marker == 0xff) {
      i++;
      continue;
    }
    if (marker == 0xd8 ||
        marker == 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    final length = (bytes[i + 2] << 8) | bytes[i + 3];
    final startOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker != 0xc4 &&
        marker != 0xc8 &&
        marker != 0xcc;
    if (startOfFrame) {
      final height = (bytes[i + 5] << 8) | bytes[i + 6];
      final width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? (width, height) : null;
    }
    i += 2 + length;
  }
  return null;
}

/// The phone tasks of this app session, driven by `nova/phone/events`.
class PhoneRunTracker extends ChangeNotifier with WidgetsBindingObserver {
  PhoneRunTracker(this.channel) : preview = PhonePreview(channel);
  final PhoneChannel channel;
  final PhonePreview preview;
  final _runs = <String, PhoneRun>{};
  StreamSubscription<PhoneEvent>? _events;
  bool _disposed = false;

  /// Set when a takeover command failed; cleared by the next event.
  bool actionFailed = false;

  static const _kept = 8;

  void start() {
    if (_events != null) return;
    _events = channel.events.listen(_onEvent, onError: (Object _) {});
    WidgetsBinding.instance.addObserver(this);
  }

  /// The run's result is in, so it is over even if its `done` event never
  /// arrived (the event stream is dropped whenever the activity detaches).
  void markEnded(String taskId) {
    final run = _runs[taskId];
    if (_disposed || run == null || !run.active) return;
    run.endedByResult = true;
    notifyListeners();
  }

  /// Native events are not queued while the app is away: on return, a run that
  /// native no longer lists as in progress is over.
  Future<void> reconcile() async {
    if (_runs.values.every((run) => !run.active)) return;
    final running = await channel.activeTaskIds();
    if (_disposed || running == null) return;
    var changed = false;
    for (final run in _runs.values) {
      if (run.active && !running.contains(run.taskId)) {
        run.endedByResult = true;
        changed = true;
      }
    }
    if (changed) notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(reconcile());
  }

  PhoneRun? run(String taskId) => _runs[taskId];
  PhoneRun? get latest => _runs.isEmpty ? null : _runs.values.last;

  /// The running task on the virtual screen, if any.
  PhoneRun? get activeVirtual {
    for (final run in _runs.values.toList().reversed) {
      if (run.active && run.isVirtual) return run;
    }
    return null;
  }

  void _onEvent(PhoneEvent event) {
    if (_disposed) return;
    final String? taskId = switch (event) {
      PhoneStepEvent() => event.taskId,
      PhoneTakeoverEvent() => event.taskId,
      PhoneDoneEvent() => event.taskId,
      PhoneStatusEvent() => null,
    };
    if (taskId == null) return;
    var run = _runs[taskId];
    if (run == null) {
      // Only steps and takeovers start a run; a stray `done` is dropped.
      if (event is PhoneDoneEvent) return;
      run = _runs[taskId] = PhoneRun(
        taskId,
        event is PhoneStepEvent ? event.tier : PhoneTier.virtual,
      );
      while (_runs.length > _kept) {
        _runs.remove(_runs.keys.first);
      }
    }
    actionFailed = false;
    run.apply(event);
    notifyListeners();
  }

  /// "我来": moves the app to the main screen.
  Future<void> takeover(String taskId) =>
      _command(taskId, channel.takeover(taskId));

  /// "处理好了": gives the app back to the task.
  Future<void> handBack(String taskId) =>
      _command(taskId, channel.handBack(taskId));

  Future<void> _command(String taskId, Future<TakeoverState> command) async {
    try {
      final state = await command;
      final run = _runs[taskId];
      if (_disposed || run == null || !run.active) return;
      run.takeover = state;
      actionFailed = state == TakeoverState.failed;
    } catch (_) {
      actionFailed = true;
    }
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    if (_events != null) WidgetsBinding.instance.removeObserver(this);
    unawaited(_events?.cancel());
    preview.dispose();
    super.dispose();
  }
}
