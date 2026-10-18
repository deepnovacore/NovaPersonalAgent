import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/voice/voice_provider.dart';
import 'package:nova_mobile/voice/cascaded/cascaded_voice_provider.dart';
import 'package:nova_mobile/voice/cascaded/model_llm.dart';
import 'package:nova_mobile/voice/cascaded/speech_adapters.dart';

class FakeAsr implements CascadeAsr {
  final inputs = <Uint8List>[];
  bool finalResult = true;
  Completer<void>? gate;
  @override
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm,
    CascadeCancellation cancel,
  ) async* {
    inputs.add(pcm);
    if (gate != null) await gate!.future;
    yield CascadeTranscript('heard', isFinal: finalResult);
  }
}

class FakeLlm implements CascadeLlm {
  final messages = <List<Map<String, dynamic>>>[],
      offeredTools = <List<Map<String, dynamic>>>[];
  List<CascadeLlmDelta> deltas = [const CascadeLlmDelta(text: 'Hello. Next!')];
  Completer<void>? gate;
  @override
  Stream<CascadeLlmDelta> generate(
    List<Map<String, dynamic>> input,
    List<Map<String, dynamic>> tools,
    CascadeCancellation cancel,
  ) async* {
    messages.add(input);
    offeredTools.add(tools);
    final hold = gate;
    gate = null;
    if (hold != null) await hold.future;
    for (final delta in deltas) {
      yield delta;
    }
  }
}

class FakeTts implements CascadeTts {
  final segments = <String>[];
  Completer<void>? gate;
  bool fail = false;
  @override
  Stream<CascadeAudio> synthesize(
    String text,
    CascadeCancellation cancel,
  ) async* {
    segments.add(text);
    final hold = gate;
    gate = null;
    if (hold != null) await hold.future;
    if (fail) throw const CascadeFailure('test_tts_failure');
    yield CascadeAudio(Uint8List.fromList([1, 0, 2, 0]), sampleRate: 24000);
  }
}

Uint8List sound(int windows, [int value = 4000]) {
  final data = ByteData(windows * 1024);
  for (var i = 0; i < data.lengthInBytes; i += 2) {
    data.setInt16(i, value, Endian.little);
  }
  return data.buffer.asUint8List();
}

Future<void> until(bool Function() predicate) async {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 2));
  }
  fail('condition did not become true');
}

Future<void> submitAndComplete(
  CascadedVoiceProvider provider,
  String text,
) async {
  final terminal = provider.events.firstWhere(
    (e) => e.kind == VoiceEventKind.responseEnd,
  );
  await provider.submitText(text);
  await terminal;
}

