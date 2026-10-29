import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_presets.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/voice/voice_settings.dart';
import 'package:nova_mobile/voice/voice_settings_sheet.dart';

const _openButton = ValueKey('open-voice-settings');
const _tabIntegrated = ValueKey('pipeline.tab.integrated');
const _tabCascaded = ValueKey('pipeline.tab.cascaded');
const _providerKey = ValueKey('integrated.provider');
const _modelKey = ValueKey('integrated.model');
const _voiceKey = ValueKey('integrated.voice');
const _keyKey = ValueKey('integrated.key');
const _asrProviderKey = ValueKey('asr.provider');
const _ttsProviderKey = ValueKey('tts.provider');
const _fastLlmProtocolKey = ValueKey('fastLlm.protocol');
const _zhIntegratedTab = '端到端';
const _zhCascadedTab = '级联';

VoiceServiceConfiguration _builtIn(
  IntegratedVoiceService provider, {
  String? model,
  String? voice,
  String key = '',
  String? endpoint,
}) {
  final defaults = VoiceConfiguration.integratedDefaults(provider);
  return defaults.copyWith(
    endpoint: endpoint ?? defaults.endpoint,
    model: model ?? defaults.model,
    voice: voice ?? defaults.voice,
    key: key,
  );
}

/// Valid cascaded sub-configurations so the sheet can save in either mode.
VoiceConfiguration _validCascaded({
  VoicePipeline pipeline = VoicePipeline.cascaded,
}) {
  const defaults = VoiceConfiguration();
  return defaults.copyWith(
    pipeline: pipeline,
    asr: defaults.asr.copyWith(key: 'asr-key'),
    tts: defaults.tts.copyWith(key: 'tts-key'),
    fastLlm: const VoiceServiceConfiguration(
      endpoint: 'https://example.com/v1/chat/completions',
      model: 'fast-model',
      key: 'llm-key',
    ),
  );
}

Future<void> _openSettings(
  WidgetTester tester, {
  VoiceConfiguration? initial,
  String language = 'zh',
  Size surfaceSize = const Size(1000, 1800),
  Map<String, String> storageValues = const {},
}) async {
  tester.view.physicalSize = surfaceSize;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  FlutterSecureStorage.setMockInitialValues({
    ...storageValues,
    if (initial != null) VoiceSettings.storageKey: jsonEncode(initial.toJson()),
  });
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              key: _openButton,
              onPressed: () => showVoiceSettings(
                context,
                VoiceSettings(),
                language: language,
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.byKey(_openButton));
  await tester.pumpAndSettle();
}

Future<void> _switchTab(WidgetTester tester, Key tab) async {
  await tester.tap(find.byKey(tab));
  await tester.pumpAndSettle();
}

