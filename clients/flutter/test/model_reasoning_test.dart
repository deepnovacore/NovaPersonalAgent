import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';

void main() {
  final deepseek = ModelConfiguration(
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-reasoner',
    key: 'synthetic',
  );
  final qwen = ModelConfiguration(
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-flash',
    key: 'synthetic',
  );

  test('chat bodies never disable thinking unless a Qwen opt-out is explicit', () {
    // DeepSeek has no thinking flag in chat: reasoning is the provider default.
    for (final disableThinking in [false, true]) {
      final body = modelRequestBody(deepseek, [], [], disableThinking: disableThinking);
      expect(body.containsKey('thinking'), false);
      expect(body.containsKey('enable_thinking'), false);
    }
    // Chat Completions leaves Qwen thinking on unless asked otherwise.
    expect(modelRequestBody(qwen, [], []).containsKey('enable_thinking'), false);
    expect(
      modelRequestBody(qwen, [], [], disableThinking: true)['enable_thinking'],
      false,
    );
    // The explicit opt-out only targets the priced DashScope models.
    final remote = ModelConfiguration(
      endpoint: 'https://example.com/v1',
      model: 'qwen-flash',
      key: 'synthetic',
    );
    expect(
      modelRequestBody(remote, [], [], disableThinking: true).containsKey(
        'enable_thinking',
      ),
      false,
    );
    final otherQwen = ModelConfiguration(
      endpoint: qwen.endpoint,
      model: 'qwen-plus',
      key: 'synthetic',
    );
    expect(
      modelRequestBody(otherQwen, [], [], disableThinking: true).containsKey(
        'enable_thinking',
      ),
      false,
    );
  });

  test('DeepSeek replays stored reasoning and fills the legacy empty field', () {
    final messages = <Map<String, dynamic>>[
      {'role': 'system', 'content': 'system'},
      {
        'role': 'assistant',
        'content': '第一轮',
        'reasoning_content': '先思考',
        'reasoning': 'internal duplicate',
        '_nova_response_items': [
          {'type': 'reasoning'},
        ],
      },
      {'role': 'assistant', 'content': '旧轮次'},
      {'role': 'user', 'content': '继续'},
    ];
    final body = modelRequestBody(deepseek, messages, []);
    final history = body['messages'] as List;
    final replayed = history[1] as Map;
    expect(replayed['content'], '第一轮');
    expect(replayed['reasoning_content'], '先思考');
    expect(replayed.containsKey('reasoning'), false);
    expect(replayed.containsKey('_nova_response_items'), false);
    // Legacy assistant turns predate visible thinking; DeepSeek expects the field.
    expect((history[2] as Map)['reasoning_content'], '');
    // Building the wire history never mutates the stored turn.
    expect(messages[1]['reasoning_content'], '先思考');
  });

  test('non-DeepSeek hosts strip provider-private reasoning from the wire', () {
    final body = modelRequestBody(qwen, [
      {
        'role': 'assistant',
        'content': '答案',
        'reasoning_content': '不应上送',
        'reasoning': 'internal duplicate',
        '_nova_response_items': [
          {'type': 'reasoning'},
        ],
      },
      {'role': 'user', 'content': '继续'},
    ], []);
    final history = body['messages'] as List;
    final assistant = history[0] as Map;
    expect(assistant['content'], '答案');
    expect(assistant.containsKey('reasoning_content'), false);
    expect(assistant.containsKey('reasoning'), false);
    expect(assistant.containsKey('_nova_response_items'), false);
    expect((history[1] as Map)['content'], '继续');
  });

  test(
    'Chat Completions SSE normalizes reasoning_content and reasoning deltas',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((request) async {
        await request.drain<void>();
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        for (final event in [
          {
            'choices': [
              {
                'delta': {'reasoning_content': '先想'},
              },
            ],
          },
          {
            'choices': [
              {
                'delta': {'reasoning': '再想'},
              },
            ],
          },
          {
            'choices': [
              {
                'delta': {'content': '答案'},
              },
            ],
          },
          {
            'choices': [
              {
                'delta': {'reasoning_content': '更多', 'content': '了'},
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
      final config = ModelConfiguration(
        endpoint: 'http://127.0.0.1:${server.port}',
        model: 'm',
        key: 'synthetic',
      );
      final chunks = await ModelClient().stream(config, []).toList();
      expect(chunks, hasLength(4));
      expect(chunks[0]['reasoning'], '先想');
      expect(chunks[1]['reasoning'], '再想');
      expect(chunks[2]['content'], '答案');
      expect(chunks[3]['reasoning'], '更多');
      expect(chunks[3]['content'], '了');
    },
  );

  test('reasoning bytes count against maxOutputBytes', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) async {
      await request.drain<void>();
      request.response.headers.contentType = ContentType('text', 'event-stream');
      final event = jsonEncode({
        'choices': [
          {
            'delta': {'reasoning_content': 'x' * 600},
          },
        ],
      });
      request.response.add(utf8.encode('data: $event\n\n'));
      request.response.add(utf8.encode('data: [DONE]\n\n'));
      await request.response.close();
    });
    final config = ModelConfiguration(
      endpoint: 'http://127.0.0.1:${server.port}',
      model: 'm',
      key: 'synthetic',
    );
    await expectLater(
      ModelClient(maxOutputBytes: 500).stream(config, []).toList(),
      throwsA(
        isA<AgentFailure>().having(
          (e) => e.code,
          'code',
          'model_response_too_large',
        ),
      ),
    );
  });

  test('Responses surfaces reasoning summaries but never fabricates them', () {
    final stream = ResponsesStream();
    // Encrypted-only reasoning has no human-readable summary.
    final encrypted = stream.add({
      'type': 'response.output_item.done',
      'item': {
        'type': 'reasoning',
        'id': 'r1',
        'encrypted_content': 'opaque',
        'summary': [],
      },
    });
    expect(encrypted.isEmpty, true);
    expect(encrypted.containsKey('reasoning'), false);
    final summarized = stream.add({
      'type': 'response.output_item.done',
      'item': {
        'type': 'reasoning',
        'id': 'r2',
        'summary': [
          {'type': 'summary_text', 'text': 'First thought'},
          {'type': 'summary_text', 'text': 'Second thought'},
        ],
      },
    });
    expect(summarized['reasoning'], 'First thought\nSecond thought');
    expect(stream.items, hasLength(2));
    // Replay of exact output items is unchanged.
    final completed = stream.add({
      'type': 'response.completed',
      'response': {'status': 'completed'},
    });
    expect(completed['_nova_response_items'], hasLength(2));
    expect(stream.finished, true);
  });
}
