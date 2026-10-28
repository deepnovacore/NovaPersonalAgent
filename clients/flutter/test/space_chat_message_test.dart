import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/chat_message.dart';

void main() {
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
      expect(find.text('Host 未能完成回复。'), findsOneWidget);
      expect(find.textContaining('本条未被接受'), findsOneWidget);
    },
  );
}
