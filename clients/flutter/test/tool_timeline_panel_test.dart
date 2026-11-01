import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/thinking_block.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'agent_core_test.dart' show MemoryPersistence;

Future<(ConversationStore, String)> _openStore() async {
  final store = ConversationStore(MemoryPersistence());
  await store.open();
  return (store, await store.create());
}

Future<void> _plan(
  ConversationStore store,
  String id,
  String reasoning,
  String callId,
  String name,
  Map<String, Object?> arguments, {
  String content = '',
}) => store.append(id, {
  'role': 'assistant',
  'content': content,
  'reasoning_content': reasoning,
  'tool_calls': [
    {
      'id': callId,
      'function': {'name': name, 'arguments': jsonEncode(arguments)},
    },
  ],
});

Future<void> _result(
  ConversationStore store,
  String id,
  String callId,
  String name, [
  String status = 'completed',
]) => store.append(id, {
  'role': 'tool',
  'tool_name': name,
  'tool_call_id': callId,
  'content': jsonEncode({'status': status, 'data': {}}),
});

Future<AgentCoreHost> _pump(
  WidgetTester tester,
  ConversationStore store,
  String id, {
  bool running = false,
}) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final host = AgentCoreHost(store: store, settings: ModelSettings());
  if (running) {
    host
      ..busy = true
      ..activeConversationId = id;
  }
  addTearDown(host.dispose);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: LocalChatPanel(host: host, conversationId: id),
      ),
    ),
  );
  // A running chat shows a looping activity pill, which never settles.
  await tester.pump(const Duration(milliseconds: 50));
  return host;
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('reasoning-only messages do not split one run into groups', (
    tester,
  ) async {
    final (store, id) = await _openStore();
    await store.append(id, {'role': 'user', 'content': 'go'});
    await _plan(store, id, 'first idea', 'a', 'file_read', {});
    await _result(store, id, 'a', 'file_read');
    await _plan(store, id, 'second idea', 'b', 'file_edit', {});
    await _result(store, id, 'b', 'file_edit');
    await store.append(id, {'role': 'assistant', 'content': 'done'});
    final original = jsonEncode(store.conversation(id)['messages']);
    await _pump(tester, store, id);
    final groups = tester.widgetList<ToolStepGroup>(find.byType(ToolStepGroup));
    expect(groups, hasLength(1));
    expect(groups.single.steps.map((step) => step.name), [
      'file_read',
      'file_edit',
    ]);
    expect(groups.single.steps.map((step) => step.narration), [
      'first idea',
      'second idea',
    ]);
    expect(find.byType(ThinkingBlock), findsNothing);
    expect(find.textContaining('做了 2 步'), findsOneWidget);
    // The model's sentence is the row title; tapping a row reveals its text.
    await tester.tap(find.textContaining('做了 2 步'));
    await tester.pumpAndSettle();
    expect(find.text('first idea'), findsOneWidget);
    expect(find.text('second idea'), findsOneWidget);
    expect(jsonEncode(store.conversation(id)['messages']), original);
  });

  testWidgets('visible assistant text and user messages still end a run', (
    tester,
  ) async {
    final (store, id) = await _openStore();
    await store.append(id, {'role': 'user', 'content': 'go'});
    await _plan(store, id, 'idea', 'a', 'file_read', {});
    await _result(store, id, 'a', 'file_read');
    await _plan(
      store,
      id,
      'again',
      'b',
      'file_edit',
      {},
      content: 'Visible explanation',
    );
    await _result(store, id, 'b', 'file_edit');
    await _pump(tester, store, id);
    expect(find.byType(ToolStepGroup), findsNWidgets(2));
  });

  testWidgets('reasoning with no tool after it stays a thinking block', (
    tester,
  ) async {
    final (store, id) = await _openStore();
    await store.append(id, {'role': 'user', 'content': 'go'});
    await _plan(store, id, 'idea', 'a', 'file_read', {});
    await _result(store, id, 'a', 'file_read');
    await store.append(id, {
      'role': 'assistant',
      'content': '',
      'reasoning_content': 'closing thought',
    });
    await _pump(tester, store, id);
    expect(find.byType(ThinkingBlock), findsOneWidget);
  });

  testWidgets('consecutive reads of one file merge using safe targets', (
    tester,
  ) async {
    final (store, id) = await _openStore();
    await store.append(id, {'role': 'user', 'content': 'go'});
    for (final call in ['a', 'b']) {
      await _plan(store, id, '', call, 'file_read', {
        'path': '/workspace/secret-dir/notes.txt',
      });
      await _result(store, id, call, 'file_read');
    }
    await _plan(store, id, '', 'c', 'web_fetch', {
      'url': 'https://example.com/private?token=1',
    });
    await _result(store, id, 'c', 'web_fetch');
    await _pump(tester, store, id);
    await tester.tap(find.textContaining('做了 2 步'));
    await tester.pumpAndSettle();
    expect(find.text('读取文件 · notes.txt · 2 次'), findsOneWidget);
    expect(find.text('读取网页 · example.com'), findsOneWidget);
    expect(find.textContaining('secret-dir'), findsNothing);
    expect(find.textContaining('token'), findsNothing);
  });

  testWidgets('a running run keeps its rail while only planning follows', (
    tester,
  ) async {
    final (store, id) = await _openStore();
    await store.append(id, {'role': 'user', 'content': 'go'});
    for (var i = 0; i < 7; i++) {
      await _plan(store, id, 'idea $i', 'c$i', 'shell_execute', {});
      await _result(store, id, 'c$i', 'shell_execute');
    }
    // The next tool is being planned: reasoning is stored, no result yet.
    await _plan(store, id, 'idea 7', 'c7', 'shell_execute', {});
    await _pump(tester, store, id, running: true);
    final group = tester.widget<ToolStepGroup>(find.byType(ToolStepGroup));
    expect(group.running, isTrue);
    expect(find.text('更早的 2 步'), findsOneWidget);
    expect(find.textContaining('做了'), findsNothing);
    await tester.tap(find.text('更早的 2 步'));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('更早的 2 步'), findsNothing);
    expect(find.text('idea 0'), findsOneWidget);
  });

  testWidgets('a finished run collapses to one line', (tester) async {
    final (store, id) = await _openStore();
    await store.append(id, {'role': 'user', 'content': 'go'});
    for (var i = 0; i < 3; i++) {
      await _plan(store, id, 'idea $i', 'c$i', 'shell_execute', {});
      await _result(store, id, 'c$i', 'shell_execute');
    }
    await store.append(id, {'role': 'assistant', 'content': 'all done'});
    await _pump(tester, store, id);
    expect(
      tester.widget<ToolStepGroup>(find.byType(ToolStepGroup)).running,
      isFalse,
    );
    expect(find.textContaining('做了 3 步'), findsOneWidget);
    expect(find.text('idea 0'), findsNothing);
  });
}
