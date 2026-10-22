import 'dart:async';
import 'package:flutter/services.dart';

/// Platform lifetime for an explicitly started call, separate from task lifetime.
abstract interface class VoiceCompanion {
  Future<bool> Function()? onRestore;
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

class NativeVoiceCompanion implements VoiceCompanion {
  static int _nextCall = 0;
  String? _callId;
  @override
  Future<bool> Function()? onRestore;
  static const _channel = MethodChannel('nova/voice_companion');
  final _actions = StreamController<String>.broadcast(sync: true);
  @override
  Stream<String> get actions => _actions.stream;
  @override
  Future<void> start() async {
    final id = _callId =
        '${DateTime.now().microsecondsSinceEpoch}-${_nextCall++}';
    _channel.setMethodCallHandler((call) async {
      if (_callId != id) return false;
      final arguments = call.arguments;
      if (arguments is Map) {
        if (arguments['callId'] != id) return false;
        if (call.method == 'restore') {
          final restored = await onRestore?.call() ?? false;
          return _callId == id && restored;
        }
        if (call.method == 'action' && arguments['action'] is String) {
          _actions.add(arguments['action'] as String);
        }
      }
      if (call.method == 'action' && call.arguments is String) {
        _actions.add(call.arguments as String);
      }
    });
    await _channel.invokeMethod<void>('start', {'callId': id});
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
      if (_callId == null) _channel.setMethodCallHandler(null);
    }
  }
}
