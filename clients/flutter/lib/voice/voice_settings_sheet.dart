import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';

import '../agent_core/model_client.dart';
import '../agent_core/model_presets.dart';
import '../ui/local_dialog.dart';
import '../ui/provider_credentials_sheet.dart';
import 'voice_settings.dart';

Future<bool?> showVoiceSettings(
  BuildContext context,
  VoiceSettings settings, {
  bool dictationOnly = false,
  String language = 'zh',
}) async {
  final existing = await settings.readDraft();
  if (!context.mounted) return null;
  return showLocalDialog<bool>(
    context: context,
    builder: (_) => VoiceSettingsSheet(
      settings: settings,
      initial: existing,
      dictationOnly: dictationOnly,
      language: language,
    ),
  );
}

class VoiceSettingsSheet extends StatefulWidget {
  const VoiceSettingsSheet({
    super.key,
    required this.settings,
    this.initial,
    this.dictationOnly = false,
    this.language = 'zh',
  });
  final VoiceSettings settings;
  final VoiceConfiguration? initial;
  final bool dictationOnly;
  final String language;
  @override
  State<VoiceSettingsSheet> createState() => _VoiceSettingsSheetState();
}

class _ServiceFields {
  _ServiceFields(VoiceServiceConfiguration config)
    : endpoint = TextEditingController(text: config.endpoint),
      model = TextEditingController(text: config.model),
      voice = TextEditingController(text: config.voice),
      credentialId = config.credentialId {
    endpoint.addListener(_endpointChanged);
  }
  final TextEditingController endpoint, model, voice;
  String? credentialId;
  final resourceId = TextEditingController();
  void _endpointChanged() {
    credentialId = null;
    resourceId.clear();
  }

  VoiceServiceConfiguration get value => VoiceServiceConfiguration(
    endpoint: endpoint.text,
    model: model.text,
    credentialId: credentialId,
    voice: voice.text,
    resourceId: resourceId.text,
  );
  void replace(VoiceServiceConfiguration config) {
    endpoint.text = config.endpoint;
    model.text = config.model;
    voice.text = config.voice;
    credentialId = null;
    resourceId.clear();
    credentialId = config.credentialId;
  }

  void dispose() {
    endpoint.removeListener(_endpointChanged);
    endpoint.dispose();
    model.dispose();
    voice.dispose();
    resourceId.dispose();
  }
}

class _VoiceSettingsSheetState extends State<VoiceSettingsSheet> {
  late VoiceConfiguration _draft;
  late final _ServiceFields _asr, _tts, _llm;
  ModelPreset? _forebrainPreset;
  bool _endpointRewritten = false;
  bool _saving = false;
  String? _error;
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;

  @override
  void initState() {
    super.initState();
    final initial = widget.initial ?? const VoiceConfiguration();
    final provider = initial.integratedProfile;
    // The integrated service only talks to the provider's official endpoint.
    // Historical custom endpoints are replaced instead of shown or kept.
    final endpoint = IntegratedVoiceCatalog.officialEndpoint(provider);
    _endpointRewritten =
        initial.integrated.endpoint.trim().isNotEmpty &&
        initial.integrated.endpoint.trim() != endpoint;
    final savedModel = initial.integrated.model.trim();
    final model = savedModel.isEmpty
        ? IntegratedVoiceCatalog.defaultModel(provider)
        : savedModel;
    final savedVoice = initial.integrated.voice.trim();
    final voice = savedVoice.isEmpty
        ? IntegratedVoiceCatalog.defaultVoice(provider, model)
        : savedVoice;
    _draft = initial.copyWith(
      integrated: initial.integrated.copyWith(
        endpoint: endpoint,
        model: model,
        voice: voice,
      ),
    );
    _asr = _ServiceFields(_draft.asr);
    _tts = _ServiceFields(_draft.tts);
    _llm = _ServiceFields(_draft.fastLlm);
    _forebrainPreset = ModelPreset.forEndpoint(_draft.fastLlm.endpoint);
  }

