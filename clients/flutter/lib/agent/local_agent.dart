import 'dart:convert';
import 'package:flutter/services.dart';

/// UI commands and projections only. The native host owns task state.
abstract interface class LocalAgent {
  Future<dynamic> call(String method, [Map<String, dynamic> input = const {}]);
}

class NativeLocalAgent implements LocalAgent {
  const NativeLocalAgent();
  static const _channel = MethodChannel('nova/local_agent/v1');
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    final reply = await _channel.invokeMethod<String>(
      method,
      jsonEncode(input),
    );
    return reply == null ? null : jsonDecode(reply);
  }
}

// These native loop stages only read; an interrupted dispatch keeps an unknown outcome.
bool isNativeReadFailure(Map task) {
  final reason = task['reason'];
  return task['phase'] == 'interrupted' &&
      reason is String &&
      (reason.startsWith('observation_') ||
          reason.startsWith('model_') ||
          reason == 'tool_screen_changed_during_capture');
}
