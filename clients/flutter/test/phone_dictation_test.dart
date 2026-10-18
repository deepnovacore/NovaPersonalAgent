import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/widgets.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/phone_dictation.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/voice/audio_owner.dart';
import 'package:nova_mobile/voice/cascaded/ports.dart';
import 'package:nova_mobile/voice/voice_settings.dart';
import 'support/fake_audio.dart';

class DictationAudio extends FakeAudio {
  int? generation;
  Completer<void>? startGate, stopGate;
  bool failStop = false;
  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  }) async {
    this.generation = generation;
    expect(capture, true);
    await super.startRelay(
      generation: generation,
      capture: capture,
      threshold: threshold,
    );
    if (startGate != null) await startGate!.future;
  }

  @override
  Future<void> stop() async {
    if (stopGate != null) await stopGate!.future;
    if (failStop) throw StateError('secret endpoint/token');
    await super.stop();
  }

  void pcm(Uint8List bytes, {int? epoch}) => controller.add({
    'kind': 'pcm',
    'generation': epoch ?? generation,
    'pcm': bytes,
  });
}

class DictationAsr implements CascadeAsr {
  final inputs = <Uint8List>[];
  final cancellations = <CascadeCancellation>[];
  final events = StreamController<CascadeTranscript>.broadcast(sync: true);
  @override
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm16,
    CascadeCancellation cancel,
  ) {
    inputs.add(pcm16);
    cancellations.add(cancel);
    return events.stream;
  }

  void finalText([String text = '你好 Nova']) =>
      events.add(CascadeTranscript(text, isFinal: true));
}