  @override
  void dispose() {
    for (final fields in [_asr, _tts, _llm]) {
      fields.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (widget.dictationOnly) {
        await widget.settings.saveAsr(
          provider: _draft.asrProvider,
          asr: _asr.value,
        );
      } else {
        await widget.settings.save(
          _draft.copyWith(
            integrated: _draft.integrated.copyWith(
              endpoint: IntegratedVoiceCatalog.officialEndpoint(
                _draft.integratedProfile,
              ),
              key: '',
            ),
            asr: _asr.value,
            tts: _tts.value,
            fastLlm: _llm.value,
          ),
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error =
            error is AgentFailure &&
                (error.code == 'invalid_voice_settings' ||
                    error.code == 'invalid_model_settings')
            ? t(
                '请检查服务地址和模型，并到「配置密钥」检查密钥。地址须使用 HTTPS/WSS（本机开发地址除外），不能含查询参数、账号或片段。',
                'Check the service address and model, and configure credentials in Model provider. Use HTTPS/WSS (except local development), without query parameters, account information or fragments.',
              )
            : t(
                '无法安全保存语音设置，请稍后重试。',
                'Could not securely save voice settings. Please try again.',
              );
      });
    }
  }

  void _selectPipeline(VoicePipeline value) {
    if (_draft.pipeline == value) return;
    setState(() => _draft = _draft.copyWith(pipeline: value));
  }

