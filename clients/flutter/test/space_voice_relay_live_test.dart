@Tags(['live'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/space_call_controller.dart';
import 'package:nova_mobile/space/space_call_media.dart';
import 'package:nova_mobile/voice/audio_owner.dart';
import 'space_call_controller_test.dart' show RecordingAudio, until;

/// Talks to test/support/space_voice_relay_fixture.mjs: a real relay with media
/// enabled and the real Host SpaceVoiceController. Only the provider is fake.
class _Fixture {
  _Fixture(this.process) {
    process.stderr.transform(utf8.decoder).listen(errors.add);
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          final value = jsonDecode(line) as Map<String, dynamic>;
          if (value['ready'] != null) {
            ready.complete(Map<String, dynamic>.from(value['ready'] as Map));
          } else if (value['event'] == 'notify') {
            notes.add(Map<String, dynamic>.from(value['body'] as Map));
          } else {
            final reply = _replies.remove(value['id']);
            if (value['error'] != null) {
              reply?.completeError(StateError(value['error'] as String));
            } else {
              reply?.complete(
                Map<String, dynamic>.from(value['result'] as Map),
              );
            }
          }
        });
  }
  final Process process;
  final errors = <String>[];
  final ready = Completer<Map<String, dynamic>>();
  final notes = StreamController<Map<String, dynamic>>.broadcast();
  final _replies = <int, Completer<Map<String, dynamic>>>{};
  int _id = 0;

  Future<Map<String, dynamic>> call(
    String method, [
    Map<String, Object?> params = const {},
  ]) {
    final id = ++_id, reply = Completer<Map<String, dynamic>>();
    _replies[id] = reply;
    process.stdin.writeln(jsonEncode({'id': id, 'method': method, ...params}));
    return reply.future.timeout(
      const Duration(seconds: 15),
      onTimeout: () => throw StateError('fixture: ${errors.join()}'),
    );
  }
}

