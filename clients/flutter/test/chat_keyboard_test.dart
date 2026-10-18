import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'agent_core_test.dart' show MemoryPersistence;

void main() {
  testWidgets(
    'tapping chat blank space dismisses keyboard without losing the draft',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: id,

              language: 'en',
            ),
          ),
        ),
      );
      await tester.enterText(find.byType(TextField), 'keep draft');
      await tester.showKeyboard(find.byType(TextField));
      expect(tester.testTextInput.isVisible, true);
      await tester.tap(find.text('Start here.'));
      await tester.pump();
      expect(tester.testTextInput.isVisible, false);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'keep draft',
      );
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );
}