  Widget _pipelineTab(VoicePipeline value, String label) {
    final selected = _draft.pipeline == value;
    final scheme = Theme.of(context).colorScheme;
    return Expanded(
      child: Semantics(
        button: true,
        selected: selected,
        inMutuallyExclusiveGroup: true,
        child: GestureDetector(
          key: ValueKey('pipeline.tab.${value.name}'),
          behavior: HitTestBehavior.opaque,
          onTap: _saving ? null : () => _selectPipeline(value),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            constraints: const BoxConstraints(minHeight: 56),
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
            decoration: BoxDecoration(
              color: selected ? scheme.secondaryContainer : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              label,
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: selected
                    ? scheme.onSecondaryContainer
                    : scheme.onSurfaceVariant,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Two-tab pipeline selector. The selected tab is the pipeline and only that
  /// pipeline's fields are shown below it.
  Widget _pipelineTabs() {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: const ValueKey('pipeline.tabs'),
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          _pipelineTab(VoicePipeline.integrated, t('端到端', 'End-to-end')),
          const SizedBox(width: 4),
          _pipelineTab(VoicePipeline.cascaded, t('级联', 'Cascaded')),
        ],
      ),
    );
  }

  Widget _credentialControl(
    String slot,
    String endpoint, {
    String? credentialId,
    bool optional = false,
    required ValueChanged<String> onConfigured,
  }) => FutureBuilder(
    future: endpoint.trim().isEmpty
        ? Future.value(null)
        : widget.settings.credentials.resolve(
            endpoint,
            credentialId: credentialId,
          ),
    builder: (context, snapshot) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          liveRegion: true,
          child: Row(
            children: [
              Icon(
                snapshot.hasData
                    ? Icons.check_circle_outline
                    : Icons.info_outline,
                size: 16,
                color: snapshot.hasData
                    ? Colors.green
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  snapshot.connectionState != ConnectionState.done
                      ? t('正在读取配置…', 'Checking saved credentials…')
                      : snapshot.hasError
                      ? t('配置读取失败，请重试', 'Could not read credentials')
                      : snapshot.hasData
                      ? t('密钥已配置', 'Key configured')
                      : optional
                      ? t(
                          '未配置密钥（服务允许时可不填）',
                          'No key saved (optional if supported)',
                        )
                      : t('密钥未配置', 'Key not configured'),
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: snapshot.hasData
                        ? Colors.green
                        : Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
        TextButton(
          key: ValueKey('$slot.credentials'),
          onPressed: _saving || endpoint.trim().isEmpty
              ? null
              : () async {
                  try {
                    final id = await showProviderCredentials(
                      context,
                      widget.settings.credentials,
                      modelSettings: widget.settings.modelSettings,
                      endpoint: endpoint,
                      credentialId: credentialId,
                      language: widget.language,
                      onChanged:
                          widget.settings.modelSettings.refreshApiKeyProjection,
                    );
                    if (mounted && id != null) {
                      setState(() {
                        onConfigured(id);
                        _error = null;
                      });
                    }
                  } catch (_) {
                    if (mounted) {
                      setState(
                        () => _error = t(
                          '无法读取模型服务配置，请稍后重试。',
                          'Could not read provider settings. Try again.',
                        ),
                      );
                    }
                  }
                },
          child: Text(t('配置密钥', 'Configure keys')),
        ),
      ],
    ),
  );

  Widget _fields(
    String title,
    _ServiceFields fields, {
    String? label,
    bool heading = true,
    bool endpoint = true,
    bool websocket = false,
    bool model = true,
    bool voice = false,
    bool optionalKey = false,
    bool optionalVoice = false,
    bool geminiBase = false,
    bool resourceId = false,
  }) {
    final items = <Widget>[
      if (endpoint)
        TextField(
          controller: fields.endpoint,
          enabled: !_saving,
          key: ValueKey('$title.endpoint'),
          onChanged: (_) => setState(() {}),
          autocorrect: false,
          keyboardType: TextInputType.url,
          decoration: InputDecoration(
            labelText: websocket
                ? t('WSS 服务地址', 'WSS endpoint')
                : t('HTTPS 服务地址', 'HTTPS endpoint'),
            helperText: geminiBase
                ? t(
                    'Gemini API 基础地址，例如 https://generativelanguage.googleapis.com/v1beta',
                    'Gemini API base URL, e.g. https://generativelanguage.googleapis.com/v1beta',
                  )
                : null,
          ),
        ),
      if (model)
        TextField(
          controller: fields.model,
          enabled: !_saving,
          key: ValueKey('$title.model'),
          autocorrect: false,
          decoration: InputDecoration(labelText: t('模型 ID', 'Model ID')),
        ),
      if (resourceId)
        TextField(
          controller: fields.resourceId,
          enabled: !_saving,
          key: ValueKey('$title.resourceId'),
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          enableIMEPersonalizedLearning: false,
          decoration: InputDecoration(
            labelText: 'Resource ID',
            helperText: t(
              '留空仅保留已保存的资源 ID',
              'Leave blank to keep the saved resource ID',
            ),
          ),
        ),
      if (voice)
        TextField(
          controller: fields.voice,
          enabled: !_saving,
          key: ValueKey('$title.voice'),
          autocorrect: false,
          decoration: InputDecoration(
            labelText: optionalVoice
                ? t('音色（可留空）', 'Voice (optional)')
                : t('音色', 'Voice'),
          ),
        ),
      _credentialControl(
        title,
        fields.endpoint.text,
        credentialId: fields.credentialId,
        optional: optionalKey,
        onConfigured: (id) => fields.credentialId = id,
      ),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (heading)
          Padding(
            padding: const EdgeInsets.only(top: 16, bottom: 12),
            child: Text(
              label ?? title,
              style: Theme.of(context).textTheme.titleSmall,
            ),
          ),
        for (var index = 0; index < items.length; index++) ...[
          if (index > 0) const SizedBox(height: 12),
          items[index],
        ],
      ],
    );
  }

  Widget _speechSelector({required bool asr}) {
    final selected = asr ? _draft.asrProvider : _draft.ttsProvider;
    return DropdownButtonFormField<SpeechProvider>(
      key: ValueKey(asr ? 'asr.provider' : 'tts.provider'),
      initialValue: selected,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: asr
            ? t('语音识别服务', 'Speech recognition service')
            : t('语音合成服务', 'Speech synthesis service'),
      ),
      items: [
        const DropdownMenuItem(
          value: SpeechProvider.stepfun,
          child: Text('StepFun'),
        ),
        DropdownMenuItem(
          value: SpeechProvider.together,
          child: Text(asr ? 'Together AI' : 'Together AI / Orpheus'),
        ),
        if (!asr)
          const DropdownMenuItem(
            value: SpeechProvider.togetherKokoro,
            child: Text('Together AI / Kokoro'),
          ),
        if (asr)
          const DropdownMenuItem(
            value: SpeechProvider.mistral,
            child: Text('Mistral'),
          ),
        if (asr)
          const DropdownMenuItem(
            value: SpeechProvider.groq,
            child: Text('Groq'),
          ),
        const DropdownMenuItem(
          value: SpeechProvider.openRouter,
          child: Text('OpenRouter'),
        ),
        DropdownMenuItem(
          value: SpeechProvider.zhipu,
          child: Text(asr ? 'Zhipu / GLM-ASR (≤30s)' : 'Zhipu / GLM-TTS'),
        ),
        const DropdownMenuItem(
          value: SpeechProvider.openaiCompatible,
          child: Text('OpenAI / Compatible'),
        ),
        const DropdownMenuItem(
          value: SpeechProvider.siliconFlow,
          child: Text('SiliconFlow'),
        ),
        DropdownMenuItem(value: SpeechProvider.gemini, child: Text('Gemini')),
        DropdownMenuItem(
          value: SpeechProvider.volcengine,
          child: Text(t('火山语音', 'Volcengine')),
        ),
        DropdownMenuItem(
          value: SpeechProvider.selfHosted,
          child: Text(t('自部署服务', 'Self-hosted')),
        ),
      ],
      onChanged: _saving
          ? null
          : (value) {
              if (value == null || value == selected) return;
              setState(() {
                final defaults = VoiceConfiguration.speechDefaults(
                  value,
                  asr: asr,
                );
                (asr ? _asr : _tts).replace(defaults);
                _draft = asr
                    ? _draft.copyWith(asrProvider: value)
                    : _draft.copyWith(ttsProvider: value);
              });
            },
    );
  }

  List<Widget> _asrFields() => [
    _speechSelector(asr: true),
    const SizedBox(height: 12),
    _fields(
      'ASR',
      _asr,
      heading: false,
      websocket:
          _draft.asrProvider == SpeechProvider.selfHosted ||
          _draft.asrProvider == SpeechProvider.volcengine,
      resourceId: _draft.asrProvider == SpeechProvider.volcengine,
      model:
          _draft.asrProvider != SpeechProvider.selfHosted &&
          _draft.asrProvider != SpeechProvider.volcengine,
      optionalKey: _draft.asrProvider == SpeechProvider.selfHosted,
      geminiBase: _draft.asrProvider == SpeechProvider.gemini,
    ),
  ];

  String _providerLabel(IntegratedVoiceService provider) => switch (provider) {
    IntegratedVoiceService.qwen => 'Qwen',
    IntegratedVoiceService.stepfun => 'StepFun',
    IntegratedVoiceService.openai => 'OpenAI',
    IntegratedVoiceService.gemini => 'Gemini Live',
  };

  List<String> _modelOptions() {
    final models = IntegratedVoiceCatalog.models(_draft.integratedProfile);
    final saved = _draft.integrated.model;
    return saved.isEmpty || models.contains(saved)
        ? models
        : [...models, saved];
  }

  List<String> _voiceOptions(String model) {
    final voices = IntegratedVoiceCatalog.voices(
      _draft.integratedProfile,
      model,
    );
    final saved = _draft.integrated.voice;
    return saved.isEmpty || voices.contains(saved)
        ? voices
        : [...voices, saved];
  }

  void _selectIntegratedProvider(IntegratedVoiceService? value) {
    if (value == null || value == _draft.integratedProfile) return;
    final model = IntegratedVoiceCatalog.defaultModel(value);
    setState(() {
      _draft = _draft.copyWith(
        integratedProfile: value,
        integrated: _draft.integrated.copyWith(
          endpoint: IntegratedVoiceCatalog.officialEndpoint(value),
          model: model,
          voice: IntegratedVoiceCatalog.defaultVoice(value, model),
          key: '',
        ),
      );
      _endpointRewritten = false;
    });
  }

  void _selectIntegratedModel(String? value) {
    if (value == null || value == _draft.integrated.model) return;
    setState(() {
      _draft = _draft.copyWith(
        integrated: _draft.integrated.copyWith(
          model: value,
          voice: IntegratedVoiceCatalog.defaultVoice(
            _draft.integratedProfile,
            value,
          ),
        ),
      );
    });
  }

  void _selectIntegratedVoice(String? value) {
    if (value == null || value == _draft.integrated.voice) return;
    setState(() {
      _draft = _draft.copyWith(
        integrated: _draft.integrated.copyWith(voice: value),
      );
    });
  }

  /// Provider, model, voice and key for the built-in realtime service. There is
  /// no endpoint field: the app always uses the provider's official endpoint.
  List<Widget> _integratedFields() {
    final provider = _draft.integratedProfile;
    final model = _draft.integrated.model;
    final savedVoice = _draft.integrated.voice;
    final voice = savedVoice.isEmpty
        ? IntegratedVoiceCatalog.defaultVoice(provider, model)
        : savedVoice;
    final voices = _voiceOptions(model);
    return [
      const SizedBox(height: 12),
      DropdownButtonFormField<IntegratedVoiceService>(
        key: const ValueKey('integrated.provider'),
        initialValue: provider,
        isExpanded: true,
        decoration: InputDecoration(labelText: t('实时服务', 'Realtime service')),
        items: [
          for (final value in IntegratedVoiceService.values)
            DropdownMenuItem(value: value, child: Text(_providerLabel(value))),
        ],
        onChanged: _saving ? null : _selectIntegratedProvider,
      ),
      const SizedBox(height: 12),
      // Reset the form-field state when the provider changes so the dropdown
      // displays the new provider's defaults.
      KeyedSubtree(
        key: ValueKey('integrated.model.rebuild.${provider.name}'),
        child: DropdownButtonFormField<String>(
          key: const ValueKey('integrated.model'),
          initialValue: model,
          isExpanded: true,
          decoration: InputDecoration(labelText: t('模型', 'Model')),
          items: [
            for (final value in _modelOptions())
              DropdownMenuItem(value: value, child: Text(value)),
          ],
          onChanged: _saving ? null : _selectIntegratedModel,
        ),
      ),
      const SizedBox(height: 12),
      // Reset the form-field state when the model (or provider) changes so the
      // voice dropdown displays the model's default voice.
      KeyedSubtree(
        key: ValueKey('integrated.voice.rebuild.${provider.name}.$model'),
        child: DropdownButtonFormField<String>(
          key: const ValueKey('integrated.voice'),
          initialValue: voice,
          isExpanded: true,
          decoration: InputDecoration(labelText: t('音色', 'Voice')),
          items: [
            for (final value in voices)
              DropdownMenuItem(value: value, child: Text(value)),
          ],
          onChanged: _saving ? null : _selectIntegratedVoice,
        ),
      ),
      if (_endpointRewritten) ...[
        const SizedBox(height: 12),
        Text(
          t(
            '服务地址已切换为官方地址。旧地址保存的密钥不会沿用，请到「配置密钥」配置该服务。',
            'The service address was switched to the official endpoint. Keys saved for the old address are not reused; configure credentials in Model provider.',
          ),
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
      const SizedBox(height: 12),
      _credentialControl(
        'integrated',
        _draft.integrated.endpoint,
        credentialId: _draft.integrated.credentialId,
        onConfigured: (id) => _draft = _draft.copyWith(
          integrated: _draft.integrated.copyWith(credentialId: id),
        ),
      ),
    ];
  }

  List<Widget> _forebrainFields() => [
    Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 12),
      child: Text(
        t('前脑', 'Forebrain'),
        style: Theme.of(context).textTheme.titleSmall,
      ),
    ),
    DropdownButtonFormField<String>(
      key: const ValueKey('fastLlm.provider'),
      initialValue: _forebrainPreset?.id ?? 'custom',
      isExpanded: true,
      decoration: InputDecoration(labelText: t('模型厂商', 'Provider')),
      items: [
        // 127.0.0.1 is this phone, so a self-hosted service cannot be the
        // forebrain; keep it only when it is already the saved choice.
        for (final preset in modelPresets)
          if (!preset.selfHosted || preset.id == _forebrainPreset?.id)
            DropdownMenuItem(
              value: preset.id,
              child: Text(
                preset.label(widget.language),
                overflow: TextOverflow.ellipsis,
              ),
            ),
        DropdownMenuItem(
          value: 'custom',
          child: Text(t('自定义（OpenAI 兼容）', 'Custom (OpenAI-compatible)')),
        ),
      ],
      onChanged: _saving
          ? null
          : (id) {
              if (id == null) return;
              setState(() {
                _forebrainPreset = ModelPreset.byId(id);
                _llm.credentialId = null;
                final preset = _forebrainPreset;
                if (preset == null) return;
                _llm.replace(
                  VoiceServiceConfiguration(
                    endpoint: preset.endpoint,
                    model: preset.recommendedModels.firstOrNull ?? '',
                  ),
                );
                _draft = _draft.copyWith(
                  fastLlmProtocol: preset.protocol == ModelProtocol.responses
                      ? FastLlmProtocol.responses
                      : FastLlmProtocol.chatCompletions,
                );
              });
            },
    ),
    const SizedBox(height: 12),
    if (_forebrainPreset == null)
      DropdownButtonFormField<FastLlmProtocol>(
        key: const ValueKey('fastLlm.protocol'),
        initialValue: _draft.fastLlmProtocol,
        isExpanded: true,
        decoration: InputDecoration(labelText: t('API 协议', 'API protocol')),
        items: const [
          DropdownMenuItem(
            value: FastLlmProtocol.responses,
            child: Text('Responses'),
          ),
          DropdownMenuItem(
            value: FastLlmProtocol.chatCompletions,
            child: Text('Chat Completions'),
          ),
          DropdownMenuItem(
            value: FastLlmProtocol.arkResponses,
            child: Text('Ark Responses'),
          ),
        ],
        onChanged: _saving
            ? null
            : (value) {
                if (value != null && value != _draft.fastLlmProtocol) {
                  setState(() {
                    _draft = _draft.copyWith(fastLlmProtocol: value);
                    _llm.replace(const VoiceServiceConfiguration());
                  });
                }
              },
      ),
    _fields(
      'fastLlm',
      _llm,
      heading: false,
      endpoint: _forebrainPreset == null,
    ),
    Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(
        _forebrainPreset != null
            ? t(
                '前脑负责语音对话，长任务仍交给手机后脑。',
                'The forebrain handles voice chat; longer tasks stay with the phone brain.',
              )
            : _draft.fastLlmProtocol == FastLlmProtocol.arkResponses
            ? t(
                '填写完整的 Ark /responses 地址。此模型负责语音对话，长任务仍交给手机后脑。',
                'Use the full Ark /responses URL. This model handles voice chat; longer tasks stay with the phone brain.',
              )
            : t(
                '填写 Base URL 或完整接口地址，协议由上方选项决定。此模型负责语音对话，长任务仍交给手机后脑。',
                'Use a base URL or full endpoint; the protocol is set above. This model handles voice chat; longer tasks stay with the phone brain.',
              ),
      ),
    ),
  ];

