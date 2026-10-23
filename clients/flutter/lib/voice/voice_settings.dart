import '../space/space_storage.dart';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../agent_core/model_client.dart';

enum VoicePipeline { integrated, cascaded }

enum IntegratedVoiceService { qwen, stepfun, openai, gemini }

enum SpeechProvider {
  gemini,
  selfHosted,
  volcengine,
  openaiCompatible,
  siliconFlow,
  groq,
  openRouter,
  zhipu,
  stepfun,
  together,
  togetherKokoro,
  mistral,
}

enum FastLlmProtocol { chatCompletions, arkResponses, responses }

/// Drafts may have empty credentials. Validate the selected pipeline before use.
class VoiceServiceConfiguration {
  const VoiceServiceConfiguration({
    this.endpoint = '',
    this.model = '',
    this.key = '',
    this.voice = '',
    this.resourceId = '',
  });
  final String endpoint, model, key, voice, resourceId;

  VoiceServiceConfiguration copyWith({
    String? endpoint,
    String? model,
    String? key,
    String? voice,
    String? resourceId,
  }) => VoiceServiceConfiguration(
    endpoint: endpoint ?? this.endpoint,
    model: model ?? this.model,
    key: key ?? this.key,
    voice: voice ?? this.voice,
    resourceId: resourceId ?? this.resourceId,
  );

  Map<String, dynamic> toJson() => {
    'endpoint': endpoint,
    'model': model,
    'key': key,
    'voice': voice,
    'resourceId': resourceId,
  };
  factory VoiceServiceConfiguration.fromJson(Map<String, dynamic> value) =>
      VoiceServiceConfiguration(
        endpoint: value['endpoint'] as String,
        model: value['model'] as String,
        key: value['key'] as String,
        voice: value['voice'] as String,
        resourceId: value['resourceId'] as String? ?? '',
      );

  void validate({
    required bool websocket,
    bool requireKey = true,
    bool requireModel = true,
    bool requireVoice = false,
    bool requireResourceId = false,
  }) {
    final uri = Uri.tryParse(endpoint);
    final host = uri?.host.replaceAll('[', '').replaceAll(']', '');
    final loopback =
        host == 'localhost' ||
        (host != null && InternetAddress.tryParse(host)?.isLoopback == true);
    if (uri == null ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        endpoint.length > 4096 ||
        RegExp(r'\s').hasMatch(endpoint) ||
        !(uri.scheme == (websocket ? 'wss' : 'https') ||
            (loopback && uri.scheme == (websocket ? 'ws' : 'http'))) ||
        (requireModel && model.trim().isEmpty) ||
        model.length > 200 ||
        (requireKey && key.trim().isEmpty) ||
        key.length > 8192 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch('$model$key$voice$resourceId') ||
        (requireVoice && voice.trim().isEmpty) ||
        voice.length > 200 ||
        resourceId.length > 256 ||
        (requireResourceId && resourceId.trim().isEmpty)) {
      throw const AgentFailure('invalid_voice_settings');
    }
  }
}

class VoiceConfiguration {
  const VoiceConfiguration({
    this.pipeline = VoicePipeline.integrated,
    this.integratedProfile = IntegratedVoiceService.qwen,
    this.integrated = const VoiceServiceConfiguration(
      endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
      model: 'qwen-audio-3.0-realtime-plus',
      voice: 'longanqian',
    ),
    this.asrProvider = SpeechProvider.gemini,
    this.asr = const VoiceServiceConfiguration(
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.5-flash',
    ),
    this.ttsProvider = SpeechProvider.gemini,
    this.tts = const VoiceServiceConfiguration(
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.8-flash-tts',
      voice: 'Kore',
    ),
    this.fastLlm = const VoiceServiceConfiguration(),
    this.fastLlmProtocol = FastLlmProtocol.chatCompletions,
  });
  final VoicePipeline pipeline;
  final FastLlmProtocol fastLlmProtocol;
  final IntegratedVoiceService integratedProfile;
  final SpeechProvider asrProvider, ttsProvider;
  final VoiceServiceConfiguration integrated, asr, tts, fastLlm;

