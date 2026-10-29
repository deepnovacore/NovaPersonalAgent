import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/ui/provider_credentials_sheet.dart';

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
      await tester.tap(find.text('添加服务'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('credential.secret')),
        'voice-secret',
      );
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(native.saves, 1);
      expect((await settings.readApiKey())!.model, 'deepseek-flash');
      expect((await settings.readApiKey())!.key, 'chat-secret');
      final openai = await settings.credentials.resolve(
        'wss://api.openai.com/v1/realtime',
      );
      expect(openai!.key, 'voice-secret');
      await tester.tap(find.text('OpenAI'));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('credential.secret')),
      );
      expect(field.controller!.text, isEmpty);
      expect(field.obscureText, isTrue);
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect((await settings.credentials.get(openai.id))!.key, 'voice-secret');
      final raw = await const FlutterSecureStorage().read(
        key: ModelSettings.storageKey,
      );
      expect(jsonDecode(raw!)['key'], isNull);
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
