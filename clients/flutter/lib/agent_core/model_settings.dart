import '../space/space_storage.dart';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../agent/local_agent.dart';
import 'model_client.dart';
import 'chatgpt_accounts.dart';

class ModelSettings {
  ModelSettings({
    this.storage = const FlutterSecureStorage(),
    this.native = const NativeLocalAgent(),
    this.headless = false,
  });
  final FlutterSecureStorage storage;
  final LocalAgent native;
  final bool headless;
  String? _projection;
  late final chatGpt = ChatGptAccounts(storage: storage);

  Future<void> clearNativeChatGpt() async {
    _projection = null;
    await native.call('clearChatGptSettings');
  }

  Future<void> useApiKey() async {
    await chatGpt.useApiKey();
    await clearNativeChatGpt();
    final config = await readApiKey();
    if (config != null) {
      await native.call('saveModelSettings', config.toJson());
    }
  }

  final String _scopedKey = SpaceStorage.secureKey(storageKey);
  static const storageKey = 'nova.dart-model.v1';

  Future<ModelConfiguration?> read() async {
    try {
      final account = await chatGpt.active();
      if (account != null) {
        final credentials = await chatGpt.credentials(allowRefresh: !headless);
        if (credentials['client_id'] != account['client_id']) {
          throw const AgentFailure('chatgpt_account_changed');
        }
        Future<void> validateSelection() async {
          final selected = await chatGpt.active();
          if (selected == null ||
              selected['client_id'] != credentials['client_id'] ||
              selected['model'] != credentials['model'] ||
              selected['access_token'] != credentials['access_token']) {
            throw const AgentFailure('chatgpt_account_changed');
          }
        }

        await validateSelection();
        if (credentials['model'] is! String) {
          throw const AgentFailure('chatgpt_model_required');
        }
        final config = ModelConfiguration(
          endpoint: chatGptResource,
          model: credentials['model'] as String,
          key: credentials['access_token'] as String,
          protocol: ModelProtocol.chatgptResponses,
        );
        final projection = jsonEncode(config.toJson());
        if (!headless && _projection != projection) {
          await native.call('saveModelSettings', {
            ...config.toJson(),
            'expires_at': credentials['expires_at'],
          });
          _projection = projection;
        }
        await validateSelection();
        return config;
      }
      return await readApiKey();
    } on AgentFailure {
      rethrow;
    } catch (_) {
      throw const AgentFailure('model_settings_unavailable');
    }
  }

  Future<ModelConfiguration?> readApiKey() async {
    try {
      final raw = await storage.read(key: _scopedKey);
      if (raw == null) return null;
      final value = jsonDecode(raw) as Map;
      return ModelConfiguration(
        endpoint: value['endpoint'] as String,
        model: value['model'] as String,
        key: value['key'] as String,
        protocol: ModelProtocol.values.byName(
          value['protocol'] as String? ?? 'chatCompletions',
        ),
      );
    } on AgentFailure {
      rethrow;
    } catch (_) {
      throw const AgentFailure('model_settings_unavailable');
    }
  }

  Future<void> save({
    required String endpoint,
    required String model,
    required String key,
    ModelProtocol protocol = ModelProtocol.chatCompletions,
  }) async {
    final old = await readApiKey();
    final value = ModelConfiguration(
      endpoint: endpoint.trim(),
      protocol: protocol,
      model: model.trim(),
      key: key.isEmpty && old?.endpoint == endpoint.trim() ? old!.key : key,
    );
    try {
      await chatGpt.useApiKey();
      // Dart is authoritative; a failed projection is visible and can be retried.
      await storage.write(key: _scopedKey, value: jsonEncode(value.toJson()));
      await native.call('saveModelSettings', value.toJson());
    } catch (_) {
      throw const AgentFailure('model_settings_projection_failed');
    }
  }
}
