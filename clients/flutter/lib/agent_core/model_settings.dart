import '../space/space_storage.dart';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../agent/local_agent.dart';
import 'model_client.dart';
import 'chatgpt_accounts.dart';
import 'provider_credentials.dart';

class ModelSettings {
  ModelSettings({
    this.storage = const FlutterSecureStorage(),
    this.native = const NativeLocalAgent(),
    this.headless = false,
  }) : credentials = ProviderCredentials(storage: storage),
       chatGpt = ChatGptAccounts(storage: storage);
  final ProviderCredentials credentials;
  final ChatGptAccounts chatGpt;
  final FlutterSecureStorage storage;
  final LocalAgent native;
  final bool headless;
  String? _projection;

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

  Future<Map<String, dynamic>?> _readRecord() async {
    await credentials.list(); // Completes registry-first legacy migration.
    final raw = await storage.read(key: _scopedKey);
    return raw == null ? null : jsonDecode(raw) as Map<String, dynamic>;
  }

  Future<ModelConfiguration?> readApiKey() async {
    try {
      final value = await _readRecord();
      if (value == null) return null;
      final endpoint = value['endpoint'] as String;
      final credential = await credentials.resolve(
        endpoint,
        credentialId: value['credentialId'] as String?,
      );
      return ModelConfiguration(
        endpoint: endpoint,
        model: value['model'] as String,
        key: credential?.key ?? '',
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

  Future<void> _projectApiKey(ModelConfiguration config) async {
    final projection = jsonEncode(config.toJson());
    if (_projection == projection) return;
    await native.call('saveModelSettings', config.toJson());
    _projection = projection;
  }

  /// Credential edits do not change the selected conversation or OAuth mode.
  Future<void> refreshApiKeyProjection([String? changedCredentialId]) async {
    if (headless || await chatGpt.active() != null) return;
    if (changedCredentialId != null &&
        (await _readRecord())?['credentialId'] != changedCredentialId) {
      return;
    }
    final config = await readApiKey();
    if (config != null) await _projectApiKey(config);
  }

  Future<void> save({
    required String endpoint,
    required String model,
    required String key,
    ModelProtocol protocol = ModelProtocol.chatCompletions,
  }) async {
    final address = endpoint.trim();
    final old = await _readRecord();
    final sameScope =
        old != null &&
        ProviderCredentials.scopeForEndpoint(old['endpoint'] as String) ==
            ProviderCredentials.scopeForEndpoint(address);
    final credential = await credentials.resolve(
      address,
      credentialId: sameScope ? (old['credentialId'] as String?) : null,
    );
    final value = ModelConfiguration(
      endpoint: address,
      protocol: protocol,
      model: model.trim(),
      key: key.isEmpty ? credential?.key ?? '' : key,
    );
    try {
      final saved = key.isEmpty
          ? credential!
          : await credentials.save(
              id: credential?.id,
              endpoint: address,
              key: key,
            );
      // Dart is authoritative; a failed projection is visible and can be retried.
      await storage.write(
        key: _scopedKey,
        value: jsonEncode({
          'endpoint': value.endpoint,
          'model': value.model,
          'protocol': value.protocol.name,
          'credentialId': saved.id,
        }),
      );
      await chatGpt.useApiKey();
      _projection = null;
      await _projectApiKey(value);
    } catch (_) {
      throw const AgentFailure('model_settings_projection_failed');
    }
  }
}
