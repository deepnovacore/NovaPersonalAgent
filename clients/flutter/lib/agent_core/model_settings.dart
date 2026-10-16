import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../agent/local_agent.dart';
import 'model_client.dart';

class ModelSettings {
  ModelSettings({
    this.storage = const FlutterSecureStorage(),
    this.native = const NativeLocalAgent(),
  });
  final FlutterSecureStorage storage;
  final LocalAgent native;
  static const storageKey = 'nova.dart-model.v1';

  Future<ModelConfiguration?> read() async {
    try {
      final raw = await storage.read(key: storageKey);
      if (raw == null) return null;
      final value = jsonDecode(raw) as Map;
      return ModelConfiguration(
        endpoint: value['endpoint'] as String,
        model: value['model'] as String,
        key: value['key'] as String,
      );
    } catch (_) {
      throw const AgentFailure('model_settings_unavailable');
    }
  }

  Future<void> save({
    required String endpoint,
    required String model,
    required String key,
  }) async {
    final old = await read();
    final value = ModelConfiguration(
      endpoint: endpoint.trim(),
      model: model.trim(),
      key: key.isEmpty && old?.endpoint == endpoint.trim() ? old!.key : key,
    );
    try {
      // Dart is authoritative; a failed projection is visible and can be retried.
      await storage.write(key: storageKey, value: jsonEncode(value.toJson()));
      await native.call('saveModelSettings', value.toJson());
    } catch (_) {
      throw const AgentFailure('model_settings_projection_failed');
    }
  }
}
