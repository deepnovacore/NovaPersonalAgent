import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/voice/cascaded/speech_adapters.dart';
import 'package:nova_mobile/voice/cascaded/ports.dart';

void main() {
  test(
    'ASR sends required JSON format or omits it for strict services',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final bodies = <String>[];
      server.listen((request) async {
        bodies.add(await latin1.decoder.bind(request).join());
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"text":"OK"}');
        await request.response.close();
      });
      for (final send in [true, false]) {
        final client = OpenAiCompatibleAsr(
          endpoint: 'http://127.0.0.1:${server.port}',
          model: 'model',
          apiKey: 'synthetic',
          sendResponseFormat: send,
        );
        final result = await client
            .transcribe(Uint8List(320), CascadeCancellation())
            .toList();
        expect(result.single.text, 'OK');
      }
      expect(bodies.first, contains('name="response_format"'));
      expect(bodies.last, isNot(contains('name="response_format"')));
    },
  );
  test(
    'Responses refuses incomplete streams and bounds reasoning replay',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      var request = 0;
      server.listen((r) async {
        await r.drain<void>();
        r.response.headers.contentType = ContentType('text', 'event-stream');
        if (request++ == 0) {
          r.response.write('data: [DONE]\n\n');
        } else {
          r.response.write(
            'data: ${jsonEncode({
              'type': 'response.output_item.done',
              'item': {'type': 'reasoning', 'encrypted_content': 'x' * 2000},
            })}\n\n',
          );
          r.response.write(
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          );
        }
        await r.response.close();
      });
      final config = ModelConfiguration(
        endpoint: 'http://127.0.0.1:${server.port}',
        model: 'm',
        key: 'k',
        protocol: ModelProtocol.responses,
      );
      await expectLater(
        ModelClient().stream(config, []).toList(),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'model_stream_interrupted',
          ),
        ),
      );
      await expectLater(
        ModelClient(maxOutputBytes: 1000).stream(config, []).toList(),
        throwsA(
          isA<AgentFailure>().having(
            (e) => e.code,
            'code',
            'model_response_too_large',
          ),
        ),
      );
    },
  );
  test('SiliconFlow requests 24k PCM; compressed audio is rejected', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((r) async {
      final body = jsonDecode(await utf8.decoder.bind(r).join()) as Map;
      expect(body['sample_rate'], 24000);
      r.response.headers.contentType = ContentType('audio', 'mpeg');
      r.response.add([1, 2, 3, 4]);
      await r.response.close();
    });
    await expectLater(
      OpenAiCompatibleTts(
        endpoint: 'http://127.0.0.1:${server.port}',
        model: 'm',
        apiKey: 'k',
        voice: 'v',
        requestSampleRate: true,
      ).synthesize('text', CascadeCancellation()).toList(),
      throwsA(
        isA<CascadeFailure>().having(
          (e) => e.code,
          'code',
          'invalid_tts_audio_format',
        ),
      ),
    );
  });
  test(
    'Responses maps tool history and retains encrypted reasoning without vendor flags',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      Map? body;
      server.listen((r) async {
        expect(r.uri.path, '/v1/responses');
        body = jsonDecode(await utf8.decoder.bind(r).join()) as Map;
        r.response.headers.contentType = ContentType('text', 'event-stream');
        for (final event in [
          {'type': 'response.output_text.delta', 'delta': 'Hello'},
          {
            'type': 'response.output_item.done',
            'item': {
              'type': 'reasoning',
              'id': 'rs1',
              'summary': [],
              'encrypted_content': 'opaque',
            },
          },
          {
            'type': 'response.output_item.done',
            'item': {
              'type': 'function_call',
              'id': 'fc1',
              'call_id': 'call1',
              'name': 'lookup',
              'arguments': '{}',
            },
          },
          {
            'type': 'response.completed',
            'response': {'status': 'completed'},
          },
        ]) {
          r.response.write('data: ${jsonEncode(event)}\n\n');
        }
        await r.response.close();
      });
      final config = ModelConfiguration(
        endpoint: 'http://127.0.0.1:${server.port}/v1',
        model: 'm',
        key: 'test',
        protocol: ModelProtocol.responses,
      );
      final chunks = await ModelClient()
          .stream(
            config,
            [
              {'role': 'system', 'content': 'help'},
              {
                'role': 'assistant',
                'content': '',
                'tool_calls': [
                  {
                    'id': 'old',
                    'type': 'function',
                    'function': {'name': 'lookup', 'arguments': '{}'},
                  },
                ],
                '_nova_response_items': [
                  {
                    'type': 'reasoning',
                    'id': 'old-r',
                    'summary': [],
                    'encrypted_content': 'previous',
                  },
                  {
                    'type': 'function_call',
                    'id': 'old-f',
                    'call_id': 'old',
                    'name': 'lookup',
                    'arguments': '{}',
                  },
                ],
              },
              {'role': 'tool', 'tool_call_id': 'old', 'content': 'result'},
            ],
            tools: [
              {
                'type': 'function',
                'function': {
                  'name': 'lookup',
                  'parameters': {'type': 'object'},
                },
              },
            ],
          )
          .toList();
      expect(body!['store'], false);
      expect(body!.containsKey('thinking'), false);
      expect(body!.containsKey('previous_response_id'), false);
      expect(
        (body!['input'] as List).where((e) => e['type'] == 'function_call'),
        hasLength(1),
      );
      expect(
        (body!['input'] as List).any(
          (e) => e['encrypted_content'] == 'previous',
        ),
        true,
      );
      expect(
        chunks
            .where((e) => e['content'] != null)
            .map((e) => e['content'])
            .join(),
        'Hello',
      );
      expect(chunks.last['_nova_response_items'], hasLength(2));
      expect(
        chunks.expand((e) => e['tool_calls'] as List? ?? []).single['id'],
        'call1',
      );
    },
  );
  test('generic ASR sends WAV multipart and TTS validates PCM WAV', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((r) async {
      final bytes = await r.fold<List<int>>([], (a, b) => a..addAll(b));
      if (r.uri.path.endsWith('transcriptions')) {
        expect(r.headers.contentType!.mimeType, 'multipart/form-data');
        expect(latin1.decode(bytes), contains('RIFF'));
        expect(latin1.decode(bytes), contains('name="model"'));
        r.response.headers.contentType = ContentType.json;
        r.response.write('{"text":"你好"}');
      } else {
        final body = jsonDecode(utf8.decode(bytes)) as Map;
        expect(body, {
          'model': 'tts',
          'voice': 'alloy',
          'input': '你好',
          'response_format': 'pcm',
        });
        r.response.headers.contentType = ContentType('audio', 'wav');
        r.response.add(pcmWav(Uint8List.fromList([0, 0, 1, 0]), 24000));
      }
      await r.response.close();
    });
    final base = 'http://127.0.0.1:${server.port}/v1';
    final text = await OpenAiCompatibleAsr(
      endpoint: base,
      model: 'asr',
      apiKey: 'test',
    ).transcribe(Uint8List(320), CascadeCancellation()).toList();
    expect(text.single.text, '你好');
    final audio = await OpenAiCompatibleTts(
      endpoint: base,
      model: 'tts',
      apiKey: 'test',
      voice: 'alloy',
    ).synthesize('你好', CascadeCancellation()).toList();
    expect(audio.single.pcm, [0, 0, 1, 0]);
    expect(audio.single.sampleRate, 24000);
  });
  test('generic speech cancellation stops pending response', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final received = Completer<void>();
    server.listen((r) async {
      await r.drain<void>();
      received.complete();
    });
    final cancel = CascadeCancellation();
    final result = OpenAiCompatibleAsr(
      endpoint: 'http://127.0.0.1:${server.port}',
      model: 'a',
      apiKey: 'k',
    ).transcribe(Uint8List(100), cancel).toList();
    final assertion = expectLater(
      result,
      throwsA(isA<CascadeFailure>().having((e) => e.code, 'code', 'cancelled')),
    );
    await received.future;
    cancel.cancel();
    await assertion.timeout(const Duration(seconds: 2));
  });
}
