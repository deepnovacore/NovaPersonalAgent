import 'dart:async';
import 'package:flutter/services.dart';

/// Platform lifetime for an explicitly started call, separate from task lifetime.
abstract interface class VoiceCompanion {
  Future<bool> Function()? onRestore;

  /// Call controls plus task_stop, task_takeover and open. Task actions are
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
  /// Pass PetAvatarStore.customPath, or portrait PNG bytes. Omit both to reset to orb.
  Future<void> setAvatar({Uint8List? pngBytes, String? filePath});

  /// Returns false if overlay permission or foreground-service startup is denied.
  /// Integration maps phone events to these statuses; this API starts no task.
  /// done/failed remain visible for three seconds, without ending an active call.
  Future<bool> showTask({
    required String taskId,
    required String status,
    String label = '',
    int? step,
  });

  /// Latest JPEG preview, dropped above 5fps or while a send is in flight.
  /// Native also drops frames while hidden/collapsed. Subscribe to phone frames
  /// separately; secure/takeover frames must not be forwarded.
  Future<void> taskFrame(Uint8List jpeg);

  /// Releases only the task overlay lifetime, not the task or active call.
  Future<void> hideTask();
}

class NativeVoiceCompanion implements VoiceCompanion, TaskCompanion {
  static int _nextCall = 0;
  String? _callId;
  String? _taskId;
  int _taskRevision = 0;
  final _frameClock = Stopwatch()..start();
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
          if (call.method == 'action' && arguments['action'] is String) {
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
    if (_taskId != taskId) _lastFrame = null;
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
      if (!shown && _taskRevision == revision) _taskId = null;
      return shown;
    } catch (_) {
      if (_taskRevision == revision) _taskId = null;
      rethrow;
    }
  }

  @override
  Future<void> taskFrame(Uint8List jpeg) async {
    final id = _taskId;
    final now = _frameClock.elapsedMilliseconds;
    if (id == null ||
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
  Future<void> hideTask() async {
    _taskRevision++;
    _taskId = null;
    _lastFrame = null;
    try {
      await _channel.invokeMethod<void>('hideTask');
    } finally {
      if (_callId == null && _taskId == null) {
        _channel.setMethodCallHandler(null);
      }
    }
  }

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
