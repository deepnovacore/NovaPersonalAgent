import 'dart:async';
import 'package:flutter/services.dart';
import '../ui/pet_avatar.dart';

/// Platform lifetime for an explicitly started call, separate from task lifetime.
abstract interface class VoiceCompanion {
  Future<bool> Function()? onRestore;

  /// Call controls plus task_stop and open. Task actions are
  /// filtered to the currently shown task; integration executes the operation.
  Stream<String> get actions;
  Future<void> start();
  Future<void> update({
    required bool muted,
    String status = 'listening',
    String language = 'zh',
  });
  Future<bool> minimize();
  Future<void> stop();
}

/// Independent Android phone-task lifetime. Use the same instance as the call
/// companion so task and call callbacks share one channel handler.
abstract interface class TaskCompanion {
  /// Portrait PNG bytes or a device-local file. Use bindTaskAvatar for the default.
  Future<void> setAvatar({Uint8List? pngBytes, String? filePath});

  /// Returns true on success; throws PlatformException with overlay_permission,
  /// foreground_blocked, timeout, or overlay_blocked on failure.
  /// Integration maps phone events to these statuses; this API starts no task.
  /// done/failed remain visible for three seconds, without ending an active call.
  Future<bool> showTask({
    required String taskId,
    required String status,
    String label = '',
    int? step,
  });

  /// Latest JPEG preview, dropped above 5fps or while a send is in flight.
  /// Send only while previewWanted; use previewChanges to stop encoding/capture.
  /// Secure/takeover frames must not be forwarded.
  Future<void> taskFrame(Uint8List jpeg);

  /// Releases only the task overlay lifetime, not the task or active call.
  Future<void> hideTask({String? taskId});
  Future<void> requestOverlayPermission();
  bool get previewWanted;
  Stream<bool> get previewChanges;
  Stream<TaskOverlayGone> get taskDisappearances;
}

class TaskOverlayGone {
  const TaskOverlayGone(this.taskId, this.reason);
  final String taskId;
  final String reason;
}

/// Integration owns this binding; call the returned function before disposing
/// the store. The default is the already-approved Flutter asset, not the orb.
Future<void Function()> bindTaskAvatar(
  TaskCompanion companion,
  PetAvatarStore store, {
  AssetBundle? bundle,
  required void Function(Object, StackTrace) onError,
}) async {
  var revision = 0;
  var disposed = false;
  Future<void> apply() async {
    final current = ++revision;
    final path = store.customPath;
    if (path != null) {
      await companion.setAvatar(filePath: path);
    } else {
      final data = await (bundle ?? rootBundle).load(petAvatarAsset);
      if (disposed || current != revision) return;
      await companion.setAvatar(
        pngBytes: data.buffer.asUint8List(
          data.offsetInBytes,
          data.lengthInBytes,
        ),
      );
    }
  }

  void changed() {
    unawaited(apply().catchError(onError));
  }

  store.addListener(changed);
  try {
    await apply();
  } catch (_) {
    disposed = true;
    store.removeListener(changed);
    rethrow;
  }
  return () {
    disposed = true;
    revision++;
    store.removeListener(changed);
  };
}

class NativeVoiceCompanion implements VoiceCompanion, TaskCompanion {
  static int _nextCall = 0;
  String? _callId;
  String? _taskId;
  int _taskRevision = 0;
  NativeVoiceCompanion({int Function()? frameMilliseconds})
    : _frameMilliseconds =
          frameMilliseconds ?? (Stopwatch()..start()).elapsedMillisecondsClock;
  final int Function() _frameMilliseconds;
  bool _previewWanted = false;
  final _previewChanges = StreamController<bool>.broadcast(sync: true);
  final _taskDisappearances = StreamController<TaskOverlayGone>.broadcast(
    sync: true,
  );
  @override
  bool get previewWanted => _previewWanted;
  @override
  Stream<bool> get previewChanges => _previewChanges.stream;
  @override
  Stream<TaskOverlayGone> get taskDisappearances => _taskDisappearances.stream;
  void _setPreviewWanted(bool wanted) {
    if (_previewWanted == wanted) return;
    _previewWanted = wanted;
    _previewChanges.add(wanted);
  }

