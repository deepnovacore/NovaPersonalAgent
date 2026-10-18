import 'dart:async';
import 'package:flutter/services.dart';

/// Platform lifetime for an explicitly started call, separate from task lifetime.
abstract interface class VoiceCompanion {
  Stream<String> get actions;
  Future<void> start();
  Future<void> update({required bool muted});
  Future<bool> minimize();
  Future<void> stop();
}

class NativeVoiceCompanion implements VoiceCompanion {
  static const _channel = MethodChannel('nova/voice_companion');
  final _actions = StreamController<String>.broadcast(sync: true);
  @override
  Stream<String> get actions => _actions.stream;
  @override
  Future<void> start() async {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'action' && call.arguments is String) {
        _actions.add(call.arguments as String);
      }
    });
    await _channel.invokeMethod<void>('start');
  }

  @override
  Future<void> update({required bool muted}) =>
      _channel.invokeMethod<void>('update', {'muted': muted});
  @override
  Future<bool> minimize() async =>
      await _channel.invokeMethod<bool>('minimize') ?? false;
  @override
  Future<void> stop() async {
    try {
      await _channel.invokeMethod<void>('stop');
    } finally {
      _channel.setMethodCallHandler(null);
    }
  }
}
