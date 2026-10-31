import '../agent_core/model_client.dart' hide listModels;
import '../agent_core/model_client.dart' as discovery show listModels;
import '../agent_core/model_presets.dart';
import '../agent_core/model_settings.dart';

/// Editable selection and capabilities only. Credentials never enter this view.
class ModelSettingsView {
  const ModelSettingsView({
    required this.providerId,
    required this.endpoint,
    required this.model,
    this.protocol = ModelProtocol.chatCompletions,
    this.providers = modelPresets,
    this.customEndpoint = true,
    this.modelDiscovery = true,
    this.canFollow = false,
    this.following = false,
    this.readOnly = false,
    this.allowKeyEntry = true,
    this.notice,
    this.followLabel,
    this.securityText,
  });
  final String? providerId;
  final String endpoint, model;
  final ModelProtocol protocol;
  final List<ModelPreset> providers;
  final bool customEndpoint, modelDiscovery, canFollow, following, readOnly;
  final bool allowKeyEntry;
  final String? notice, securityText, followLabel;
}

/// A newly typed key is write-only and must never be copied into a view.
class ModelSettingsInput {
  const ModelSettingsInput({
    required this.providerId,
    required this.endpoint,
    required this.model,
    required this.protocol,
    this.newKey = '',
  });
  final String? providerId;
  final String endpoint, model, newKey;
  final ModelProtocol protocol;
}

/// One instance edits one model lane; transport and secure storage stay behind it.
abstract class ModelSettingsBackend {
  Future<ModelSettingsView> load();
  Future<bool> hasCredential(String? providerId, String endpoint);
  Future<void> save(ModelSettingsInput input);
  Future<void> follow() => throw UnsupportedError('follow');
  Future<List<String>> listModels(ModelSettingsInput input) =>
      throw UnsupportedError('modelDiscovery');
}

class LocalModelSettingsBackend extends ModelSettingsBackend {
  LocalModelSettingsBackend(this.settings, {this.support = false});
  final ModelSettings settings;
  final bool support;
  Map<String, dynamic>? _supportDraft;

  @override
  Future<ModelSettingsView> load() async {
    _supportDraft = support ? await settings.readSupportDraft() : null;
    final draft = _supportDraft ?? const <String, dynamic>{};
    final current = support ? null : await settings.read();
    final endpoint = support ? draft['endpoint'] as String? : current?.endpoint;
    final address = endpoint ?? ModelPreset.byId('openrouter')!.endpoint;
    return ModelSettingsView(
      providerId: ModelPreset.forEndpoint(address)?.id,
      endpoint: address,
      model:
          (support ? draft['model'] as String? : current?.model) ??
          'openai/gpt-4.1-mini',
      protocol: support
          ? ModelProtocol.values.byName(
              draft['protocol'] as String? ?? 'chatCompletions',
            )
          : current?.protocol ?? ModelProtocol.chatCompletions,
      canFollow: support,
      following: support && _supportDraft == null,
      allowKeyEntry: !support,
    );
  }

  String? _credentialId(String endpoint) {
    final draft = _supportDraft;
    if (draft == null || draft['endpoint'] != endpoint) return null;
    return draft['credentialId'] as String?;
  }

  @override
  Future<bool> hasCredential(String? providerId, String endpoint) async =>
      await settings.credentials.resolve(
        endpoint,
        credentialId: _credentialId(endpoint),
      ) !=
      null;

  @override
  Future<void> save(ModelSettingsInput input) async {
    if (!support) {
      await settings.save(
        endpoint: input.endpoint,
        model: input.model,
        key: input.newKey,
        protocol: input.protocol,
      );
      return;
    }
    final credential = await settings.credentials.resolve(
      input.endpoint,
      credentialId: _credentialId(input.endpoint),
    );
    if (credential == null) throw const AgentFailure('invalid_model_settings');
    await settings.saveSupport(
      endpoint: input.endpoint,
      model: input.model,
      credentialId: credential.id,
      protocol: input.protocol,
    );
  }

  @override
  Future<void> follow() => settings.resetSupport();

  @override
  Future<List<String>> listModels(ModelSettingsInput input) async {
    final key = input.newKey.isNotEmpty
        ? input.newKey
        : (await settings.credentials.resolve(input.endpoint))?.key ?? '';
    return await discovery.listModels(endpoint: input.endpoint, key: key);
  }
}