  int? _lastFrame;
  bool _framePending = false;
  @override
  Future<bool> Function()? onRestore;
  static const _channel = MethodChannel('nova/voice_companion');
  final _actions = StreamController<String>.broadcast(sync: true);
  @override
  Stream<String> get actions => _actions.stream;
  void _installHandler() {
    _channel.setMethodCallHandler((call) async {
      final arguments = call.arguments;
      if (arguments is Map) {
        if (arguments.containsKey('taskId')) {
          if (_taskId == null || arguments['taskId'] != _taskId) return false;
          if (call.method == 'previewWanted') {
            _setPreviewWanted(arguments['wanted'] == true);
          } else if (call.method == 'taskGone') {
            final id = _taskId!;
            _taskId = null;
            _taskRevision++;
            _lastFrame = null;
            _setPreviewWanted(false);
            _taskDisappearances.add(
              TaskOverlayGone(id, arguments['reason'] as String? ?? 'hidden'),
            );
          } else if (call.method == 'action' && arguments['action'] is String) {
            _actions.add(arguments['action'] as String);
          }
          return null;
        }
        final id = _callId;
        if (id == null || arguments['callId'] != id) return false;
        if (call.method == 'restore') {
          final restored = await onRestore?.call() ?? false;
          return _callId == id && restored;
        }
        if (call.method == 'action' && arguments['action'] is String) {
          _actions.add(arguments['action'] as String);
        }
      }
      if (_callId != null && call.method == 'action' && arguments is String) {
        _actions.add(arguments);
      }
      return null;
    });
  }

  @override
  Future<void> start() async {
    final id = _callId =
        '${DateTime.now().microsecondsSinceEpoch}-${_nextCall++}';
    _installHandler();
    await _channel.invokeMethod<void>('start', {'callId': id});
  }

  @override
  Future<void> setAvatar({Uint8List? pngBytes, String? filePath}) {
    if (pngBytes != null && filePath != null) {
      throw ArgumentError('Supply either pngBytes or filePath');
    }
    return _channel.invokeMethod<void>('setAvatar', {
      'pngBytes': pngBytes,
      'filePath': filePath,
    });
  }

  @override
  Future<bool> showTask({
    required String taskId,
    required String status,
    String label = '',
    int? step,
  }) async {
    if (taskId.trim().isEmpty ||
        !const {'running', 'needs_user', 'done', 'failed'}.contains(status) ||
        (step != null && step < 0)) {
      throw ArgumentError('Invalid task state');
    }
    final revision = ++_taskRevision;
    if (_taskId != taskId) {
      _lastFrame = null;
      _setPreviewWanted(false);
    }
    if (status != 'running') _setPreviewWanted(false);
    _taskId = taskId;
    _installHandler();
    try {
      final shown =
          await _channel.invokeMethod<bool>('showTask', {
            'taskId': taskId,
            'status': status,
            'label': label,
            'step': step,
          }) ??
          false;
      if (!shown) {
        throw PlatformException(
          code: 'overlay_blocked',
          message: 'Legacy overlay startup failed',
        );
      }
      return true;
    } catch (_) {
      if (_taskRevision == revision) {
        _taskId = null;
        _setPreviewWanted(false);
      }
      rethrow;
    }
  }

  @override
  Future<void> taskFrame(Uint8List jpeg) async {
    final id = _taskId;
    final now = _frameMilliseconds();
    if (id == null ||
        !_previewWanted ||
        _framePending ||
        (_lastFrame != null && now - _lastFrame! < 200)) {
      return;
    }
    _lastFrame = now;
    _framePending = true;
    try {
      await _channel.invokeMethod<void>('taskFrame', {
        'taskId': id,
        'jpeg': jpeg,
      });
    } finally {
      _framePending = false;
    }
  }

  @override
  Future<void> hideTask({String? taskId}) async {
    if (taskId != null && taskId != _taskId) return;
    final id = taskId ?? _taskId;
    _taskRevision++;
    _setPreviewWanted(false);
    _taskId = null;
    _lastFrame = null;
    try {
      await _channel.invokeMethod<void>('hideTask', {'taskId': id});
    } finally {
      if (_callId == null && _taskId == null) {
        _channel.setMethodCallHandler(null);
      }
    }
  }

  @override
  Future<void> requestOverlayPermission() =>
      _channel.invokeMethod<void>('requestOverlayPermission');

  @override
  Future<void> update({
    required bool muted,
    String status = 'listening',
    String language = 'zh',
  }) => _channel.invokeMethod<void>('update', {
    'callId': _callId,
    'muted': muted,
    'status': status,
    'language': language,
  });
  @override
  Future<bool> minimize() async =>
      await _channel.invokeMethod<bool>('minimize', {'callId': _callId}) ??
      false;
  @override
  Future<void> stop() async {
    final id = _callId;
    _callId = null;
    try {
      await _channel.invokeMethod<void>('stop', {'callId': id});
    } finally {
      if (_callId == null && _taskId == null) {
        _channel.setMethodCallHandler(null);
      }
    }
  }
}

// Keep production and test throttle clocks monotonic without wall-clock sleeps.
extension on Stopwatch {
  int elapsedMillisecondsClock() => elapsedMilliseconds;
}
