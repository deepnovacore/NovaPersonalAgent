import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'package:nova_mobile/ui/tool_timeline.dart';
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
    'only the latest saved preview per target and user turn is shown',
    (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final workspace = PreviewWorkspace();
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      await store.append(id, {'role': 'user', 'content': 'Build a game'});
      for (final (step, name) in [
        'file_write',
        'file_edit',
        'file_edit',
        'file_read',
      ].indexed) {
        await store.append(id, {
          'role': 'tool',
          'tool_name': name,
          'content': jsonEncode({
            'status': 'completed',
            'data': {
              'path': '/workspace/index.html',
              'url': 'nova-file:///workspace/index.html',
            },
          }),
        });
        if (step == 1) {
          await store.append(id, {
            'role': 'assistant',
            'content': 'First edit checked',
          });
        }
      }
      await store.append(id, {
        'role': 'tool',
        'tool_name': 'file_write',
        'content': jsonEncode({
          'status': 'completed',
          'data': {
            'path': '/workspace/other.html',
            'url': 'nova-file:///workspace/other.html',
          },
        }),
      });
      await store.append(id, {
        'role': 'tool',
        'tool_name': 'file_read',
        'content': jsonEncode({
          'status': 'completed',
          'data': {
            'path': '/workspace/read-only.html',
            'url': 'nova-file:///workspace/read-only.html',
          },
        }),
      });
      await store.append(id, {'role': 'user', 'content': 'Update the game'});
      for (final status in ['completed', 'rejected']) {
        await store.append(id, {
          'role': 'tool',
          'tool_name': 'file_edit',
          'content': jsonEncode({
            'status': status,
            'data': {
              'path': '/workspace/index.html',
              'url': 'nova-file:///workspace/index.html',
            },
          }),
        });
      }
      final originalMessages = jsonEncode(store.conversation(id)['messages']);
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
      expect(find.text('index.html'), findsNWidgets(2));
      expect(
        tester.getTopLeft(find.text('index.html').first).dy,
        greaterThan(
          tester
              .getBottomLeft(
                find.text('First edit checked', findRichText: true),
              )
              .dy,
        ),
      );
      // Saved-page cards sit after their run and no longer split it.
      expect(find.byType(ExpansionTile), findsNothing);
      expect(find.byType(ToolTimeline), findsNWidgets(3));
      expect(
        tester
            .widgetList<ToolStepGroup>(find.byType(ToolStepGroup))
            .map((group) => group.steps.length),
        [2, 4, 2],
      );
      expect(find.text('other.html'), findsOneWidget);
      expect(find.text('read-only.html'), findsNothing);
      expect(find.text('Saved · Tap to open'), findsNWidgets(3));
      await tester.tap(find.text('index.html').last);
      await tester.pumpAndSettle();
      expect(workspace.opened, ['nova-file:///workspace/index.html']);
      expect(jsonEncode(store.conversation(id)['messages']), originalMessages);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
    },
  );

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

  testWidgets('a saved page keeps its step in the run, card after the group', (
    tester,
  ) async {
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
    await store.append(id, {'role': 'user', 'content': 'build it'});
    for (final (call, name, data) in [
      ('a', 'file_read', <String, Object?>{}),
      (
        'b',
        'file_write',
        <String, Object?>{
          'path': '/workspace/index.html',
          'url': 'nova-file:///workspace/index.html',
        },
      ),
      ('c', 'shell_execute', <String, Object?>{}),
    ]) {
      await store.append(id, {
        'role': 'assistant',
        'content': '',
        'tool_calls': [
          {
            'id': call,
            'function': {'name': name, 'arguments': '{}'},
          },
        ],
      });
      await store.append(id, {
        'role': 'tool',
        'tool_name': name,
        'tool_call_id': call,
        'content': jsonEncode({'status': 'completed', 'data': data}),
      });
    }
    final host =
        AgentCoreHost(
            store: store,
            settings: FixtureSettings(),
            tools: ToolRunner(
              registry: registry,
              journal: ToolJournal(MemoryPersistence()),
            ),
          )
          ..busy = true
          ..activeConversationId = id;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(host: host, conversationId: id, language: 'en'),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));
    final group = tester.widget<ToolStepGroup>(find.byType(ToolStepGroup));
    expect(group.steps.map((step) => step.name), [
      'file_read',
      'file_write',
      'shell_execute',
    ]);
    expect(group.running, isTrue);
    expect(find.text('Saved · Tap to open'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Saved · Tap to open')).dy,
      greaterThan(tester.getBottomLeft(find.byType(ToolStepGroup)).dy),
    );
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
}
