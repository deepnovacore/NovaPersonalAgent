import 'package:flutter/material.dart';

import '../agent_core/model_client.dart';
import '../ui/local_dialog.dart';
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
      voice = TextEditingController(text: config.voice) {
    endpoint.addListener(_endpointChanged);
  }
  final TextEditingController endpoint, model, voice;
  // Never populate form controllers with a stored secret.
  final key = TextEditingController();
  final resourceId = TextEditingController();
  void _endpointChanged() {
    key.clear();
    resourceId.clear();
  }

  VoiceServiceConfiguration get value => VoiceServiceConfiguration(
    endpoint: endpoint.text,
    model: model.text,
    key: key.text,
    voice: voice.text,
    resourceId: resourceId.text,
  );
  void replace(VoiceServiceConfiguration config) {
    endpoint.text = config.endpoint;
    model.text = config.model;
    voice.text = config.voice;
    key.clear();
    resourceId.clear();
  }

  void dispose() {
    endpoint.removeListener(_endpointChanged);
    endpoint.dispose();
    model.dispose();
    voice.dispose();
    key.dispose();
    resourceId.dispose();
  }
}

class _VoiceSettingsSheetState extends State<VoiceSettingsSheet> {
  late VoiceConfiguration _draft;
  late final _ServiceFields _integrated, _asr, _tts, _llm;
  bool _saving = false;
  String? _error;
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;

  @override
  void initState() {
    super.initState();
    _draft = widget.initial ?? const VoiceConfiguration();
    _integrated = _ServiceFields(_draft.integrated);
    _asr = _ServiceFields(_draft.asr);
    _tts = _ServiceFields(_draft.tts);
    _llm = _ServiceFields(_draft.fastLlm);
  }

  @override
  void dispose() {
    for (final fields in [_integrated, _asr, _tts, _llm]) {
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
            integrated: _integrated.value,
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
                '请检查服务地址、模型和凭据。地址须使用 HTTPS/WSS（本机开发地址除外），不能含查询参数、账号或片段。',
                'Check the service address, model and credentials. Use HTTPS/WSS (except local development), without query parameters, account information or fragments.',
              )
            : t(
                '无法安全保存语音设置，请稍后重试。',
                'Could not securely save voice settings. Please try again.',
              );
      });
    }
  }

  Widget _fields(
    String title,
    _ServiceFields fields, {
    bool websocket = false,
    bool model = true,
    bool voice = false,
    bool optionalKey = false,
    bool optionalVoice = false,
    bool geminiBase = false,
    bool resourceId = false,
  }) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Text(title, style: Theme.of(context).textTheme.titleSmall),
      ),
      TextField(
        controller: fields.endpoint,
        enabled: !_saving,
        key: ValueKey('$title.endpoint'),
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
              '留空仅保留同一供应商、同一地址已保存的资源 ID',
              'Leave blank to keep the saved resource ID only for the same provider and endpoint',
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
      TextField(
        controller: fields.key,
        enabled: !_saving,
        key: ValueKey('$title.key'),
        obscureText: true,
        autocorrect: false,
        enableSuggestions: false,
        enableIMEPersonalizedLearning: false,
        decoration: InputDecoration(
          labelText: optionalKey
              ? t('API 密钥（服务允许时可不填）', 'API key (optional if supported)')
              : t('API 密钥', 'API key'),
          helperText: t(
            '留空仅保留同一供应商、同一地址已保存的密钥',
            'Leave blank to keep the saved key only for the same provider and endpoint',
          ),
        ),
      ),
    ],
  );

  Widget _speechSelector({required bool asr}) {
    final selected = asr ? _draft.asrProvider : _draft.ttsProvider;
    return DropdownButtonFormField<SpeechProvider>(
      key: ValueKey(asr ? 'asr.provider' : 'tts.provider'),
      initialValue: selected,
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
    _fields(
      'ASR',
      _asr,
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
                    '自部署识别服务需兼容 Nova ASR 协议，并可由手机直接访问。',
                    'Your self-hosted recognition service must support the Nova ASR protocol and be reachable from this phone.',
                  ),
                ),
            ] else ...[
              const Text('手机直接连接所选服务，无需连接电脑或 Hub。语音设置与文字模型独立，密钥仅保存在本机安全存储中。'),
              const SizedBox(height: 12),
              DropdownButtonFormField<VoicePipeline>(
                key: const ValueKey('voice.pipeline'),
                initialValue: _draft.pipeline,
                decoration: const InputDecoration(labelText: '语音管线'),
                items: const [
                  DropdownMenuItem(
                    value: VoicePipeline.integrated,
                    child: Text('集成实时'),
                  ),
                  DropdownMenuItem(
                    value: VoicePipeline.cascaded,
                    child: Text('级联 ASR → 快速模型 → TTS'),
                  ),
                ],
                onChanged: _saving
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(
                            () => _draft = _draft.copyWith(pipeline: value),
                          );
                        }
                      },
              ),
              if (_draft.pipeline == VoicePipeline.integrated) ...[
                DropdownButtonFormField<IntegratedVoiceService>(
                  key: const ValueKey('integrated.provider'),
                  initialValue: _draft.integratedProfile,
                  decoration: const InputDecoration(labelText: '实时服务'),
                  items: const [
                    DropdownMenuItem(
                      value: IntegratedVoiceService.qwen,
                      child: Text('Qwen'),
                    ),
                    DropdownMenuItem(
                      value: IntegratedVoiceService.stepfun,
                      child: Text('StepFun'),
                    ),
                    DropdownMenuItem(
                      value: IntegratedVoiceService.openai,
                      child: Text('OpenAI'),
                    ),
                    DropdownMenuItem(
                      value: IntegratedVoiceService.gemini,
                      child: Text('Gemini Live'),
                    ),
                  ],
                  onChanged: _saving
                      ? null
                      : (value) {
                          if (value == null ||
                              value == _draft.integratedProfile) {
                            return;
                          }
                          setState(() {
                            _draft = _draft.copyWith(integratedProfile: value);
                            _integrated.replace(
                              VoiceConfiguration.integratedDefaults(value),
                            );
                          });
                        },
                ),
                _fields(
                  '实时模型',
                  _integrated,
                  websocket: true,
                  voice: true,
                  optionalVoice:
                      _draft.integratedProfile ==
                      IntegratedVoiceService.stepfun,
                ),
              ] else ...[
                ..._asrFields(),
                DropdownButtonFormField<FastLlmProtocol>(
                  key: const ValueKey('fastLlm.protocol'),
                  initialValue: _draft.fastLlmProtocol,
                  decoration: const InputDecoration(labelText: '快速模型协议'),
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
                          if (value != null &&
                              value != _draft.fastLlmProtocol) {
                            setState(() {
                              _draft = _draft.copyWith(fastLlmProtocol: value);
                              _llm.replace(const VoiceServiceConfiguration());
                            });
                          }
                        },
                ),
                _fields('快速前脑模型', _llm),
                Text(
                  _draft.fastLlmProtocol == FastLlmProtocol.arkResponses
                      ? '填写完整的 Ark /responses 地址。此模型负责语音对话，长任务仍交给手机后脑。'
                      : '填写 Base URL 或完整接口地址，协议由上方选项决定。此模型负责语音对话，长任务仍交给手机后脑。',
                ),
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
                  const Text(
                    '自部署服务必须兼容 Nova 的 ASR WebSocket / TTS HTTP PCM 协议，并可由手机直接访问。',
                  ),
              ],
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
