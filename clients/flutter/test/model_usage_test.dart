import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';

void main() {
  Map<String, dynamic> chunk({
    String id = 'request-1',
    String model = 'qwen3-vl-plus',
    String? reason,
    Map<String, dynamic>? usage,
  }) => {
    'id': id,
    'model': model,
    'choices': usage != null
        ? []
        : [
            {
              'index': 0,
              'delta': {'content': '{}'},
              'finish_reason': reason,
            },
          ],
    'usage': ?usage,
  };
  final valid = {
    'prompt_tokens': 100,
    'completion_tokens': 20,
    'total_tokens': 120,
  };
  test(
    'receipt requires stable identity, stop, final integral usage and completion',
    () {
      final parser = ChatCompletionUsage('qwen3-vl-plus');
      parser.add(chunk());
      expect(parser.finish(), isNull);
      parser.add(chunk(reason: 'stop'));
      expect(parser.finish(), isNull);
      parser.add(chunk(usage: valid));
      final usage = parser.finish()!;
      expect(usage.promptTokens, 100);
      expect(usage.completionTokens, 20);
      expect(usage.responseId, 'request-1');
    },
  );
  test(
    'ambiguous, missing, malformed or mismatched billing never returns a receipt',
    () {
      for (final events in <List<Map<String, dynamic>>>[
        [chunk(usage: valid)],
        [chunk(reason: 'length'), chunk(usage: valid)],
        [
          chunk(reason: 'stop'),
          chunk(usage: {...valid, 'total_tokens': 121}),
        ],
        [
          chunk(reason: 'stop'),
          chunk(usage: {...valid, 'prompt_tokens': 100.0}),
        ],
        [chunk(reason: 'stop'), chunk(id: 'other', usage: valid)],
        [chunk(reason: 'stop'), chunk(model: 'other', usage: valid)],
        [chunk(reason: 'stop'), chunk(usage: valid), chunk(usage: valid)],
        [chunk(reason: 'stop'), chunk(), chunk(usage: valid)],
        [chunk(reason: 'tool_calls'), chunk(usage: valid)],
      ]) {
        final parser = ChatCompletionUsage('qwen3-vl-plus');
        for (final event in events) {
          parser.add(event);
        }
        expect(parser.finish(), isNull);
      }
    },
  );
  test(
    'client requests usage only on opt-in and exposes it only after DONE',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final bodies = <Map<String, dynamic>>[];
      var addDone = true;
      server.listen((request) async {
        bodies.add(
          jsonDecode(await utf8.decoder.bind(request).join())
              as Map<String, dynamic>,
        );
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        for (final event in [chunk(reason: 'stop'), chunk(usage: valid)]) {
          request.response.write('data: ${jsonEncode(event)}\n\n');
        }
        if (addDone) request.response.write('data: [DONE]\n\n');
        await request.response.close();
      });
      final config = ModelConfiguration(
        endpoint: 'http://127.0.0.1:${server.port}/v1',
        model: 'qwen3-vl-plus',
        key: 'test',
      );
      final normal = ModelClient();
      await normal.stream(config, []).toList();
      expect(normal.completedUsage, isNull);
      expect(bodies.last.containsKey('stream_options'), false);
      final metered = ModelClient(collectUsage: true);
      await metered.stream(config, []).toList();
      expect(metered.completedUsage!.promptTokens, 100);
      expect(bodies.last['stream_options'], {'include_usage': true});
      addDone = false;
      await expectLater(
        metered.stream(config, []).toList(),
        throwsA(isA<AgentFailure>()),
      );
      expect(metered.completedUsage, isNull);
    },
  );
}