final tool = {
  'type': 'function',
  'function': {
    'name': 'delegate',
    'parameters': {'type': 'object'},
  },
};
void main() {
  test(
    'endpointing chunk invariant with noise rejection, pre-roll and silence pad',
    () {
      final endpoint = SilenceEndpointing(
        minSpeechMs: 64,
        silenceEndMs: 64,
        preRollMs: 32,
        speechPadMs: 32,
        maxUtteranceMs: 128,
      );
      expect(endpoint.feed(sound(1)), isEmpty);
      expect(endpoint.feed(sound(1, 0)), isEmpty);
      final events = endpoint.feed(
        Uint8List.fromList([...sound(2), ...sound(2, 0)]),
      );
      expect(events.map((e) => e.kind), ['start', 'audio', 'end']);
      expect(events.first.pcm!.length, 3072);
      expect(events[1].pcm!.length, 1024);
      final a = SilenceEndpointing(minSpeechMs: 64, silenceEndMs: 64),
          b = SilenceEndpointing(minSpeechMs: 64, silenceEndMs: 64);
      final input = Uint8List.fromList([...sound(3), ...sound(3, 0)]),
          split = <EndpointEvent>[];
      final all = a.feed(input);
      for (var i = 0; i < input.length; i += 128) {
        split.addAll(b.feed(Uint8List.sublistView(input, i, i + 128)));
      }
      expect(split.map((e) => e.kind), all.map((e) => e.kind));
      expect(split.expand((e) => e.pcm ?? []), all.expand((e) => e.pcm ?? []));
      expect(() => a.feed(Uint8List(3)), throwsA(isA<CascadeFailure>()));
    },
  );
  test('endpoint to ASR final to fast LLM to segmented PCM audio', () async {
    final asr = FakeAsr(), llm = FakeLlm(), tts = FakeTts();
    final p = CascadedVoiceProvider(
      asr: asr,
      llm: llm,
      tts: tts,
      endpointing: SilenceEndpointing(minSpeechMs: 64, silenceEndMs: 64),
    );
    final events = <VoiceEvent>[];
    p.events.listen(events.add);
    await p.connect(epoch: 7, instructions: 'brief');
    await p.sendAudio(sound(3));
    await p.sendAudio(sound(3, 0));
    await until(() => events.any((e) => e.kind == VoiceEventKind.responseEnd));
    expect(asr.inputs, hasLength(1));
    expect(tts.segments, ['Hello.', ' Next!']);
    expect(
      events.where((e) => e.kind == VoiceEventKind.transcript).single.isFinal,
      true,
    );
    expect(
      events
          .where((e) => e.kind == VoiceEventKind.audio)
          .every((e) => e.sampleRate == 24000 && e.pcm!.length == 4),
      true,
    );
    expect(events.every((e) => e.epoch == 7), true);
    await p.close();
  });
  test(
    'cancel fences late TTS and never retains interrupted history',
    () async {
      final llm = FakeLlm(), tts = FakeTts(), gate = Completer<void>();
      tts.gate = gate;
      final p = CascadedVoiceProvider(asr: FakeAsr(), llm: llm, tts: tts);
      final events = <VoiceEvent>[];
      p.events.listen(events.add);
      await p.connect(epoch: 1, instructions: '');
      final old = p.submitText('old');
      await until(() => tts.segments.isNotEmpty);
      final id = events
          .firstWhere((e) => e.kind == VoiceEventKind.responseStart)
          .responseId!;
      await p.cancelResponse(id);
      await p.cancelResponse(id);
      await submitAndComplete(p, 'new');
      gate.complete();
      await old;
      expect(
        events.where(
          (e) => e.kind == VoiceEventKind.audio && e.responseId == id,
        ),
        isEmpty,
      );
      expect(
        events.where((e) => e.kind == VoiceEventKind.cancelled),
        hasLength(1),
      );
      expect(llm.messages.last.where((m) => m['content'] == 'old'), isEmpty);
      await p.close();
    },
  );
  test('late ASR cannot revive after a new user turn', () async {
    final gate = Completer<void>(), asr = FakeAsr(), llm = FakeLlm();
    asr.gate = gate;
    final p = CascadedVoiceProvider(
      asr: asr,
      llm: llm,
      tts: FakeTts(),
      endpointing: SilenceEndpointing(minSpeechMs: 32, silenceEndMs: 32),
    );
    final events = <VoiceEvent>[];
    p.events.listen(events.add);
    await p.connect(epoch: 1, instructions: '');
    await p.sendAudio(sound(1));
    await p.sendAudio(sound(1, 0));
    await until(() => asr.inputs.isNotEmpty);
    await submitAndComplete(p, 'current');
    gate.complete();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(events.where((e) => e.text == 'heard'), isEmpty);
    expect(llm.messages, hasLength(1));
    await p.close();
  });
  test(
    'host facts ack idempotently, reject conflicting IDs, never offer tools',
    () async {
      final llm = FakeLlm();
      final p = CascadedVoiceProvider(asr: FakeAsr(), llm: llm, tts: FakeTts());
      final events = <VoiceEvent>[];
      p.events.listen(events.add);
      await p.connect(epoch: 1, instructions: '', tools: [tool]);
      const fact = VoiceHostItem(id: 'f1', text: 'Task complete', callId: 'c1');
      await p.injectHostItem(fact);
      await p.injectHostItem(fact);
      final completed = p.events.firstWhere(
        (e) => e.kind == VoiceEventKind.responseEnd,
      );
      await p.requestHostResponse('f1');
      await completed;
      expect(
        events.where((e) => e.kind == VoiceEventKind.hostAck),
        hasLength(2),
      );
      expect(llm.offeredTools.single, isEmpty);
      expect(
        llm.messages.single.where(
          (m) => (m['content'] as String).contains('Task complete'),
        ),
        hasLength(1),
      );
      await expectLater(
        p.injectHostItem(const VoiceHostItem(id: 'f1', text: 'changed')),
        throwsA(isA<CascadeFailure>()),
      );
      await p.close();
    },
  );
  test('host narration deferred while user speaks', () async {
    final llm = FakeLlm();
    final p = CascadedVoiceProvider(
      asr: FakeAsr(),
      llm: llm,
      tts: FakeTts(),
      endpointing: SilenceEndpointing(minSpeechMs: 32, silenceEndMs: 32),
    );
    await p.connect(epoch: 1, instructions: '', tools: [tool]);
    await p.injectHostItem(const VoiceHostItem(id: 'f', text: 'done'));
    await p.sendAudio(sound(1));
    await p.requestHostResponse('f');
    await p.injectHostItem(
      const VoiceHostItem(id: 'later', text: 'A different outcome'),
    );
    expect(llm.messages, isEmpty);
    await p.sendAudio(sound(1, 0));
    await until(() => llm.messages.length == 2);
    expect(llm.offeredTools.first, hasLength(1));
    expect(llm.offeredTools.last, isEmpty);
    expect(llm.messages.last.toString(), contains('done'));
    expect(
      llm.messages.last.toString(),
      isNot(contains('A different outcome')),
    );
    await p.close();
  });
  test(
    'tools emitted once after successful TTS; speech failure cannot dispatch',
    () async {
      final llm = FakeLlm()
        ..deltas = [
          const CascadeLlmDelta(text: 'Working.'),
          const CascadeLlmDelta(
            callId: 'c',
            name: 'delegate',
            arguments: {'task': 'x'},
          ),
        ];
      final tts = FakeTts();
      final p = CascadedVoiceProvider(asr: FakeAsr(), llm: llm, tts: tts);
      final events = <VoiceEvent>[];
      p.events.listen(events.add);
      await p.connect(epoch: 1, instructions: '', tools: [tool]);
      await submitAndComplete(p, 'go');
      expect(
        events.where((e) => e.kind == VoiceEventKind.toolCall),
        hasLength(1),
      );
      events.clear();
      tts.fail = true;
      await submitAndComplete(p, 'again');
      expect(events.where((e) => e.kind == VoiceEventKind.toolCall), isEmpty);
      expect(events.any((e) => e.code == 'test_tts_failure'), true);
      await p.close();
    },
  );
  test('missing ASR final and oversized LLM response fail closed', () async {
    final asr = FakeAsr()..finalResult = false, llm = FakeLlm();
    final p = CascadedVoiceProvider(
      asr: asr,
      llm: llm,
      tts: FakeTts(),
      endpointing: SilenceEndpointing(minSpeechMs: 32, silenceEndMs: 32),
    );
    final events = <VoiceEvent>[];
    p.events.listen(events.add);
    await p.connect(epoch: 1, instructions: '');
    await p.sendAudio(sound(1));
    await p.sendAudio(sound(1, 0));
    await until(() => events.any((e) => e.kind == VoiceEventKind.error));
    expect(llm.messages, isEmpty);
    llm.deltas = [CascadeLlmDelta(text: 'x' * 4001)];
    await submitAndComplete(p, 'long');
    expect(events.any((e) => e.code == 'response_text_overflow'), true);
    await p.close();
  });
  test(
    'Gemini wire: WAV transcription and configured TTS voice with PCM decode',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final bodies = <Map<String, dynamic>>[], paths = <String>[];
      server.listen((r) async {
        paths.add(r.uri.path);
        expect(r.headers.value('x-goog-api-key'), 'fake-key');
        final b =
            jsonDecode(await utf8.decoder.bind(r).join())
                as Map<String, dynamic>;
        bodies.add(b);
        r.response.headers.contentType = ContentType.json;
        r.response.write(
          jsonEncode({
            'candidates': [
              {
                'finishReason': 'STOP',
                'content': {
                  'parts': b['generationConfig']['responseModalities'] == null
                      ? [
                          {'text': 'hello'},
                        ]
                      : [
                          {
                            'inlineData': {
                              'mimeType': 'audio/L16;codec=pcm;rate=24000',
                              'data': base64Encode([1, 0, 2, 0]),
                            },
                          },
                        ],
                },
              },
            ],
          }),
        );
        await r.response.close();
      });
      final endpoint = 'http://127.0.0.1:${server.port}/v1beta';
      final result = await GeminiBatchAsr(
        endpoint: endpoint,
        model: 'asr-model',
        apiKey: 'fake-key',
      ).transcribe(sound(1), CascadeCancellation()).toList();
      expect(result.single.text, 'hello');
      final wav = base64Decode(
        bodies.first['contents'][0]['parts'][1]['inlineData']['data'],
      );
      expect(ascii.decode(wav.sublist(0, 4)), 'RIFF');
      expect(ByteData.sublistView(wav).getUint32(24, Endian.little), 16000);
      final audio = await GeminiBatchTts(
        endpoint: endpoint,
        model: 'tts-model',
        apiKey: 'fake-key',
        voice: 'test-voice',
      ).synthesize('Hello.', CascadeCancellation()).toList();
      expect(audio.single.pcm, [1, 0, 2, 0]);
      expect(paths, [
        '/v1beta/models/asr-model:generateContent',
        '/v1beta/models/tts-model:generateContent',
      ]);
      expect(
        bodies
            .last['generationConfig']['speechConfig']['voiceConfig']['prebuiltVoiceConfig']['voiceName'],
        'test-voice',
      );
      expect(
        decodeGeminiAudio(
          'audio/wav',
          base64Encode(pcmWav(Uint8List.fromList([1, 0]), 24000)),
        ),
        [1, 0],
      );
      expect(
        () => decodeGeminiAudio('audio/pcm;rate=16000', base64Encode([1, 0])),
        throwsA(isA<CascadeFailure>()),
      );
    },
  );
  test(
    'self-hosted WS ready, ordered PCM, finish, replace hypotheses and final',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      var received = 0;
      server.listen((r) async {
        final ws = await WebSocketTransformer.upgrade(r);
        ws.add(
          jsonEncode({'type': 'ready', 'sampleRate': 16000, 'format': 's16le'}),
        );
        await for (final e in ws) {
          if (e is List<int>) {
            received += e.length;
          } else if (e == 'finish') {
            ws.add(
              jsonEncode({'text': 'partial', 'replace': true, 'final': false}),
            );
            ws.add(
              jsonEncode({'text': 'final', 'replace': true, 'final': true}),
            );
          }
        }
      });
      final results = await SelfHostedWsAsr(
        endpoint: 'ws://127.0.0.1:${server.port}/asr',
      ).transcribe(sound(40), CascadeCancellation()).toList();
      expect(received, 40960);
      expect(results.map((r) => r.text), ['partial', 'final']);
      expect(results.last.isFinal, true);
    },
  );
  test(
    'self-hosted HTTP multipart PCM assembles samples across odd chunks',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      String? body;
      server.listen((r) async {
        body = await utf8.decoder.bind(r).join();
        r.response.headers.set('content-type', 'audio/pcm');
        r.response.headers.set('x-sample-rate', '24000');
        r.response.headers.set('x-sample-format', 's16le');
        r.response.add([1]);
        await r.response.flush();
        r.response.add([0, 2, 0]);
        await r.response.close();
      });
      final result = await SelfHostedPcmTts(
        endpoint: 'http://127.0.0.1:${server.port}/tts',
        instruction: 'neutral',
      ).synthesize('Hello', CascadeCancellation()).toList();
      expect(result.expand((a) => a.pcm), [1, 0, 2, 0]);
      expect(body, contains('name="text"\r\n\r\nHello'));
      expect(body, contains('name="instruction"\r\n\r\nneutral'));
    },
  );
  test('Gemini cancel closes pending HTTP request', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    final seen = Completer<void>();
    server.listen((r) async {
      await r.drain<void>();
      seen.complete();
    });
    final cancel = CascadeCancellation();
    final pending = GeminiBatchAsr(
      endpoint: 'http://127.0.0.1:${server.port}',
      model: 'm',
      apiKey: 'secret',
    ).transcribe(sound(1), cancel).toList();
    final assertion = expectLater(
      pending,
      throwsA(isA<CascadeFailure>().having((e) => e.code, 'code', 'cancelled')),
    );
    await seen.future;
    cancel.cancel();
    await assertion;
  });
  test(
    'standalone Dart ModelClient SSE normalizes fragmented tool calls once',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((r) async {
        await r.drain<void>();
        r.response.headers.set('content-type', 'text/event-stream');
        for (final d in [
          {'content': 'Okay.'},
          {
            'tool_calls': [
              {
                'index': 0,
                'id': 'call-1',
                'function': {'name': 'delegate', 'arguments': '{"task":'},
              },
            ],
          },
          {
            'tool_calls': [
              {
                'index': 0,
                'function': {'arguments': '"do it"}'},
              },
            ],
          },
        ]) {
          r.response.write(
            'data: ${jsonEncode({
              'choices': [
                {'delta': d},
              ],
            })}\n\n',
          );
        }
        r.response.write('data: [DONE]\n\n');
        await r.response.close();
      });
      final llm = ChatCompletionsCascadeLlm(
        configuration: ModelConfiguration(
          endpoint: 'http://127.0.0.1:${server.port}/chat/completions',
          model: 'fast',
          key: 'fake',
        ),
      );
      final result = await llm
          .generate(
            [
              {'role': 'user', 'content': 'go'},
            ],
            [tool],
            CascadeCancellation(),
          )
          .toList();
      expect(result.where((d) => d.callId != null), hasLength(1));
      expect(result.last.arguments, {'task': 'do it'});
    },
  );
  test(
    'long text splits bounded segments and completed pairs seed next turn',
    () async {
      final llm = FakeLlm()..deltas = [CascadeLlmDelta(text: 'a' * 600)];
      final tts = FakeTts();
      final p = CascadedVoiceProvider(asr: FakeAsr(), llm: llm, tts: tts);
      await p.connect(epoch: 1, instructions: '');
      await submitAndComplete(p, 'first');
      expect(tts.segments.map((s) => s.length), [256, 256, 88]);
      await submitAndComplete(p, 'second');
      expect(
        llm.messages.last.where((m) => m['content'] == 'first'),
        hasLength(1),
      );
      expect(
        llm.messages.last.where((m) => m['role'] == 'assistant'),
        hasLength(1),
      );
      await p.close();
    },
  );
  test('duplicate tool IDs fail before any executable tool event', () async {
    const call = CascadeLlmDelta(
      callId: 'c',
      name: 'delegate',
      arguments: {'task': 'x'},
    );
    final llm = FakeLlm()..deltas = [call, call];
    final p = CascadedVoiceProvider(asr: FakeAsr(), llm: llm, tts: FakeTts());
    final events = <VoiceEvent>[];
    p.events.listen(events.add);
    await p.connect(epoch: 1, instructions: '', tools: [tool]);
    await submitAndComplete(p, 'go');
    expect(events.where((e) => e.kind == VoiceEventKind.toolCall), isEmpty);
    expect(events.any((e) => e.code == 'duplicate_tool_call'), true);
    await p.close();
  });
  test('close fences pending synthesis and refuses further input', () async {
    final gate = Completer<void>(), tts = FakeTts();
    tts.gate = gate;
    final p = CascadedVoiceProvider(asr: FakeAsr(), llm: FakeLlm(), tts: tts);
    final events = <VoiceEvent>[];
    p.events.listen(events.add);
    await p.connect(epoch: 1, instructions: '');
    final active = p.submitText('go');
    await until(() => tts.segments.isNotEmpty);
    await p.close();
    gate.complete();
    await active;
    expect(events.where((e) => e.kind == VoiceEventKind.audio), isEmpty);
    await expectLater(p.submitText('late'), throwsA(isA<CascadeFailure>()));
  });
  test(
    'self-hosted ASR rejects wrong sample rate before uploading audio',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      var received = false;
      server.listen((r) async {
        final ws = await WebSocketTransformer.upgrade(r);
        ws.add(
          jsonEncode({'type': 'ready', 'sampleRate': 24000, 'format': 's16le'}),
        );
        await for (final event in ws) {
          if (event is List<int>) received = true;
        }
      });
      await expectLater(
        SelfHostedWsAsr(
          endpoint: 'ws://127.0.0.1:${server.port}',
        ).transcribe(sound(1), CascadeCancellation()).toList(),
        throwsA(
          isA<CascadeFailure>().having(
            (e) => e.code,
            'code',
            'invalid_asr_ready',
          ),
        ),
      );
      expect(received, false);
    },
  );
  test('self-hosted TTS rejects odd final byte and mismatched rate', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    var rate = '24000';
    server.listen((r) async {
      await r.drain<void>();
      r.response.headers.set('content-type', 'audio/pcm');
      r.response.headers.set('x-sample-rate', rate);
      r.response.headers.set('x-sample-format', 's16le');
      r.response.add([1]);
      await r.response.close();
    });
    final tts = SelfHostedPcmTts(endpoint: 'http://127.0.0.1:${server.port}');
    await expectLater(
      tts.synthesize('hello', CascadeCancellation()).toList(),
      throwsA(
        isA<CascadeFailure>().having(
          (e) => e.code,
          'code',
          'incomplete_tts_audio',
        ),
      ),
    );
    rate = '16000';
    await expectLater(
      tts.synthesize('hello', CascadeCancellation()).toList(),
      throwsA(
        isA<CascadeFailure>().having(
          (e) => e.code,
          'code',
          'invalid_tts_audio_format',
        ),
      ),
    );
  });
  for (final host in [false, true]) {
    test(
      '${host ? "host response" : "submit text"} acknowledges dispatch before delayed LLM and TTS finish',
      () async {
        final llmGate = Completer<void>(), ttsGate = Completer<void>();
        final llm = FakeLlm()..gate = llmGate;
        final tts = FakeTts()..gate = ttsGate;
        final provider = CascadedVoiceProvider(
          asr: FakeAsr(),
          llm: llm,
          tts: tts,
        );
        final events = <VoiceEvent>[];
        provider.events.listen(events.add);
        addTearDown(() async {
          if (!llmGate.isCompleted) llmGate.complete();
          if (!ttsGate.isCompleted) ttsGate.complete();
          await provider.close();
        });
        await provider.connect(epoch: 1, instructions: '');
        if (host) {
          await provider.injectHostItem(
            const VoiceHostItem(id: 'fact', text: 'done'),
          );
        }
        var accepted = false;
        final command = host
            ? provider.requestHostResponse('fact')
            : provider.submitText('hello');
        unawaited(
          command.then((_) {
            accepted = true;
          }),
        );
        await until(() => accepted && llm.messages.isNotEmpty);
        expect(
          events.where((e) => e.kind == VoiceEventKind.responseStart),
          hasLength(1),
        );
        expect(
          events.where((e) => e.kind == VoiceEventKind.responseEnd),
          isEmpty,
        );
        expect(tts.segments, isEmpty);
        llmGate.complete();
        await until(() => tts.segments.isNotEmpty);
        expect(events.where((e) => e.kind == VoiceEventKind.audio), isEmpty);
        expect(
          events.where((e) => e.kind == VoiceEventKind.responseEnd),
          isEmpty,
        );
        ttsGate.complete();
        await until(
          () => events.any((e) => e.kind == VoiceEventKind.responseEnd),
        );
        expect(
          events.where((e) => e.kind == VoiceEventKind.responseEnd),
          hasLength(1),
        );
        expect(events.where((e) => e.kind == VoiceEventKind.audio), isNotEmpty);
        expect(events.where((e) => e.kind == VoiceEventKind.error), isEmpty);
      },
    );
  }
}
