import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/voice/voice_settings.dart';
import 'package:nova_mobile/voice/voice_settings_sheet.dart';

VoiceConfiguration configured({String key = 'test-key'}) =>
    const VoiceConfiguration().copyWith(
      integrated: const VoiceConfiguration().integrated.copyWith(key: key),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('secure round trip is independent of text settings', () async {
    const storage = FlutterSecureStorage();
    await storage.write(key: ModelSettings.storageKey, value: 'text-config');
    const settings = VoiceSettings();
    expect(await settings.read(), isNull);
    final saved = await settings.save(configured());
    final loaded = (await settings.read())!;
    expect(loaded.toJson(), saved.toJson());
    expect(await storage.read(key: ModelSettings.storageKey), 'text-config');
    final json =
        jsonDecode((await storage.read(key: VoiceSettings.storageKey))!) as Map;
    expect(json['pipeline'], 'integrated');
    expect(json['integratedProfile'], 'qwen');
    expect(json['version'], 1);
  });

  test(
    'ASR-only configuration works without integrated, LLM or TTS credentials',
    () async {
      const settings = VoiceSettings();
      final saved = await settings.saveAsr(
        provider: SpeechProvider.volcengine,
        asr: const VoiceServiceConfiguration(
          endpoint: 'wss://example.com/asr',
          key: 'asr-key',
          resourceId: 'asr-resource',
        ),
      );
      expect(saved.integrated.key, isEmpty);
      expect(saved.fastLlm.key, isEmpty);
      expect((await settings.readForDictation())!.asr.key, 'asr-key');
      await expectLater(settings.read(), throwsA(isA<AgentFailure>()));
      final full = await settings.save(
        (await settings.readDraft())!.copyWith(
          integrated: configured().integrated,
        ),
      );
      expect(full.asr.key, 'asr-key');
      expect((await settings.read())!.integrated.key, 'test-key');
    },
  );

  test(
    'ASR save preserves conversation settings and scopes retained secrets',
    () async {
      const settings = VoiceSettings();
      await settings.save(configured());
      const service = VoiceServiceConfiguration(
        endpoint: 'wss://example.com/asr',
        key: 'asr-key',
        resourceId: 'resource',
      );
      final saved = await settings.saveAsr(
        provider: SpeechProvider.volcengine,
        asr: service,
      );
      final retained = await settings.saveAsr(
        provider: SpeechProvider.volcengine,
        asr: service.copyWith(key: '', resourceId: ''),
      );
      expect(retained.asr.toJson(), saved.asr.toJson());
      expect(retained.integrated.toJson(), configured().integrated.toJson());
      await expectLater(
        settings.saveAsr(
          provider: SpeechProvider.volcengine,
          asr: service.copyWith(
            endpoint: 'wss://other.example/asr',
            key: '',
            resourceId: '',
          ),
        ),
        throwsA(isA<AgentFailure>()),
      );
      expect(
        (await settings.readForDictation())!.asr.endpoint,
        service.endpoint,
      );
      await settings.saveAsr(
        provider: SpeechProvider.selfHosted,
        asr: service.copyWith(key: '', resourceId: ''),
      );
      expect((await settings.readForDictation())!.asr.key, isEmpty);
    },
  );

  test('blank key preserved only for same endpoint and provider', () async {
    const settings = VoiceSettings();
    final original = await settings.save(configured());
    final blank = original.copyWith(
      integrated: original.integrated.copyWith(model: 'another-model', key: ''),
    );
    expect((await settings.save(blank)).integrated.key, 'test-key');
    await expectLater(
      settings.save(
        blank.copyWith(
          integrated: blank.integrated.copyWith(
            endpoint: 'wss://other.example/realtime',
          ),
        ),
      ),
      throwsA(isA<AgentFailure>()),
    );
    await expectLater(
      settings.save(
        blank.copyWith(integratedProfile: IntegratedVoiceService.openai),
      ),
      throwsA(isA<AgentFailure>()),
    );
    expect(
      (await settings.read())!.integratedProfile,
      IntegratedVoiceService.qwen,
    );
    expect((await settings.read())!.integrated.key, 'test-key');
  });

  test('cascaded secrets are independent and have separate scopes', () async {
    const settings = VoiceSettings();
    final original = const VoiceConfiguration().copyWith(
      pipeline: VoicePipeline.cascaded,
      asr: const VoiceConfiguration().asr.copyWith(key: 'asr-secret'),
      tts: const VoiceConfiguration().tts.copyWith(key: 'tts-secret'),
      fastLlm: const VoiceServiceConfiguration(
        endpoint: 'https://example.com/v1/chat/completions',
        model: 'fast',
        key: 'llm-secret',
      ),
    );
    await settings.save(original);
    final blank = original.copyWith(
      asr: original.asr.copyWith(key: ''),
      tts: original.tts.copyWith(key: ''),
      fastLlm: original.fastLlm.copyWith(key: ''),
    );
    final saved = await settings.save(blank);
    expect(saved.asr.key, 'asr-secret');
    expect(saved.tts.key, 'tts-secret');
    expect(saved.fastLlmConfiguration.key, 'llm-secret');
    await expectLater(
      settings.save(
        blank.copyWith(
          fastLlm: blank.fastLlm.copyWith(
            endpoint: 'https://other.example/chat',
          ),
        ),
      ),
      throwsA(isA<AgentFailure>()),
    );
    final selfHosted = await settings.save(
      blank.copyWith(ttsProvider: SpeechProvider.selfHosted),
    );
    expect(selfHosted.tts.key, isEmpty); // Same address, different provider.
  });

  test(
    'public URLs require TLS, reject embedded credentials and parameters',
    () {
      for (final endpoint in [
        'ws://example.com/audio',
        'https://example.com/audio',
        'wss://user:secret@example.com/audio',
        'wss://example.com/audio?key=secret',
        'wss://example.com/audio#secret',
        'wss:///audio',
        'wss://example.com/a b',
      ]) {
        expect(
          () => configured()
              .copyWith(
                integrated: configured().integrated.copyWith(
                  endpoint: endpoint,
                ),
              )
              .validate(),
          throwsA(isA<AgentFailure>()),
          reason: endpoint,
        );
      }
      for (final endpoint in [
        'ws://localhost:8000/audio',
        'ws://127.0.0.1/audio',
        'ws://[::1]:8000/audio',
        'wss://example.com/audio',
      ]) {
        expect(
          () => configured()
              .copyWith(
                integrated: configured().integrated.copyWith(
                  endpoint: endpoint,
                ),
              )
              .validate(),
          returnsNormally,
        );
      }
    },
  );

  test('required values and header injection are rejected', () {
    for (final service in [
      configured().integrated.copyWith(key: ''),
      configured().integrated.copyWith(key: 'secret\r\nInjected: bad'),
      configured().integrated.copyWith(model: ''),
      configured().integrated.copyWith(voice: ''),
    ]) {
      expect(
        () => configured().copyWith(integrated: service).validate(),
        throwsA(isA<AgentFailure>()),
      );
    }
    expect(
      () => configured()
          .copyWith(
            integratedProfile: IntegratedVoiceService.stepfun,
            integrated: configured().integrated.copyWith(voice: ''),
          )
          .validate(),
      returnsNormally,
    );
  });

  test(
    'malformed secure data gives a fixed error without secret text',
    () async {
      const storage = FlutterSecureStorage();
      for (final raw in [
        'secret invalid json',
        jsonEncode({'version': 99, 'secret': 'private'}),
      ]) {
        await storage.write(key: VoiceSettings.storageKey, value: raw);
        await expectLater(
          const VoiceSettings().read(),
          throwsA(
            isA<AgentFailure>().having(
              (e) => e.toString(),
              'error',
              'voice_settings_unavailable',
            ),
          ),
        );
      }
    },
  );

  test('unknown enum never falls back to a different provider', () {
    final value = configured().toJson()..['integratedProfile'] = 'unknown';
    expect(() => VoiceConfiguration.fromJson(value), throwsArgumentError);
  });

  testWidgets(
    'saved secrets stay out of controllers and edited address clears entered key',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: VoiceSettingsSheet(
              settings: const VoiceSettings(),
              initial: configured(),
            ),
          ),
        ),
      );
      final keyFinder = find.byKey(const ValueKey('实时模型.key'));
      final field = tester.widget<TextField>(keyFinder);
      expect(field.obscureText, isTrue);
      expect(field.controller!.text, isEmpty);
      expect(find.text('test-key'), findsNothing);
      await tester.enterText(keyFinder, 'new-secret');
      await tester.enterText(
        find.byKey(const ValueKey('实时模型.endpoint')),
        'wss://another.example/realtime',
      );
      expect(field.controller!.text, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
