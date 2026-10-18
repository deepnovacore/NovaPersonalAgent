import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_settings.dart';
import 'package:nova_mobile/voice/voice_provider_factory.dart';
import 'package:nova_mobile/voice/cascaded/speech_adapters.dart';
import 'package:nova_mobile/voice/cascaded/cascaded_voice_provider.dart';

void main() {
  test('compatible speech presets persist and route to existing adapters', () {
    for (final asr in [
      SpeechProvider.groq,
      SpeechProvider.openRouter,
      SpeechProvider.zhipu,
      SpeechProvider.stepfun,
      SpeechProvider.together,
      SpeechProvider.mistral,
    ]) {
      for (final tts in [
        SpeechProvider.openRouter,
        SpeechProvider.zhipu,
        SpeechProvider.stepfun,
        SpeechProvider.together,
        SpeechProvider.togetherKokoro,
      ]) {
        final config = VoiceConfiguration(
          pipeline: VoicePipeline.cascaded,
          asrProvider: asr,
          asr: VoiceConfiguration.speechDefaults(
            asr,
            asr: true,
          ).copyWith(key: 'asr-only'),
          ttsProvider: tts,
          tts: VoiceConfiguration.speechDefaults(
            tts,
            asr: false,
          ).copyWith(key: 'tts-only'),
          fastLlm: const VoiceServiceConfiguration(
            endpoint: 'https://example.com/v1',
            model: 'model',
            key: 'llm-only',
          ),
        );
        final restored = VoiceConfiguration.fromJson(config.toJson());
        expect(restored.asrProvider, asr);
        expect(restored.ttsProvider, tts);
        expect(createVoiceAsr(restored), isA<OpenAiCompatibleAsr>());
        expect(
          (createVoiceAsr(restored) as OpenAiCompatibleAsr).sendResponseFormat,
          asr != SpeechProvider.mistral && asr != SpeechProvider.zhipu,
        );
        expect(createVoiceProvider(restored), isA<CascadedVoiceProvider>());
        expect(restored.asr.key, 'asr-only');
        expect(restored.tts.key, 'tts-only');
      }
    }
    expect(
      VoiceConfiguration.speechDefaults(
        SpeechProvider.zhipu,
        asr: false,
      ).endpoint,
      'https://open.bigmodel.cn/api/paas/v4',
    );
    expect(
      VoiceConfiguration.speechDefaults(SpeechProvider.groq, asr: true).model,
      'whisper-large-v3-turbo',
    );
  });
}
