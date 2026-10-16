import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/personal/local_life.dart';

class MemoryPersistence implements LifePersistence {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String data) async {
    value = data;
  }
}

void main() {
  test('conversation survives restart with backend and tool summary', () async {
    final persistence = MemoryPersistence();
    final store = ConversationStore(persistence);
    await store.open();
    final id = await store.create(computerConnected: true);
    expect(store.conversation(id)['backend'], 'computer');
    await store.selectBackend(id, 'local');
    await Future.wait([
      store.append(id, {'role': 'user', 'content': 'hello'}),
      store.append(id, {
        'role': 'tool',
        'content': 'denied',
        'tool': 'life.update',
      }),
    ]);
    final restored = ConversationStore(persistence);
    await restored.open();
    expect(restored.conversation(id)['backend'], 'local');
    expect(restored.conversation(id)['messages'], hasLength(2));
    final copy = restored.conversation(id);
    (copy['messages'] as List).clear();
    expect(restored.conversation(id)['messages'], hasLength(2));
  });
  test('unknown schema preserves original and cannot be overwritten', () async {
    final persistence = MemoryPersistence()
      ..value = '{"schema_version":99,"conversations":[]}';
    final store = ConversationStore(persistence);
    await expectLater(store.open(), throwsFormatException);
    await expectLater(store.create(computerConnected: false), throwsStateError);
    expect(persistence.value, '{"schema_version":99,"conversations":[]}');
  });
  test('restart closes interrupted tool exchange without replay', () async {
    final persistence = MemoryPersistence();
    final store = ConversationStore(persistence);
    await store.open();
    final id = await store.create(computerConnected: false);
    await store.append(id, {
      'role': 'assistant',
      'content': '',
      'tool_calls': [
        {
          'id': 'pending',
          'type': 'function',
          'function': {'name': 'life_create', 'arguments': '{}'},
        },
      ],
    });
    final restored = ConversationStore(persistence);
    await restored.open();
    final messages = restored.conversation(id)['messages'] as List;
    expect(messages.last['tool_call_id'], 'pending');
    expect(jsonDecode(messages.last['content'])['status'], 'outcome_unknown');
    final again = ConversationStore(persistence);
    await again.open();
    expect(again.conversation(id)['messages'], hasLength(2));
  });
  test('settings reject unsafe URL and header injection', () {
    for (final endpoint in [
      'http://example.com/v1',
      'https://user:secret@example.com',
      'https://example.com/?key=secret',
    ]) {
      expect(
        () => ModelConfiguration(endpoint: endpoint, model: 'm', key: 'secret'),
        throwsA(isA<AgentFailure>()),
      );
    }
    expect(
      () => ModelConfiguration(
        endpoint: 'https://example.com',
        model: 'm',
        key: 'x\r\nHeader: y',
      ),
      throwsA(isA<AgentFailure>()),
    );
  });
  test(
    'SSE handles split UTF8, ignores comments and streams tool deltas',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((request) async {
        await request.drain<void>();
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        final bytes = utf8.encode(
          ': ping\n\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n',
        );
        for (final byte in bytes) {
          request.response.add([byte]);
        }
        await request.response.close();
      });
      final config = ModelConfiguration(
        endpoint: 'http://127.0.0.1:${server.port}',
        model: 'm',
        key: 'secret',
      );
      final chunks = await ModelClient().stream(config, []).toList();
      expect(chunks.first['content'], '你好');
      expect(chunks.last['tool_calls'], isNotEmpty);
    },
  );
  test('redirects are not followed and errors do not echo secrets', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    var requests = 0;
    server.listen((request) async {
      requests++;
      await request.drain<void>();
      request.response.statusCode = 302;
      request.response.headers.set('location', '/secret');
      request.response.write('secret');
      await request.response.close();
    });
    final config = ModelConfiguration(
      endpoint: 'http://127.0.0.1:${server.port}',
      model: 'm',
      key: 'secret',
    );
    await expectLater(
      ModelClient().stream(config, []).toList(),
      throwsA(
        isA<AgentFailure>().having(
          (e) => e.code,
          'code',
          'model_request_failed',
        ),
      ),
    );
    expect(requests, 1);
  });
  test('response cap and cancellation are enforced', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) async {
      await request.drain<void>();
      request.response.headers.contentType = ContentType(
        'text',
        'event-stream',
      );
      request.response.write('data: ${'x' * 100}\n\n');
      await request.response.close();
    });
    final config = ModelConfiguration(
      endpoint: 'http://127.0.0.1:${server.port}',
      model: 'm',
      key: 'secret',
    );
    await expectLater(
      ModelClient(maxBytes: 50).stream(config, []).toList(),
      throwsA(
        isA<AgentFailure>().having(
          (e) => e.code,
          'code',
          'model_response_too_large',
        ),
      ),
    );
    final cancelled = ModelClient()..cancel();
    await expectLater(
      cancelled.stream(config, []).toList(),
      throwsA(isA<AgentFailure>().having((e) => e.code, 'code', 'cancelled')),
    );
  });
}
