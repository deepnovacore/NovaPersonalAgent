import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/chat_activity.dart';
import 'package:nova_mobile/ui/thinking_block.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'agent_chat_test.dart' show FakeNative;

class ReasoningModel extends ModelClient {
  final requests = <List<Map<String, dynamic>>>[];
  int calls = 0;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    requests.add(messages);
    calls++;
    yield {'reasoning': '第一段'};
    yield {'reasoning': '\n第二段'};
    yield {'content': '答案'};
  }
}

class FailingReasoningModel extends ModelClient {
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    yield {'reasoning': '思考一半'};
    throw const AgentFailure('model_timeout');
  }
}

class ToolReasoningModel extends ModelClient {
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    yield {'reasoning': '先规划工具'};
    yield {
      'tool_calls': [
        {
          'index': 0,
          'id': 'call-1',
          'function': {'name': 'file_read', 'arguments': '{}'},
        },
      ],
    };
  }
}

class StreamingReasoningModel extends ModelClient {
  final streaming = Completer<void>();
  final gate = Completer<void>();
  int calls = 0;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    if (calls++ > 0) {
      yield {'content': '完成'};
      return;
    }
    yield {'reasoning': '第一步'};
    yield {'reasoning': '\n第二步'};
    streaming.complete();
    await gate.future;
    yield {'content': '最终回答'};
  }
}

class ReplacingReasoningModel extends ModelClient {
  int calls = 0;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    final call = calls++;
    yield {'reasoning': call == 0 ? '增量' : '预览'};
    if (call == 0) {
      yield {'_nova_replace': true, 'content': '答案一'};
      return;
    }
    yield {
      '_nova_replace': true,
      'content': '答案二',
      'reasoning_content': '完整思考',
    };
  }
}