  List<Widget> _cascadedFields() => [
    const SizedBox(height: 12),
    ..._asrFields(),
    ..._forebrainFields(),
    const SizedBox(height: 12),
    _speechSelector(asr: false),
    _fields(
      'TTS',
      _tts,
      websocket: _draft.ttsProvider == SpeechProvider.volcengine,
      resourceId: _draft.ttsProvider == SpeechProvider.volcengine,
      model:
          _draft.ttsProvider != SpeechProvider.selfHosted &&
          _draft.ttsProvider != SpeechProvider.volcengine,
      voice: _draft.ttsProvider != SpeechProvider.selfHosted,
      optionalKey: _draft.ttsProvider == SpeechProvider.selfHosted,
      geminiBase: _draft.ttsProvider == SpeechProvider.gemini,
    ),
    if (_draft.asrProvider == SpeechProvider.selfHosted ||
        _draft.ttsProvider == SpeechProvider.selfHosted)
      Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Text(
          t(
            '自部署服务必须兼容 Nova 的 ASR WebSocket / TTS HTTP PCM 协议，并可由手机直接访问。',
            'Self-hosted services must speak Nova’s ASR WebSocket / TTS HTTP PCM protocols and be reachable from this phone.',
          ),
        ),
      ),
  ];

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(
      widget.dictationOnly
          ? t('语音输入设置', 'Voice input settings')
          : t('手机独立语音', 'Standalone voice'),
    ),
    content: SizedBox(
      width: 480,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.dictationOnly) ...[
              Text(
                t(
                  '录音会发送给你选择的语音识别服务。转写结果仅填入输入框，你可以修改后再发送。密钥保存在本机安全存储中。',
                  'Audio is sent to your selected speech recognition service. The transcript only fills the message draft; you can edit it before sending. Credentials stay in this device’s secure storage.',
                ),
              ),
              const SizedBox(height: 12),
              ..._asrFields(),
              if (_draft.asrProvider == SpeechProvider.selfHosted)
                Text(
                  t(
                    '自部署的识别服务需兼容 Nova，并能被手机直接访问。',
                    'Your self-hosted recognition service must be compatible with Nova and reachable from this phone.',
                  ),
                ),
            ] else ...[
              Text(
                t(
                  '手机直连所选服务，密钥统一在「配置密钥」中管理。',
                  'Connects directly to the selected service. Manage credentials in Model provider.',
                ),
              ),
              const SizedBox(height: 16),
              if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android)
                SwitchListTile.adaptive(
                  key: const ValueKey('voice.recordingCompatible'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(t('兼容系统录屏', 'Screen recording compatibility')),
                  subtitle: Text(
                    t(
                      '下次通话使用外放。请在系统录屏中选择设备声音和麦克风；部分手机仍无法同时录入。',
                      'Uses speakerphone on your next call. Select device audio and microphone in the system recorder; some phones cannot capture both.',
                    ),
                  ),
                  value: _draft.recordingCompatible,
                  onChanged: _saving
                      ? null
                      : (value) => setState(
                          () => _draft = _draft.copyWith(
                            recordingCompatible: value,
                          ),
                        ),
                ),
              _pipelineTabs(),
              if (_draft.pipeline == VoicePipeline.integrated)
                ..._integratedFields()
              else
                ..._cascadedFields(),
            ],
            const SizedBox(height: 16),
            Text(
              t(
                '请使用你有权访问的服务、模型和凭据。服务可用性与费用以供应商账户为准。',
                'Use services, models and credentials you are authorized to access. Availability and charges depend on your provider account.',
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: _saving ? null : () => Navigator.of(context).pop(false),
        child: Text(t('取消', 'Cancel')),
      ),
      FilledButton(
        onPressed: _saving ? null : _save,
        child: Text(_saving ? t('保存中…', 'Saving…') : t('保存', 'Save')),
      ),
    ],
  );
}
