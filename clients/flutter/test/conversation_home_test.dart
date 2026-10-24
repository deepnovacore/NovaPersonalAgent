import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/conversation_home.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  testWidgets(
    'unsent conversations stay out of history until a message is saved',
    (tester) async {
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      final first = await store.create();
      await store.create();
      await store.create();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      addTearDown(host.dispose);
      Widget home() => MaterialApp(
        home: Scaffold(
          body: ConversationHome(host: host, onOpen: (_) {}, onNew: () {}),
        ),
      );
      await tester.pumpWidget(home());
      expect(find.text('新的对话'), findsNothing);
      expect(find.text('独立的事，在这里处理'), findsOneWidget);
      expect(store.conversations, hasLength(3));
      await store.append(first, {
        'role': 'user',
        'content': 'Synthetic first message',
      });
      await tester.pumpWidget(home());
      await tester.pump();
      expect(find.text('Synthetic first message'), findsWidgets);
      expect(find.byType(ListTile), findsOneWidget);
      expect(find.text('独立的事，在这里处理'), findsNothing);
      expect(store.conversations, hasLength(3));
      await tester.pumpWidget(const SizedBox());
    },
  );
}
