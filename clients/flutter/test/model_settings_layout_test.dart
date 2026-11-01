import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/ui/theme.dart';

import 'support/fake_model_http.dart';

class _Models extends ModelSettings {
  @override
  Future<ModelConfiguration?> read() async => ModelConfiguration(
    endpoint: 'https://model.example/compatible-mode/v1/chat/completions',
    model: 'example-model',
    key: 'synthetic',
  );

  @override
  Future<void> save({
    required String endpoint,
    required String model,
    required String key,
    ModelProtocol protocol = ModelProtocol.chatCompletions,
  }) async => throw const AgentFailure('model_settings_failed');
}

void main() {
  for (final width in [320.0, 360.0]) {
    for (final language in ['zh', 'en']) {
      testWidgets('model settings are usable at $width / $language / 2x text', (
        tester,
      ) async {
        tester.view.physicalSize = Size(width, 740);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
          (_) async => null,
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
                    _Models(),
                    language: language,
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        );
        final http = installModelHttp();
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        expect(
          find.text(language == 'zh' ? '配置模型' : 'Set up a model'),
          findsOneWidget,
        );
        // The saved custom address is shown, and no saved key is echoed.
        final list = find.byType(Scrollable).first;
        Future<TextField> reveal(String name) async {
          final field = find.byKey(ValueKey(name));
          await tester.scrollUntilVisible(field, 200, scrollable: list);
          await tester.ensureVisible(field);
          await tester.pumpAndSettle();
          return tester.widget<TextField>(field);
        }

        expect(
          (await reveal('provider.baseUrl')).controller!.text,
          'https://model.example/compatible-mode/v1/chat/completions',
        );
        final key = await reveal('provider.key');
        expect(key.controller!.text, isEmpty);
        await tester.tap(find.byKey(const ValueKey('provider.key')));
        await tester.showKeyboard(find.byKey(const ValueKey('provider.key')));
        await tester.enterText(
          find.byKey(const ValueKey('provider.key')),
          'typed-key',
        );
        await tester.pumpAndSettle();
        final test = find.byKey(const ValueKey('provider.test'));
        await tester.ensureVisible(test);
        await tester.tap(test);
        await tester.pump();
        await http.lists.single.complete(tester, ['example-model']);
        await http.probes.single.callTool(tester);
        await tester.ensureVisible(
          find.byKey(const ValueKey('provider.failed')),
        );
        expect(find.textContaining('model_settings_failed'), findsNothing);
        expect(
          find.textContaining(language == 'zh' ? '未能保存' : 'Could not save'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await tester.pageBack();
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
