// Opt-in physical UI acceptance. Uses the installed app's original storage.
// Creates/reuses an unsent task; never sends a prompt or confirms an action.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_mobile/main.dart' as app;
import 'package:nova_mobile/ui/app.dart' show BottomAppBarTabs;
import 'package:nova_mobile/ui/conversation_home.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('original-data Nova and task navigation', (tester) async {
    app.main();
    for (
      var i = 0;
      i < 120 && find.byType(LocalChatPanel).evaluate().isEmpty;
      i++
    ) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(find.byType(LocalChatPanel), findsOneWidget);
    final main = tester.widget<LocalChatPanel>(find.byType(LocalChatPanel));
    expect(main.conversationId, ConversationStore.mainId);
    final original = main.host.store.conversations;
    if (Platform.isAndroid) await binding.convertFlutterSurfaceToImage();
    await binding.takeScreenshot('01-nova');

    Future<void> select(int index) async {
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump(const Duration(milliseconds: 500));
      final tabs = tester.widget<BottomAppBarTabs>(
        find.byType(BottomAppBarTabs),
      );
      final label = tabs.items[index].$3;
      await tester.tap(
        find.descendant(
          of: find.byType(BottomAppBarTabs),
          matching: find.text(label),
        ),
      );
      await tester.pump(const Duration(milliseconds: 600));
    }

    await tester.enterText(
      find.byType(TextField),
      'Navigation check — unsent main draft',
    );
    await select(1);
    expect(find.byType(ConversationHome), findsOneWidget);
    await binding.takeScreenshot('02-tasks');
    await tester.tap(
      find.descendant(
        of: find.byType(ConversationHome),
        matching: find.byType(FilledButton),
      ),
    );
    await tester.pump(const Duration(seconds: 1));
    final branch = tester.widget<LocalChatPanel>(find.byType(LocalChatPanel));
    expect(branch.conversationId, isNot(ConversationStore.mainId));
    await tester.enterText(
      find.byType(TextField),
      'Navigation check — unsent task draft',
    );
    await select(0);
    expect(find.text('Navigation check — unsent main draft'), findsOneWidget);
    await select(1);
    expect(find.text('Navigation check — unsent task draft'), findsOneWidget);
    await binding.takeScreenshot('03-task-draft');
    await select(2);
    await binding.takeScreenshot('04-timeline');
    await select(3);
    await binding.takeScreenshot('05-me');
    for (final row in original) {
      expect(
        main.host.store.conversation(row['id'])['messages'],
        row['messages'],
      );
    }
    // Clear only the two acceptance drafts; no persisted messages are deleted.
    await select(1);
    await tester.enterText(find.byType(TextField), '');
    await select(0);
    await tester.enterText(find.byType(TextField), '');
    binding.reportData = {
      ...?binding.reportData,
      'original_data': true,
      'main_id': ConversationStore.mainId,
      'existing_conversations_preserved': original.length,
      'prompts_submitted_by_test': 0,
      'checked': [
        'main_identity',
        'task_navigation',
        'draft_isolation',
        'timeline',
        'me',
      ],
      'not_checked': [
        'process_restart',
        'live_voice',
        'model_execution',
        'todo_live_action',
      ],
    };
    expect(tester.takeException(), isNull);
  });
}
