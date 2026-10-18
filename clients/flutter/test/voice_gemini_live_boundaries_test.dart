import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/providers/gemini_live_voice_provider.dart';
import 'package:nova_mobile/voice/voice_provider.dart';

class GeminiWire {
  late HttpServer server;
  late WebSocket socket;
  late GeminiLiveVoiceProvider provider;
  final events = <VoiceEvent>[];

  Future<void> open() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      socket = await WebSocketTransformer.upgrade(request);
      socket.listen((raw) {
        if ((jsonDecode(raw as String) as Map).containsKey('setup')) {
          socket.add(jsonEncode({'setupComplete': {}}));
        }
      });
    });
    provider = GeminiLiveVoiceProvider(
      endpoint: 'ws://127.0.0.1:${server.port}/live',
      model: 'test',
      apiKey: 'test',
      voice: 'test',
    );
    final subscription = provider.events.listen(events.add);
    addTearDown(() async {
      await provider.close();
      await subscription.cancel();
      await socket.close();
      await server.close(force: true);
    });
    await provider.connect(epoch: 1, instructions: 'brief');
  }

  Future<void> send(Map<String, dynamic> content) async {
    socket.add(jsonEncode({'serverContent': content}));
    await Future<void>.delayed(const Duration(milliseconds: 30));
  }

  Iterable<VoiceEvent> of(VoiceEventKind kind) =>
      events.where((e) => e.kind == kind);
}

const audio = {
  'modelTurn': {
    'parts': [
      {
        'inlineData': {'mimeType': 'audio/pcm;rate=24000', 'data': 'AAAAAA=='},
      },
    ],
  },
};

