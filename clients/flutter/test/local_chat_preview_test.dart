import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'scheduled_agent_runner_test.dart' show FixtureSettings;

class PreviewWorkspace extends AgentWorkspace {
  PreviewWorkspace({this.failToOpen = false})
    : super(Directory('/unused-preview-workspace'));
  final bool failToOpen;
  final opened = <String>[];
  @override
  Future<void> openPreview(String pathOrUrl) async {
    opened.add(pathOrUrl);
    if (failToOpen) throw StateError('Preview unavailable');
  }
}

void main() {
  for (final content in [
    '`nova-file:///workspace/counter.html`',
    '[counter.html](nova-file:///workspace/counter.html)',
  ]) {
    testWidgets('preview failure shows a notice when tapping $content', (
      tester,
    ) async {
      final workspace = PreviewWorkspace(failToOpen: true);
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      await store.append(id, {'role': 'assistant', 'content': content});
      final host = AgentCoreHost(
        store: store,
        settings: FixtureSettings(),
        tools: ToolRunner(
          registry: ToolRegistry(
            snapshot: () => {},
            mutate: (input, {required operationId}) async => {},
            hasConflict: () => false,
            fetch: (_) async => {},
            workspace: workspace,
          ),
          journal: ToolJournal(MemoryPersistence()),
        ),
      );
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
      await tester.pumpAndSettle();
      await tester.tap(find.text('counter.html'));
      await tester.pumpAndSettle();
      expect(workspace.opened, ['nova-file:///workspace/counter.html']);
      expect(tester.takeException(), isNull);
      expect(
        find.text('Could not open this artifact. Try again.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    });
  }

  testWidgets('stored assistant code URLs open the workspace preview', (
    tester,
  ) async {
    final workspace = PreviewWorkspace();
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    await store.append(id, {
      'role': 'assistant',
      'content': '打开计数器：`nova-file:///workspace/counter.html`',
    });
    final host = AgentCoreHost(
      store: store,
      settings: FixtureSettings(),
      tools: ToolRunner(
        registry: ToolRegistry(
          snapshot: () => {},
          mutate: (input, {required operationId}) async => {},
          hasConflict: () => false,
          fetch: (_) async => {},
          workspace: workspace,
        ),
        journal: ToolJournal(MemoryPersistence()),
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(host: host, conversationId: id, language: 'zh'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, 'counter.html'));
    await tester.pumpAndSettle();
    expect(workspace.opened, ['nova-file:///workspace/counter.html']);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });

  testWidgets(
    'new HTML files and stored legacy artifacts render working preview cards',
    (tester) async {
      final workspace = PreviewWorkspace();
      final registry = ToolRegistry(
        snapshot: () => {},
        mutate: (input, {required operationId}) async => {},
        hasConflict: () => false,
        fetch: (_) async => {},
        workspace: workspace,
      );
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      for (final data in [
        {
          'path': '/workspace/game/index.html',
          'bytes': 100,
          'url': 'nova-file:///workspace/game/index.html',
        },
        {
          'artifact': {'id': 'legacy-id', 'title': 'Old game'},
        },
        {
          'path': '/workspace/check.py',
          'bytes': 10,
          'url': 'nova-file:///workspace/check.py',
        },
      ]) {
        await store.append(id, {
          'role': 'tool',
          'content': jsonEncode({'status': 'completed', 'data': data}),
        });
      }
      final host = AgentCoreHost(
        store: store,
        settings: FixtureSettings(),
        tools: ToolRunner(
          registry: registry,
          journal: ToolJournal(MemoryPersistence()),
        ),
      );
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
      await tester.pumpAndSettle();
      expect(find.text('Saved · Tap to open'), findsNWidgets(2));
      await tester.tap(find.text('index.html'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Old game'));
      await tester.pumpAndSettle();
      expect(workspace.opened, [
        'nova-file:///workspace/game/index.html',
        'legacy-id',
      ]);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );
}