  // Public service defaults mirror runtime/src/config/config.ts. No private
  // service, preset or credential is bundled with the phone application.
  static VoiceServiceConfiguration integratedDefaults(
    IntegratedVoiceService p,
  ) => switch (p) {
    IntegratedVoiceService.qwen => const VoiceConfiguration().integrated,
    IntegratedVoiceService.stepfun => const VoiceServiceConfiguration(
      endpoint: 'wss://api.stepfun.com/v1/realtime',
      model: 'stepaudio-3-realtime-preview',
    ),
    IntegratedVoiceService.openai => const VoiceServiceConfiguration(
      endpoint: 'wss://api.openai.com/v1/realtime',
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
    ),
    IntegratedVoiceService.gemini => const VoiceServiceConfiguration(
      endpoint:
          'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
      model: 'gemini-3.8-live',
      voice: 'Kore',
    ),
  };

  static VoiceServiceConfiguration speechDefaults(
    SpeechProvider provider, {
    required bool asr,
  }) => switch (provider) {
    SpeechProvider.groq => const VoiceServiceConfiguration(
      endpoint: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
    ),
    SpeechProvider.openRouter => VoiceServiceConfiguration(
      endpoint: 'https://openrouter.ai/api/v1',
      model: asr
          ? 'openai/whisper-large-v3'
          : 'openai/gpt-4o-mini-tts-2025-12-15',
      voice: asr ? '' : 'alloy',
    ),
    SpeechProvider.stepfun => VoiceServiceConfiguration(
      endpoint: 'https://api.stepfun.com/v1',
      model: asr ? 'stepaudio-2.5-asr' : 'stepaudio-3-tts',
      voice: asr ? '' : 'cixingnansheng',
    ),
    SpeechProvider.together ||
    SpeechProvider.togetherKokoro => VoiceServiceConfiguration(
      endpoint: 'https://api.together.ai/v1',
      model: asr
          ? 'openai/whisper-large-v3'
          : provider == SpeechProvider.togetherKokoro
          ? 'hexgrad/Kokoro-82M'
          : 'canopylabs/orpheus-3b-0.1-ft',
      voice: asr
          ? ''
          : provider == SpeechProvider.togetherKokoro
          ? 'af_alloy'
          : 'tara',
    ),
    SpeechProvider.mistral => const VoiceServiceConfiguration(
      endpoint: 'https://api.mistral.ai/v1',
      model: 'voxtral-mini-latest',
    ),
    SpeechProvider.zhipu => VoiceServiceConfiguration(
      endpoint: 'https://open.bigmodel.cn/api/paas/v4',
      model: asr ? 'glm-asr-2512' : 'glm-tts',
      voice: asr ? '' : 'tongtong',
    ),
    SpeechProvider.openaiCompatible => VoiceServiceConfiguration(
      endpoint: 'https://api.openai.com/v1',
      model: asr ? 'whisper-1' : 'tts-1',
      voice: asr ? '' : 'alloy',
    ),
    SpeechProvider.siliconFlow => VoiceServiceConfiguration(
      endpoint: 'https://api.siliconflow.cn/v1',
      model: asr
          ? 'FunAudioLLM/SenseVoiceSmall'
          : 'FunAudioLLM/CosyVoice2-0.5B',
      voice: asr ? '' : 'FunAudioLLM/CosyVoice2-0.5B:alex',
    ),
    SpeechProvider.gemini =>
      asr ? const VoiceConfiguration().asr : const VoiceConfiguration().tts,
    _ => const VoiceServiceConfiguration(),
  };