void main() {
  test(
    'three live-shaped turns without finished end floor before each response',
    () async {
      final wire = GeminiWire();
      await wire.open();
      for (final text in [
        'Recommend two activities.',
        'How do I begin?',
        'Only thirty minutes.',
      ]) {
        await wire.send({
          'inputTranscription': {'text': text},
        });
        await wire.send({
          'outputTranscription': {'text': 'A suggestion.'},
        });
        await wire.send(audio);
        await wire.send({'turnComplete': true});
      }
      final starts = wire.of(VoiceEventKind.speechStart).toList();
      final ends = wire.of(VoiceEventKind.speechEnd).toList();
      expect(starts.map((e) => e.itemId).toSet(), hasLength(3));
      expect(ends.map((e) => e.itemId), starts.map((e) => e.itemId));
      expect(
        ends.every((e) => e.code == 'response_boundary' && !e.isFinal),
        isTrue,
      );
      expect(wire.of(VoiceEventKind.transcript).any((e) => e.isFinal), isFalse);
      for (var i = 0; i < 3; i++) {
        expect(
          wire.events.indexOf(ends[i]),
          lessThan(
            wire.events.indexOf(
              wire.of(VoiceEventKind.responseStart).elementAt(i),
            ),
          ),
        );
      }
      expect(wire.of(VoiceEventKind.audio), hasLength(3));
      expect(wire.provider.capabilities.voiceTools, isFalse);
    },
  );

  test('input and audio in one frame still release floor first', () async {
    final wire = GeminiWire();
    await wire.open();
    await wire.send({
      'inputTranscription': {'text': 'Hello'},
      ...audio,
    });
    expect(wire.events.map((e) => e.kind), [
      VoiceEventKind.ready,
      VoiceEventKind.speechStart,
      VoiceEventKind.transcript,
      VoiceEventKind.speechEnd,
      VoiceEventKind.responseStart,
      VoiceEventKind.audio,
    ]);
  });

  test(
    'silent model turn completes input without declaring ASR final',
    () async {
      final wire = GeminiWire();
      await wire.open();
      await wire.send({
        'inputTranscription': {'text': 'Hello'},
      });
      await wire.send({'turnComplete': true});
      expect(
        wire.of(VoiceEventKind.speechEnd).single.code,
        'response_boundary',
      );
      expect(wire.of(VoiceEventKind.transcript).single.isFinal, isFalse);
    },
  );

  test('explicit transcription finished retains its final semantics', () async {
    final wire = GeminiWire();
    await wire.open();
    await wire.send({
      'inputTranscription': {'text': 'Hello', 'finished': true},
    });
    await wire.send(audio);
    expect(wire.of(VoiceEventKind.speechEnd).single.code, isNull);
    final finalText = wire.of(VoiceEventKind.transcript).last;
    expect(finalText.isFinal, isTrue);
    expect(finalText.text, 'Hello');
    expect(finalText.replace, isTrue);
    expect(finalText.inputOriginVerified, isFalse);
  });

  test(
    'late native final cannot turn a split negation into verified input',
    () async {
      final wire = GeminiWire();
      await wire.open();
      await wire.send({
        'inputTranscription': {'text': '不要'},
      });
      await wire.send(audio);
      await wire.send({
        'inputTranscription': {'text': '删除我的文件', 'finished': true},
      });
      final transcripts = wire.of(VoiceEventKind.transcript).toList();
      expect(transcripts.first.itemId, isNot(transcripts.last.itemId));
      expect(transcripts.last.isFinal, isTrue);
      expect(transcripts.last.text, '删除我的文件');
      expect(transcripts.every((e) => e.inputOriginVerified == false), isTrue);
      expect(wire.provider.capabilities.voiceTools, isFalse);
    },
  );

  test('explicit typed input has verified origin', () async {
    final wire = GeminiWire();
    await wire.open();
    await wire.provider.submitText('Please summarize.');
    await Future<void>.delayed(const Duration(milliseconds: 30));
    final transcript = wire.of(VoiceEventKind.transcript).single;
    expect(transcript.isFinal, isTrue);
    expect(transcript.inputOriginVerified, isTrue);
  });

  test('input during old output survives its normal terminal', () async {
    final wire = GeminiWire();
    await wire.open();
    await wire.send({
      'inputTranscription': {'text': 'First'},
    });
    await wire.send(audio);
    await wire.send({
      'inputTranscription': {'text': 'New input'},
    });
    await wire.send({'turnComplete': true});
    expect(wire.of(VoiceEventKind.speechStart), hasLength(2));
    expect(wire.of(VoiceEventKind.speechEnd), hasLength(1));
    await wire.send(audio);
    expect(wire.of(VoiceEventKind.speechEnd), hasLength(2));
    expect(
      wire.of(VoiceEventKind.speechEnd).last.itemId,
      wire.of(VoiceEventKind.speechStart).last.itemId,
    );
  });

  for (final bundled in [false, true]) {
    test(
      'interrupted old terminal preserves new input (bundled=$bundled)',
      () async {
        final wire = GeminiWire();
        await wire.open();
        await wire.send({
          'inputTranscription': {'text': 'First'},
        });
        await wire.send(audio);
        if (!bundled) {
          await wire.send({
            'inputTranscription': {'text': 'New'},
          });
        }
        await wire.send({
          'interrupted': true,
          if (bundled) 'inputTranscription': {'text': 'New'},
          ...audio,
        });
        await wire.send({'turnComplete': true});
        expect(wire.of(VoiceEventKind.cancelled), hasLength(1));
        expect(wire.of(VoiceEventKind.audio), hasLength(1));
        expect(wire.of(VoiceEventKind.speechEnd), hasLength(1));
        await wire.send({
          'inputTranscription': {'text': ' request'},
        });
        await wire.send(audio);
        final transcripts = wire.of(VoiceEventKind.transcript).toList();
        expect(transcripts[0].itemId, isNot(transcripts[1].itemId));
        expect(transcripts[1].itemId, transcripts[2].itemId);
        expect(wire.of(VoiceEventKind.speechEnd), hasLength(2));
        expect(
          wire.of(VoiceEventKind.transcript).any((e) => e.isFinal),
          isFalse,
        );
      },
    );
  }
}