Future<void> until(bool Function() predicate) async {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  fail('condition not reached');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late DictationAudio audio;
  late DictationAsr asr;
  late AudioOwner owner;
  late List<String> output;
  late PhoneDictation input;
  setUp(() {
    audio = DictationAudio();
    asr = DictationAsr();
    owner = AudioOwner();
    output = [];
    input = PhoneDictation(
      onText: output.add,
      audio: audio,
      audioOwner: owner,
      requestMicrophone: () async => true,
      readConfiguration: () async => const VoiceConfiguration(),
      createAsr: (_) => asr,
    );
  });
  tearDown(() async {
    input.dispose();
    // A zero-duration timer cannot advance during testWidgets teardown.
    await Future<void>.value();
    await asr.events.close();
    await audio.controller.close();
  });
  test(
    'PCM API ASR finishes only after capture stops and inserts a draft once',
    () async {
      await input.begin('zh');
      expect(input.recording, true);
      audio.pcm(Uint8List.fromList([1, 0, 2, 0]));
      audio.stopGate = Completer<void>();
      final ending = input.finish();
      await Future<void>.delayed(Duration.zero);
      expect(input.transcribing, true);
      expect(asr.inputs, isEmpty);
      expect(output, isEmpty);
      audio.stopGate!.complete();
      await until(() => asr.inputs.isNotEmpty);
      expect(audio.stopCount, 1);
      expect(asr.inputs.single, [1, 0, 2, 0]);
      asr.events.add(const CascadeTranscript('你好'));
      expect(input.partial, '你好');
      expect(output, isEmpty);
      asr.finalText();
      await ending;
      expect(output, ['你好 Nova']);
      expect(input.busy, false);
      asr.finalText('late duplicate');
      expect(output, ['你好 Nova']);
    },
  );
  test(
    'missing ASR settings never request microphone or use system recognition',
    () async {
      input.dispose();
      var permissions = 0;
      input = PhoneDictation(
        onText: output.add,
        audio: audio,
        audioOwner: owner,
        requestMicrophone: () async {
          permissions++;
          return true;
        },
        readConfiguration: () async => null,
        createAsr: (_) => asr,
      );
      await input.begin('zh');
      expect(input.notice, 'dictation_settings_required');
      expect(permissions, 0);
      expect(audio.startCount, 0);
      expect(asr.inputs, isEmpty);
    },
  );
  test(
    'ASR factory accepts integrated mode without requiring fast LLM or TTS',
    () async {
      input.dispose();
      VoiceConfiguration? received;
      input = PhoneDictation(
        onText: output.add,
        audio: audio,
        audioOwner: owner,
        requestMicrophone: () async => true,
        readConfiguration: () async => const VoiceConfiguration(
          pipeline: VoicePipeline.integrated,
          asrProvider: SpeechProvider.volcengine,
        ),
        createAsr: (config) {
          received = config;
          return asr;
        },
      );
      await input.begin('zh');
      expect(received!.pipeline, VoicePipeline.integrated);
      expect(received!.asrProvider, SpeechProvider.volcengine);
      expect(input.recording, true);
    },
  );
  test('microphone denial is explicit and does not start audio', () async {
    input.dispose();
    input = PhoneDictation(
      onText: output.add,
      audio: audio,
      audioOwner: owner,
      requestMicrophone: () async => false,
      readConfiguration: () async => const VoiceConfiguration(),
      createAsr: (_) => asr,
    );
    await input.begin('zh');
    expect(input.notice, 'microphone_denied');
    expect(audio.startCount, 0);
    expect(input.busy, false);
  });
  test(
    'quick release during permission cancels without late native start',
    () async {
      input.dispose();
      final permission = Completer<bool>();
      input = PhoneDictation(
        onText: output.add,
        audio: audio,
        audioOwner: owner,
        requestMicrophone: () => permission.future,
        readConfiguration: () async => const VoiceConfiguration(),
        createAsr: (_) => asr,
      );
      final beginning = input.begin('en');
      await Future<void>.delayed(Duration.zero);
      await input.finish();
      permission.complete(true);
      await beginning;
      expect(audio.startCount, 0);
      expect(input.busy, false);
      expect(output, isEmpty);
    },
  );
  test(
    'cancel during pending native start waits for cleanup and prevents ASR',
    () async {
      audio.startGate = Completer<void>();
      final beginning = input.begin('en');
      await until(() => audio.startCount == 1);
      final cancelling = input.cancel();
      expect(input.busy, false);
      audio.startGate!.complete();
      await beginning;
      await cancelling;
      expect(audio.stopCount, 1);
      expect(asr.inputs, isEmpty);
      expect(output, isEmpty);
    },
  );
  test(
    'new begin after cancel cannot overlap pending native teardown',
    () async {
      await input.begin('zh');
      audio.stopGate = Completer<void>();
      final cancelling = input.cancel();
      final restarting = input.begin('zh');
      await Future<void>.delayed(Duration.zero);
      expect(audio.startCount, 1);
      audio.stopGate!.complete();
      await cancelling;
      await restarting;
      expect(audio.stopCount, 1);
      expect(audio.startCount, 2);
      expect(input.recording, true);
    },
  );
  test('foreign audio owner is neither replaced nor stopped', () async {
    final foreign = OwnedAudioPort(audio, owner);
    await foreign.startRelay(generation: 4, capture: true, threshold: .03);
    await input.begin('zh');
    expect(input.notice, 'audio_in_use');
    expect(audio.startCount, 1);
    expect(audio.stopCount, 0);
    expect(owner.owns(foreign), true);
    await foreign.dispose();
  });
  test(
    'passing an owned audio port creates an independent dictation owner',
    () async {
      input.dispose();
      final sessionAudio = OwnedAudioPort(audio, owner);
      input = PhoneDictation(
        onText: output.add,
        audio: sessionAudio,
        audioOwner: owner,
        requestMicrophone: () async => true,
        readConfiguration: () async => const VoiceConfiguration(),
        createAsr: (_) => asr,
      );
      await input.begin('zh');
      await sessionAudio.stop();
      expect(audio.stopCount, 0);
      expect(input.recording, true);
      await input.cancel();
      expect(audio.stopCount, 1);
      await sessionAudio.dispose();
    },
  );
  test(
    'cancel while transcribing suppresses late final and cancels ASR',
    () async {
      await input.begin('zh');
      audio.pcm(Uint8List.fromList([1, 0]));
      final ending = input.finish();
      await until(() => asr.inputs.isNotEmpty);
      await input.cancel();
      await ending;
      expect(asr.cancellations.single.isCancelled, true);
      asr.finalText('late');
      expect(output, isEmpty);
      expect(input.busy, false);
    },
  );
  test('dispose while transcribing suppresses late output', () async {
    await input.begin('zh');
    audio.pcm(Uint8List.fromList([1, 0]));
    final ending = input.finish();
    await until(() => asr.inputs.isNotEmpty);
    input.dispose();
    await ending;
    asr.finalText('late');
    expect(output, isEmpty);
    expect(asr.cancellations.single.isCancelled, true);
  });
  test(
    'background cancels native capture but permission inactive does not',
    () async {
      await input.begin('zh');
      input.didChangeAppLifecycleState(AppLifecycleState.inactive);
      expect(input.recording, true);
      input.didChangeAppLifecycleState(AppLifecycleState.paused);
      await until(() => audio.stopCount == 1);
      expect(input.busy, false);
      expect(asr.inputs, isEmpty);
      expect(output, isEmpty);
    },
  );
  test(
    'PCM memory is bounded to 45 seconds and excess input triggers finish',
    () async {
      await input.begin('zh');
      final frame = Uint8List(64000);
      for (var i = 0; i < 23; i++) {
        audio.pcm(frame);
      }
      await until(() => asr.inputs.isNotEmpty);
      expect(asr.inputs.single.length, 16000 * 2 * 45);
      expect(audio.stopCount, 1);
      asr.finalText();
      await until(() => !input.busy);
      expect(output, ['你好 Nova']);
    },
  );
  test('45 second deadline stops capture and requests ASR', () {
    fakeAsync((clock) {
      final capture = DictationAudio();
      final recognition = DictationAsr();
      final drafts = <String>[];
      final controller = PhoneDictation(
        onText: drafts.add,
        audio: capture,
        audioOwner: AudioOwner(),
        requestMicrophone: () async => true,
        readConfiguration: () async => const VoiceConfiguration(),
        createAsr: (_) => recognition,
      );
      unawaited(controller.begin('zh'));
      clock.flushMicrotasks();
      expect(controller.recording, true);
      capture.pcm(Uint8List.fromList([1, 0]));
      clock.elapse(const Duration(seconds: 45));
      clock.flushMicrotasks();
      expect(capture.stopCount, 1);
      expect(recognition.inputs, hasLength(1));
      recognition.finalText();
      clock.flushMicrotasks();
      expect(drafts, ['你好 Nova']);
      expect(controller.busy, false);
      controller.dispose();
      clock.flushMicrotasks();
      unawaited(recognition.events.close());
      unawaited(capture.controller.close());
      clock.flushMicrotasks();
      expect(clock.pendingTimers, isEmpty);
    });
  });
  test(
    'stale generation is ignored and empty capture does not call ASR',
    () async {
      await input.begin('zh');
      audio.pcm(Uint8List.fromList([1, 0]), epoch: audio.generation! - 1);
      await input.finish();
      expect(asr.inputs, isEmpty);
      expect(input.notice, 'dictation_empty');
      expect(output, isEmpty);
    },
  );
  test(
    'provider errors and missing final are sanitized without modifying draft',
    () async {
      await input.begin('zh');
      audio.pcm(Uint8List.fromList([1, 0]));
      final ending = input.finish();
      await until(() => asr.inputs.isNotEmpty);
      asr.events.addError(StateError('secret API key'));
      await ending;
      expect(input.notice, 'dictation_unavailable');
      expect(output, isEmpty);
      await input.begin('zh');
      audio.pcm(Uint8List.fromList([1, 0]));
      final retry = input.finish();
      await until(() => asr.inputs.length == 2);
      await asr.events.close();
      await retry;
      expect(input.notice, 'dictation_unavailable');
      expect(output, isEmpty);
    },
  );
  test('native stop failure never uploads captured audio', () async {
    await input.begin('zh');
    audio.pcm(Uint8List.fromList([1, 0]));
    audio.failStop = true;
    await input.finish();
    expect(asr.inputs, isEmpty);
    expect(input.notice, 'dictation_unavailable');
    expect(output, isEmpty);
    audio.failStop = false;
  });
  test('malformed PCM cancels capture with no upload', () async {
    await input.begin('zh');
    audio.pcm(Uint8List(3));
    await until(() => audio.stopCount == 1);
    expect(input.busy, false);
    expect(asr.inputs, isEmpty);
    expect(input.notice, 'dictation_unavailable');
  });
  test(
    'saved integrated-only configuration shows ASR settings notice on read failure',
    () async {
      input.dispose();
      var permissions = 0;
      input = PhoneDictation(
        onText: output.add,
        audio: audio,
        audioOwner: owner,
        requestMicrophone: () async {
          permissions++;
          return true;
        },
        readConfiguration: () async =>
            throw const AgentFailure('dictation_settings_required'),
        createAsr: (_) => asr,
      );
      await input.begin('zh');
      expect(input.notice, 'dictation_settings_required');
      expect(permissions, 0);
      expect(audio.startCount, 0);
      expect(asr.inputs, isEmpty);
    },
  );
}
