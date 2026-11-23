import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_audio/nova_audio.dart';
import 'package:nova_mobile/space/space_call_controller.dart';
import 'package:nova_mobile/space/space_call_media.dart';
import 'package:nova_mobile/space/space_voice_crypto.dart';
import 'package:nova_mobile/voice/audio_owner.dart';

final _contentKey = List<int>.generate(32, (i) => i + 1);
String _b64(List<int> v) => base64Url.encode(v).replaceAll('=', '');

class FakeSignals implements SpaceCallSignals {
  int observed = 2;
  bool online = true;
  final intents = <Map<String, dynamic>>[];
  @override
  SpaceCallContext context() => SpaceCallContext(
    space: 'space-1',
    epoch: 2,
    clientDevice: 'phone',
    hostDevice: 'host',
    contentKey: _contentKey,
  );
  @override
  int observedHostEpoch() => observed;
  final epochEvents = StreamController<int>.broadcast(sync: true);
  @override
  Stream<int> get epochEvidence => epochEvents.stream;

  /// Verified rotation evidence, announced the way SpaceCrypto does.
  void rotate(int epoch) {
    observed = epoch;
    epochEvents.add(epoch);
  }

  @override
  Future<bool> hostOnline() async => online;
  @override
  Future<void> sendIntent(
    Map<String, dynamic> payload, {
    required int expiresAt,
  }) async =>
      intents.add(jsonDecode(jsonEncode(payload)) as Map<String, dynamic>);
}

class FakeSocket implements SpaceCallSocket {
  final inbound = StreamController<Uint8List>.broadcast(sync: true);
  final sent = <Uint8List>[];
  final _closed = Completer<String>();
  bool closedByClient = false;

  /// When set, close() waits for it (a slow socket teardown).
  Completer<void>? closeGate;
  @override
  Stream<Uint8List> get frames => inbound.stream;
  @override
  Future<String> get closed => _closed.future;
  @override
  Future<void> send(Uint8List frame) async {
    if (_closed.isCompleted) throw StateError('media_closed');
    sent.add(frame);
  }

  @override
  Future<void> close() async {
    closedByClient = true;
    await closeGate?.future;
    if (!_closed.isCompleted) _closed.complete('closed');
  }

  void drop() {
    if (!_closed.isCompleted) _closed.complete('transport_lost');
  }
}

class FakeMedia implements SpaceCallMedia {
  final sessions = <String>[];
  FakeSocket? socket;
  bool fail = false;
  @override
  Future<SpaceCallSocket> connect(String session) async {
    sessions.add(session);
    if (fail) throw StateError('media_session_unknown');
    return socket = FakeSocket();
  }
}

/// Records native relay calls and decodes NOVA frames back to identities.
class RecordingAudio implements AudioPort {
  final controller = StreamController<Map<String, Object?>>.broadcast(
    sync: true,
  );
  final enqueued =
      <(String, int, int, int)>[]; // utterance, epoch, sequence, bytes
  final terminals = <(String, int)>[], clears = <(String, int)>[];
  int starts = 0, stops = 0;
  bool? lastMute;
  int? generation;
  double? threshold;
  @override
  Stream<Map<String, Object?>> get events => controller.stream;
  @override
  Future<Map<String, Object?>> capabilities() async => {'relay': true};
  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
    bool recordingCompatible = false,
  }) async {
    starts++;
    this.generation = generation;
    this.threshold = threshold;
  }

  @override
  Future<void> enqueue(Uint8List frame) async {
    final length = ByteData.sublistView(frame).getUint16(4);
    final header = jsonDecode(utf8.decode(frame.sublist(6, 6 + length))) as Map;
    enqueued.add((
      header['utterance_id'] as String,
      header['generation_epoch'] as int,
      header['sequence'] as int,
      frame.length - 6 - length,
    ));
  }

  @override
  Future<void> terminal(String u, int e) async => terminals.add((u, e));
  @override
  Future<void> clear(String u, int e) async => clears.add((u, e));
  @override
  Future<void> mute(bool v) async => lastMute = v;
  @override
  Future<void> setSpeaker(bool v) async {}
  @override
  Future<void> stop() async => stops++;
  @override
  Future<void> disconnect() async => stops++;

  /// A native event for the current capture generation.
  void emit(Map<String, Object?> event) =>
      controller.add({...event, 'generation': generation});
}

