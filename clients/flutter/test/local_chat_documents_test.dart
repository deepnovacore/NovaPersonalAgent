import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'scheduled_agent_runner_test.dart' show FixtureSettings;

class DocumentHost extends AgentCoreHost {
  DocumentHost(ConversationStore store, ToolRunner runner)
    : super(store: store, settings: FixtureSettings(), tools: runner);
  bool reject = false;
  bool authorProvided = false;
  @override
  Future<void> send(
    String conversationId,
    String text, {
    ToolApproval? approve,
    String? language,
    bool userAuthored = true,
    Future<ModelConfiguration> Function()? authorModel,
  }) async {
    authorProvided = authorModel != null;
    if (reject) {
      error = 'model_settings_required';
      return;
    }
    await store.append(conversationId, {'role': 'user', 'content': text});
  }
}

void main() {
  testWidgets(
    'author text rejects attached draft and forwards only foreground text',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      final host = DocumentHost(
        store,
        ToolRunner(
          registry: ToolRegistry(
            snapshot: () => {},
            mutate: (_, {required operationId}) async => {},
            hasConflict: () => false,
            fetch: (_) async => {},
            workspace: AgentWorkspace(Directory('/unused')),
          ),
          journal: ToolJournal(MemoryPersistence()),
        ),
      );
      final key = GlobalKey<LocalChatPanelState>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              key: key,
              host: host,
              conversationId: id,
              language: 'en',
              authorModel: () async => ModelConfiguration(
                endpoint: 'https://example.test',
                model: 'author',
                key: 'temporary',
              ),
            ),
          ),
        ),
      );
      key.currentState!.attachmentDrafts[id] = [
        {'path': '/workspace/inbox/private.txt'},
      ];
      key.currentState!.prefill('Hello');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      expect(store.conversation(id)['messages'], isEmpty);
      expect(
        find.text(
          'Remove the attachments or switch back under Redeem experience code.',
        ),
        findsOneWidget,
      );
      expect(key.currentState!.input.text, 'Hello');
      key.currentState!.attachmentDrafts[id]!.clear();
      key.currentState!.prefill('Hello');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      expect(host.authorProvided, isTrue);
      expect(
        (store.conversation(id)['messages'] as List).single['content'],
        'Hello',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      host.dispose();
    },
  );

  testWidgets(
    'attachment chips stay with the draft and send workspace references',
    (tester) async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final first = await store.create(), second = await store.create();
      final host = DocumentHost(
        store,
        ToolRunner(
          registry: ToolRegistry(
            snapshot: () => {},
            mutate: (_, {required operationId}) async => {},
            hasConflict: () => false,
            fetch: (_) async => {},
            workspace: AgentWorkspace(Directory('/unused')),
          ),
          journal: ToolJournal(MemoryPersistence()),
        ),
      );
      final key = GlobalKey<LocalChatPanelState>();
      Widget panel(String id) => MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            key: key,
            host: host,
            conversationId: id,
            language: 'en',
          ),
        ),
      );
      await tester.pumpWidget(panel(first));
      key.currentState!.attachmentDrafts[first] = [
        {'path': '/workspace/inbox/test/sales.xlsx'},
      ];
      await tester.pumpWidget(panel(second));
      expect(find.byType(InputChip), findsNothing);
      await tester.pumpWidget(panel(first));
      expect(find.widgetWithText(InputChip, 'sales.xlsx'), findsOneWidget);
      host.reject = true;
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      expect(key.currentState!.attachments, hasLength(1));
      host.reject = false;
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      final messages = store.conversation(first)['messages'] as List;
      expect(
        messages.last['content'],
        contains('/workspace/inbox/test/sales.xlsx'),
      );
      expect(key.currentState!.attachments, isEmpty);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );

  testWidgets('attachment chip can be removed without sending', (tester) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final host = AgentCoreHost(store: store, settings: FixtureSettings());
    final key = GlobalKey<LocalChatPanelState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(key: key, host: host, conversationId: id),
        ),
      ),
    );
    key.currentState!.attachmentDrafts[id] = [
      {'path': '/workspace/inbox/test/paper.pdf'},
    ];
    key.currentState!.prefill('Read this');
    await tester.pump();
    final chip = tester.widget<InputChip>(find.byType(InputChip));
    chip.onDeleted!();
    await tester.pump();
    expect(find.byType(InputChip), findsNothing);
    expect(key.currentState!.input.text, 'Read this');
    expect(store.conversation(id)['messages'], isEmpty);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
}