Future<void> _pumpPanel(WidgetTester tester, AgentCoreHost host, String id) {
  return tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: LocalChatPanel(host: host, conversationId: id)),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('DeepSeek turns store and replay their reasoning', () async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final settings = ModelSettings(native: FakeNative());
    await settings.save(
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-reasoner',
      key: 'secret',
    );
    final model = ReasoningModel();
    final host = AgentCoreHost(
      store: store,
      settings: settings,
      clientFactory: () => model,
    );
    addTearDown(host.dispose);
    await host.send(id, 'first');
    expect(host.error, isNull);
    final messages = store.conversation(id)['messages'] as List;
    expect(messages.last['role'], 'assistant');
    expect(messages.last['content'], '答案');
    expect(messages.last['reasoning_content'], '第一段\n第二段');
    // The live copy is cleared when the turn ends; the stored turn keeps it.
    expect(host.reasoning, isEmpty);
    await host.send(id, 'second');
    expect(model.requests, hasLength(2));
    final replayed = model.requests[1].firstWhere(
      (message) => message['role'] == 'assistant',
    );
    expect(replayed['content'], '答案');
    expect(replayed['reasoning_content'], '第一段\n第二段');
  });

  test('non-DeepSeek requests strip stored reasoning from the wire', () async {
    // Widget tests mock live HTTP; this test needs a real loopback server.
    final previous = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = previous);
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final bodies = <Map<String, dynamic>>[];
    server.listen((request) async {
      final body =
          jsonDecode(await utf8.decoder.bind(request).join())
              as Map<String, dynamic>;
      bodies.add(body);
      request.response.headers.contentType = ContentType(
        'text',
        'event-stream',
      );
      for (final event in [
        {
          'choices': [
            {
              'delta': {'reasoning_content': '打算'},
            },
          ],
        },
        {
          'choices': [
            {
              'delta': {'content': '回答'},
            },
          ],
        },
      ]) {
        // HttpResponse defaults to latin1; encode the SSE bytes explicitly.
        request.response.add(utf8.encode('data: ${jsonEncode(event)}\n\n'));
      }
      request.response.add(utf8.encode('data: [DONE]\n\n'));
      await request.response.close();
    });
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final settings = ModelSettings(native: FakeNative());
    await settings.save(
      endpoint: 'http://127.0.0.1:${server.port}',
      model: 'm',
      key: 'secret',
    );
    final host = AgentCoreHost(store: store, settings: settings);
    addTearDown(host.dispose);
    await host.send(id, 'first');
    expect(host.error, isNull);
    final stored = (store.conversation(id)['messages'] as List).last as Map;
    expect(stored['content'], '回答');
    expect(stored['reasoning_content'], '打算');
    await host.send(id, 'second');
    expect(bodies, hasLength(2));
    final history = bodies[1]['messages'] as List;
    final assistant = history.firstWhere(
      (message) => message is Map && message['role'] == 'assistant',
    ) as Map;
    expect(assistant['content'], '回答');
    expect(assistant.containsKey('reasoning_content'), false);
    expect(assistant.containsKey('reasoning'), false);
  });

  test('interrupted turns keep their partial reasoning', () async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final settings = ModelSettings(native: FakeNative());
    await settings.save(
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-reasoner',
      key: 'secret',
    );
    final host = AgentCoreHost(
      store: store,
      settings: settings,
      clientFactory: FailingReasoningModel.new,
    );
    addTearDown(host.dispose);
    await host.send(id, 'first');
    expect(host.error, 'model_timeout');
    final last = (store.conversation(id)['messages'] as List).last as Map;
    expect(last['role'], 'assistant');
    expect(last['interrupted'], true);
    expect(last['reasoning_content'], '思考一半');
  });

  test('tool-call assistant turns persist their reasoning', () async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final settings = ModelSettings(native: FakeNative());
    await settings.save(
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-reasoner',
      key: 'secret',
    );
    final host = AgentCoreHost(
      store: store,
      settings: settings,
      clientFactory: ToolReasoningModel.new,
    );
    addTearDown(host.dispose);
    await host.send(id, 'do it');
    final messages = store.conversation(id)['messages'] as List;
    final assistant = messages.firstWhere(
      (message) =>
          message is Map &&
          message['role'] == 'assistant' &&
          message['tool_calls'] != null,
    ) as Map;
    expect(assistant['reasoning_content'], '先规划工具');
  });

  test('native replacement frames replace reasoning without losing previews', () async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final settings = ModelSettings(native: FakeNative());
    await settings.save(
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-reasoner',
      key: 'secret',
    );
    final model = ReplacingReasoningModel();
    final host = AgentCoreHost(
      store: store,
      settings: settings,
      clientFactory: () => model,
    );
    addTearDown(host.dispose);
    await host.send(id, 'first');
    // A replacement without final reasoning keeps the incremental preview.
    var last = (store.conversation(id)['messages'] as List).last as Map;
    expect(last['content'], '答案一');
    expect(last['reasoning_content'], '增量');
    await host.send(id, 'second');
    // A replacement with final reasoning installs it instead of appending.
    last = (store.conversation(id)['messages'] as List).last as Map;
    expect(last['content'], '答案二');
    expect(last['reasoning_content'], '完整思考');
  });

  test('checkpoint recovery restores partial reasoning', () async {
    final persistence = MemoryPersistence();
    final store = ConversationStore(persistence);
    await store.open();
    final id = await store.create();
    await store.append(id, {'role': 'user', 'content': '问题'});
    await store.checkpointTurn(id, {
      'draft': '半句',
      'reasoning': '思考一半',
      'tool': null,
      'characters': 0,
      'units': 0,
    });
    final restored = ConversationStore(persistence);
    await restored.open();
    final last = (restored.conversation(id)['messages'] as List).last as Map;
    expect(last['role'], 'assistant');
    expect(last['content'], '半句');
    expect(last['reasoning_content'], '思考一半');
    expect(last['interrupted'], true);
  });

  testWidgets('persisted thinking is collapsed until tapped', (tester) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    await store.append(id, {'role': 'user', 'content': '帮我看看'});
    await store.append(id, {
      'role': 'assistant',
      'content': '这是答案',
      'reasoning_content': '先分析问题\n再检查边界\n最后写答案',
    });
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    await _pumpPanel(tester, host, id);
    await tester.pumpAndSettle();
    expect(find.byType(ThinkingBlock), findsOneWidget);
    expect(find.text('思考'), findsOneWidget);
    // Collapsed by default: only the last line summary is visible.
    expect(find.text('最后写答案'), findsOneWidget);
    expect(find.textContaining('先分析问题', findRichText: true), findsNothing);
    await tester.tap(find.byTooltip('查看思考过程'));
    await tester.pumpAndSettle();
    expect(find.textContaining('先分析问题', findRichText: true), findsOneWidget);
    expect(find.byTooltip('收起思考过程'), findsOneWidget);
  });

  testWidgets('tool-call turns show their thinking instead of hiding', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    await store.append(id, {'role': 'user', 'content': '读文件'});
    await store.append(id, {
      'role': 'assistant',
      'content': '',
      'reasoning_content': '先看看目录',
      'tool_calls': [
        {
          'id': 'c1',
          'type': 'function',
          'function': {'name': 'file_read', 'arguments': '{"path":"/workspace"}'},
        },
      ],
    });
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    await _pumpPanel(tester, host, id);
    await tester.pumpAndSettle();
    expect(find.byType(ThinkingBlock), findsOneWidget);
    expect(find.text('思考'), findsOneWidget);
    expect(find.text('先看看目录'), findsOneWidget);
    // The raw tool call is not an answer and stays hidden.
    expect(find.textContaining('file_read', findRichText: true), findsNothing);
  });

  testWidgets('live activity shows the last reasoning line and expands', (
    tester,
  ) async {
    late AgentCoreHost host;
    late StreamingReasoningModel model;
    late String id;
    await tester.runAsync(() async {
      final settings = ModelSettings(native: FakeNative());
      await settings.save(
        endpoint: 'https://example.com/v1',
        model: 'm',
        key: 'secret',
      );
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      id = await store.create();
      model = StreamingReasoningModel();
      host = AgentCoreHost(
        store: store,
        settings: settings,
        clientFactory: () => model,
      );
    });
    addTearDown(host.dispose);
    await _pumpPanel(tester, host, id);
    late Future<void> sending;
    await tester.runAsync(() async {
      sending = host.send(id, '说说');
      await model.streaming.future.timeout(const Duration(seconds: 10));
      for (var i = 0; i < 300 && host.reasoning != '第一步\n第二步'; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    });
    expect(host.reasoning, '第一步\n第二步');
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(find.byType(ChatActivity), findsOneWidget);
    expect(find.text('正在思考'), findsOneWidget);
    expect(find.text('第二步'), findsOneWidget);
    await tester.tap(find.byTooltip('查看执行过程'));
    await tester.pump();
    expect(find.textContaining('第一步', findRichText: true), findsOneWidget);
    await tester.runAsync(() async {
      model.gate.complete();
      await sending;
    });
    await tester.pumpAndSettle();
    expect(find.byType(ChatActivity), findsNothing);
    expect(host.error, isNull);
    // Persisted reasoning replays collapsed after the live turn ends.
    expect(find.byType(ThinkingBlock), findsOneWidget);
    expect(find.text('思考'), findsOneWidget);
    expect(find.text('第二步'), findsOneWidget);
    expect(find.textContaining('第一步', findRichText: true), findsNothing);
    await tester.tap(find.byTooltip('查看思考过程'));
    await tester.pumpAndSettle();
    expect(find.textContaining('第一步', findRichText: true), findsOneWidget);
  });

  testWidgets('thinking block keeps the helper, live title and elapsed time', (
    tester,
  ) async {
    expect(thinkingSummary('a\n\n  b  \n'), 'b');
    expect(thinkingSummary('  \n '), isEmpty);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: ThinkingBlock(
              text: 'line one\nlast line',
              language: 'en',
              live: true,
              elapsed: const Duration(seconds: 75),
            ),
          ),
        ),
      ),
    );
    expect(find.text('Thinking'), findsOneWidget);
    expect(find.text('last line'), findsOneWidget);
    expect(find.text('1m 15s'), findsOneWidget);
    expect(find.byType(SelectableText), findsNothing);
    await tester.tap(find.byTooltip('Show thinking'));
    await tester.pumpAndSettle();
    expect(find.byType(SelectableText), findsOneWidget);
    expect(find.textContaining('line one', findRichText: true), findsOneWidget);
    expect(find.byTooltip('Hide thinking'), findsOneWidget);
  });
}