/// The Host end of the handshake, built only from the shared Dart primitives.
class HostPeer {
  HostPeer._(this.accept, this.sender, this.receiver, this.hash);
  final Map<String, dynamic> accept;
  final VoiceFrameSender sender;
  final VoiceFrameReceiver receiver;
  final Uint8List hash;

  static Future<HostPeer> answer(
    Map<String, dynamic> intent, {
    String? peerEph,
    Map<String, dynamic>? selected,
    String? startHash,
  }) async {
    final own = await VoiceEphemeral.generate();
    final input = intent['input'] as Map<String, dynamic>;
    final hash = await voiceStartHash(
      start: intent,
      space: 'space-1',
      epoch: 2,
      client: 'phone',
      host: 'host',
    );
    const session = 'session-aaaaaaaaaaaaaaaaaaaaaa';
    final keys = await voiceDeriveCallKeys(
      own: own,
      peer: input['eph'] as String,
      contentKey: _contentKey,
      startHash: hash,
      ephC: input['eph'] as String,
      ephH: own.publicKey,
      session: session,
      codec: 'pcm16',
      frameMs: 40,
    );
    return HostPeer._(
      {
        'v': 1,
        'type': 'voice.accept',
        'op_id': intent['op_id'],
        'start_hash': startHash ?? _b64(hash),
        'session': session,
        'eph': peerEph ?? own.publicKey,
        'selected': selected ?? {'codec': 'pcm16', 'frame_ms': 40},
        'call_deadline': DateTime.now().millisecondsSinceEpoch + 3600000,
      },
      VoiceFrameSender(keys.down),
      VoiceFrameReceiver(keys.up),
      hash,
    );
  }

  Future<Uint8List> control(Map<String, Object?> body) =>
      sender.seal(voiceFrameControl, utf8.encode(jsonEncode(body)));
  Future<Uint8List> audio(int gen, int seq, int offset, int bytes) =>
      sender.seal(
        voiceFrameAudio,
        voiceEncodeAudio(VoiceAudioPayload(gen, seq, offset, Uint8List(bytes))),
      );

  /// Opens every frame the phone sent, in order.
  Future<List<(int, Object)>> read(List<Uint8List> frames) async {
    final out = <(int, Object)>[];
    for (final frame in frames) {
      final opened = await receiver.open(frame);
      if (opened == null) continue;
      out.add((
        opened.type,
        opened.type == voiceFrameControl
            ? jsonDecode(utf8.decode(opened.plaintext)) as Map
            : opened.type == voiceFrameAudio
            ? voiceDecodeAudio(opened.plaintext)
            : 'keepalive',
      ));
    }
    return out;
  }
}