class _Signals implements SpaceCallSignals {
  _Signals(this.fixture, this.ready, this.onReceipt);
  final _Fixture fixture;
  final Map<String, dynamic> ready;
  final Future<void> Function(Map<String, dynamic>) onReceipt;
  final kinds = <String>[];
  @override
  SpaceCallContext context() => SpaceCallContext(
    space: ready['space'] as String,
    epoch: ready['epoch'] as int,
    clientDevice: ready['phone'] as String,
    hostDevice: ready['host'] as String,
    contentKey: base64Url.decode(
      base64Url.normalize(ready['content_key'] as String),
    ),
  );
  @override
  int observedHostEpoch() => ready['epoch'] as int;
  @override
  Stream<int> get epochEvidence => const Stream.empty();
  @override
  Future<bool> hostOnline() async => true;
  @override
  Future<void> sendIntent(
    Map<String, dynamic> payload, {
    required int expiresAt,
  }) async {
    kinds.add(payload['kind'] as String);
    // The Host's receipt arrives asynchronously, like a mailbox delivery.
    unawaited(
      fixture
          .call('intent', {'payload': payload})
          .then((receipt) => onReceipt(receipt)),
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null; // Real loopback relay.
  test(
    'Flutter client calls the real Host over the real relay: handshake, uplink, downlink with terminal, receipts, renewal and hang-up',
    () async {
      final process = await Process.start('node', [
        'test/support/space_voice_relay_fixture.mjs',
      ], environment: Platform.environment);
      final fixture = _Fixture(process);
      SpaceCallController? call;
      try {
        final ready = await fixture.ready.future.timeout(
          const Duration(seconds: 30),
          onTimeout: () =>
              throw StateError('fixture: ${fixture.errors.join()}'),
        );
        var token = ready['token'] as String;
        var expiresAt = ready['expires_at'] as int;
        var renewals = 0;
        final media = RelaySpaceCallMedia(
          uri: () => Uri.parse(
            (ready['relay'] as String).replaceFirst('http', 'ws'),
          ).replace(path: '/v1/media'),
          token: () => token,
          expiresAt: () => expiresAt,
          renew: () async {
            final fresh = await fixture.call('renew');
            token = fresh['token'] as String;
            expiresAt = fresh['expires_at'] as int;
            renewals++;
          },
          // Renew as soon as allowed so the in-band path runs within the test.
          renewLead: const Duration(days: 3650),
        );
        final audio = RecordingAudio();
        late final _Signals signals;
        signals = _Signals(
          fixture,
          ready,
          (receipt) => call!.onHostMessage(receipt),
        );
        call = SpaceCallController(
          signals: signals,
          media: media,
          audio: audio,
          audioOwner: AudioOwner(),
          requestMicrophone: () async => true,
          timing: const SpaceCallTiming(progressInterval: Duration.zero),
        );
        final ended = <Map<String, dynamic>>[];
        fixture.notes.stream.listen((note) {
          ended.add(note);
          unawaited(call!.onHostMessage(note));
        });

        await call.start('chat:main');
        await until(
          () => call!.phase == SpaceCallPhase.connecting,
          'connecting (end: ${call.endReason}, ${fixture.errors.join()})',
        );
        // Mic audio while the Host's provider is still starting never leaves the phone.
        audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
        await until(
          () => call!.phase == SpaceCallPhase.active,
          'active (end: ${call.endReason}, ${fixture.errors.join()})',
        );
        expect(signals.kinds, ['voice.start']);
        // "In call" only once the Host's slow startVoice has completed.
        final atActive = await fixture.call('state');
        expect(atActive['events'], contains('start:chat:main'));
        expect(atActive['audio'], isEmpty);

        // Uplink: the real Host opens the frames and forwards PCM to the provider.
        for (var i = 0; i < 4; i++) {
          audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
        }
        Map<String, dynamic> state = {};
        Future<void> poll(bool Function(Map<String, dynamic>) done) async {
          final deadline = DateTime.now().add(const Duration(seconds: 5));
          while (true) {
            state = await fixture.call('state');
            if (done(state)) return;
            if (DateTime.now().isAfter(deadline)) {
              fail('fixture state: $state ${fixture.errors.join()}');
            }
            await Future<void>.delayed(const Duration(milliseconds: 20));
          }
        }

        await poll((s) => (s['audio'] as List).length >= 4);
        expect((state['audio'] as List).toSet(), {1280});
        expect((state['audio'] as List).length, 4);
        expect(state['events'], contains('start:chat:main'));

        // In-band token renewal on the live leg; the call keeps working.
        await until(() => renewals >= 1, 'renewal');
        await Future<void>.delayed(const Duration(milliseconds: 200));
        expect(call.phase, SpaceCallPhase.active);

        // Downlink: three 24 kHz packets, then the terminal after the tail.
        await fixture.call('downlink', {
          'utterance': 'u1',
          'epoch': 4,
          'bytes': 1920 * 3,
        });
        await until(() => audio.terminals.isNotEmpty, 'terminal');
        expect(audio.enqueued, [
          ('u1', 4, 0, 1920),
          ('u1', 4, 1, 1920),
          ('u1', 4, 2, 1920),
        ]);
        expect(audio.terminals, [('u1', 4)]);
        expect(call.replayDrops, 0);

        // Native playback receipts reach the Host's voice service.
        audio.emit({
          'kind': 'control',
          'control': {
            'type': 'playback.progress',
            'utterance_id': 'u1',
            'generation_epoch': 4,
            'played_ms': 40,
          },
        });
        audio.emit({
          'kind': 'control',
          'control': {
            'type': 'playback.done',
            'utterance_id': 'u1',
            'generation_epoch': 4,
            'played_ms': 120,
          },
        });
        await poll((s) => (s['receipts'] as List).length >= 2);
        expect(state['receipts'], ['started:u1:4', 'done:u1:4:120']);

        // Hang-up ends the Host call and frees its audio owner.
        await call.stop();
        expect(call.phase, SpaceCallPhase.ended);
        await poll(
          (s) =>
              (s['events'] as List).contains('stop:chat:main') &&
              s['owner'] == false,
        );
        expect(signals.kinds, ['voice.start', 'voice.stop']);
      } finally {
        await call?.stop();
        await process.stdin.close();
        final code = await process.exitCode.timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            process.kill();
            return -1;
          },
        );
        expect(code, 0, reason: fixture.errors.join());
      }
    },
    skip:
        Platform.environment['NOVA_RELAY_BUILD_ROOT'] == null ||
            Platform.environment['NOVA_RUNTIME_BUILD_ROOT'] == null
        ? 'Set NOVA_RELAY_BUILD_ROOT and NOVA_RUNTIME_BUILD_ROOT to compiled src directories'
        : false,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
