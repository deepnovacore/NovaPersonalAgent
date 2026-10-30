import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';

void main() {
  testWidgets(
    'model key status follows the selected provider and edited endpoint',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final settings = ModelSettings(headless: true);
      await settings.credentials.save(
        endpoint: 'https://openrouter.ai/api/v1',
        key: 'saved-secret',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showLocalModelSettings(context, settings),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(find.text('API 密钥：已配置'), findsOneWidget);
      final secret = find.byWidgetPredicate(
        (widget) => widget is TextField && widget.obscureText,
      );
      expect(tester.widget<TextField>(secret).controller!.text, isEmpty);
      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('OpenAI').last);
      await tester.pumpAndSettle();
      expect(find.text('API 密钥：未配置'), findsOneWidget);
      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('自定义（OpenAI 兼容）'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.tap(find.text('自定义（OpenAI 兼容）'));
      await tester.pumpAndSettle();
      final url = find.byWidgetPredicate(
        (widget) =>
            widget is TextField && widget.keyboardType == TextInputType.url,
      );
      await tester.enterText(
        url,
        'https://openrouter.ai/api/v1/chat/completions',
      );
      await tester.pumpAndSettle();
      expect(find.text('API 密钥：已配置'), findsOneWidget);
      await tester.enterText(url, 'https://another.example/v1');
      await tester.pumpAndSettle();
      expect(find.text('API 密钥：未配置'), findsOneWidget);
      expect(tester.widget<TextField>(secret).controller!.text, isEmpty);
      expect(find.text('saved-secret'), findsNothing);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
    },
  );
}
