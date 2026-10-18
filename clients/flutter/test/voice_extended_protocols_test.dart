import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/voice/cascaded/ports.dart';
import 'package:nova_mobile/voice/cascaded/volc_wire.dart';
import 'package:nova_mobile/voice/cascaded/volc_speech.dart';
import 'package:nova_mobile/voice/cascaded/ark_llm.dart';
import 'package:nova_mobile/voice/voice_settings.dart';

Uint8List asrFrame(
  String text, {
  bool finalFrame = false,
  bool compressed = true,
}) {
  final payload = utf8.encode(
    jsonEncode({
      'result': {'text': text},
    }),
  );
  final bytes = compressed ? gzip.encode(payload) : payload;
  final out = Uint8List(12 + bytes.length);
  out.setAll(0, [0x11, finalFrame ? 0x93 : 0x91, compressed ? 0x11 : 0x10, 0]);
  final view = ByteData.sublistView(out);
  view.setInt32(4, finalFrame ? -2 : 1);
  view.setUint32(8, bytes.length);
  out.setAll(12, bytes);
  return out;
}

void main() {
  test(
    'Volc wire validates flags, session IDs, truncation, bounded inflate',
    () {
      final frame = VolcFrame(
        type: 0xb,
        event: 352,
        sessionId: 's',
        payload: Uint8List.fromList([1, 2]),
      );
      final decoded = VolcFrame.decode(frame.encode());
      expect(decoded.event, 352);
      expect(decoded.sessionId, 's');
      expect(decoded.payload, [1, 2]);
      final malformed = frame.encode()..[1] = 0xb5;
      expect(() => VolcFrame.decode(malformed), throwsA(isA<CascadeFailure>()));
      expect(
        () => VolcFrame.decode(frame.encode().sublist(0, 10)),
        throwsA(isA<CascadeFailure>()),
      );
      expect(
        () => decodeVolcAsr(asrFrame('a' * (1024 * 1024))),
        throwsA(isA<CascadeFailure>()),
      );
      expect(decodeVolcAsr(asrFrame('你好', finalFrame: true))!.isFinal, isTrue);
    },
  );

  test(
    'Volc ASR sends gzip request, signed final PCM and consumes final result',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final observed = Completer<void>();
      server.listen((request) async {
        expect(request.headers.value('X-Api-Key'), 'test-key');
        expect(request.headers.value('X-Api-Resource-Id'), 'test-resource');
        final ws = await WebSocketTransformer.upgrade(request);
        var step = 0;
        ws.listen((raw) {
          final bytes = Uint8List.fromList(raw as List<int>);
          if (step++ == 0) {
            expect(bytes.sublist(0, 4), [0x11, 0x11, 0x11, 0]);
            final body = jsonDecode(
              utf8.decode(gzip.decode(bytes.sublist(12))),
            );
            expect(body['audio']['rate'], 16000);
            ws.add(asrFrame(''));
          } else {
            expect(bytes[1], 0x23);
            expect(ByteData.sublistView(bytes).getInt32(4), -2);
            expect(gzip.decode(bytes.sublist(12)), [1, 2, 3, 4]);
            ws.add(asrFrame('测试', finalFrame: true));
            observed.complete();
          }
        });
      });
      final result =
          await VolcAsr(
                endpoint: 'ws://127.0.0.1:${server.port}/asr',
                apiKey: 'test-key',
                resourceId: 'test-resource',
              )
              .transcribe(
                Uint8List.fromList([1, 2, 3, 4]),
                CascadeCancellation(),
              )
              .toList();
      await observed.future;
      expect(result.last.text, '测试');
      expect(result.last.isFinal, isTrue);
    },
  );

  test('Volc TTS handshake/session events and PCM output', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final events = <int>[];
    server.listen((request) async {
      final ws = await WebSocketTransformer.upgrade(request);
      ws.listen((raw) {
        final f = VolcFrame.decode(raw as List<int>);
        events.add(f.event!);
        void respond(
          int event, {
          int type = 9,
          List<int> payload = const [123, 125],
        }) => ws.add(
          VolcFrame(
            type: type,
            event: event,
            sessionId: f.sessionId,
            connectId: 'connection',
            payload: Uint8List.fromList(payload),
          ).encode(),
        );
        if (f.event == 1) respond(50);
        if (f.event == 100) {
          final body = jsonDecode(utf8.decode(f.payload));
          expect(body['req_params']['speaker'], 'configured-public-voice');
          expect(body['req_params']['audio_params']['sample_rate'], 24000);
          respond(150);
        }
        if (f.event == 200) {
          expect(
            jsonDecode(utf8.decode(f.payload))['req_params']['text'],
            '你好',
          );
        }
        if (f.event == 102) {
          respond(352, type: 11, payload: [1, 2, 3, 4]);
          respond(152);
        }
      });
    });
    final result = await VolcTts(
      endpoint: 'ws://127.0.0.1:${server.port}/tts',
      apiKey: 'test-key',
      resourceId: 'test-resource',
      voice: 'configured-public-voice',
    ).synthesize('你好', CascadeCancellation()).toList();
    expect(result.single.pcm, [1, 2, 3, 4]);
    expect(result.single.sampleRate, 24000);
    expect(events.take(4), [1, 100, 200, 102]);
  });

  test(
    'Volc cancellation closes a pending session without late delivery',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final cancel = CascadeCancellation();
      server.listen((request) async {
        final ws = await WebSocketTransformer.upgrade(request);
        ws.listen((_) {
          cancel.cancel();
        });
      });
      await expectLater(
        VolcAsr(
          endpoint: 'ws://127.0.0.1:${server.port}/asr',
          apiKey: 'key',
          resourceId: 'resource',
        ).transcribe(Uint8List(4), cancel).toList(),
        throwsA(isA<CascadeFailure>()),
      );
    },
  );

  Future<List<CascadeLlmDelta>> arkFixture(
    List<Map<String, dynamic>> events, {
    List<Map<String, dynamic>> tools = const [],
    void Function(Map<String, dynamic>)? inspect,
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      expect(req.uri.path, '/responses');
      inspect?.call(
        jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>,
      );
      req.response.headers.contentType = ContentType(
        'text',
        'event-stream',
        charset: 'utf-8',
      );
      for (final e in events) {
        req.response.write('data: ${jsonEncode(e)}\r\n\r\n');
      }
      await req.response.close();
    });
    return ArkResponsesCascadeLlm(
          configuration: ModelConfiguration(
            endpoint: 'http://127.0.0.1:${server.port}/responses',
            model: 'test-model',
            key: 'test-key',
          ),
        )
        .generate(
          [
            {'role': 'system', 'content': 'instructions'},
            {'role': 'user', 'content': 'hi'},
          ],
          tools,
          CascadeCancellation(),
        )
        .toList();
  }

  final created = {
    'type': 'response.created',
    'response': {'id': 'r'},
  };
  final completed = {
    'type': 'response.completed',
    'response': {'id': 'r'},
  };
  final tool = {
    'type': 'function',
    'function': {
      'name': 'delegate_task',
      'parameters': {'type': 'object'},
    },
  };
  test('Ark Responses streaming text and request translation', () async {
    final values = await arkFixture(
      [
        created,
        {'type': 'response.output_text.delta', 'delta': '你好'},
        completed,
      ],
      inspect: (body) {
        expect(body['instructions'], 'instructions');
        expect(body['thinking'], {'type': 'disabled'});
        expect(body['parallel_tool_calls'], isFalse);
        expect(body['input'], [
          {'role': 'user', 'content': 'hi'},
        ]);
      },
    );
    expect(values.single.text, '你好');
  });
  test('Ark validates and emits tool only after completed', () async {
    final values = await arkFixture(
      [
        created,
        {
          'type': 'response.output_item.done',
          'item': {
            'type': 'function_call',
            'id': 'i',
            'call_id': 'c',
            'name': 'delegate_task',
            'arguments': '{"task":"test"}',
          },
        },
        completed,
      ],
      tools: [tool],
      inspect: (body) {
        expect(body['tools'][0]['name'], 'delegate_task');
      },
    );
    expect(values.single.callId, 'c');
    expect(values.single.arguments, {'task': 'test'});
    await expectLater(
      arkFixture(
        [
          created,
          {
            'type': 'response.output_item.done',
            'item': {
              'type': 'function_call',
              'id': 'i',
              'call_id': 'c',
              'name': 'delegate_task',
              'arguments': '{}',
            },
          },
          {
            'type': 'response.failed',
            'response': {'id': 'r'},
          },
        ],
        tools: [tool],
      ),
      throwsA(isA<CascadeFailure>()),
    );
  });
  test(
    'Ark rejects EOF, mismatched completion, and text/tool mixtures',
    () async {
      await expectLater(arkFixture([created]), throwsA(isA<CascadeFailure>()));
      await expectLater(
        arkFixture([
          created,
          {
            'type': 'response.completed',
            'response': {'id': 'other'},
          },
        ]),
        throwsA(isA<CascadeFailure>()),
      );
      await expectLater(
        arkFixture(
          [
            created,
            {'type': 'response.output_text.delta', 'delta': 'hi'},
            {
              'type': 'response.output_item.done',
              'item': {
                'type': 'function_call',
                'id': 'i',
                'call_id': 'c',
                'name': 'delegate_task',
                'arguments': '{}',
              },
            },
            completed,
          ],
          tools: [tool],
        ),
        throwsA(isA<CascadeFailure>()),
      );
    },
  );
  test('Ark cancellation aborts an open SSE request promptly', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final cancel = CascadeCancellation();
    server.listen((req) async {
      await req.drain<void>();
      req.response.headers.contentType = ContentType(
        'text',
        'event-stream',
        charset: 'utf-8',
      );
      req.response.write('data: ${jsonEncode(created)}\n\n');
      await req.response.flush();
      cancel.cancel();
    });
    final llm = ArkResponsesCascadeLlm(
      configuration: ModelConfiguration(
        endpoint: 'http://127.0.0.1:${server.port}/responses',
        model: 'test',
        key: 'key',
      ),
    );
    await expectLater(
      llm
          .generate(
            [
              {'role': 'user', 'content': 'hi'},
            ],
            [],
            cancel,
          )
          .toList()
          .timeout(const Duration(seconds: 3)),
      throwsA(isA<CascadeFailure>()),
    );
  });
  test('Ark rejects oversized SSE lines before decoding JSON', () async {
    await expectLater(
      arkFixture([
        created,
        {'type': 'unknown', 'data': 'a' * (256 * 1024)},
      ]),
      throwsA(isA<CascadeFailure>()),
    );
  });
  test('Volc errors and handshake timeout fail closed', () async {
    final error = Uint8List(12);
    error.setAll(0, [0x11, 0xf0, 0x10, 0]);
    expect(() => decodeVolcAsr(error), throwsA(isA<CascadeFailure>()));
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      final ws = await WebSocketTransformer.upgrade(req);
      ws.listen((_) {});
    });
    await expectLater(
      VolcAsr(
        endpoint: 'ws://127.0.0.1:${server.port}/asr',
        apiKey: 'key',
        resourceId: 'resource',
        timeout: const Duration(milliseconds: 100),
      ).transcribe(Uint8List(4), CascadeCancellation()).toList(),
      throwsA(isA<CascadeFailure>()),
    );
  });
  test('Volc TTS rejects wrong session handshake', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      final ws = await WebSocketTransformer.upgrade(req);
      ws.listen((raw) {
        final f = VolcFrame.decode(raw as List<int>);
        if (f.event == 1 || f.event == 100) {
          ws.add(
            VolcFrame(
              type: 9,
              event: f.event == 1 ? 50 : 150,
              sessionId: 'wrong',
              connectId: 'c',
              payload: Uint8List.fromList([123, 125]),
            ).encode(),
          );
        }
      });
    });
    await expectLater(
      VolcTts(
        endpoint: 'ws://127.0.0.1:${server.port}/tts',
        apiKey: 'key',
        resourceId: 'resource',
        voice: 'configured-voice',
      ).synthesize('test', CascadeCancellation()).toList(),
      throwsA(isA<CascadeFailure>()),
    );
  });
  test('old v1 settings default to Chat Completions', () {
    final old = const VoiceConfiguration().toJson()..remove('fastLlmProtocol');
    expect(
      VoiceConfiguration.fromJson(old).fastLlmProtocol,
      FastLlmProtocol.chatCompletions,
    );
  });
}
