import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_provider.dart';
import 'package:nova_mobile/voice/providers/qwen_realtime_voice_provider.dart';
import 'package:nova_mobile/voice/providers/gemini_live_voice_provider.dart';
import 'package:nova_mobile/voice/providers/realtime_socket.dart';

class Wire {
  late HttpServer server;
  WebSocket? socket;
  final frames = <Map<String, dynamic>>[];
  final connected = Completer<void>();
  bool acknowledgeItems = true, closing = false;
  Future<void> open({bool gemini = false, bool acknowledge = true}) async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((r) async {
      socket = await WebSocketTransformer.upgrade(r);
      connected.complete();
      if (!gemini) {
        send({
          'type': 'session.created',
          'session': {'id': 's'},
        });
      }
      socket!.listen((raw) {
        final f = jsonDecode(raw as String) as Map<String, dynamic>;
        frames.add(f);
        if (acknowledge && f['type'] == 'session.update') {
          send({
            'type': 'session.updated',
            'session': {'id': 's'},
          });
        }
        if (acknowledge && f.containsKey('setup')) send({'setupComplete': {}});
        if (acknowledge &&
            acknowledgeItems &&
            f['type'] == 'conversation.item.create') {
          send({'type': 'conversation.item.created', 'item': f['item']});
        }
      });
    });
  }

  String get endpoint => 'ws://127.0.0.1:${server.port}/live';
  void send(Map<String, dynamic> frame) {
    if (!closing && socket?.readyState == WebSocket.open) {
      socket!.add(jsonEncode(frame));
    }
  }

  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 30));
  Future<void> waitForFrame(bool Function(Map<String, dynamic>) matches) async {
    final deadline = DateTime.now().add(const Duration(seconds: 2));
    while (!frames.any(matches)) {
      if (DateTime.now().isAfter(deadline)) {
        throw StateError('Expected wire frame not received');
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  Future<void> close() async {
    closing = true;
    await socket?.close();
    await server.close(force: true);
  }
}

const delegatedTools = <Map<String, dynamic>>[
  {
    'type': 'function',
    'function': {
      'name': 'delegate_task',
      'description': 'Run a task',
      'parameters': {
        'type': 'object',
        'properties': {
          'task': {'type': 'string'},
        },
        'required': ['task'],
      },
    },
  },
];
void main() {
  for (final profile in IntegratedVoiceProfile.values) {
    test(
      '$profile restores both roles using its accepted history format',
      () async {
        final wire = Wire();
        await wire.open();
        final provider = QwenRealtimeVoiceProvider(
          endpoint: wire.endpoint,
          model: 'test',
          apiKey: 'test',
          voice: 'voice',
          profile: profile,
        );
        final subscription = provider.events.listen((_) {});
        addTearDown(() async {
          await provider.close();
          await subscription.cancel();
          await wire.close();
        });
        await provider.connect(
          epoch: 1,
          instructions: 'Continue the conversation.',
          history: const [
            VoiceHistoryItem('user', 'Remember 43.'),
            VoiceHistoryItem('assistant', '43.'),
          ],
        );
        final items = wire.frames
            .where((frame) => frame['type'] == 'conversation.item.create')
            .map((frame) => frame['item'] as Map)
            .toList();
        expect(items.map((item) => item['role']), ['user', 'assistant']);
        expect(items[0]['content'], [
          {'type': 'input_text', 'text': 'Remember 43.'},
        ]);
        expect(items[1]['content'], [
          {
            'type': profile == IntegratedVoiceProfile.qwen
                ? 'output_text'
                : 'text',
            'text': '43.',
          },
        ]);
        expect(
          wire.frames.where((frame) => frame['type'] == 'response.create'),
          isEmpty,
        );
      },
    );
  }

  for (final profile in IntegratedVoiceProfile.values) {
    test(
      '$profile setup, audio and completed tool calls; cancel fences late frames',
      () async {
        final wire = Wire();
        await wire.open();
        final provider = QwenRealtimeVoiceProvider(
          endpoint: wire.endpoint,
          model: 'test',
          apiKey: 'test-key',
          voice: 'voice',
          profile: profile,
          connectTimeout: const Duration(milliseconds: 300),
        );
        final events = <VoiceEvent>[];
        final sub = provider.events.listen(events.add);
        addTearDown(() async {
          await provider.close();
          await sub.cancel();
          await wire.close();
        });
        await provider.connect(
          epoch: 7,
          instructions: 'brief',
          tools: delegatedTools,
        );
        final setup =
            wire.frames.firstWhere(
                  (f) => f['type'] == 'session.update',
                )['session']
                as Map;
        final tool = (setup['tools'] as List).single as Map;
        expect(
          profile == IntegratedVoiceProfile.stepfun
              ? tool['function']['name']
              : tool['name'],
          'delegate_task',
        );
        if (profile == IntegratedVoiceProfile.openai) {
          expect(setup['audio']['input']['format']['rate'], 24000);
          expect(setup['type'], 'realtime');
        } else {
          expect(
            setup['input_audio_format'],
            profile == IntegratedVoiceProfile.qwen ? 'pcm' : 'pcm16',
          );
        }
        await provider.sendAudio(Uint8List.fromList([0, 0, 1, 0, 2, 0]));
        await wire.settle();
        expect(
          wire.frames.where((f) => f['type'] == 'response.create'),
          isEmpty,
        );
        final audio = base64Decode(wire.frames.last['audio'] as String);
        expect(audio.length, profile == IntegratedVoiceProfile.qwen ? 6 : 8);
        wire.send({
          'type': 'response.created',
          'response': {'id': 'r'},
        });
        wire.send({
          'type': 'response.function_call_arguments.delta',
          'response_id': 'r',
          'delta': '{"x":',
        });
        wire.send({
          'type': 'response.function_call_arguments.done',
          'response_id': 'r',
          'item_id': 'i',
          'call_id': 'c',
          'name': 'run',
          'arguments': '{"x":1}',
        });
        wire.send({
          'type': 'response.function_call_arguments.done',
          'response_id': 'r',
          'item_id': 'i',
          'call_id': 'c',
          'name': 'run',
          'arguments': '{"x":1}',
        });
        await wire.settle();
        expect(
          events
              .where((e) => e.kind == VoiceEventKind.toolCall)
              .single
              .arguments,
          {'x': 1},
        );
        await provider.cancelResponse('r');
        wire.send({
          'type': profile == IntegratedVoiceProfile.openai
              ? 'response.output_audio.delta'
              : 'response.audio.delta',
          'response_id': 'r',
          'item_id': 'a',
          'content_index': 0,
          'delta': 'AAA=',
        });
        wire.send({
          'type': 'response.created',
          'response': {'id': 'r'},
        });
        await wire.settle();
        expect(events.where((e) => e.kind == VoiceEventKind.audio), isEmpty);
        expect(
          events.where((e) => e.kind == VoiceEventKind.responseStart).length,
          1,
        );
        expect(events.every((e) => e.epoch == 7), isTrue);
      },
    );
  }
  test('host result waits for ack; host response disables tools', () async {
    final wire = Wire();
    await wire.open();
    final provider = QwenRealtimeVoiceProvider(
      endpoint: wire.endpoint,
      model: 'test',
      apiKey: 'test',
      voice: 'voice',
    );
    final events = <VoiceEvent>[];
    final sub = provider.events.listen(events.add);
    addTearDown(() async {
      await provider.close();
      await sub.cancel();
      await wire.close();
    });
    await provider.connect(
      epoch: 1,
      instructions: 'Use Simplified Chinese for user-facing speech.',
      history: const [VoiceHistoryItem('user', 'prior')],
    );
    await provider.injectHostItem(
      const VoiceHostItem(id: 'host1', text: '计数器已完成，按钮测试通过。'),
    );
    expect(
      events.where((e) => e.kind == VoiceEventKind.hostAck).single.itemId,
      'host1',
    );
    await provider.requestHostResponse('host1');
    await wire.settle();
    expect(
      wire.frames.last['response']['instructions'],
      contains('计数器已完成，按钮测试通过。'),
    );
    expect(wire.frames.last['response']['tool_choice'], 'none');
    expect(wire.frames.last['response']['tools'], isEmpty);
    expect(
      wire.frames.last['response']['instructions'],
      contains('Use Simplified Chinese'),
    );
    expect(
      wire.frames.last['response']['instructions'],
      contains('Do not perform work or call tools'),
    );
  });
  test(
    'host activation selects its acknowledged ID, not newest history',
    () async {
      final wire = Wire();
      await wire.open();
      final provider = QwenRealtimeVoiceProvider(
        endpoint: wire.endpoint,
        model: 'test',
        apiKey: 'test',
        voice: 'voice',
      );
      final sub = provider.events.listen((_) {});
      addTearDown(() async {
        await provider.close();
        await sub.cancel();
        await wire.close();
      });
      await provider.connect(epoch: 1, instructions: 'Speak Chinese.');
      await provider.injectHostItem(
        const VoiceHostItem(id: 'accepted', text: '已接单'),
      );
      await provider.injectHostItem(
        const VoiceHostItem(id: 'completed', text: '已完成并测试通过'),
      );
      await expectLater(
        provider.requestHostResponse('missing'),
        throwsStateError,
      );
      expect(await provider.requestHostResponse('accepted'), {'accepted'});
      await wire.settle();
      final first = wire.frames.last['response']['instructions'] as String;
      expect(first, contains('已接单'));
      expect(first, isNot(contains('已完成并测试通过')));
      await expectLater(
        provider.requestHostResponse('completed'),
        throwsStateError,
      );
      wire.send({
        'type': 'response.created',
        'response': {'id': 'ack'},
      });
      wire.send({
        'type': 'response.done',
        'response': {'id': 'ack', 'status': 'completed'},
      });
      await wire.settle();
      await expectLater(
        provider.requestHostResponse('accepted'),
        throwsStateError,
      );
      expect(await provider.requestHostResponse('completed'), {'completed'});
      await wire.settle();
      final second = wire.frames.last['response']['instructions'] as String;
      expect(second, contains('已完成并测试通过'));
      expect(second, isNot(contains('已接单')));
    },
  );
  test(
    'Qwen speech during narration preparation never creates a host response',
    () async {
      final wire = Wire();
      await wire.open();
      final provider = QwenRealtimeVoiceProvider(
        endpoint: wire.endpoint,
        model: 'test',
        apiKey: 'test',
        voice: 'voice',
      );
      final events = <VoiceEvent>[];
      final sub = provider.events.listen(events.add);
      addTearDown(() async {
        await provider.close();
        await sub.cancel();
        await wire.close();
      });
      await provider.connect(epoch: 1, instructions: 'brief');
      await provider.injectHostItem(
        const VoiceHostItem(id: 'fact', text: 'done'),
      );
      wire.acknowledgeItems = false;
      final requested = expectLater(
        provider.requestHostResponse('fact'),
        throwsUnsupportedError,
      );
      await wire.waitForFrame((f) => f['item']?['role'] == 'user');
      final item = wire.frames.lastWhere(
        (f) => f['item']?['role'] == 'user',
      )['item'];
      wire.send({
        'type': 'input_audio_buffer.speech_started',
        'item_id': 'real-user',
      });
      wire.send({'type': 'conversation.item.created', 'item': item});
      await requested;
      expect(wire.frames.where((f) => f['type'] == 'response.create'), isEmpty);
      expect(provider.capabilities.voiceTools, isFalse);
    },
  );
  test(
    'Gemini text tool call, automatic turn, truthful unsupported actions',
    () async {
      final wire = Wire();
      await wire.open(gemini: true);
      final provider = GeminiLiveVoiceProvider(
        endpoint: wire.endpoint,
        model: 'gemini-test',
        apiKey: 'test',
        voice: 'voice',
      );
      final events = <VoiceEvent>[];
      final sub = provider.events.listen(events.add);
      addTearDown(() async {
        await provider.close();
        await sub.cancel();
        await wire.close();
      });
      await provider.connect(
        epoch: 2,
        instructions: 'brief',
        tools: delegatedTools,
      );
      expect(
        wire
            .frames
            .first['setup']['tools'][0]['functionDeclarations'][0]['name'],
        'delegate_task',
      );
      await provider.submitText('run the requested tool');
      wire.send({
        'serverContent': {
          'modelTurn': {
            'parts': [
              {
                'inlineData': {
                  'mimeType': 'audio/pcm;rate=24000',
                  'data': 'AAA=',
                },
              },
            ],
          },
        },
      });
      wire.send({
        'toolCall': {
          'functionCalls': [
            {
              'id': 'c',
              'name': 'run',
              'args': {'x': 1},
            },
          ],
        },
      });
      await wire.settle();
      expect(
        events.where((e) => e.kind == VoiceEventKind.audio).single.sampleRate,
        24000,
      );
      expect(
        events.where((e) => e.kind == VoiceEventKind.toolCall).single.arguments,
        {'x': 1},
      );
      await expectLater(
        provider.cancelResponse(
          events
              .firstWhere((e) => e.kind == VoiceEventKind.responseStart)
              .responseId!,
        ),
        throwsUnsupportedError,
      );
      await provider.injectHostItem(
        const VoiceHostItem(id: 'h', text: 'done', callId: 'c'),
      );
      await provider.requestHostResponse('h');
      await wire.settle();
      expect(
        wire.frames.last['toolResponse']['functionResponses'][0]['id'],
        'c',
      );
      expect(events.where((e) => e.kind == VoiceEventKind.hostAck), isEmpty);
      await expectLater(
        provider.reportPlayback('r', 0, interrupted: true),
        throwsUnsupportedError,
      );
    },
  );
  test('Gemini audio tool origins are unverified and never executable', () async {
    final wire = Wire();
    await wire.open(gemini: true);
    final provider = GeminiLiveVoiceProvider(
      endpoint: wire.endpoint,
      model: 'test',
      apiKey: 'test',
      voice: 'voice',
    );
    final events = <VoiceEvent>[];
    final sub = provider.events.listen(events.add);
    addTearDown(() async {
      await provider.close();
      await sub.cancel();
      await wire.close();
    });
    await provider.connect(epoch: 3, instructions: 'brief');
    await provider.sendAudio(Uint8List(2));
    await wire.settle();
    expect(
      wire.frames.last['realtimeInput']['audio']['mimeType'],
      'audio/pcm;rate=16000',
    );
    wire.send({
      'serverContent': {
        'inputTranscription': {'text': 'do it', 'finished': true},
      },
    });
    wire.send({
      'toolCall': {
        'functionCalls': [
          {'id': 'c', 'name': 'run', 'args': {}},
        ],
      },
    });
    await wire.settle();
    expect(events.where((e) => e.kind == VoiceEventKind.toolCall), isEmpty);
    expect(
      wire
          .frames
          .last['toolResponse']['functionResponses'][0]['response']['error']['code'],
      'unverified_input_origin',
    );
    final start = events.firstWhere(
      (e) => e.kind == VoiceEventKind.speechStart,
    );
    expect(
      events
          .firstWhere((e) => e.kind == VoiceEventKind.transcript && e.isFinal)
          .itemId,
      start.itemId,
    );
    wire.send({
      'serverContent': {
        'interrupted': true,
        'modelTurn': {
          'parts': [
            {
              'inlineData': {
                'mimeType': 'audio/pcm;rate=24000',
                'data': 'AAA=',
              },
            },
          ],
        },
      },
    });
    await wire.settle();
    expect(events.where((e) => e.kind == VoiceEventKind.audio), isEmpty);
  });
  test('streaming resampler retains phase across uneven capture chunks', () {
    final input = Uint8List.fromList([0, 0, 10, 0, 20, 0, 30, 0, 40, 0]);
    final whole = StreamingPcm16Resampler(16000, 24000).convert(input);
    final split = StreamingPcm16Resampler(16000, 24000);
    expect([
      ...split.convert(Uint8List.sublistView(input, 0, 2)),
      ...split.convert(Uint8List.sublistView(input, 2, 6)),
      ...split.convert(Uint8List.sublistView(input, 6)),
    ], whole);
  });
  test('setup timeout sanitizes errors and closes resources', () async {
    final wire = Wire();
    await wire.open(acknowledge: false);
    final provider = QwenRealtimeVoiceProvider(
      endpoint: wire.endpoint,
      model: 'test',
      apiKey: 'secret-must-not-appear',
      voice: 'voice',
      connectTimeout: const Duration(milliseconds: 60),
    );
    final events = <VoiceEvent>[];
    final sub = provider.events.listen(events.add);
    addTearDown(() async {
      await provider.close();
      await sub.cancel();
      await wire.close();
    });
    await expectLater(
      provider.connect(epoch: 1, instructions: 'brief'),
      throwsStateError,
    );
    expect(events.any((e) => e.kind == VoiceEventKind.ready), isFalse);
    expect(
      events.map((e) => e.text).join(),
      isNot(contains('secret-must-not-appear')),
    );
    await expectLater(provider.sendAudio(Uint8List(2)), throwsStateError);
  });
  test(
    'OpenAI truncation uses actual item and clamps rendered duration',
    () async {
      final wire = Wire();
      await wire.open();
      final provider = QwenRealtimeVoiceProvider(
        endpoint: wire.endpoint,
        model: 'test',
        apiKey: 'test',
        voice: 'voice',
        profile: IntegratedVoiceProfile.openai,
      );
      final sub = provider.events.listen((_) {});
      addTearDown(() async {
        await provider.close();
        await sub.cancel();
        await wire.close();
      });
      await provider.connect(epoch: 1, instructions: 'brief');
      wire.send({
        'type': 'response.created',
        'response': {'id': 'r'},
      });
      wire.send({
        'type': 'response.output_audio.delta',
        'response_id': 'r',
        'item_id': 'item',
        'content_index': 0,
        'delta': base64Encode(Uint8List(4800)),
      });
      await wire.settle();
      await provider.reportPlayback('r', 400, interrupted: true);
      await wire.settle();
      expect(wire.frames.last, {
        'type': 'conversation.item.truncate',
        'item_id': 'item',
        'content_index': 0,
        'audio_end_ms': 100,
      });
    },
  );
  test(
    'unknown host delivery cannot be silently retried or acknowledged late',
    () async {
      final wire = Wire();
      await wire.open();
      final provider = QwenRealtimeVoiceProvider(
        endpoint: wire.endpoint,
        model: 'test',
        apiKey: 'test',
        voice: 'voice',
        // Exercise the missing item acknowledgement, not loopback startup speed.
        connectTimeout: const Duration(seconds: 2),
      );
      final events = <VoiceEvent>[];
      final sub = provider.events.listen(events.add);
      addTearDown(() async {
        await provider.close();
        await sub.cancel();
        await wire.close();
      });
      await provider.connect(epoch: 1, instructions: 'brief');
      wire.acknowledgeItems = false;
      const item = VoiceHostItem(id: 'unknown', text: 'done');
      await expectLater(provider.injectHostItem(item), throwsStateError);
      await expectLater(provider.injectHostItem(item), throwsStateError);
      wire.send({
        'type': 'conversation.item.created',
        'item': {'id': 'unknown'},
      });
      await wire.settle();
      expect(events.where((e) => e.kind == VoiceEventKind.hostAck), isEmpty);
      await expectLater(
        provider.requestHostResponse('unknown'),
        throwsStateError,
      );
      expect(
        wire.frames
            .where((f) => f['type'] == 'conversation.item.create')
            .length,
        1,
      );
    },
  );
  test(
    'closing a never-connected provider releases its event stream',
    () async {
      final provider = QwenRealtimeVoiceProvider(
        endpoint: 'ws://127.0.0.1:1',
        model: 'test',
        apiKey: 'test',
        voice: 'voice',
      );
      final done = Completer<void>();
      provider.events.listen((_) {}, onDone: done.complete);
      await provider.close();
      await done.future.timeout(const Duration(seconds: 1));
      await expectLater(
        provider.connect(epoch: 1, instructions: 'brief'),
        throwsStateError,
      );
    },
  );
  test('malformed audio produces sanitized terminal failure', () async {
    final wire = Wire();
    await wire.open();
    final provider = QwenRealtimeVoiceProvider(
      endpoint: wire.endpoint,
      model: 'test',
      apiKey: 'never-log-this',
      voice: 'voice',
    );
    final events = <VoiceEvent>[];
    final sub = provider.events.listen(events.add);
    addTearDown(() async {
      await provider.close();
      await sub.cancel();
      await wire.close();
    });
    await provider.connect(epoch: 4, instructions: 'brief');
    wire.send({
      'type': 'response.created',
      'response': {'id': 'r'},
    });
    wire.send({
      'type': 'response.audio.delta',
      'response_id': 'r',
      'delta': 'AA==',
    });
    await wire.settle();
    expect(events.where((e) => e.kind == VoiceEventKind.audio), isEmpty);
    expect(
      events.where((e) => e.kind == VoiceEventKind.error).single.code,
      'protocol_error',
    );
    expect(events.map((e) => e.text).join(), isNot(contains('never-log-this')));
  });
  for (final profile in IntegratedVoiceProfile.values) {
    test(
      '$profile host activation overlap fences tools without killing fresh speech',
      () async {
        final wire = Wire();
        await wire.open();
        final provider = QwenRealtimeVoiceProvider(
          endpoint: wire.endpoint,
          model: 'test',
          apiKey: 'test',
          voice: 'voice',
          profile: profile,
        );
        final events = <VoiceEvent>[];
        final sub = provider.events.listen(events.add);
        addTearDown(() async {
          await provider.close();
          await sub.cancel();
          await wire.close();
        });
        await provider.connect(
          epoch: 8,
          instructions: 'brief',
          tools: delegatedTools,
        );
        await provider.injectHostItem(
          const VoiceHostItem(id: 'fact', text: 'completed'),
        );
        await provider.requestHostResponse('fact');
        await wire.settle();
        expect(wire.frames.last['response']['tools'], isEmpty);
        wire.send({
          'type': 'input_audio_buffer.speech_started',
          'item_id': 'overlap-user',
        });
        wire.send({
          'type': 'response.created',
          'response': {'id': 'ambiguous'},
        });
        wire.send({
          'type': 'response.function_call_arguments.done',
          'response_id': 'ambiguous',
          'item_id': 'tool',
          'call_id': 'unsafe',
          'name': 'delegate_task',
          'arguments': '{}',
        });
        wire.send({
          'type': 'response.audio.delta',
          'response_id': 'ambiguous',
          'delta': 'AAA=',
        });
        await wire.settle();
        expect(provider.capabilities.voiceTools, isFalse);
        expect(
          events
              .where((e) => e.kind == VoiceEventKind.responseStart)
              .single
              .hostOrigin,
          isNull,
        );
        expect(
          events.where((e) => e.kind == VoiceEventKind.cancelled).single.code,
          'ambiguous_host_activation',
        );
        expect(
          events.where(
            (e) =>
                e.kind == VoiceEventKind.audio ||
                e.kind == VoiceEventKind.toolCall ||
                e.kind == VoiceEventKind.error,
          ),
          isEmpty,
        );
        await wire.waitForFrame(
          (f) =>
              f['type'] == 'response.cancel' && f['response_id'] == 'ambiguous',
        );
        expect(
          wire.frames
              .where(
                (f) =>
                    f['type'] == 'response.cancel' &&
                    f['response_id'] == 'ambiguous',
              )
              .length,
          1,
        );
        wire.send({
          'type': 'response.done',
          'response': {'id': 'ambiguous', 'status': 'cancelled'},
        });
        wire.send({
          'type': 'response.function_call_arguments.done',
          'response_id': 'ambiguous',
          'item_id': 'late-tool',
          'call_id': 'late',
          'name': 'delegate_task',
          'arguments': '{}',
        });
        wire.send({
          'type': 'input_audio_buffer.speech_stopped',
          'item_id': 'overlap-user',
        });
        wire.send({
          'type': 'input_audio_buffer.speech_started',
          'item_id': 'fresh-user',
        });
        wire.send({
          'type': 'input_audio_buffer.speech_stopped',
          'item_id': 'fresh-user',
        });
        wire.send({
          'type': 'response.created',
          'response': {'id': 'fresh'},
        });
        wire.send({
          'type': 'response.audio.delta',
          'response_id': 'fresh',
          'item_id': 'fresh-audio',
          'content_index': 0,
          'delta': 'AAA=',
        });
        wire.send({
          'type': 'response.text.delta',
          'response_id': 'fresh',
          'delta': 'Fresh spoken reply',
        });
        wire.send({
          'type': 'response.done',
          'response': {'id': 'fresh', 'status': 'completed'},
        });
        await wire.settle();
        expect(
          events.where((e) => e.kind == VoiceEventKind.audio).single.responseId,
          'fresh',
        );
        expect(
          events.where((e) => e.kind == VoiceEventKind.text).single.text,
          'Fresh spoken reply',
        );
        expect(
          events.where(
            (e) =>
                e.kind == VoiceEventKind.error ||
                e.kind == VoiceEventKind.toolCall,
          ),
          isEmpty,
        );
        await provider.submitText('A fresh typed turn');
        await wire.settle();
        wire.send({
          'type': 'response.created',
          'response': {'id': 'typed'},
        });
        wire.send({
          'type': 'response.function_call_arguments.done',
          'response_id': 'typed',
          'item_id': 'typed-tool',
          'call_id': 'still-blocked',
          'name': 'delegate_task',
          'arguments': '{}',
        });
        await wire.settle();
        expect(
          events.where(
            (e) =>
                e.kind == VoiceEventKind.toolCall ||
                e.kind == VoiceEventKind.error,
          ),
          isEmpty,
        );
        expect(events.last.code, 'origin_uncertain');
        expect(provider.capabilities.voiceTools, isFalse);
      },
    );
    test(
      '$profile pins host origin to one response through overlapping terminals',
      () async {
        final wire = Wire();
        await wire.open();
        final provider = QwenRealtimeVoiceProvider(
          endpoint: wire.endpoint,
          model: 'test',
          apiKey: 'test',
          voice: 'voice',
          profile: profile,
        );
        final events = <VoiceEvent>[];
        final sub = provider.events.listen(events.add);
        addTearDown(() async {
          await provider.close();
          await sub.cancel();
          await wire.close();
        });
        await provider.connect(epoch: 9, instructions: 'brief');
        await provider.injectHostItem(
          const VoiceHostItem(id: 'fact', text: 'completed'),
        );
        await provider.requestHostResponse('fact');
        wire.send({
          'type': 'response.created',
          'response': {'id': 'host'},
        });
        wire.send({
          'type': 'input_audio_buffer.speech_started',
          'item_id': 'user',
        });
        wire.send({
          'type': 'response.created',
          'response': {'id': 'user-response'},
        });
        wire.send({
          'type': 'response.done',
          'response': {'id': 'user-response', 'status': 'completed'},
        });
        wire.send({
          'type': 'response.function_call_arguments.done',
          'response_id': 'host',
          'item_id': 'h-tool',
          'call_id': 'unsafe',
          'name': 'delegate_task',
          'arguments': '{}',
        });
        await wire.settle();
        final starts = events
            .where((e) => e.kind == VoiceEventKind.responseStart)
            .toList();
        expect(starts.map((e) => e.hostOrigin), [true, false]);
        expect(
          events.where(
            (e) =>
                e.kind == VoiceEventKind.toolCall ||
                e.kind == VoiceEventKind.error,
          ),
          isEmpty,
        );
        expect(events.last.code, 'host_tool_blocked');
        expect(provider.capabilities.voiceTools, isTrue);
      },
    );
  }
  test(
    'Qwen observed text/stash ASR snapshots replace partials until completed',
    () async {
      final wire = Wire();
      await wire.open();
      final provider = QwenRealtimeVoiceProvider(
        endpoint: wire.endpoint,
        model: 'test',
        apiKey: 'test',
        voice: 'voice',
      );
      final events = <VoiceEvent>[];
      final sub = provider.events.listen(events.add);
      addTearDown(() async {
        await provider.close();
        await sub.cancel();
        await wire.close();
      });
      await provider.connect(epoch: 12, instructions: 'brief');
      wire.send({
        'type': 'input_audio_buffer.speech_started',
        'item_id': 'spoken',
      });
      for (final partial in [
        {'text': '', 'stash': '帮我'},
        {'text': '', 'stash': '帮我口头整理一个'},
        {'text': '帮我口头整理一个虚构的', 'stash': '采购清单：3个苹果、2盒盒牛奶，不'},
        {'text': '帮我口头整理一个虚构的', 'stash': '采购清单：3个苹果、2盒牛奶，不要真的下单'},
      ]) {
        wire.send({
          'type': 'conversation.item.input_audio_transcription.delta',
          'item_id': 'spoken',
          'content_index': 0,
          ...partial,
        });
      }
      await wire.settle();
      final partials = events
          .where((e) => e.kind == VoiceEventKind.transcript)
          .toList();
      expect(partials.length, 4);
      expect(
        partials.every((e) => e.replace && !e.isFinal && e.itemId == 'spoken'),
        isTrue,
      );
      expect(partials.first.text, '帮我');
      expect(partials.last.text, '帮我口头整理一个虚构的采购清单：3个苹果、2盒牛奶，不要真的下单');
      wire.send({
        'type': 'conversation.item.input_audio_transcription.completed',
        'item_id': 'spoken',
        'content_index': 0,
        'transcript': '帮我口头整理一个虚构的采购清单：3个苹果、2盒牛奶，不要真的下单。',
      });
      wire.send({
        'type': 'response.created',
        'response': {'id': 'reply'},
      });
      wire.send({
        'type': 'response.audio.delta',
        'response_id': 'reply',
        'delta': 'AAA=',
      });
      await wire.settle();
      expect(
        events
            .where((e) => e.kind == VoiceEventKind.transcript && e.isFinal)
            .single
            .itemId,
        'spoken',
      );
      expect(
        events.where((e) => e.kind == VoiceEventKind.audio).single.responseId,
        'reply',
      );
      expect(events.where((e) => e.kind == VoiceEventKind.error), isEmpty);
    },
  );
  test('Qwen text/stash ASR still rejects malformed field types', () async {
    final wire = Wire();
    await wire.open();
    final provider = QwenRealtimeVoiceProvider(
      endpoint: wire.endpoint,
      model: 'test',
      apiKey: 'test',
      voice: 'voice',
    );
    final events = <VoiceEvent>[];
    final sub = provider.events.listen(events.add);
    addTearDown(() async {
      await provider.close();
      await sub.cancel();
      await wire.close();
    });
    await provider.connect(epoch: 13, instructions: 'brief');
    wire.send({
      'type': 'conversation.item.input_audio_transcription.delta',
      'item_id': 'spoken',
      'text': 'prefix',
      'stash': 42,
    });
    await wire.settle();
    expect(
      events.where((e) => e.kind == VoiceEventKind.error).single.code,
      'protocol_error',
    );
    expect(events.where((e) => e.kind == VoiceEventKind.transcript), isEmpty);
  });
}
