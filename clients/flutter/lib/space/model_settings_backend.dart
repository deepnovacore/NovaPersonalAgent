import 'dart:async';
import '../agent_core/model_client.dart';
import '../agent_core/model_presets.dart';
import '../settings/model_settings_backend.dart';
import 'client_state.dart';

/// Only the encrypted Space outbox writes Host configuration. No local model
/// settings, credentials or native engine are opened by this adapter.
class RemoteModelSettingsBackend extends ModelSettingsBackend {
  RemoteModelSettingsBackend(
    this.state, {
    required this.onSync,
    required this.lane,
  });
  final SpaceClientState state;
  final Future<void> Function() onSync;
  final String lane;
  int? _version;

  Map<String, dynamic> _models() {
    final settings = state.snapshot['host_settings'];
    final models = settings is Map ? settings['models'] : null;
    if (state.snapshot['owner'] != true ||
        models is! Map ||
        models['version'] is! int) {
      throw const AgentFailure('host_settings_unavailable');
    }
    return Map<String, dynamic>.from(models);
  }

  List<Map<String, dynamic>> _providers(Map<String, dynamic> models) =>
      (models['providers'] as List? ?? [])
          .whereType<Map>()
          .map((v) => Map<String, dynamic>.from(v))
          .toList();

  @override
  Future<ModelSettingsView> load() async {
    final models = _models();
    _version = models['version'] as int;
    final route = (models['routes'] as Map?)?[lane] as Map?;
    final allowed = (models['lanes'] as Map?)?[lane] as List? ?? const [];
    final current = route?['provider'] as String?;
    final catalog = (models['models'] as List? ?? []).whereType<Map>();
    final providers = _providers(models)
        .where(
          (p) =>
              allowed.contains(p['id']) &&
              (!['self-hosted', 'openai-compatible'].contains(p['id']) ||
                  p['usable'] == true ||
                  p['id'] == current),
        )
        .map(
          (p) => ModelPreset(
            id: p['id'] as String,
            name: p['label'] as String? ?? p['id'] as String,
            endpoint: '',
            recommendedModels: catalog
                .where((m) => m['provider'] == p['id'])
                .map((m) => m['id'] as String)
                .toList(),
            keyUrl: '',
          ),
        )
        .toList();
    final following = route == null;
    final locked = models['locked'] == true;
    return ModelSettingsView(
      providerId: current,
      endpoint: '',
      model: route?['model'] as String? ?? '',
      providers: providers,
      customEndpoint: false,
      modelDiscovery: false,
      canFollow: true,
      followLabel: '使用电脑默认模型',
      following: following,
      readOnly: locked,
      notice: locked
          ? '此模型由电脑的启动配置管理，请在电脑上修改。'
          : models['version'] != models['applied_version']
          ? '已保存的模型选择将在重启电脑上的助手后生效。'
          : following
          ? '当前使用电脑的默认模型。保存后将改用所选模型。'
          : null,
      securityText: '模型选择和新密钥将加密发送到电脑，保存在当前 Space。已有密钥不会传回手机。',
    );
  }

  @override
  Future<bool> hasCredential(String? providerId, String endpoint) async =>
      _providers(_models()).any(
        (p) =>
            p['id'] == providerId &&
            (p['configured'] == true || p['keyOptional'] == true),
      );

  Map<String, dynamic> _editable() {
    final models = _models();
    if (_version == null || models['locked'] == true) {
      throw const AgentFailure('host_settings_read_only');
    }
    return models;
  }

  void _wake() {
    unawaited(onSync().catchError((Object _) {}));
  }

  @override
  Future<void> save(ModelSettingsInput input) async {
    final models = _editable(), providerId = input.providerId;
    final allowed = (models['lanes'] as Map?)?[lane] as List? ?? const [];
    final provider = _providers(
      models,
    ).where((p) => p['id'] == providerId).firstOrNull;
    final key = input.newKey.trim(), name = input.model.trim();
    if (!allowed.contains(providerId) ||
        provider == null ||
        input.endpoint.isNotEmpty ||
        name.isEmpty ||
        name.length > 256 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(name) ||
        key.length > 4096 ||
        RegExp(r'[\x00\r\n]').hasMatch(key)) {
      throw const AgentFailure('invalid_model_settings');
    }
    if (key.isEmpty &&
        provider['configured'] != true &&
        provider['keyOptional'] != true) {
      throw const AgentFailure('invalid_model_settings');
    }
    final dependencies = <String>[];
    if (key.isNotEmpty) {
      dependencies.add(
        await state.enqueue('secret.put', {
          'name': provider['keyName'],
          'value': key,
        }),
      );
    }
    await state.enqueue('settings.patch', {
      'method': 'models.configure',
      'params': {
        'expected_version': _version,
        'routes': {
          lane: {'provider': providerId, 'model': name},
        },
      },
    }, dependsOn: dependencies);
    _wake();
  }

  @override
  Future<void> follow() async {
    _editable();
    await state.enqueue('settings.patch', {
      'method': 'models.configure',
      'params': {
        'expected_version': _version,
        'routes': {lane: null},
      },
    });
    _wake();
  }
}
