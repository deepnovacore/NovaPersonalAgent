import 'package:flutter/material.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/ui/app.dart';
import 'phone_voice_app_test.dart' show openChat;

Future<void> tab(WidgetTester tester, String label) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
  await tester.tap(
    find.descendant(
      of: find.byType(BottomAppBarTabs),
      matching: find.text(label),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'todo action opens one task draft and discuss preserves Nova text',
    (tester) async {
      final repo = LocalLife(MemoryLifePersistence());
      await repo.open();
      await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Prepare review',
        'note': 'Keep evidence',
      });
      final fixture = await openChat(
        tester,
        lifeHost: LifeHost(repository: repo),
      );
      await tab(tester, 'Timeline');
      await tester.tap(find.byTooltip('Work on this'));
      await tester.pumpAndSettle();
      final task = tester
          .widget<LocalChatPanel>(find.byType(LocalChatPanel))
          .conversationId;
      expect(task, isNot('chat:main'));
      expect(fixture.host.store.conversation(task)['messages'], isEmpty);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        contains('Keep evidence'),
      );
      await tester.enterText(find.byType(TextField), 'My edited task draft');
      await tab(tester, 'Timeline');
      await tester.tap(find.text('Prepare review'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Work on this'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<LocalChatPanel>(find.byType(LocalChatPanel))
            .conversationId,
        task,
      );
      expect(find.text('My edited task draft'), findsOneWidget);
      expect(fixture.host.store.conversations, hasLength(2));
      await tab(tester, 'Timeline');
      await tester.tap(find.text('Prepare review'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Discuss in chat'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<LocalChatPanel>(find.byType(LocalChatPanel))
            .conversationId,
        'chat:main',
      );
      final text = tester
          .widget<TextField>(find.byType(TextField))
          .controller!
          .text;
      expect(text, contains('Keep this unsent draft'));
      expect(text, contains('Prepare review'));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'Nova is durable home; task drafts and Me destinations stay separate',
    (tester) async {
      final fixture = await openChat(tester);
      expect(
        tester
            .widget<LocalChatPanel>(find.byType(LocalChatPanel))
            .conversationId,
        'chat:main',
      );
      expect(find.text('New chat'), findsNothing);
      await tab(tester, 'Tasks');
      await tester.tap(find.widgetWithText(FilledButton, 'New task'));
      await tester.pumpAndSettle();
      final task = tester
          .widget<LocalChatPanel>(find.byType(LocalChatPanel))
          .conversationId;
      expect(task, isNot('chat:main'));
      await tester.enterText(find.byType(TextField), 'Task draft');
      await tab(tester, 'Nova');
      expect(find.text('Keep this unsent draft'), findsOneWidget);
      await tab(tester, 'Tasks');
      expect(find.text('Task draft'), findsOneWidget);
      await tester.tap(find.byTooltip('All tasks'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'New task'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<LocalChatPanel>(find.byType(LocalChatPanel))
            .conversationId,
        task,
      );
      expect(fixture.host.store.conversations, hasLength(2));
      await tab(tester, 'Me');
      for (final label in ['Profile', 'Goals', 'Settings']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
