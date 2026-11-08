import '../space/space_storage.dart';
import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../agent/local_agent.dart';
import 'model_client.dart';
import 'chatgpt_accounts.dart';
import 'provider_credentials.dart';

enum ModelPurpose { conversationText, support }

class ModelSettings {
  ModelSettings({
    this.storage = const FlutterSecureStorage(),
    this.native = const NativeLocalAgent(),
    this.headless = false,
    this.managedConfiguration,
  }) : credentials = ProviderCredentials(storage: storage),
       chatGpt = ChatGptAccounts(storage: storage);
  final ProviderCredentials credentials;
  final ChatGptAccounts chatGpt;
  final FlutterSecureStorage storage;
  final LocalAgent native;
  final bool headless;
  final Future<ModelConfiguration> Function()? managedConfiguration;
  String? _projection;

  Map<String, String> get _nativeScope => {'space_id': ?_spaceId};

  static final _projectionTails = <String, Future<void>>{};

  // Validate queued writes against the selection after an in-flight reset.
  Future<void> _serializeProjection(Future<void> Function() action) {
    final result = (_projectionTails[_scopedKey] ?? Future<void>.value()).then(
      (_) => action(),
    );
    final tail = result.then<void>((_) {}, onError: (Object _) {});
    _projectionTails[_scopedKey] = tail;
    unawaited(
      tail.whenComplete(() {
        if (identical(_projectionTails[_scopedKey], tail)) {
          _projectionTails.remove(_scopedKey);
        }
      }),
    );
    return result;
  }

  Future<void> clearNativeChatGpt() => _serializeProjection(() async {
    _projection = null;
    await native.call('clearChatGptSettings', _nativeScope);
  });

  Future<void> useApiKey() async {
    await chatGpt.useApiKey();
    _changed();
    await clearNativeChatGpt();
    final config = await readApiKey();
    if (config != null) {
      await _projectApiKey(config);
    }
  }

  final String _scopedKey = SpaceStorage.secureKey(storageKey);
  final String _supportKey = SpaceStorage.secureKey(supportStorageKey);
  static const supportStorageKey = 'nova.model-support.v1';
  static final _changes = StreamController<String>.broadcast(sync: true);
  Stream<void> get changes =>
      _changes.stream.where((key) => key == _scopedKey).map((_) {});
  void _changed() => _changes.add(_scopedKey);

  /// An unset support route follows the current conversation, including OAuth.
  Future<ModelConfiguration?> readForPurpose(ModelPurpose purpose) async {
    if (managedConfiguration case final managed?) return managed();
    if (purpose == ModelPurpose.conversationText) return read();
    final draft = await readSupportDraft();
    if (draft == null) return read();
    try {
      final protocol = ModelProtocol.values.byName(draft['protocol'] as String);
      if (protocol == ModelProtocol.chatgptResponses) {
        throw const AgentFailure('invalid_model_settings');
      }
      final credential = await credentials.resolve(
        draft['endpoint'] as String,
        credentialId: draft['credentialId'] as String,
      );
      if (credential == null) {
        throw const AgentFailure('provider_credential_missing');
      }
      return ModelConfiguration(
        endpoint: draft['endpoint'] as String,
        model: draft['model'] as String,
        key: credential.key,
        protocol: protocol,
      );
    } on AgentFailure {
      rethrow;
    } catch (_) {
      throw const AgentFailure('model_settings_unavailable');
    }
  }

  /// This editable selection contains references only, never API or OAuth keys.
  Future<Map<String, dynamic>?> readSupportDraft() async {
    try {
      final raw = await storage.read(key: _supportKey);
      return raw == null ? null : jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      throw const AgentFailure('model_settings_unavailable');
    }
  }

  Future<void> saveSupport({
    required String endpoint,
    required String model,
    required String credentialId,
    ModelProtocol protocol = ModelProtocol.chatCompletions,
  }) async {
    if (protocol == ModelProtocol.chatgptResponses) {
      throw const AgentFailure('invalid_model_settings');
    }
    final address = endpoint.trim();
    final credential = await credentials.resolve(
      address,
      credentialId: credentialId,
    );
    if (credential == null) {
      throw const AgentFailure('provider_credential_missing');
    }
    final value = ModelConfiguration(
      endpoint: address,
      model: model.trim(),
      key: credential.key,
      protocol: protocol,
    );
    await storage.write(
      key: _supportKey,
      value: jsonEncode({
        'endpoint': value.endpoint,
        'model': value.model,
        'protocol': value.protocol.name,
        'credentialId': credential.id,
      }),
    );
    _changed();
  }

  Future<void> resetSupport() async {
    await storage.delete(key: _supportKey);
    _changed();
  }

  static const storageKey = 'nova.dart-model.v1';
  final String? _spaceId = SpaceStorage.scope?.id;

  Future<bool> hasConversationSelection() async =>
      await chatGpt.active() != null ||
      await storage.read(key: _scopedKey) != null;

  Future<void> clearConversationSelection() => _serializeProjection(() async {
    if (!headless) {
      await native.call('clearModelSettings', _nativeScope);
    }
    _projection = null;
    await storage.delete(key: _scopedKey);
    await chatGpt.useApiKey();
    _changed();
  });

  Future<ModelConfiguration?> read() async {
    if (managedConfiguration case final managed?) return managed();
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
          await _serializeProjection(() async {
            await validateSelection();
            if (_projection == projection) return;
            await native.call('saveModelSettings', {
              ...config.toJson(),
              ..._nativeScope,
              'expires_at': credentials['expires_at'],
            });
            _projection = projection;
          });
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

  Future<Map<String, dynamic>?> readConversationDraft() => _readRecord();

  Future<ModelConfiguration?> readApiKey() async {
    try {
      final value = await _readRecord();
      if (value == null) return null;
      final endpoint = value['endpoint'] as String;
      final credential = await credentials.resolve(
        endpoint,
        credentialId: value['credentialId'] as String?,
      );
      if (credential == null) {
        throw const AgentFailure('provider_credential_missing');
      }
      return ModelConfiguration(
        endpoint: endpoint,
        model: value['model'] as String,
        key: credential.key,
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

  Future<void> _projectApiKey(ModelConfiguration config) =>
      _serializeProjection(() async {
        final projection = jsonEncode(config.toJson());
        if (_projection == projection || await chatGpt.active() != null) return;
        if (jsonEncode((await readApiKey())?.toJson()) != projection) return;
        await native.call('saveModelSettings', {
          ...config.toJson(),
          ..._nativeScope,
        });
        _projection = projection;
      });

  /// Credential edits do not change the selected conversation or OAuth mode.
  Future<void> refreshApiKeyProjection([String? changedCredentialId]) async {
    _changed();
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
      // The credential also records the protocol, so the provider list can
      // reopen a custom endpoint with the API it was saved with.
      final saved = key.isEmpty && credential!.protocol == protocol
          ? credential
          : await credentials.save(
              id: credential?.id,
              endpoint: address,
              key: key,
              protocol: protocol,
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
      _changed();
      await _projectApiKey(value);
    } catch (_) {
      throw const AgentFailure('model_settings_projection_failed');
    }
  }
}
