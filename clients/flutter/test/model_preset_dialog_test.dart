import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/ui/theme.dart';

class _Models extends ModelSettings {
  _Models(this.saved);
  final ModelConfiguration? saved;
  Map<String, Object?>? last;

  @override
  Future<ModelConfiguration?> read() async => saved;

  @override
  Future<void> save({
    required String endpoint,
    required String model,
    required String key,
    ModelProtocol protocol = ModelProtocol.chatCompletions,
  }) async {
    last = {
      'endpoint': endpoint,
      'model': model,
      'key': key,
      'protocol': protocol,
    };
  }
}

Future<void> _open(WidgetTester tester, _Models models) async {
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
    (_) async => null,
  );
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showLocalModelSettings(context, models),
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
  testWidgets('a new user sees a preset form: key only, no URL field', (
    tester,
  ) async {
    final models = _Models(null);
    await _open(tester, models);
    expect(find.byType(TextField), findsNWidgets(2)); // key + model
    expect(find.text('接口地址'), findsNothing);
    await tester.enterText(find.widgetWithText(TextField, 'API 密钥'), 'sk-1');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(models.last, {
      'endpoint': 'https://openrouter.ai/api/v1',
      'model': 'openai/gpt-4.1-mini',
      'key': 'sk-1',
      'protocol': ModelProtocol.chatCompletions,
    });
  });

  testWidgets('choosing another preset swaps endpoint and recommended model', (
    tester,
  ) async {
    final models = _Models(null);
    await _open(tester, models);
    await tester.tap(find.text('OpenRouter'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('DeepSeek').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'API 密钥'), 'sk-2');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(models.last?['endpoint'], 'https://api.deepseek.com');
    expect(models.last?['model'], 'deepseek-chat');
    expect(models.last?['key'], 'sk-2');
  });

  testWidgets('custom keeps the free-form fields and a blank key', (
    tester,
  ) async {
    final models = _Models(
      ModelConfiguration(
        endpoint: 'https://model.example/v1/chat/completions',
        model: 'm',
        key: 'saved',
      ),
    );
    await _open(tester, models);
    expect(find.text('接口地址'), findsOneWidget);
    expect(find.text('自定义（OpenAI 兼容）'), findsOneWidget);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(
      models.last?['endpoint'],
      'https://model.example/v1/chat/completions',
    );
    expect(models.last?['key'], '');
  });

  testWidgets('a saved preset endpoint reopens on that preset unchanged', (
    tester,
  ) async {
    final models = _Models(
      ModelConfiguration(
        endpoint: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-reasoner',
        key: 'saved',
      ),
    );
    await _open(tester, models);
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('接口地址'), findsNothing);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    // Endpoint text is preserved so the stored key is still retained.
    expect(
      models.last?['endpoint'],
      'https://api.deepseek.com/chat/completions',
    );
    expect(models.last?['model'], 'deepseek-reasoner');
  });
}
