import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/chatgpt_accounts.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/ui/provider_credentials_sheet.dart';
import 'package:nova_mobile/ui/provider_setup_page.dart';
import 'support/fake_model_http.dart';

class _Native implements LocalAgent {
  bool taskActive = false;
  int saves = 0;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    if (method == 'saveModelSettings') {
      saves++;
      if (taskActive) throw StateError('stop_task_before_changing_model');
    }
    return null;
  }
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  testWidgets(
    'another provider can be managed without switching chat or exposing saved keys',
    (tester) async {
      final native = _Native();
      await ModelSettings(native: native).save(
        endpoint: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        key: 'chat-secret',
      );
      final http = installModelHttp();
      native.taskActive = true;
      final settings = ModelSettings(native: native);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showProviderCredentials(
                  context,
                  settings.credentials,
                  onChanged: settings.refreshApiKeyProjection,
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(find.text('chat-secret'), findsNothing);
      expect(find.byType(ProviderSetupPage), findsOneWidget);
      expect(find.text('配置密钥'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('provider.add')));
      await tester.pumpAndSettle();
      final chip = find.byKey(const ValueKey('provider.chip.openai'));
      await tester.ensureVisible(chip);
      await tester.tap(chip);
      await tester.pumpAndSettle();
      final key = find.byKey(const ValueKey('provider.key'));
      await tester.ensureVisible(key);
      await tester.enterText(key, 'voice-secret');
      await tester.pump();
      final test = find.byKey(const ValueKey('provider.test'));
      await tester.ensureVisible(test);
      await tester.tap(test);
      await tester.pump();
      await http.lists.single.complete(tester, ['gpt-4.1']);
      await http.probes.single.callTool(tester);
      expect(native.saves, 1);
      expect((await settings.readApiKey())!.model, 'deepseek-flash');
      expect((await settings.readApiKey())!.key, 'chat-secret');
      final openai = await settings.credentials.resolve(
        'wss://api.openai.com/v1/realtime',
      );
      expect(openai!.key, 'voice-secret');
      expect(find.text('voice-secret'), findsNothing);
      expect(find.textContaining('当前模型未更改'), findsOneWidget);
      final raw = await const FlutterSecureStorage().read(
        key: ModelSettings.storageKey,
      );
      expect(jsonDecode(raw!)['key'], isNull);
    },
  );
  testWidgets(
    'opening key setup preserves ChatGPT and does not refresh its token',
    (tester) async {
      const storage = FlutterSecureStorage();
      final oauth = jsonEncode({
        'active': 'oaiapp_test',
        'accounts': [
          {
            'client_id': 'oaiapp_test',
            'access_token': 'oauth-secret',
            'model': 'chat',
          },
        ],
      });
      await storage.write(key: ChatGptAccounts.storageKey, value: oauth);
      final native = _Native();
      final settings = ModelSettings(native: native);
      final http = installModelHttp();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showProviderCredentials(
                  context,
                  settings.credentials,
                  modelSettings: settings,
                  onChanged: settings.refreshApiKeyProjection,
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(find.byType(ProviderSetupPage), findsOneWidget);
      expect(await storage.read(key: ChatGptAccounts.storageKey), oauth);
      expect(native.saves, 0);
      expect(http.lists, isEmpty);
      expect(http.probes, isEmpty);
      expect(find.text('oauth-secret'), findsNothing);
      await tester.pageBack();
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'editing the custom URL keeps a typed key for the same provider',
    (tester) async {
      tester.view.physicalSize = const Size(480, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final settings = ModelSettings(native: _Native());
      await settings.credentials.save(
        endpoint: 'https://api.example.test/v1',
        key: 'saved-secret',
      );
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
      await tester.ensureVisible(find.text('语音专用密钥'));
      await tester.tap(find.text('语音专用密钥'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('添加服务'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('credential.provider')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('自定义服务').last);
      await tester.pumpAndSettle();
      const endpoint = ValueKey('credential.endpoint');
      const secret = ValueKey('credential.secret');
      await tester.enterText(find.byKey(endpoint), 'https://api.other.test/v1');
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(secret), 'typed-secret');
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(endpoint), 'https://api.other.test/v2');
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byKey(secret)).controller!.text,
        'typed-secret',
        reason: 'The URL still belongs to the same unsaved provider.',
      );
      await tester.enterText(
        find.byKey(endpoint),
        'https://api.example.test/v1',
      );
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byKey(secret)).controller!.text,
        isEmpty,
        reason: 'A typed key must not carry over to another saved credential.',
      );
    },
  );
  testWidgets('central editor fits a small phone with large text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final settings = ModelSettings(native: _Native());
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
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
    await tester.scrollUntilVisible(
      find.text('语音专用密钥'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('语音专用密钥'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('添加服务'));
    await tester.tap(find.text('添加服务'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.enterText(
      find.byKey(const ValueKey('credential.secret')),
      'test-secret',
    );
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(await settings.credentials.list(), hasLength(1));
  });
}
