import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';

void main() {
  test('Responses interrupted stream never becomes success', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) async {
      await request.drain<void>();
      request.response.headers.contentType = ContentType(
        'text',
        'event-stream',
      );
      request.response.write(
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      );
      await request.response.close();
    });
    final client = ModelClient();
    await expectLater(
      client
          .stream(
            ModelConfiguration(
              endpoint: 'http://127.0.0.1:${server.port}',
              model: 'test',
              key: 'test',
              protocol: ModelProtocol.responses,
            ),
            [],
          )
          .toList(),
      throwsA(
        isA<AgentFailure>().having(
          (f) => f.code,
          'code',
          'model_stream_interrupted',
        ),
      ),
    );
  });
}
