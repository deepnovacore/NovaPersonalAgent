import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/ui/provider_setup_page.dart';
import 'package:nova_mobile/ui/model_settings_editor.dart';
import 'package:nova_mobile/settings/model_settings_backend.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/ui/theme.dart';

class _Native implements LocalAgent {
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> args = const {},
  ]) async {}
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  testWidgets(
    'model selector refreshes newly configured services and saves no key input',
    (tester) async {
      final settings = ModelSettings(native: _Native());
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showModelSettingsEditor(
                  context,
                  LocalModelSettingsBackend(settings),
                  onManageCredentials: (_) async {
                    await settings.credentials.save(
                      endpoint: 'https://relay.example/v1',
                      key: 'relay-secret',
                      protocol: ModelProtocol.responses,
                    );
                  },
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(find.text('未配置'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('model.credentials')));
      await tester.pumpAndSettle();
      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('https://relay.example/v1').last);
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'selected-model');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      final selected = (await settings.readApiKey())!;
      expect(selected.model, 'selected-model');
      expect(selected.key, 'relay-secret');
      expect(selected.protocol, ModelProtocol.responses);
      expect(find.byType(AlertDialog), findsNothing);
    },
  );

  for (final width in [320.0, 360.0]) {
    for (final language in ['zh', 'en']) {
      testWidgets(
        'model selection has no key editor at $width / $language / 2x text',
        (tester) async {
          tester.view.physicalSize = Size(width, 740);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final settings = ModelSettings(native: _Native());
          await settings.save(
            endpoint: 'https://api.deepseek.com',
            model: 'deepseek-chat',
            key: 'saved-secret',
          );
          await tester.pumpWidget(
            MaterialApp(
              theme: novaTheme(),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: const TextScaler.linear(2)),
                child: child!,
              ),
              home: Scaffold(
                body: Builder(
                  builder: (context) => TextButton(
                    onPressed: () => showLocalModelSettings(
                      context,
                      settings,
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
          expect(
            find.text(language == 'zh' ? '对话模型' : 'Conversation model'),
            findsOneWidget,
          );
          expect(find.byType(ProviderSetupPage), findsNothing);
          expect(find.byKey(const ValueKey('provider.key')), findsNothing);
          expect(find.text('saved-secret'), findsNothing);
          expect(
            find.text(language == 'zh' ? '去获取 API 密钥' : 'Get an API key'),
            findsNothing,
          );
          final save = find.widgetWithText(
            FilledButton,
            language == 'zh' ? '保存' : 'Save',
          );
          await tester.ensureVisible(save);
          await tester.tap(save);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          expect((await settings.readApiKey())!.key, 'saved-secret');
          expect(find.byType(AlertDialog), findsNothing);
        },
      );
    }
  }
}
