import '../agent_core/model_catalog.dart';
import '../agent_core/model_client.dart' hide listModels, listModelsDetailed;
import '../agent_core/model_client.dart'
    as discovery
    show listModels, listModelsDetailed;
import '../agent_core/model_presets.dart';
import '../agent_core/model_probe.dart';
import '../agent_core/model_settings.dart';
import '../agent_core/provider_credentials.dart';

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

  /// Whether this view supports provider setup in the credential manager.
  /// Model editors do not route here automatically.
  bool get supportsProviderSetup =>
      allowKeyEntry &&
      customEndpoint &&
      modelDiscovery &&
      !canFollow &&
      !readOnly;
}

/// A provider with a key on this device; the key itself never leaves storage.
class SavedProvider {
  const SavedProvider({
    required this.id,
    required this.endpoint,
    required this.label,
    this.presetId,
    this.protocol = ModelProtocol.chatCompletions,
  });
  final String id, endpoint, label;

  /// The preset this endpoint belongs to, if any: its name can be shown in the
  /// reader's language, unlike [label].
  final String? presetId;

  /// The API the endpoint was saved with. Records without one read as the
  /// preset's protocol, or Chat Completions.
  final ModelProtocol protocol;

  /// [label], or the preset's name in [language] when there is a preset.
  String labelFor(String language) =>
      ModelPreset.byId(presetId ?? '')?.label(language) ?? label;
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

  /// Listing with capabilities and a typed failure; device-owned keys only.
  Future<ModelListResult> listModelsDetailed(ModelSettingsInput input) =>
      throw UnsupportedError('modelDiscovery');

  /// Asks [ModelSettingsInput.model] to call one tool with the resolved key.
  Future<ProbeResult> probe(ModelSettingsInput input) =>
      throw UnsupportedError('probe');

  Future<List<SavedProvider>> savedProviders() async => const [];

  /// Stores or replaces a provider's key without choosing a model.
  Future<void> saveCredential(ModelSettingsInput input) =>
      throw UnsupportedError('credentials');
  Future<void> deleteProvider(String id) =>
      throw UnsupportedError('credentials');
}

class LocalModelSettingsBackend extends ModelSettingsBackend {
  LocalModelSettingsBackend(
    this.settings, {
    this.support = false,
    this.credentialsOnly = false,
  });
  final ModelSettings settings;
  final bool support, credentialsOnly;
  Map<String, dynamic>? _supportDraft;

  @override
  Future<ModelSettingsView> load() async {
    _supportDraft = support ? await settings.readSupportDraft() : null;
    final draft = _supportDraft ?? const <String, dynamic>{};
    final current = support
        ? null
        : credentialsOnly
        ? await settings.readApiKey()
        : await settings.read();
    final endpoint = support ? draft['endpoint'] as String? : current?.endpoint;
    final address = endpoint ?? ModelPreset.byId('openrouter')!.endpoint;
    final saved = await savedProviders();
    final selected = saved
        .where(
          (p) =>
              ProviderCredentials.scopeForEndpoint(p.endpoint) ==
              ProviderCredentials.scopeForEndpoint(address),
        )
        .firstOrNull;
    return ModelSettingsView(
      providerId: credentialsOnly
          ? ModelPreset.forEndpoint(address)?.id
          : selected?.id,
      providers: credentialsOnly
          ? modelPresets
          : [
              for (final p in saved)
                ModelPreset(
                  id: p.id,
                  name: p.labelFor('zh'),
                  nameEn: p.labelFor('en'),
                  endpoint: p.endpoint,
                  protocol: p.protocol,
                  recommendedModels:
                      ModelPreset.forEndpoint(p.endpoint)?.recommendedModels ??
                      const [],
                  keyUrl: '',
                  sessionHeader: ModelPreset.forEndpoint(
                    p.endpoint,
                  )?.sessionHeader,
                ),
            ],
      customEndpoint: credentialsOnly,
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
      allowKeyEntry: credentialsOnly,
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
    if (credentialsOnly) throw UnsupportedError('model selection');
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

  Future<String> _key(ModelSettingsInput input) async => input.newKey.isNotEmpty
      ? input.newKey
      : (await settings.credentials.resolve(input.endpoint))?.key ?? '';

  @override
  Future<List<String>> listModels(ModelSettingsInput input) async =>
      await discovery.listModels(
        endpoint: input.endpoint,
        key: await _key(input),
        kind: _kind(input),
      );

  @override
  Future<ModelListResult> listModelsDetailed(ModelSettingsInput input) async =>
      await discovery.listModelsDetailed(
        endpoint: input.endpoint,
        key: await _key(input),
        kind: _kind(input),
      );

  /// The preset's own API family decides how its models are listed.
  ProviderKind _kind(ModelSettingsInput input) =>
      ModelPreset.byId(input.providerId ?? '')?.providerKind ??
      ModelPreset.forEndpoint(input.endpoint)?.providerKind ??
      ProviderKind.openAiCompat;

  @override
  Future<ProbeResult> probe(ModelSettingsInput input) async {
    final ModelConfiguration config;
    try {
      config = ModelConfiguration(
        endpoint: input.endpoint.trim(),
        model: input.model.trim(),
        key: await _key(input),
        protocol: input.protocol,
      );
    } on AgentFailure catch (failure) {
      return ProbeFailed(failure);
    }
    return await probeModelTool(config);
  }

  @override
  Future<List<SavedProvider>> savedProviders() async => [
    for (final entry in await settings.credentials.list())
      if (entry.endpoint.startsWith('http'))
        _saved(entry, ModelPreset.forEndpoint(entry.endpoint)),
  ];

  SavedProvider _saved(ProviderCredential entry, ModelPreset? preset) =>
      SavedProvider(
        id: entry.id,
        endpoint: entry.endpoint,
        label: preset?.name ?? entry.label,
        presetId: preset?.id,
        protocol:
            entry.protocol ?? preset?.protocol ?? ModelProtocol.chatCompletions,
      );

  @override
  Future<void> saveCredential(ModelSettingsInput input) async {
    final existing = await settings.credentials.resolve(input.endpoint);
    final saved = await settings.credentials.save(
      id: existing?.id,
      endpoint: input.endpoint.trim(),
      key: input.newKey,
      protocol: input.protocol,
    );
    await settings.refreshApiKeyProjection(saved.id);
  }

  @override
  Future<void> deleteProvider(String id) async {
    await settings.credentials.delete(id);
    await settings.refreshApiKeyProjection(id);
  }
}
