import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';

void main() {
  test(
    'active output can exceed the idle timeout without being interrupted',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((r) async {
        await r.drain<void>();
        r.response.headers.contentType = ContentType('text', 'event-stream');
        r.response.bufferOutput = false;
        for (var i = 0; i < 7; i++) {
          r.response.write(
            'data: {"choices":[{"delta":{"content":"code"}}]}\n\n',
          );
          await r.response.flush();
          await Future<void>.delayed(const Duration(milliseconds: 150));
        }
        r.response.write('data: [DONE]\n\n');
        await r.response.close();
      });
      final chunks =
          await ModelClient(timeout: const Duration(milliseconds: 600))
              .stream(
                ModelConfiguration(
                  endpoint: 'http://127.0.0.1:${server.port}',
                  model: 'm',
                  key: 'test',
                ),
                [],
              )
              .toList();
      expect(chunks, hasLength(7));
    },
  );
  test('SSE envelope overhead does not truncate a small actual answer', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((r) async {
      await r.drain<void>();
      r.response.headers.contentType = ContentType('text', 'event-stream');
      for (var i = 0; i < 60; i++) {
        r.response.write(
          'data: {"padding":"${'x' * 19000}","choices":[{"delta":{"content":"ok"}}]}\n\n',
        );
      }
      r.response.write('data: [DONE]\n\n');
      await r.response.close();
    });
    final result = await ModelClient()
        .stream(
          ModelConfiguration(
            endpoint: 'http://127.0.0.1:${server.port}',
            model: 'm',
            key: 'test',
          ),
          [],
        )
        .toList();
    expect(result.map((d) => d['content']).join(), 'ok' * 60);
  });
  test(
    'an output length limit is explicit rather than a saved broken tool call',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((r) async {
        await r.drain<void>();
        r.response.headers.contentType = ContentType('text', 'event-stream');
        r.response.bufferOutput = false;
        r.response.write(
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        );
        await r.response.close();
      });
      await expectLater(
        ModelClient()
            .stream(
              ModelConfiguration(
                endpoint: 'http://127.0.0.1:${server.port}',
                model: 'm',
                key: 'test',
              ),
              [],
            )
            .toList(),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'model_output_limit',
          ),
        ),
      );
    },
  );
}
