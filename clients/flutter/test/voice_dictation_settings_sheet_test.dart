import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_settings.dart';
import 'package:nova_mobile/voice/voice_settings_sheet.dart';

Future<void> openDictationSettings(
  WidgetTester tester, {
  String language = 'zh',
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showVoiceSettings(
              context,
              VoiceSettings(),
              dictationOnly: true,
              language: language,
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'dictation settings save ASR without requiring live voice configuration',
    (tester) async {
      await openDictationSettings(tester);
      expect(find.text('语音输入设置'), findsOneWidget);
      expect(find.byKey(const ValueKey('asr.provider')), findsOneWidget);
      expect(find.byKey(const ValueKey('ASR.endpoint')), findsOneWidget);
      expect(find.byKey(const ValueKey('voice.pipeline')), findsNothing);
      expect(find.byKey(const ValueKey('integrated.provider')), findsNothing);
      expect(find.byKey(const ValueKey('fastLlm.protocol')), findsNothing);
      expect(find.byKey(const ValueKey('tts.provider')), findsNothing);
      expect(find.textContaining('转写结果仅填入输入框'), findsOneWidget);
      expect(find.textContaining('AOQ'), findsNothing);
      final key = find.byKey(const ValueKey('ASR.key'));
      expect(tester.widget<TextField>(key).obscureText, isTrue);
      await tester.enterText(key, 'asr-test-secret');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(find.byType(VoiceSettingsSheet), findsNothing);
      final saved = (await VoiceSettings().readDraft())!;
      expect(saved.asr.key, 'asr-test-secret');
      expect(saved.integrated.key, isEmpty);
      expect(saved.fastLlm.key, isEmpty);
      expect(saved.tts.key, isEmpty);
    },
  );

  testWidgets(
    'English ASR-only edit reads partial draft and preserves unrelated settings',
    (tester) async {
      final initial = const VoiceConfiguration().copyWith(
        pipeline: VoicePipeline.cascaded,
        asr: const VoiceConfiguration().asr.copyWith(key: 'saved-asr-secret'),
        // Deliberately incomplete fast model: ASR editing must still be available.
        fastLlm: const VoiceServiceConfiguration(model: 'incomplete'),
        tts: const VoiceConfiguration().tts.copyWith(key: 'saved-tts-secret'),
      );
      FlutterSecureStorage.setMockInitialValues({
        VoiceSettings.storageKey: jsonEncode(initial.toJson()),
      });
      await openDictationSettings(tester, language: 'en');
      expect(find.text('Voice input settings'), findsOneWidget);
      expect(find.text('Speech recognition service'), findsOneWidget);
      expect(
        find.textContaining('transcript only fills the message draft'),
        findsOneWidget,
      );
      final visibleText = tester
          .widgetList<Text>(find.byType(Text))
          .map((text) => text.data ?? '')
          .join(' ');
      expect(RegExp(r'[\u4e00-\u9fff]').hasMatch(visibleText), isFalse);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('ASR.key')))
            .controller!
            .text,
        isEmpty,
      );
      await tester.enterText(
        find.byKey(const ValueKey('ASR.model')),
        'updated-asr-model',
      );
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final saved = (await VoiceSettings().readDraft())!;
      expect(saved.asr.key, 'saved-asr-secret');
      expect(saved.asr.model, 'updated-asr-model');
      expect(saved.pipeline, initial.pipeline);
      expect(saved.fastLlm.toJson(), initial.fastLlm.toJson());
      expect(saved.tts.toJson(), initial.tts.toJson());
      expect(saved.integrated.toJson(), initial.integrated.toJson());
    },
  );

  testWidgets(
    'ASR endpoint change cannot silently retain the previous credential',
    (tester) async {
      final initial = const VoiceConfiguration().copyWith(
        asr: const VoiceConfiguration().asr.copyWith(key: 'saved-asr-secret'),
      );
      FlutterSecureStorage.setMockInitialValues({
        VoiceSettings.storageKey: jsonEncode(initial.toJson()),
      });
      await openDictationSettings(tester, language: 'en');
      final key = find.byKey(const ValueKey('ASR.key'));
      await tester.enterText(key, 'newly-entered-secret');
      await tester.enterText(
        find.byKey(const ValueKey('ASR.endpoint')),
        'https://another.example/v1beta',
      );
      expect(tester.widget<TextField>(key).controller!.text, isEmpty);
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.byType(VoiceSettingsSheet), findsOneWidget);
      expect(find.textContaining('Check the service address'), findsOneWidget);
      expect(
        (await VoiceSettings().readDraft())!.asr.endpoint,
        initial.asr.endpoint,
      );
      await tester.enterText(key, 'replacement-secret');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.byType(VoiceSettingsSheet), findsNothing);
      expect(
        (await VoiceSettings().readDraft())!.asr.key,
        'replacement-secret',
      );
    },
  );
}