  ModelConfiguration get fastLlmConfiguration => ModelConfiguration(
    endpoint: fastLlm.endpoint,
    model: fastLlm.model,
    key: fastLlm.key,
    protocol: fastLlmProtocol == FastLlmProtocol.responses
        ? ModelProtocol.responses
        : ModelProtocol.chatCompletions,
  );

  void validateAsr() => asr.validate(
    websocket:
        asrProvider == SpeechProvider.selfHosted ||
        asrProvider == SpeechProvider.volcengine,
    requireKey: asrProvider != SpeechProvider.selfHosted,
    requireResourceId: asrProvider == SpeechProvider.volcengine,
    requireModel:
        asrProvider != SpeechProvider.selfHosted &&
        asrProvider != SpeechProvider.volcengine,
  );

  void validate() {
    if (pipeline == VoicePipeline.integrated) {
      integrated.validate(
        websocket: true,
        requireVoice: integratedProfile != IntegratedVoiceService.stepfun,
      );
    } else {
      validateAsr();
      tts.validate(
        websocket: ttsProvider == SpeechProvider.volcengine,
        requireKey: ttsProvider != SpeechProvider.selfHosted,
        requireResourceId: ttsProvider == SpeechProvider.volcengine,
        requireModel:
            ttsProvider != SpeechProvider.selfHosted &&
            ttsProvider != SpeechProvider.volcengine,
        requireVoice: ttsProvider != SpeechProvider.selfHosted,
      );
      fastLlm.validate(websocket: false);
      fastLlmConfiguration;
    }
  }

  VoiceConfiguration copyWith({
    VoicePipeline? pipeline,
    FastLlmProtocol? fastLlmProtocol,
    IntegratedVoiceService? integratedProfile,
    VoiceServiceConfiguration? integrated,
    SpeechProvider? asrProvider,
    VoiceServiceConfiguration? asr,
    SpeechProvider? ttsProvider,
    VoiceServiceConfiguration? tts,
    VoiceServiceConfiguration? fastLlm,
  }) => VoiceConfiguration(
    pipeline: pipeline ?? this.pipeline,
    fastLlmProtocol: fastLlmProtocol ?? this.fastLlmProtocol,
    integratedProfile: integratedProfile ?? this.integratedProfile,
    integrated: integrated ?? this.integrated,
    asrProvider: asrProvider ?? this.asrProvider,
    asr: asr ?? this.asr,
    ttsProvider: ttsProvider ?? this.ttsProvider,
    tts: tts ?? this.tts,
    fastLlm: fastLlm ?? this.fastLlm,
  );

  Map<String, dynamic> toJson() => {
    'version': 1,
    'pipeline': pipeline.name,
    'fastLlmProtocol': fastLlmProtocol.name,
    'integratedProfile': integratedProfile.name,
    'integrated': integrated.toJson(),
    'asrProvider': asrProvider.name,
    'asr': asr.toJson(),
    'ttsProvider': ttsProvider.name,
    'tts': tts.toJson(),
    'fastLlm': fastLlm.toJson(),
  };
  factory VoiceConfiguration.fromJson(Map<String, dynamic> value) {
    if (value['version'] != 1) {
      throw const AgentFailure('invalid_voice_settings');
    }
    return VoiceConfiguration(
      pipeline: VoicePipeline.values.byName(value['pipeline'] as String),
      fastLlmProtocol: FastLlmProtocol.values.byName(
        value['fastLlmProtocol'] as String? ?? 'chatCompletions',
      ),
      integratedProfile: IntegratedVoiceService.values.byName(
        value['integratedProfile'] as String,
      ),
      integrated: VoiceServiceConfiguration.fromJson(
        value['integrated'] as Map<String, dynamic>,
      ),
      asrProvider: SpeechProvider.values.byName(value['asrProvider'] as String),
      asr: VoiceServiceConfiguration.fromJson(
        value['asr'] as Map<String, dynamic>,
      ),
      ttsProvider: SpeechProvider.values.byName(value['ttsProvider'] as String),
      tts: VoiceServiceConfiguration.fromJson(
        value['tts'] as Map<String, dynamic>,
      ),
      fastLlm: VoiceServiceConfiguration.fromJson(
        value['fastLlm'] as Map<String, dynamic>,
      ),
    );
  }
}