Future<void> _openDropdown(WidgetTester tester, Key key) async {
  final finder = find.byKey(key);
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _closeDropdown(WidgetTester tester) async {
  await tester.tapAt(const Offset(4, 4));
  await tester.pumpAndSettle();
}

Future<void> _selectDropdown(
  WidgetTester tester,
  Key key,
  String option,
) async {
  await _openDropdown(tester, key);
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

TextField _textField(WidgetTester tester, Key key) =>
    tester.widget<TextField>(find.byKey(key));

String _visibleText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((text) => text.data ?? '')
    .join(' ');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('pipeline tabs only show the selected pipeline fields', (
    tester,
  ) async {
    await _openSettings(tester);
    // Two-tab selector replaces the old advanced fold and mode dropdown.
    expect(find.byKey(const ValueKey('pipeline.tabs')), findsOneWidget);
    expect(find.byKey(_tabIntegrated), findsOneWidget);
    expect(find.byKey(_tabCascaded), findsOneWidget);
    expect(find.byType(ExpansionTile), findsNothing);
    expect(find.text('高级：分步处理'), findsNothing);
    expect(find.text('语音模式'), findsNothing);
    // Default integrated pipeline: tab 1 fields only.
    expect(find.byKey(_providerKey), findsOneWidget);
    expect(find.byKey(_modelKey), findsOneWidget);
    expect(find.byKey(_voiceKey), findsOneWidget);
    expect(find.byKey(_keyKey), findsOneWidget);
    expect(find.byKey(_asrProviderKey), findsNothing);
    expect(find.byKey(_fastLlmProtocolKey), findsNothing);
    // No endpoint field, no redundant section heading or status card copy.
    expect(find.byKey(const ValueKey('实时模型.endpoint')), findsNothing);
    expect(find.text('WSS 服务地址'), findsNothing);
    expect(find.text('实时模型'), findsNothing);
    expect(find.text('实时语音'), findsNothing);
    expect(find.text('当前使用分步处理'), findsNothing);
    // Model and voice are closed dropdowns, not free-text fields.
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is DropdownButtonFormField<String> &&
            widget.key == _modelKey,
      ),
      findsOneWidget,
    );
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is DropdownButtonFormField<String> &&
            widget.key == _voiceKey,
      ),
      findsOneWidget,
    );
    expect(find.text('Qwen'), findsOneWidget);
    expect(find.text(IntegratedVoiceCatalog.qwenDefaultModel), findsOneWidget);
    expect(find.text(IntegratedVoiceCatalog.qwenDefaultVoice), findsOneWidget);

    // Switching tabs swaps the fields entirely.
    await _switchTab(tester, _tabCascaded);
    expect(find.byKey(_asrProviderKey), findsOneWidget);
    expect(find.byKey(_fastLlmProtocolKey), findsOneWidget);
    expect(find.byKey(_ttsProviderKey), findsOneWidget);
    expect(find.byKey(_providerKey), findsNothing);
    expect(find.byKey(_modelKey), findsNothing);
    expect(find.byKey(_keyKey), findsNothing);

    await _switchTab(tester, _tabIntegrated);
    expect(find.byKey(_providerKey), findsOneWidget);
    expect(find.byKey(_keyKey), findsOneWidget);
    expect(find.byKey(_asrProviderKey), findsNothing);
    expect(find.byKey(_ttsProviderKey), findsNothing);
  });

  testWidgets('Qwen catalog drives per-model default voices', (tester) async {
    await _openSettings(tester);
    await _openDropdown(tester, _modelKey);
    for (final model in IntegratedVoiceCatalog.models(
      IntegratedVoiceService.qwen,
    )) {
      expect(find.text(model), findsWidgets, reason: model);
    }
    await tester.tap(find.text(IntegratedVoiceCatalog.qwenV31Model).last);
    await tester.pumpAndSettle();
    expect(find.text(IntegratedVoiceCatalog.qwenV31Voice), findsOneWidget);
    // The 3.1 model only offers its 3.1 voice.
    await _openDropdown(tester, _voiceKey);
    expect(find.text(IntegratedVoiceCatalog.qwenV31Voice), findsWidgets);
    expect(find.text('longanlingxin'), findsNothing);
    await _closeDropdown(tester);

    await _selectDropdown(tester, _modelKey, 'qwen3.5-omni-flash-realtime');
    expect(find.text(IntegratedVoiceCatalog.qwenOmniVoice), findsOneWidget);
    await _openDropdown(tester, _voiceKey);
    expect(find.text(IntegratedVoiceCatalog.qwenOmniVoice), findsWidgets);
    expect(find.text(IntegratedVoiceCatalog.qwenV31Voice), findsNothing);
    await _closeDropdown(tester);

    await _selectDropdown(tester, _modelKey, 'qwen-audio-3.0-realtime-flash');
    expect(find.text(IntegratedVoiceCatalog.qwenDefaultVoice), findsOneWidget);
    await _openDropdown(tester, _voiceKey);
    for (final voice in [
      'longanqian',
      'longanlingxin',
      'longanlingxi',
      'longanxiaoxin',
      'longanlufeng',
    ]) {
      expect(find.text(voice), findsWidgets, reason: voice);
    }
    await _closeDropdown(tester);
  });

  testWidgets('switching provider applies official defaults and clears key', (
    tester,
  ) async {
    await _openSettings(tester);
    await tester.enterText(find.byKey(_keyKey), 'entered-key');
    expect(_textField(tester, _keyKey).controller!.text, 'entered-key');

    await _selectDropdown(tester, _providerKey, 'OpenAI');
    expect(
      find.text(IntegratedVoiceCatalog.openaiDefaultModel),
      findsOneWidget,
    );
    expect(
      find.text(IntegratedVoiceCatalog.openaiDefaultVoice),
      findsOneWidget,
    );
    expect(_textField(tester, _keyKey).controller!.text, isEmpty);

    await _selectDropdown(tester, _providerKey, 'Gemini Live');
    expect(
      find.text(IntegratedVoiceCatalog.geminiDefaultModel),
      findsOneWidget,
    );
    expect(
      find.text(IntegratedVoiceCatalog.geminiDefaultVoice),
      findsOneWidget,
    );

    await _selectDropdown(tester, _providerKey, 'StepFun');
    expect(
      find.text(IntegratedVoiceCatalog.stepfunDefaultModel),
      findsOneWidget,
    );
    expect(
      find.text(IntegratedVoiceCatalog.stepfunDefaultVoice),
      findsOneWidget,
    );
    expect(find.text('WSS 服务地址'), findsNothing);

    // OpenAI's second model shares the catalog voices and keeps marin first.
    await _selectDropdown(tester, _providerKey, 'OpenAI');
    await _selectDropdown(tester, _modelKey, 'gpt-realtime-2.1');
    expect(
      find.text(IntegratedVoiceCatalog.openaiDefaultVoice),
      findsOneWidget,
    );

    // A provider switch saves that provider's official endpoint.
    await _selectDropdown(tester, _providerKey, 'StepFun');
    await tester.enterText(find.byKey(_keyKey), 'stepfun-key');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(find.byType(VoiceSettingsSheet), findsNothing);
    final saved = (await VoiceSettings().readDraft())!;
    expect(saved.integratedProfile, IntegratedVoiceService.stepfun);
    expect(saved.integrated.endpoint, IntegratedVoiceCatalog.stepfunEndpoint);
    expect(saved.integrated.model, IntegratedVoiceCatalog.stepfunDefaultModel);
    expect(saved.integrated.voice, IntegratedVoiceCatalog.stepfunDefaultVoice);
    expect(saved.integrated.key, 'stepfun-key');
  });

  testWidgets('saved model and voice outside the catalog stay selectable', (
    tester,
  ) async {
    const savedModel = 'qwen-audio-9.9-realtime-preview';
    const savedVoice = 'longan-custom';
    final initial = const VoiceConfiguration().copyWith(
      integrated: _builtIn(
        IntegratedVoiceService.qwen,
        model: savedModel,
        voice: savedVoice,
      ),
    );
    await _openSettings(tester, initial: initial);
    expect(find.text(savedModel), findsOneWidget);
    expect(find.text(savedVoice), findsOneWidget);

    await _openDropdown(tester, _modelKey);
    expect(find.text(savedModel), findsWidgets);
    for (final model in IntegratedVoiceCatalog.models(
      IntegratedVoiceService.qwen,
    )) {
      expect(find.text(model), findsWidgets, reason: model);
    }
    await _closeDropdown(tester);

    await _openDropdown(tester, _voiceKey);
    expect(find.text(savedVoice), findsWidgets);
    await _closeDropdown(tester);
    await _selectDropdown(
      tester,
      _modelKey,
      IntegratedVoiceCatalog.qwenV31Model,
    );
    // Selecting a catalog model replaces the saved voice with its default.
    expect(find.text(IntegratedVoiceCatalog.qwenV31Voice), findsOneWidget);
    await _openDropdown(tester, _voiceKey);
    expect(find.text(savedVoice), findsNothing);
    await _closeDropdown(tester);
  });

  testWidgets('saving keeps the official endpoint, defaults and saved key', (
    tester,
  ) async {
    for (final provider in IntegratedVoiceService.values) {
      final defaults = VoiceConfiguration.integratedDefaults(provider);
      final initial = const VoiceConfiguration().copyWith(
        integratedProfile: provider,
        integrated: defaults.copyWith(key: 'saved-${provider.name}'),
      );
      await _openSettings(tester, initial: initial);
      expect(find.text('WSS 服务地址'), findsNothing, reason: provider.name);
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(
        find.byType(VoiceSettingsSheet),
        findsNothing,
        reason: provider.name,
      );
      final saved = (await VoiceSettings().readDraft())!;
      expect(saved.integratedProfile, provider);
      expect(
        saved.integrated.endpoint,
        IntegratedVoiceCatalog.officialEndpoint(provider),
      );
      expect(saved.integrated.model, defaults.model);
      expect(saved.integrated.voice, defaults.voice);
      expect(saved.integrated.key, 'saved-${provider.name}');
      expect(saved.pipeline, VoicePipeline.integrated);
    }
  });

  testWidgets('historical custom endpoints are replaced by the official one', (
    tester,
  ) async {
    final initial = const VoiceConfiguration().copyWith(
      integrated: _builtIn(
        IntegratedVoiceService.qwen,
        endpoint: 'wss://voice.example.com/realtime',
        key: 'old-key',
      ),
    );
    await _openSettings(tester, initial: initial);
    expect(find.text('WSS 服务地址'), findsNothing);
    expect(find.textContaining('已切换为官方地址'), findsOneWidget);
    // The key saved for the custom address is not silently reused.
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(find.byType(VoiceSettingsSheet), findsOneWidget);
    expect(find.textContaining('请检查服务地址'), findsOneWidget);
    await tester.enterText(find.byKey(_keyKey), 'replacement-key');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(find.byType(VoiceSettingsSheet), findsNothing);
    final saved = (await VoiceSettings().readDraft())!;
    expect(saved.integrated.endpoint, IntegratedVoiceCatalog.qwenEndpoint);
    expect(saved.integrated.key, 'replacement-key');
    expect(saved.integrated.model, IntegratedVoiceCatalog.qwenDefaultModel);
    expect(saved.integrated.voice, IntegratedVoiceCatalog.qwenDefaultVoice);
  });

  testWidgets('saved cascaded pipeline opens on the step-by-step tab', (
    tester,
  ) async {
    await _openSettings(tester, initial: _validCascaded());
    // Saved cascaded pipeline starts on tab 2 and hides the integrated fields.
    expect(find.byKey(_asrProviderKey), findsOneWidget);
    expect(find.byKey(_fastLlmProtocolKey), findsOneWidget);
    expect(find.byKey(_ttsProviderKey), findsOneWidget);
    expect(find.byKey(_providerKey), findsNothing);
    expect(find.byKey(_modelKey), findsNothing);
    expect(find.byKey(_keyKey), findsNothing);
    // No duplicate mode dropdown, status card or advanced heading.
    expect(find.text('语音模式'), findsNothing);
    expect(find.text('当前使用分步处理'), findsNothing);
    expect(find.byType(ExpansionTile), findsNothing);

    await _switchTab(tester, _tabIntegrated);
    expect(find.byKey(_providerKey), findsOneWidget);
    expect(find.byKey(_keyKey), findsOneWidget);
    expect(find.byKey(_asrProviderKey), findsNothing);
    expect(find.byKey(_ttsProviderKey), findsNothing);
  });

  testWidgets('saving persists the selected tab pipeline', (tester) async {
    // Start integrated (tab 1) with valid cascaded settings; switching to tab 2
    // and saving must persist the cascaded pipeline.
    final initial = _validCascaded(pipeline: VoicePipeline.integrated).copyWith(
      integrated: _builtIn(IntegratedVoiceService.qwen, key: 'qwen-key'),
    );
    await _openSettings(tester, initial: initial);
    expect(find.byKey(_providerKey), findsOneWidget);
    await _switchTab(tester, _tabCascaded);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(find.byType(VoiceSettingsSheet), findsNothing);
    var saved = (await VoiceSettings().readDraft())!;
    expect(saved.pipeline, VoicePipeline.cascaded);
    expect(saved.asr.key, 'asr-key');
    expect(saved.tts.key, 'tts-key');
    expect(saved.fastLlmConfiguration.key, 'llm-key');

    // The saved cascaded pipeline opens on tab 2; switching back to tab 1 and
    // saving must persist the integrated pipeline again.
    await _openSettings(tester, initial: saved);
    expect(find.byKey(_providerKey), findsNothing);
    await _switchTab(tester, _tabIntegrated);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(find.byType(VoiceSettingsSheet), findsNothing);
    saved = (await VoiceSettings().readDraft())!;
    expect(saved.pipeline, VoicePipeline.integrated);
    expect(saved.integrated.key, 'qwen-key');
  });

  testWidgets('English labels cover the tabs and integrated pipeline', (
    tester,
  ) async {
    await _openSettings(tester, language: 'en');
    // Tabs and integrated fields are bilingual; no hidden Chinese copy.
    expect(find.text('End-to-end'), findsOneWidget);
    expect(find.text('Cascaded'), findsOneWidget);
    expect(find.text('Realtime service'), findsOneWidget);
    expect(find.text('Model'), findsOneWidget);
    expect(find.text('Voice'), findsOneWidget);
    expect(find.text('API key'), findsOneWidget);
    expect(find.text('Standalone voice'), findsOneWidget);
    expect(find.text('WSS endpoint'), findsNothing);
    expect(find.text('高级：分步处理'), findsNothing);
    expect(RegExp(r'[\u4e00-\u9fff]').hasMatch(_visibleText(tester)), isFalse);
  });

  testWidgets('English labels cover the step-by-step tab', (tester) async {
    await _openSettings(tester, initial: _validCascaded(), language: 'en');
    expect(find.text('Speech recognition service'), findsOneWidget);
    expect(find.text('Speech synthesis service'), findsOneWidget);
    expect(find.text('API protocol'), findsOneWidget);
    expect(find.text('Forebrain'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    expect(RegExp(r'[\u4e00-\u9fff]').hasMatch(_visibleText(tester)), isFalse);
  });

  testWidgets(
    'forebrain presets reuse configured keys and preserve custom URLs',
    (tester) async {
      final initial = _validCascaded();
      await _openSettings(
        tester,
        initial: initial,
        storageValues: {
          ModelSettings.storageKey: jsonEncode({
            'endpoint': ModelPreset.byId('openai')!.endpoint,
            'model': 'text-model',
            'key': 'saved-model-secret',
          }),
        },
      );
      expect(find.text('语音识别服务'), findsOneWidget);
      expect(find.text('ASR'), findsNothing);
      expect(find.byKey(const ValueKey('ASR.endpoint')), findsOneWidget);
      expect(find.text('前脑'), findsOneWidget);
      expect(find.text('快速前脑模型'), findsNothing);
      expect(
        _textField(tester, const ValueKey('fastLlm.endpoint')).controller!.text,
        initial.fastLlm.endpoint,
      );
      await _openDropdown(tester, const ValueKey('fastLlm.provider'));
      for (final preset in modelPresets) {
        expect(find.text(preset.name), findsWidgets);
      }
      await tester.tap(find.text('OpenAI').last);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('fastLlm.endpoint')), findsNothing);
      expect(
        _textField(tester, const ValueKey('fastLlm.key')).controller!.text,
        isEmpty,
      );
      expect(find.text('saved-model-secret'), findsNothing);
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(find.byType(VoiceSettingsSheet), findsNothing);
      final saved = (await VoiceSettings().readDraft())!;
      expect(saved.fastLlm.endpoint, ModelPreset.byId('openai')!.endpoint);
      expect(saved.fastLlm.key, isEmpty);
      expect((await VoiceSettings().read())!.fastLlm.key, 'saved-model-secret');

      await _openSettings(tester, initial: initial);
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(
        (await VoiceSettings().readDraft())!.fastLlm.toJson(),
        initial.fastLlm.toJson(),
      );
    },
  );

  testWidgets('tabs and fields fit a narrow phone width', (tester) async {
    // The real phone dialog is about 310 logical pixels wide.
    await _openSettings(tester, surfaceSize: const Size(390, 844));
    expect(find.byKey(_tabIntegrated), findsOneWidget);
    expect(find.byKey(_tabCascaded), findsOneWidget);
    expect(find.text(_zhIntegratedTab), findsOneWidget);
    expect(find.text(_zhCascadedTab), findsOneWidget);
    // Long Qwen model ids must ellipsize instead of overflowing the row.
    await _openDropdown(tester, _modelKey);
    await tester.tap(find.text(IntegratedVoiceCatalog.qwenV31Model).last);
    await tester.pumpAndSettle();
    expect(find.text(IntegratedVoiceCatalog.qwenV31Voice), findsOneWidget);
    // Both tabs must fit without overflow at phone width.
    await _switchTab(tester, _tabCascaded);
    expect(find.byKey(_asrProviderKey), findsOneWidget);
    expect(find.byKey(_fastLlmProtocolKey), findsOneWidget);
    await _switchTab(tester, _tabIntegrated);
    expect(find.byKey(_providerKey), findsOneWidget);
  });
}
