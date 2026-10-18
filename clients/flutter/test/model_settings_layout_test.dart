import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/ui/theme.dart';

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
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        expect(
          find.text(language == 'zh' ? '模型服务' : 'Model provider'),
          findsOneWidget,
        );
        final fields = tester
            .widgetList<TextField>(find.byType(TextField))
            .toList();
        expect(
          fields[0].controller!.text,
          'https://model.example/compatible-mode/v1/chat/completions',
        );
        expect(fields[1].controller!.text, 'example-model');
        await tester.ensureVisible(find.byType(TextField).last);
        await tester.tap(find.byType(TextField).last);
        await tester.showKeyboard(find.byType(TextField).last);
        await tester.pumpAndSettle();
        expect(
          find.text(
            language == 'zh'
                ? '不修改接口地址时，留空可保留现有密钥'
                : 'Leave blank to keep your current key if the API URL is unchanged',
          ),
          findsOneWidget,
        );
        await tester.ensureVisible(find.text(language == 'zh' ? '保存' : 'Save'));
        await tester.tap(find.text(language == 'zh' ? '保存' : 'Save'));
        await tester.pumpAndSettle();
        expect(find.textContaining('model_settings_failed'), findsNothing);
        expect(
          find.textContaining(language == 'zh' ? '未能保存' : 'Could not save'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await tester.tap(find.text(language == 'zh' ? '取消' : 'Cancel'));
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
