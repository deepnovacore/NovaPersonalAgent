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