Future<void> until(
  bool Function() predicate, [
  String label = 'condition',
]) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!predicate()) {
    if (DateTime.now().isAfter(deadline)) fail('timed out waiting for $label');
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

class Rig {
  Rig({
    bool microphone = true,
    AudioOwner? owner,
    SpaceCallTiming? timing,
    Future<VoiceEphemeral> Function()? ephemeral,
  }) : owner = owner ?? AudioOwner() {
    call = SpaceCallController(
      signals: signals,
      media: media,
      audio: audio,
      audioOwner: this.owner,
      requestMicrophone: () async => microphone,
      ephemeral: ephemeral,
      timing:
          timing ??
          const SpaceCallTiming(
            startDeadline: Duration(seconds: 2),
            joinTimeout: Duration(seconds: 2),
            gap: Duration(milliseconds: 60),
            progressInterval: Duration.zero,
          ),
    );
  }
  final signals = FakeSignals();
  final media = FakeMedia();
  final audio = RecordingAudio();
  final AudioOwner owner;
  late final SpaceCallController call;
  late HostPeer peer;
  final controls = <Map>[];
  final audioUp = <VoiceAudioPayload>[];
  int _read = 0;

  Future<void> startedIntent() async {
    unawaited(call.start('chat:main'));
    await until(() => signals.intents.isNotEmpty, 'voice.start');
  }

  /// Full handshake up to an active call.
  Future<void> connect() async {
    await startedIntent();
    peer = await HostPeer.answer(signals.intents.single);
    await call.onHostMessage(peer.accept);
    await until(() => media.socket?.sent.isNotEmpty == true, 'phone ready');
    await pump();
    expect(controls.single, {'type': 'ready', 'start_hash': _b64(peer.hash)});
    media.socket!.inbound.add(
      await peer.control({'type': 'ready', 'start_hash': _b64(peer.hash)}),
    );
    await until(() => call.phase == SpaceCallPhase.active, 'active');
  }

  /// Decrypts newly sent phone frames.
  Future<void> pump() async {
    final sent = media.socket!.sent;
    final fresh = sent.sublist(_read);
    _read = sent.length;
    for (final (type, value) in await peer.read(fresh)) {
      if (type == voiceFrameControl) controls.add(value as Map);
      if (type == voiceFrameAudio) audioUp.add(value as VoiceAudioPayload);
    }
  }

  Future<void> send(Future<Uint8List> frame) async =>
      media.socket!.inbound.add(await frame);
}

void main() {
  test(
    'handshake: sealed ready after the relay join, provider audio only once active, uplink in 40 ms packets',
    () async {
      final rig = Rig();
      await rig.startedIntent();
      final intent = rig.signals.intents.single;
      expect(intent['kind'], 'voice.start');
      final input = intent['input'] as Map;
      expect(input['offers'], {
        'codecs': ['pcm16'],
        'frame_ms': [40],
      });
      expect(
        (intent['expires_at'] as int) - (intent['created_at'] as int),
        lessThanOrEqualTo(15000),
      );
      expect(input['deadline'], intent['expires_at']);
      expect((input['nonce'] as String).length, 43);
      expect(rig.audio.starts, 1);
      // Mic audio before the call is active never leaves the phone.
      rig.audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
      rig.peer = await HostPeer.answer(intent);
      await rig.call.onHostMessage(rig.peer.accept);
      await until(() => rig.media.socket?.sent.isNotEmpty == true);
      await rig.pump();
      expect(rig.controls.single['type'], 'ready');
      expect(rig.call.phase, SpaceCallPhase.connecting);
      await rig.send(
        rig.peer.control({'type': 'ready', 'start_hash': _b64(rig.peer.hash)}),
      );
      await until(() => rig.call.phase == SpaceCallPhase.active);
      // Capture handoffs are 20 ms; the uplink seals one 40 ms packet per two.
      rig.audio.emit({'kind': 'pcm', 'pcm': Uint8List(640)});
      rig.audio.emit({'kind': 'pcm', 'pcm': Uint8List(640)});
      rig.audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
      await until(() => rig.media.socket!.sent.length >= 3);
      await rig.pump();
      expect(
        rig.audioUp.map((a) => [a.nativeSeq, a.sampleOffset, a.pcm.length]),
        [
          [0, 0, 1280],
          [1, 640, 1280],
        ],
      );
      // A duplicate accept (stream plus receipt) changes nothing.
      await rig.call.onHostMessage({
        'v': 1,
        'type': 'receipt',
        'op_id': rig.call.opId,
        'status': 'accepted',
        'voice': rig.peer.accept,
      });
      expect(rig.media.sessions.length, 1);
      await rig.call.stop();
      expect(rig.audio.stops, 1);
      expect(rig.signals.intents.last['kind'], 'voice.stop');
      expect(
        (rig.signals.intents.last['input'] as Map)['op_id'],
        intent['op_id'],
      );
    },
  );

  test(
    'handshake verification: start-hash binding, unoffered selection, all-zero DH and late accepts',
    () async {
      for (final (name, mutate, reason) in [
        (
          'start hash',
          (Map<String, dynamic> i) =>
              HostPeer.answer(i, startHash: _b64(List.filled(32, 7))),
          'handshake_invalid',
        ),
        (
          'unoffered codec',
          (Map<String, dynamic> i) =>
              HostPeer.answer(i, selected: {'codec': 'opus', 'frame_ms': 40}),
          'handshake_invalid',
        ),
        (
          'unoffered frame',
          (Map<String, dynamic> i) =>
              HostPeer.answer(i, selected: {'codec': 'pcm16', 'frame_ms': 20}),
          'handshake_invalid',
        ),
        (
          'all-zero DH',
          (Map<String, dynamic> i) =>
              HostPeer.answer(i, peerEph: _b64(List.filled(32, 0))),
          'invalid_shared_secret',
        ),
      ]) {
        final rig = Rig();
        await rig.startedIntent();
        final peer = await mutate(rig.signals.intents.single);
        await rig.call.onHostMessage(peer.accept);
        expect(rig.call.phase, SpaceCallPhase.ended, reason: name);
        expect(rig.call.endReason, reason, reason: name);
        expect(rig.media.sessions, isEmpty, reason: name);
        expect(rig.audio.stops, 1, reason: name);
      }
      // A late accept after the start deadline is ignored.
      final late = Rig(
        timing: const SpaceCallTiming(
          startDeadline: Duration(milliseconds: 50),
        ),
      );
      await late.startedIntent();
      final peer = await HostPeer.answer(late.signals.intents.single);
      await until(() => late.call.phase == SpaceCallPhase.ended);
      expect(late.call.endReason, 'start_timeout');
      await late.call.onHostMessage(peer.accept);
      expect(late.media.sessions, isEmpty);
      // An accept for another op is ignored.
      final foreign = Rig();
      await foreign.startedIntent();
      final other = await HostPeer.answer({
        ...foreign.signals.intents.single,
        'op_id': 'someone-else',
      });
      await foreign.call.onHostMessage(other.accept);
      expect(foreign.call.phase, SpaceCallPhase.starting);
      expect(foreign.media.sessions, isEmpty);
      await foreign.call.stop();
    },
  );

  test(
    'replayed downlink frames are dropped by the per-direction window',
    () async {
      final rig = Rig();
      await rig.connect();
      await rig.send(
        rig.peer.control({
          'type': 'playback.start',
          'gen': 0,
          'utterance_id': 'u',
          'generation_epoch': 3,
        }),
      );
      final frame = await rig.peer.audio(0, 0, 0, 1920);
      rig.media.socket!.inbound.add(frame);
      rig.media.socket!.inbound.add(frame);
      await until(() => rig.call.replayDrops == 1);
      expect(rig.audio.enqueued, [('u', 3, 0, 1920)]);
      await rig.call.stop();
    },
  );

  test(
    'loss fence: a missing packet fences the utterance, the prefix finishes and is reported as loss',
    () async {
      final rig = Rig();
      await rig.connect();
      await rig.send(
        rig.peer.control({
          'type': 'playback.start',
          'gen': 0,
          'utterance_id': 'u',
          'generation_epoch': 3,
        }),
      );
      await rig.send(rig.peer.audio(0, 0, 0, 1920));
      await rig.send(rig.peer.audio(0, 2, 1920, 1920)); // packet 1 lost
      await until(() => rig.audio.terminals.isNotEmpty, 'loss fence');
      expect(rig.audio.enqueued.map((e) => e.$3), [0]);
      expect(rig.audio.terminals, [('u', 3)]);
      await rig.send(rig.peer.audio(0, 1, 960, 1920)); // too late: fenced
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(rig.audio.enqueued.length, 1);
      rig.audio.emit({
        'kind': 'control',
        'control': {
          'type': 'playback.done',
          'utterance_id': 'u',
          'generation_epoch': 3,
          'played_ms': 40,
        },
      });
      await until(() => rig.media.socket!.sent.length >= 2);
      await rig.pump();
      expect(rig.controls.last, {
        'type': 'playback.stopped',
        'utterance_id': 'u',
        'generation_epoch': 3,
        'played_ms': 40,
        'reason': 'loss',
      });
      await rig.call.stop();
    },
  );

  test(
    'terminal before the tail is normal: finalize once the prefix reaches last_native_seq and end_offset',
    () async {
      final rig = Rig();
      await rig.connect();
      await rig.send(
        rig.peer.control({
          'type': 'playback.start',
          'gen': 0,
          'utterance_id': 'u',
          'generation_epoch': 3,
        }),
      );
      await rig.send(rig.peer.audio(0, 0, 0, 1920));
      await rig.send(rig.peer.audio(0, 1, 960, 1920));
      await rig.send(
        rig.peer.control({
          'type': 'playback.terminal',
          'utterance_id': 'u',
          'generation_epoch': 3,
          'last_native_seq': 2,
          'end_offset': 2500,
        }),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(rig.audio.terminals, isEmpty, reason: 'the tail has not arrived');
      await rig.send(rig.peer.audio(0, 2, 1920, 1160));
      await until(() => rig.audio.terminals.isNotEmpty);
      expect(rig.audio.enqueued.map((e) => (e.$3, e.$4)), [
        (0, 1920),
        (1, 1920),
        (2, 1160),
      ]);
      rig.audio.emit({
        'kind': 'control',
        'control': {
          'type': 'playback.progress',
          'utterance_id': 'u',
          'generation_epoch': 3,
          'played_ms': 40,
        },
      });
      rig.audio.emit({
        'kind': 'control',
        'control': {
          'type': 'playback.done',
          'utterance_id': 'u',
          'generation_epoch': 3,
          'played_ms': 104,
        },
      });
      await until(() => rig.media.socket!.sent.length >= 4);
      await rig.pump();
      expect(rig.controls.skip(1).map((c) => c['type']), [
        'playback.started',
        'playback.progress',
        'playback.done',
      ]);
      expect(rig.controls.last['played_ms'], 104);
      // A tail that never arrives fences after the gap instead of hanging.
      await rig.send(
        rig.peer.control({
          'type': 'playback.start',
          'gen': 1,
          'utterance_id': 'v',
          'generation_epoch': 4,
        }),
      );
      await rig.send(rig.peer.audio(1, 0, 0, 1920));
      await rig.send(
        rig.peer.control({
          'type': 'playback.terminal',
          'utterance_id': 'v',
          'generation_epoch': 4,
          'last_native_seq': 1,
          'end_offset': 1920,
        }),
      );
      await until(() => rig.audio.terminals.length == 2);
      rig.audio.emit({
        'kind': 'control',
        'control': {
          'type': 'playback.done',
          'utterance_id': 'v',
          'generation_epoch': 4,
          'played_ms': 40,
        },
      });
      await until(
        () => rig.controls.length >= 5 || rig.media.socket!.sent.length >= 5,
      );
      await rig.pump();
      expect(rig.controls.last['reason'], 'loss');
      // Clear fences the generation and clears the native ledger.
      await rig.send(
        rig.peer.control({
          'type': 'playback.start',
          'gen': 2,
          'utterance_id': 'w',
          'generation_epoch': 5,
        }),
      );
      await rig.send(
        rig.peer.control({
          'type': 'playback.clear',
          'utterance_id': 'w',
          'generation_epoch': 5,
        }),
      );
      await until(() => rig.audio.clears.isNotEmpty);
      await rig.send(rig.peer.audio(2, 0, 0, 1920));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(rig.audio.enqueued.where((e) => e.$1 == 'w'), isEmpty);
      await rig.call.stop();
    },
  );

  test(
    'verified higher-epoch evidence ends the call and releases audio',
    () async {
      final rig = Rig();
      await rig.connect();
      rig.signals.rotate(3);
      await until(() => rig.call.phase == SpaceCallPhase.ended);
      await until(() => !rig.call.tearingDown, 'teardown');
      expect(rig.call.endReason, 'epoch_rotated');
      expect(rig.audio.stops, 1);
      expect(rig.media.socket!.closedByClient, isTrue);
    },
  );

  test(
    'disconnect, Host end, rejection and crypto failure all end the call with a reason',
    () async {
      final dropped = Rig();
      await dropped.connect();
      dropped.media.socket!.drop();
      await until(() => dropped.call.phase == SpaceCallPhase.ended);
      expect(dropped.call.endReason, 'transport_lost');

      final ended = Rig();
      await ended.connect();
      await ended.send(
        ended.peer.control({'type': 'voice.ended', 'reason': 'taken_over'}),
      );
      await until(() => ended.call.phase == SpaceCallPhase.ended);
      expect(ended.call.endReason, 'taken_over');

      final rejected = Rig();
      await rejected.startedIntent();
      await rejected.call.onHostMessage({
        'v': 1,
        'type': 'receipt',
        'op_id': rejected.call.opId,
        'status': 'rejected',
        'error': 'voice_active',
      });
      expect(rejected.call.endReason, 'voice_active');
      expect(
        rejected.signals.intents.length,
        1,
        reason: 'no voice.stop for a refused start',
      );

      final forged = Rig();
      await forged.connect();
      final garbage = Uint8List(64)
        ..[0] = 1
        ..[1] = 2;
      for (var i = 0; i < 10; i++) {
        garbage[11] = 100 + i;
        forged.media.socket!.inbound.add(Uint8List.fromList(garbage));
      }
      await until(() => forged.call.phase == SpaceCallPhase.ended);
      expect(forged.call.endReason, 'voice_crypto_failed');
    },
  );

  test(
    'mic denied fails before voice.start; dictation contention refuses the call via AudioOwner',
    () async {
      final denied = Rig(microphone: false);
      await denied.call.start('chat:main');
      expect(denied.call.endReason, 'microphone_denied');
      expect(denied.signals.intents, isEmpty);
      expect(denied.audio.starts, 0);

      final owner = AudioOwner();
      final dictation = Object();
      await owner.acquire(dictation, () async {});
      final busy = Rig(owner: owner);
      await busy.call.start('chat:main');
      expect(busy.call.endReason, 'audio_busy');
      expect(busy.signals.intents, isEmpty);
      await owner.release(dictation, () async {});
      // Retry is a fresh start with fresh ephemerals.
      await busy.startedIntent();
      expect(busy.signals.intents.length, 1);
      await busy.call.stop();
    },
  );

  test(
    'mute stops uplink; audio focus loss and suspension end the call',
    () async {
      final rig = Rig();
      await rig.connect();
      await rig.call.setMuted(true);
      expect(rig.audio.lastMute, isTrue);
      final before = rig.media.socket!.sent.length;
      rig.audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(rig.media.socket!.sent.length, before);
      rig.audio.emit({'kind': 'stopped', 'reason': 'focus lost'});
      await until(() => rig.call.phase == SpaceCallPhase.ended);
      expect(rig.call.endReason, 'audio_interrupted');

      final suspended = Rig();
      await suspended.connect();
      suspended.call.appSuspended();
      await until(() => suspended.call.phase == SpaceCallPhase.ended);
      expect(suspended.call.endReason, 'suspended');
    },
  );

  test(
    'Host-authoritative barge-in: native local onset clearing is off and an onset sends nothing',
    () async {
      final rig = Rig();
      await rig.connect();
      expect(rig.audio.threshold, spaceCallOnsetThreshold);
      expect(spaceCallOnsetThreshold, 1.0);
      await rig.send(
        rig.peer.control({
          'type': 'playback.start',
          'gen': 0,
          'utterance_id': 'u',
          'generation_epoch': 1,
        }),
      );
      await rig.send(rig.peer.audio(0, 0, 0, 1920));
      await until(() => rig.audio.enqueued.isNotEmpty);
      final sent = rig.media.socket!.sent.length;
      rig.audio.emit({
        'kind': 'control',
        'control': {'type': 'speech.onset', 'speech_id': 's', 't_render_ms': 1},
      });
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(rig.audio.clears, isEmpty);
      expect(rig.media.socket!.sent.length, sent);
      expect(rig.call.phase, SpaceCallPhase.active);
      await rig.call.stop();
    },
  );

  test(
    'a Host clear for an identity the phone never mapped is ignored safely',
    () async {
      final rig = Rig();
      await rig.connect();
      final sent = rig.media.socket!.sent.length;
      await rig.send(
        rig.peer.control({
          'type': 'playback.clear',
          'utterance_id': 'never-started',
          'generation_epoch': 9,
        }),
      );
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(rig.audio.clears, isEmpty);
      expect(rig.media.socket!.sent.length, sent);
      expect(rig.call.phase, SpaceCallPhase.active);
      await rig.call.stop();
    },
  );

  test(
    'rotation evidence stops mic transmission: checked at admission, before every write, and on the evidence event',
    () async {
      // Evidence recorded without an event: the next mic frame is refused.
      final admitted = Rig();
      await admitted.connect();
      final before = admitted.media.socket!.sent.length;
      admitted.signals.observed = 3;
      admitted.audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
      // Refused synchronously at admission, before any write is queued.
      expect(admitted.call.phase, SpaceCallPhase.ended);
      expect(admitted.call.endReason, 'epoch_rotated');
      expect(admitted.media.socket!.sent.length, before);

      // Evidence while the Host is quiet: the event alone ends the call, and
      // no frame is written afterwards.
      final quiet = Rig();
      await quiet.connect();
      final quietBefore = quiet.media.socket!.sent.length;
      quiet.signals.rotate(3);
      expect(quiet.call.phase, SpaceCallPhase.ended);
      quiet.audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(quiet.media.socket!.sent.length, quietBefore);
      expect(quiet.call.endReason, 'epoch_rotated');

      // A write already queued when the evidence lands is dropped.
      final queued = Rig();
      await queued.connect();
      final queuedBefore = queued.media.socket!.sent.length;
      queued.audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
      queued.signals.observed = 3; // raised after admission, before the write
      await until(() => queued.call.phase == SpaceCallPhase.ended);
      expect(queued.media.socket!.sent.length, queuedBefore);
    },
  );

  test(
    'attempt ownership: hang-up during key generation sends no voice.start',
    () async {
      final gate = Completer<VoiceEphemeral>();
      final rig = Rig(ephemeral: () => gate.future);
      unawaited(rig.call.start('chat:main'));
      await until(() => rig.audio.starts == 1, 'relay started');
      await rig.call.stop();
      gate.complete(await VoiceEphemeral.generate());
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(rig.signals.intents, isEmpty);
      expect(rig.call.phase, SpaceCallPhase.ended);
      expect(rig.call.endReason, 'stopped');
    },
  );

  test(
    'attempt ownership: a slow close then an immediate retry keeps the retry keys intact',
    () async {
      final rig = Rig();
      await rig.connect();
      final first = rig.media.socket!;
      first.closeGate = Completer<void>();
      await rig.send(
        rig.peer.control({'type': 'voice.ended', 'reason': 'taken_over'}),
      );
      await until(() => rig.call.phase == SpaceCallPhase.ended);
      expect(rig.call.tearingDown, isTrue);
      unawaited(rig.call.start('chat:main'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      // The retry waits for the previous teardown before touching anything.
      expect(rig.signals.intents.length, 1);
      first.closeGate!.complete();
      await until(() => rig.signals.intents.length == 2, 'retry voice.start');
      expect(rig.call.tearingDown, isFalse);
      final peer = await HostPeer.answer(rig.signals.intents.last);
      await rig.call.onHostMessage(peer.accept);
      final second = rig.media.socket!;
      expect(identical(second, first), isFalse);
      await until(() => second.sent.isNotEmpty, 'retry ready');
      second.inbound.add(
        await peer.control({'type': 'ready', 'start_hash': _b64(peer.hash)}),
      );
      await until(() => rig.call.phase == SpaceCallPhase.active);
      rig.audio.emit({'kind': 'pcm', 'pcm': Uint8List(1280)});
      await until(() => second.sent.length >= 2, 'retry uplink');
      // Both frames open under the retry's keys: nothing destroyed them.
      final opened = await peer.read(second.sent);
      expect(opened.map((o) => o.$1), [voiceFrameControl, voiceFrameAudio]);
      await rig.call.stop();
    },
  );

  test(
    'Android transient focus loss (audio.focus hold) ends the call instead of resuming silently',
    () async {
      final rig = Rig();
      await rig.connect();
      // The exact control event RelayAudio.kt emits on FocusDecision.HOLD.
      rig.audio.emit({
        'kind': 'control',
        'control': {'type': 'audio.focus', 'state': 'hold'},
      });
      await until(() => rig.call.phase == SpaceCallPhase.ended);
      expect(rig.call.endReason, 'audio_interrupted');
      // The Host is told: a voice.stop for the call follows.
      await until(() => rig.signals.intents.length == 2);
      expect(rig.signals.intents.last['kind'], 'voice.stop');
    },
  );

  group('relay media socket', () {
    setUp(() => HttpOverrides.global = null);
    test(
      'waits for the relay ready text frame, renews in-band, and stops renewing once closed',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final received = <Object>[];
        final headers = <String, String?>{};
        WebSocket? serverSide;
        server.listen((request) async {
          headers['session'] = request.headers.value('x-nova-media-session');
          headers['auth'] = request.headers.value('authorization');
          final ws = serverSide = await WebSocketTransformer.upgrade(request);
          ws.listen((dynamic data) => received.add(data as Object));
          await Future<void>.delayed(const Duration(milliseconds: 30));
          ws.add(jsonEncode({'type': 'ready', 'role': 'client'}));
        });
        var token = 't1', expires = DateTime.now().millisecondsSinceEpoch;
        var renewals = 0;
        Completer<void>? gate;
        final media = RelaySpaceCallMedia(
          uri: () => Uri.parse('ws://127.0.0.1:${server.port}/v1/media'),
          token: () => token,
          expiresAt: () => expires,
          renew: () async {
            renewals++;
            await gate?.future;
            token = 't$renewals';
            expires = DateTime.now().millisecondsSinceEpoch;
          },
          minimumRenewDelay: const Duration(milliseconds: 40),
        );
        final socket = await media.connect('session-aaaaaaaaaaaaaaaaaaaaaa');
        expect(headers, {
          'session': 'session-aaaaaaaaaaaaaaaaaaaaaa',
          'auth': 'Bearer t1',
        });
        await until(() => received.isNotEmpty, 'renew');
        expect(jsonDecode(received.first as String), {
          'type': 'renew',
          'token': 't1',
        });
        // Binary frames flow both ways once ready.
        final inbound = <Uint8List>[];
        socket.frames.listen(inbound.add);
        serverSide!.add(Uint8List.fromList([1, 2, 3]));
        await until(() => inbound.isNotEmpty);
        // Close while a renewal login is in flight: nothing is sent afterwards.
        gate = Completer<void>();
        final count = renewals;
        await until(() => renewals > count, 'renewal in flight');
        final sentBefore = received.length;
        await socket.close();
        gate.complete();
        await Future<void>.delayed(const Duration(milliseconds: 150));
        expect(received.length, sentBefore);
        expect(renewals, count + 1);
        expect(await socket.closed, 'closed');
        await server.close(force: true);
      },
    );

    test(
      'a frame in the same burst as ready is kept until frames is listened to',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        server.listen((request) async {
          final ws = await WebSocketTransformer.upgrade(request);
          ws.add(jsonEncode({'type': 'ready', 'role': 'host'}));
          ws.add(Uint8List.fromList([9, 8, 7]));
        });
        final media = RelaySpaceCallMedia(
          uri: () => Uri.parse('ws://127.0.0.1:${server.port}/v1/media'),
          token: () => 't',
          expiresAt: () => DateTime.now().millisecondsSinceEpoch + 900000,
          renew: () async {},
        );
        final socket = await media.connect('session-aaaaaaaaaaaaaaaaaaaaaa');
        await Future<void>.delayed(const Duration(milliseconds: 50));
        final inbound = <Uint8List>[];
        socket.frames.listen(inbound.add);
        await until(() => inbound.isNotEmpty, 'buffered frame');
        expect(inbound.single, [9, 8, 7]);
        await socket.close();
        await server.close(force: true);
      },
    );

    test(
      'overflowing the pre-listener frame buffer closes with media_overflow',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        server.listen((request) async {
          final ws = await WebSocketTransformer.upgrade(request);
          ws.add(jsonEncode({'type': 'ready', 'role': 'host'}));
          for (var i = 0; i < 40; i++) {
            ws.add(Uint8List.fromList([1, 2, 0, 0, i]));
          }
        });
        final media = RelaySpaceCallMedia(
          uri: () => Uri.parse('ws://127.0.0.1:${server.port}/v1/media'),
          token: () => 't',
          expiresAt: () => DateTime.now().millisecondsSinceEpoch + 900000,
          renew: () async {},
        );
        final socket = await media.connect('session-aaaaaaaaaaaaaaaaaaaaaa');
        expect(
          await socket.closed.timeout(const Duration(seconds: 3)),
          'media_overflow',
        );
        await server.close(force: true);
      },
    );

    test(
      'a relay that rejects instead of sending ready fails the connect',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        server.listen((request) async {
          final ws = await WebSocketTransformer.upgrade(request);
          await ws.close(1008, 'media_session_unknown');
        });
        final media = RelaySpaceCallMedia(
          uri: () => Uri.parse('ws://127.0.0.1:${server.port}/v1/media'),
          token: () => 't',
          expiresAt: () => DateTime.now().millisecondsSinceEpoch + 900000,
          renew: () async {},
        );
        await expectLater(
          media.connect('session-aaaaaaaaaaaaaaaaaaaaaa'),
          throwsA(anything),
        );
        await server.close(force: true);
      },
    );
  });
}
