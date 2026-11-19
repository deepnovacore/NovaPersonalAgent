import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/ui/provider_credentials_sheet.dart';

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
      tester.view.physicalSize = const Size(800, 2600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () =>
                    showProviderCredentials(context, settings.credentials),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      // The provider already has a key, so its list comes first.
      await tester.tap(find.byKey(const ValueKey('provider.add')));
      await tester.pumpAndSettle();
      const saved = '已保存的密钥不会回显；留空时使用此服务已保存的密钥';
      final secret = find.byKey(const ValueKey('provider.key'));
      expect(find.text(saved), findsOneWidget);
      expect(tester.widget<TextField>(secret).controller!.text, isEmpty);
      await tester.tap(find.byKey(const ValueKey('provider.chip.openai')));
      await tester.pumpAndSettle();
      expect(find.text(saved), findsNothing);
      await tester.tap(find.byKey(const ValueKey('provider.chip.custom')));
      await tester.pumpAndSettle();
      final url = find.byKey(const ValueKey('provider.baseUrl'));
      await tester.enterText(
        url,
        'https://openrouter.ai/api/v1/chat/completions',
      );
      await tester.pumpAndSettle();
      expect(find.text(saved), findsOneWidget);
      await tester.enterText(url, 'https://another.example/v1');
      await tester.pumpAndSettle();
      expect(find.text(saved), findsNothing);
      expect(tester.widget<TextField>(secret).controller!.text, isEmpty);
      expect(find.text('saved-secret'), findsNothing);
      await tester.pageBack();
      await tester.pumpAndSettle();
    },
  );
}
