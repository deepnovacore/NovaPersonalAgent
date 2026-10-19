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
  PreviewWorkspace() : super(Directory('/unused-preview-workspace'));
  final opened = <String>[];
  @override
  Future<void> openPreview(String pathOrUrl) async {
    opened.add(pathOrUrl);
  }
}

void main() {
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
