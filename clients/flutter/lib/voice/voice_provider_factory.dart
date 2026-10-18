import 'voice_provider.dart';
import 'voice_settings.dart';
import 'providers/qwen_realtime_voice_provider.dart';
import 'providers/gemini_live_voice_provider.dart';
import 'cascaded/cascaded_voice_provider.dart';
import 'cascaded/speech_adapters.dart';
import 'cascaded/model_llm.dart';
import 'cascaded/volc_speech.dart';
import 'cascaded/ark_llm.dart';

VoiceProvider createVoiceProvider(VoiceConfiguration config) {
  config.validate();
  if (config.pipeline == VoicePipeline.integrated) {
    final c = config.integrated;
    if (config.integratedProfile == IntegratedVoiceService.gemini) {
      return GeminiLiveVoiceProvider(
        endpoint: c.endpoint,
        model: c.model,
        apiKey: c.key,
        voice: c.voice,
      );
    }
    return QwenRealtimeVoiceProvider(
      endpoint: c.endpoint,
      model: c.model,
      apiKey: c.key,
      voice: c.voice,
      profile: switch (config.integratedProfile) {
        IntegratedVoiceService.qwen => IntegratedVoiceProfile.qwen,
        IntegratedVoiceService.stepfun => IntegratedVoiceProfile.stepfun,
        IntegratedVoiceService.openai => IntegratedVoiceProfile.openai,
        IntegratedVoiceService.gemini => throw StateError('unreachable'),
      },
    );
  }
  final t = config.tts;
  return CascadedVoiceProvider(
    asr: createVoiceAsr(config),
    llm: switch (config.fastLlmProtocol) {
      FastLlmProtocol.chatCompletions || FastLlmProtocol.responses =>
        ChatCompletionsCascadeLlm(configuration: config.fastLlmConfiguration),
      FastLlmProtocol.arkResponses => ArkResponsesCascadeLlm(
        configuration: config.fastLlmConfiguration,
      ),
    },
    tts: switch (config.ttsProvider) {
      SpeechProvider.groq || SpeechProvider.mistral =>
        throw const FormatException('Selected preset supports ASR only'),
      SpeechProvider.stepfun ||
      SpeechProvider.together ||
      SpeechProvider.togetherKokoro ||
      SpeechProvider.openRouter ||
      SpeechProvider.zhipu ||
      SpeechProvider.openaiCompatible ||
      SpeechProvider.siliconFlow => OpenAiCompatibleTts(
        endpoint: t.endpoint,
        model: t.model,
        apiKey: t.key,
        voice: t.voice,
        requestSampleRate: config.ttsProvider == SpeechProvider.siliconFlow,
      ),
      SpeechProvider.gemini => GeminiBatchTts(
        endpoint: t.endpoint,
        model: t.model,
        apiKey: t.key,
        voice: t.voice,
      ),
      SpeechProvider.selfHosted => SelfHostedPcmTts(
        endpoint: t.endpoint,
        apiKey: t.key,
        instruction: t.voice,
      ),
      SpeechProvider.volcengine => VolcTts(
        endpoint: t.endpoint,
        apiKey: t.key,
        resourceId: t.resourceId,
        voice: t.voice,
      ),
    },
  );
}

CascadeAsr createVoiceAsr(VoiceConfiguration config) {
  config.validateAsr();
  final a = config.asr;
  return switch (config.asrProvider) {
    SpeechProvider.zhipu ||
    SpeechProvider.stepfun ||
    SpeechProvider.together ||
    SpeechProvider.togetherKokoro ||
    SpeechProvider.mistral ||
    SpeechProvider.groq ||
    SpeechProvider.openRouter ||
    SpeechProvider.openaiCompatible ||
    SpeechProvider.siliconFlow => OpenAiCompatibleAsr(
      endpoint: a.endpoint,
      model: a.model,
      apiKey: a.key,
      sendResponseFormat:
          config.asrProvider != SpeechProvider.mistral &&
          config.asrProvider != SpeechProvider.zhipu,
    ),
    SpeechProvider.gemini => GeminiBatchAsr(
      endpoint: a.endpoint,
      model: a.model,
      apiKey: a.key,
    ),
    SpeechProvider.selfHosted => SelfHostedWsAsr(
      endpoint: a.endpoint,
      apiKey: a.key,
    ),
    SpeechProvider.volcengine => VolcAsr(
      endpoint: a.endpoint,
      apiKey: a.key,
      resourceId: a.resourceId,
    ),
  };
}