/// Independent of text settings and never projected to a other Spaces.
class VoiceSettings {
  VoiceSettings({this.storage = const FlutterSecureStorage()});
  final FlutterSecureStorage storage;
  final String _scopedKey = SpaceStorage.secureKey(storageKey);
  static const storageKey = 'nova.voice.v1';

  Future<VoiceConfiguration?> read() async {
    final config = await readDraft();
    try {
      config?.validate();
      return config;
    } catch (_) {
      throw const AgentFailure('voice_settings_unavailable');
    }
  }

  /// Dictation needs only ASR, independent of conversation/LLM/TTS settings.
  Future<VoiceConfiguration?> readForDictation() async {
    final config = await readDraft();
    try {
      config?.validateAsr();
      return config;
    } catch (_) {
      throw const AgentFailure('dictation_settings_required');
    }
  }

  Future<VoiceConfiguration?> readDraft() async {
    try {
      final raw = await storage.read(key: _scopedKey);
      if (raw == null) return null;
      final config = VoiceConfiguration.fromJson(
        jsonDecode(raw) as Map<String, dynamic>,
      );
      return config;
    } catch (_) {
      throw const AgentFailure('voice_settings_unavailable');
    }
  }

  Future<VoiceConfiguration> save(VoiceConfiguration draft) async {
    final old = await readDraft();
    final value = _mergeDraft(draft, old);
    value.validate();
    return _write(value);
  }

  Future<VoiceConfiguration> saveAsr({
    required SpeechProvider provider,
    required VoiceServiceConfiguration asr,
  }) async {
    final old = await readDraft();
    final draft = (old ?? const VoiceConfiguration()).copyWith(
      asrProvider: provider,
      asr: asr,
    );
    final value = _mergeDraft(draft, old);
    value.validateAsr();
    return _write(value);
  }

  VoiceConfiguration _mergeDraft(
    VoiceConfiguration draft,
    VoiceConfiguration? old,
  ) {
    VoiceServiceConfiguration merge(
      VoiceServiceConfiguration next,
      VoiceServiceConfiguration? previous,
      bool sameProvider,
    ) {
      final trimmed = next.copyWith(
        endpoint: next.endpoint.trim(),
        model: next.model.trim(),
        voice: next.voice.trim(),
        resourceId: next.resourceId.trim(),
      );
      return trimmed.copyWith(
        resourceId:
            trimmed.resourceId.isEmpty &&
                sameProvider &&
                trimmed.endpoint == previous?.endpoint
            ? previous!.resourceId
            : trimmed.resourceId,
        key:
            trimmed.key.isEmpty &&
                sameProvider &&
                trimmed.endpoint == previous?.endpoint
            ? previous!.key
            : trimmed.key,
      );
    }

    final value = draft.copyWith(
      integrated: merge(
        draft.integrated,
        old?.integrated,
        draft.integratedProfile == old?.integratedProfile,
      ),
      asr: merge(draft.asr, old?.asr, draft.asrProvider == old?.asrProvider),
      tts: merge(draft.tts, old?.tts, draft.ttsProvider == old?.ttsProvider),
      fastLlm: merge(
        draft.fastLlm,
        old?.fastLlm,
        draft.fastLlmProtocol == old?.fastLlmProtocol,
      ),
    );
    return value;
  }

  Future<VoiceConfiguration> _write(VoiceConfiguration value) async {
    try {
      await storage.write(key: _scopedKey, value: jsonEncode(value.toJson()));
    } catch (_) {
      throw const AgentFailure('voice_settings_save_failed');
    }
    return value;
  }
}
