import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/chatgpt_accounts.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/ui/chatgpt_settings.dart';
import 'package:nova_mobile/ui/components.dart';
import 'package:nova_mobile/ui/theme.dart';

class _Settings extends ModelSettings {
  _Settings(this._accounts);
  final ChatGptAccounts _accounts;
  @override
  ChatGptAccounts get chatGpt => _accounts;
  var nativeClears = 0;

  @override
  Future<void> clearNativeChatGpt() async => nativeClears++;
}

class _FailingSignIn extends ChatGptAccounts {
  _FailingSignIn(this.failure);
  final Object failure;

  @override
  Future<void> signIn({String? clientId, bool enablePlan = false}) async {
    throw failure;
  }
}

Future<void> _open(WidgetTester tester, _Settings settings) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showChatGptSettings(context, settings),
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
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'local sign-out retains unconfirmed revocation guidance as a warning',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({
        ChatGptAccounts.storageKey: jsonEncode({
          'active': 'test-client',
          'accounts': [
            {
              'client_id': 'test-client',
              'email': 'a@example.com',
              'access_token': 'test-access-token',
              'refresh_token': 'test-refresh-token',
            },
          ],
        }),
      });
      final accounts = ChatGptAccounts(
        request: (uri, {form, bearer}) async {
          throw StateError('raw-network-error-with-test-secret');
        },
      );
      final settings = _Settings(accounts);
      await _open(tester, settings);
      await tester.tap(find.byType(PopupMenuButton<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('退出此账号'));
      await tester.pumpAndSettle();

      final notice = tester.widget<NovaNotice>(find.byType(NovaNotice));
      expect(notice.text, '已在本机退出，远程撤销未确认。可在 ChatGPT 设置中断开应用。');
      expect(notice.tone, NovaTone.warning);
      expect(find.text('需要重新登录'), findsOneWidget);
      expect(settings.nativeClears, 1);
      final stored = await accounts.active();
      expect(stored!['access_token'], isNull);
      expect(stored['refresh_token'], isNull);
      expect(find.textContaining('raw-network-error'), findsNothing);
    },
  );

  for (final failure in [
    const AgentFailure('raw-provider-error-with-test-secret'),
    StateError('raw-exception-with-test-secret'),
  ]) {
    testWidgets('unexpected ${failure.runtimeType} stays sanitized', (
      tester,
    ) async {
      await _open(tester, _Settings(_FailingSignIn(failure)));
      await tester.tap(find.text('Continue with ChatGPT'));
      await tester.pumpAndSettle();

      final notice = tester.widget<NovaNotice>(find.byType(NovaNotice));
      expect(notice.text, '操作没有完成，请重试。');
      expect(notice.tone, NovaTone.danger);
      expect(find.textContaining('test-secret'), findsNothing);
    });
  }
}
