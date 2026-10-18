import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_provider_factory.dart';
import 'package:nova_mobile/voice/voice_settings.dart';
import 'package:nova_mobile/voice/cascaded/cascaded_voice_provider.dart';
import 'package:nova_mobile/voice/cascaded/volc_speech.dart';
import 'package:nova_mobile/voice/cascaded/ark_llm.dart';
import 'package:nova_mobile/voice/cascaded/speech_adapters.dart';
import 'package:nova_mobile/voice/cascaded/model_llm.dart';
import 'package:nova_mobile/voice/providers/gemini_live_voice_provider.dart';
import 'package:nova_mobile/voice/providers/qwen_realtime_voice_provider.dart';

void main() {
  test(
    'every configured integrated profile reaches its actual provider family',
    () async {
      for (final profile in IntegratedVoiceService.values) {
        final config = VoiceConfiguration(
          integratedProfile: profile,
          integrated: VoiceConfiguration.integratedDefaults(
            profile,
          ).copyWith(key: 'fixture-key'),
        );
        final provider = createVoiceProvider(config);
        if (profile == IntegratedVoiceService.gemini) {
          expect(provider, isA<GeminiLiveVoiceProvider>());
          expect(provider.capabilities.voiceTools, false);
        } else {
          expect(provider, isA<QwenRealtimeVoiceProvider>());
        }
        await provider.close();
      }
    },
  );
  test(
    'Volc binary and Ark Responses selections cannot silently fall through to generic adapters',
    () async {
      final provider =
          createVoiceProvider(
                const VoiceConfiguration(
                  pipeline: VoicePipeline.cascaded,
                  asrProvider: SpeechProvider.volcengine,
                  asr: VoiceServiceConfiguration(
                    endpoint: 'wss://example.com/asr',
                    key: 'fixture-key',
                    resourceId: 'asr-resource',
                  ),
                  ttsProvider: SpeechProvider.volcengine,
                  tts: VoiceServiceConfiguration(
                    endpoint: 'wss://example.com/tts',
                    key: 'fixture-key',
                    resourceId: 'tts-resource',
                    voice: 'public-test-voice',
                  ),
                  fastLlmProtocol: FastLlmProtocol.arkResponses,
                  fastLlm: VoiceServiceConfiguration(
                    endpoint: 'https://example.com/responses',
                    model: 'fixture-model',
                    key: 'fixture-key',
                  ),
                ),
              )
              as CascadedVoiceProvider;
      expect(provider.asr, isA<VolcAsr>());
      expect(provider.tts, isA<VolcTts>());
      expect(provider.llm, isA<ArkResponsesCascadeLlm>());
      await provider.close();
    },
  );
  test(
    'generic direct speech remains separate from compatible chat LLM',
    () async {
      final provider =
          createVoiceProvider(
                const VoiceConfiguration(
                  pipeline: VoicePipeline.cascaded,
                  asrProvider: SpeechProvider.selfHosted,
                  asr: VoiceServiceConfiguration(
                    endpoint: 'wss://example.com/asr',
                  ),
                  ttsProvider: SpeechProvider.selfHosted,
                  tts: VoiceServiceConfiguration(
                    endpoint: 'https://example.com/tts',
                  ),
                  fastLlm: VoiceServiceConfiguration(
                    endpoint: 'https://example.com/chat/completions',
                    model: 'fixture-model',
                    key: 'fixture-key',
                  ),
                ),
              )
              as CascadedVoiceProvider;
      expect(provider.asr, isA<SelfHostedWsAsr>());
      expect(provider.tts, isA<SelfHostedPcmTts>());
      expect(provider.llm, isA<ChatCompletionsCascadeLlm>());
      await provider.close();
    },
  );
}
