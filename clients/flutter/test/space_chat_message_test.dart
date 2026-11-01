import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/chat_message.dart';

void main() {
  test(
    'closed failure reasons render advice and redact legacy provider errors',
    () {
      for (final entry in {
        'authentication': '认证失败',
        'quota': '额度不足',
        'rate_limited': '请求过于频繁',
        'network': '无法连接模型服务',
        'timeout': '回复超时',
        'output_limit': '输出限制',
        'configuration': '尚未配置',
      }.entries) {
        final text = spaceChatStatusText({
          'role': 'assistant',
          'status': 'failed',
          'error': entry.key,
        });
        expect(text, contains(entry.value));
        expect(text, contains('手动重试'));
      }
      for (final error in [null, 'sk-secret https://private.example']) {
        final text = spaceChatStatusText({
          'role': 'assistant',
          'status': 'failed',
          'error': error,
        });
        expect(text, contains('模型未能完成回复'));
        expect(text, isNot(contains('sk-secret')));
      }
      expect(
        spaceChatStatusText({
          'role': 'user',
          'status': 'failed',
          'failure_reason': 'network',
        }),
        contains('无法连接模型服务'),
      );
    },
  );
  testWidgets('manual retry requires an explicit tap', (tester) async {
    var retries = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: SpaceChatMessage(
          message: const {'role': 'assistant', 'status': 'failed'},
          onRetry: () {
            retries++;
          },
        ),
      ),
    );
    expect(retries, 0);
    await tester.tap(find.text('手动重试'));
    expect(retries, 1);
  });
  testWidgets(
    'empty interrupted cancelled failed and rejected chats have visible terminal explanations',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              children: [
                for (final status in ['interrupted', 'cancelled', 'failed'])
                  SpaceChatMessage(
                    message: {
                      'role': 'assistant',
                      'status': status,
                      'text': '',
                    },
                  ),
                const SpaceChatMessage(
                  message: {
                    'role': 'user',
                    'status': 'failed',
                    'error': 'conversation_busy',
                    'text': 'Second message',
                  },
                ),
              ],
            ),
          ),
        ),
      );
      expect(find.textContaining('Host 重启或执行中断'), findsOneWidget);
      expect(find.text('回复已取消。'), findsOneWidget);
      expect(find.textContaining('模型未能完成回复'), findsOneWidget);
      expect(find.textContaining('本条未被接受'), findsOneWidget);
    },
  );
}
