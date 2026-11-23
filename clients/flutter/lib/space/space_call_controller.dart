import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:nova_audio/nova_audio.dart';
import '../protocol/models.dart';
import '../voice/audio_owner.dart';
import '../voice/voice_media.dart';
import 'space_call_media.dart';
import 'space_voice_crypto.dart';

/// Space voice call phases (docs/design/space-voice.md §4, §7).
enum SpaceCallPhase { idle, starting, connecting, active, ended }

/// Identity of the current Space binding; the call keys bind to all of it.
class SpaceCallContext {
  const SpaceCallContext({
    required this.space,
    required this.epoch,
    required this.clientDevice,
    required this.hostDevice,
    required this.contentKey,
  });
  final String space, clientDevice, hostDevice;
  final int epoch;
  final List<int> contentKey;
}

/// What the call needs from the Client Space connection.
abstract interface class SpaceCallSignals {
  /// The current binding; throws when no content key is usable.
  SpaceCallContext context();

  /// Highest epoch on any Host-verified envelope (rotation evidence).
  int observedHostEpoch();

  /// Fires synchronously whenever [observedHostEpoch] or the local epoch
  /// changes, so a call stops without waiting for its next write.
  Stream<int> get epochEvidence;
  Future<bool> hostOnline();

  /// Seals [payload] as a signed stream-channel intent and sends it.
  Future<void> sendIntent(
    Map<String, dynamic> payload, {
    required int expiresAt,
  });
}

class SpaceCallTiming {
  const SpaceCallTiming({
    this.startDeadline = const Duration(seconds: 15),
    this.joinTimeout = const Duration(seconds: 15),
    this.keepalive = const Duration(seconds: 5),
    this.idle = const Duration(seconds: 20),
    this.gap = const Duration(milliseconds: 200),
    this.progressInterval = const Duration(milliseconds: 100),
  });
  final Duration startDeadline, joinTimeout, keepalive, idle, gap;
  final Duration progressInterval;
}

const _codec = 'pcm16', _frameMs = 40;

/// 40 ms of 16 kHz mono PCM16 uplink.
const spaceCallUplinkPacketBytes = 1280;

/// Native onset threshold for Space calls. The Host is authoritative for
/// barge-in (§5): the phone clears playback only on a Host `playback.clear`.
/// 1.0 is the channel maximum; the native RMS detector reaches it only on a
/// 50 ms run of samples all at negative full scale, so local onset clearing
/// is effectively off without a native change.
const spaceCallOnsetThreshold = 1.0;

/// Downlink packets held while waiting for a missing one, before the loss fence.
const _maxHeldPackets = 8;

class _Attempt {
  _Attempt(this.opId, this.payload, this.eph, this.deadline, this.context);
  final String opId;
  final Map<String, dynamic> payload;
  final VoiceEphemeral eph;
  final int deadline;
  final SpaceCallContext context;
}

class _Generation {
  _Generation(this.gen, this.identity);
  final int gen;
  final PlaybackIdentity identity;
  int expected = 0, endOffset = 0, playedMs = 0, lastProgressAt = 0;
  int? lastSeq;
  ({int? last, int end})? terminal;
  final held = <int, VoiceAudioPayload>{};
  bool fenced = false, loss = false, finalized = false, started = false;
  bool reported = false;
  Timer? gapTimer;
}

/// Owns one Space voice call: the handshake, the media leg, native relay
/// audio through [OwnedAudioPort], Host playback identities and receipts.
/// It is not a VoiceProvider: playback identities come from the Host.
class SpaceCallController extends ChangeNotifier {
  SpaceCallController({
    required this.signals,
    required this.media,
    required AudioPort audio,
    required this._audioOwner,
    required this.requestMicrophone,
    this.timing = const SpaceCallTiming(),
    int Function()? clock,
    Future<VoiceEphemeral> Function()? ephemeral,
  }) : _native = audio is OwnedAudioPort ? audio.native : audio,
       _clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch),
       _ephemeral = ephemeral ?? VoiceEphemeral.generate;
  final SpaceCallSignals signals;
  final SpaceCallMedia media;
  final Future<bool> Function() requestMicrophone;
  final SpaceCallTiming timing;
  final AudioPort _native;
  final AudioOwner _audioOwner;
  final int Function() _clock;
  final Future<VoiceEphemeral> Function() _ephemeral;

  SpaceCallPhase phase = SpaceCallPhase.idle;
  String? endReason, conversationId;
  bool muted = false;

  /// Replayed or too-old downlink frames dropped by the receive window.
  int replayDrops = 0;

  /// Uplink packets dropped because sends backed up.
  int uplinkDrops = 0;

  _Attempt? _attempt;
  OwnedAudioPort? _port;
  StreamSubscription<Map<String, Object?>>? _audioEvents;
  SpaceCallSocket? _socket;
  StreamSubscription<Uint8List>? _frames;
  VoiceFrameSender? _sender;
  VoiceFrameReceiver? _receiver;
  Uint8List? _startHash;
  Future<void> _inbound = Future.value(), _outbound = Future.value();

  /// Native playback events become receipts in the order they happened.
  Future<void> _nativeTail = Future.value();
  int _pendingSends = 0, _lastHeard = 0, _capture = 0, _upSeq = 0;
  int _upOffset = 0;
  final _upBuffer = BytesBuilder(copy: true);
  final _gens = <int, _Generation>{};
  final _timers = <Timer>[];
  int _run = 0;
  bool _disposed = false;
  StreamSubscription<int>? _epochEvents;

  /// The previous attempt's teardown; a retry starts only after it.
  Future<void> _teardown = Future.value();

  /// True while an ended attempt is still releasing audio, socket and keys.
  bool tearingDown = false;

  bool get busy =>
      phase == SpaceCallPhase.starting ||
      phase == SpaceCallPhase.connecting ||
      phase == SpaceCallPhase.active;

  /// The pending voice.start, for routing receipts; tests only otherwise.
  String? get opId => _attempt?.opId;

  /// Starts (or retries) a call: always a fresh `voice.start` with new
  /// ephemerals. The microphone is checked before anything is sent.
  Future<void> start(String conversation) async {
    if (busy || _disposed) return;
    final run = ++_run;
    _reset();
    conversationId = conversation;
    phase = SpaceCallPhase.starting;
    endReason = null;
    notifyListeners();
    try {
      // The previous attempt owns the native port and its keys until its
      // teardown finishes; nothing of this attempt may overlap it.
      await _teardown;
      if (run != _run) return;
      if (!await requestMicrophone()) {
        return _end('microphone_denied', run: run, tellHost: false);
      }
      if (run != _run) return;
      if (!await signals.hostOnline()) {
        return _end('host_offline', run: run, tellHost: false);
      }
      if (run != _run) return;
      final context = signals.context();
      _epochEvents = signals.epochEvidence.listen((_) {
        if (run == _run &&
            busy &&
            signals.observedHostEpoch() > context.epoch) {
          _end('epoch_rotated', run: run);
        }
      });
      final port = _port = OwnedAudioPort(_native, _audioOwner);
      _audioEvents = port.events.listen(_onAudio);
      _capture = _audioOwner.nextGeneration();
      try {
        await port.startRelay(
          generation: _capture,
          capture: true,
          threshold: spaceCallOnsetThreshold,
        );
      } on StateError catch (error) {
        return _end(
          error.message == 'audio_in_use' ? 'audio_busy' : 'audio_unavailable',
          run: run,
          tellHost: false,
        );
      }
      if (run != _run) return;
      final eph = await _ephemeral();
      final now = _clock(),
          deadline = now + timing.startDeadline.inMilliseconds;
      final random = Random.secure();
      final nonce = base64Url
          .encode(List<int>.generate(32, (_) => random.nextInt(256)))
          .replaceAll('=', '');
      final op = _newOpId(random);
      final payload = <String, dynamic>{
        'v': 1,
        'type': 'intent',
        'kind': 'voice.start',
        'op_id': op,
        'created_at': now,
        'expires_at': deadline,
        'input': {
          'conversation_id': conversation,
          'voice_mode': 'chat',
          'eph': eph.publicKey,
          'nonce': nonce,
          'offers': {
            'codecs': [_codec],
            'frame_ms': [_frameMs],
          },
          'deadline': deadline,
        },
      };
      _attempt = _Attempt(op, payload, eph, deadline, context);
      _timer(timing.startDeadline, () {
        if (phase == SpaceCallPhase.starting) _end('start_timeout', run: run);
      });
      if (run != _run || _epochRotated()) {
        if (run == _run) await _end('epoch_rotated', run: run);
        return;
      }
      await signals.sendIntent(payload, expiresAt: deadline);
    } catch (error) {
      if (run == _run && busy) await _end('start_failed', run: run);
    }
  }

  /// A Host-signed stream message or receipt the Client controller routed here.
  Future<void> onHostMessage(Map<String, dynamic> payload) async {
    final attempt = _attempt;
    if (attempt == null) return;
    switch (payload['type']) {
      case 'voice.accept':
        await _accept(payload);
      case 'receipt' when payload['op_id'] == attempt.opId:
        if (payload['status'] == 'accepted' && payload['voice'] is Map) {
          await _accept(Map<String, dynamic>.from(payload['voice'] as Map));
        } else if (payload['status'] == 'rejected' && busy) {
          final error = payload['error'];
          await _end(
            error is String ? error : 'voice_rejected',
            tellHost: false,
          );
        }
      case 'voice.ended' when payload['op_id'] == attempt.opId && busy:
        final reason = payload['reason'];
        await _end(reason is String ? reason : 'ended', tellHost: false);
    }
  }

  Future<void> _accept(Map<String, dynamic> accept) async {
    final attempt = _attempt, run = _run;
    // Late, duplicate or foreign accepts are ignored; the Host's reservation times out.
    if (attempt == null ||
        phase != SpaceCallPhase.starting ||
        accept['op_id'] != attempt.opId ||
        _clock() > attempt.deadline) {
      return;
    }
    final context = attempt.context;
    if (signals.observedHostEpoch() > context.epoch) {
      return _end('epoch_rotated', run: run);
    }
    final hash = await voiceStartHash(
      start: attempt.payload,
      space: context.space,
      epoch: context.epoch,
      client: context.clientDevice,
      host: context.hostDevice,
    );
    if (run != _run || phase != SpaceCallPhase.starting) return;
    final selected = accept['selected'];
    final session = accept['session'], peer = accept['eph'];
    if (!_sameString(accept['start_hash'], _b64(hash)) ||
        selected is! Map ||
        selected['codec'] != _codec ||
        selected['frame_ms'] != _frameMs ||
        session is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{22,64}$').hasMatch(session) ||
        peer is! String) {
      return _end('handshake_invalid', run: run);
    }
    final VoiceCallKeys keys;
    try {
      keys = await voiceDeriveCallKeys(
        own: attempt.eph,
        peer: peer,
        contentKey: context.contentKey,
        startHash: hash,
        ephC: attempt.eph.publicKey,
        ephH: peer,
        session: session,
        codec: _codec,
        frameMs: _frameMs,
      );
    } on VoiceCryptoError catch (error) {
      return _end(error.code, run: run);
    }
    if (run != _run || phase != SpaceCallPhase.starting) {
      keys.up.fillRange(0, 32, 0);
      keys.down.fillRange(0, 32, 0);
      return;
    }
    _sender = VoiceFrameSender(keys.up);
    _receiver = VoiceFrameReceiver(keys.down);
    keys.up.fillRange(0, 32, 0);
    keys.down.fillRange(0, 32, 0);
    _startHash = hash;
    phase = SpaceCallPhase.connecting;
    notifyListeners();
    _timer(timing.joinTimeout, () {
      if (phase == SpaceCallPhase.connecting) _end('join_timeout', run: run);
    });
    final SpaceCallSocket socket;
    try {
      socket = await media.connect(session);
    } catch (_) {
      if (run == _run && busy) await _end('relay_media_unavailable', run: run);
      return;
    }
    if (run != _run || phase != SpaceCallPhase.connecting) {
      await socket.close();
      return;
    }
    _socket = socket;
    _lastHeard = _clock();
    _frames = socket.frames.listen((frame) {
      _inbound = _inbound.then((_) => _receive(frame, run));
    });
    unawaited(
      socket.closed.then((_) {
        if (run == _run && busy) _end('transport_lost', run: run);
      }),
    );
    // The relay already sent its `ready`: the sealed handshake goes out now.
    await _sendControl({'type': 'ready', 'start_hash': _b64(hash)});
  }

  Future<void> _receive(Uint8List frame, int run) async {
    final receiver = _receiver;
    if (run != _run || receiver == null || !busy) return;
    VoiceOpenedFrame? opened;
    try {
      opened = await receiver.open(frame);
    } on VoiceCryptoError catch (error) {
      if (error.code == 'voice_crypto_failed') {
        await _end('voice_crypto_failed', run: run);
      }
      return;
    } catch (_) {
      return;
    }
    if (run != _run || !busy) return;
    if (opened == null) {
      replayDrops++;
      return;
    }
    _lastHeard = _clock();
    if (_epochRotated()) return _end('epoch_rotated', run: run);
    if (phase == SpaceCallPhase.connecting) {
      if (opened.type != voiceFrameControl) return;
      final body = _control(opened.plaintext);
      if (body?['type'] != 'ready' ||
          !_sameString(body?['start_hash'], _b64(_startHash!))) {
        return _end('protocol_error', run: run);
      }
      _activate(run);
      return;
    }
    if (opened.type == voiceFrameKeepalive) return;
    if (opened.type == voiceFrameAudio) {
      final VoiceAudioPayload audio;
      try {
        audio = voiceDecodeAudio(opened.plaintext);
      } catch (_) {
        return _end('protocol_error', run: run);
      }
      await _downlink(audio);
      return;
    }
    final body = _control(opened.plaintext);
    if (body == null) return _end('protocol_error', run: run);
    await _hostControl(body, run);
  }

  void _activate(int run) {
    phase = SpaceCallPhase.active;
    notifyListeners();
    void keepalive() {
      if (run != _run || phase != SpaceCallPhase.active) return;
      if (_clock() - _lastHeard >= timing.idle.inMilliseconds) {
        _end('idle', run: run);
        return;
      }
      unawaited(_seal(voiceFrameKeepalive, const <int>[]));
      _timer(timing.keepalive, keepalive);
    }

    _timer(timing.keepalive, keepalive);
  }

  bool _epochRotated() {
    final attempt = _attempt;
    return attempt != null &&
        signals.observedHostEpoch() > attempt.context.epoch;
  }

  Future<void> _hostControl(Map<String, dynamic> body, int run) async {
    final identity = _identity(body);
    switch (body['type']) {
      case 'playback.start':
        final gen = body['gen'];
        if (gen is int && identity != null && !_gens.containsKey(gen)) {
          _gens[gen] = _Generation(gen, identity);
          while (_gens.length > 64) {
            _gens.remove(_gens.keys.first)?.gapTimer?.cancel();
          }
        }
      case 'playback.terminal':
        final g = _byIdentity(identity);
        final last = body['last_native_seq'], end = body['end_offset'];
        if (g == null || g.fenced || g.finalized) return;
        if ((last != null && last is! int) || end is! int) {
          return _end('protocol_error', run: run);
        }
        g.terminal = (last: last as int?, end: end);
        await _settle(g);
      case 'playback.clear':
        // A clear for an identity this phone never mapped (the Host dropped
        // it before playback.start) has nothing to clear; the Host records it.
        final g = _byIdentity(identity);
        if (g == null) return;
        g.fenced = true;
        g.held.clear();
        g.gapTimer?.cancel();
        await _port?.clear(g.identity.utteranceId, g.identity.epoch);
      case 'voice.ended':
        final reason = body['reason'];
        await _end(
          reason is String ? reason : 'ended',
          run: run,
          tellHost: false,
        );
    }
  }

  /// In-order delivery to the native ledger with Host identities; a short
  /// reorder hold, then the v1 loss fence (§3).
  Future<void> _downlink(VoiceAudioPayload audio) async {
    final g = _gens[audio.gen];
    if (g == null || g.fenced || g.finalized) return;
    if (audio.nativeSeq < g.expected || g.held.containsKey(audio.nativeSeq)) {
      return;
    }
    if (audio.nativeSeq > g.expected) {
      g.held[audio.nativeSeq] = audio;
      if (g.held.length > _maxHeldPackets) return _fence(g);
      _armGap(g);
      return;
    }
    await _deliver(g, audio);
    while (!g.fenced && g.held.containsKey(g.expected)) {
      await _deliver(g, g.held.remove(g.expected)!);
    }
    if (g.held.isEmpty) g.gapTimer?.cancel();
    await _settle(g);
  }

  Future<void> _deliver(_Generation g, VoiceAudioPayload audio) async {
    g.expected = audio.nativeSeq + 1;
    g.lastSeq = audio.nativeSeq;
    g.endOffset = audio.sampleOffset + audio.pcm.length ~/ 2;
    await _port?.enqueue(voiceFrame(g.identity, audio.nativeSeq, audio.pcm));
  }

  /// Terminal may overtake the tail in the relay: finalize only once the
  /// contiguous prefix reaches `last_native_seq` and `end_offset`.
  Future<void> _settle(_Generation g) async {
    final terminal = g.terminal;
    if (terminal == null || g.fenced || g.finalized) return;
    final complete = terminal.last == null
        ? g.expected == 0
        : g.lastSeq == terminal.last &&
              g.endOffset == terminal.end &&
              g.held.isEmpty;
    if (!complete) {
      _armGap(g);
      return;
    }
    g.finalized = true;
    g.gapTimer?.cancel();
    if (terminal.last == null) {
      await _receipt('playback.done', g, 0);
      return;
    }
    await _port?.terminal(g.identity.utteranceId, g.identity.epoch);
  }

  void _armGap(_Generation g) {
    if (g.gapTimer?.isActive == true) return;
    final run = _run;
    g.gapTimer = Timer(timing.gap, () {
      if (run == _run && !g.finalized && !g.fenced) unawaited(_fence(g));
    });
  }

  /// Loss fence: no further enqueue for this generation; the native ledger
  /// finishes the contiguous prefix, and its completion is reported as an
  /// interrupted playback truncated at what was heard.
  Future<void> _fence(_Generation g) async {
    g.fenced = true;
    g.loss = true;
    g.held.clear();
    g.gapTimer?.cancel();
    if (g.expected == 0) {
      await _receipt('playback.stopped', g, 0, reason: 'loss');
    } else {
      await _port?.terminal(g.identity.utteranceId, g.identity.epoch);
    }
  }

  void _onAudio(Map<String, Object?> event) {
    if (event['generation'] != _capture) return;
    switch (event['kind']) {
      case 'pcm':
        final pcm = event['pcm'];
        if (phase == SpaceCallPhase.active && !muted && pcm is Uint8List) {
          // Mic admission re-checks rotation evidence synchronously.
          if (_epochRotated()) {
            _end('epoch_rotated');
            return;
          }
          _uplink(pcm);
        }
      case 'stopped':
        if (busy) {
          _end(
            event['reason'] == 'Call ended' ? 'stopped' : 'audio_interrupted',
          );
        }
      case 'control':
        final control = event['control'];
        // Android reports a transient focus loss (hold) without stopping;
        // a Space call never resumes silently, so it ends (§5).
        if (control is Map &&
            control['type'] == 'audio.focus' &&
            control['state'] == 'hold') {
          if (busy) _end('audio_interrupted');
          return;
        }
        if (control is Map) {
          final body = Map<String, dynamic>.from(control);
          _nativeTail = _nativeTail
              .then((_) => _nativeControl(body))
              .catchError((Object _) {});
        }
    }
  }

  void _uplink(Uint8List pcm) {
    _upBuffer.add(pcm);
    if (_upBuffer.length < spaceCallUplinkPacketBytes) return;
    final bytes = _upBuffer.takeBytes();
    var offset = 0;
    for (
      ;
      offset + spaceCallUplinkPacketBytes <= bytes.length;
      offset += spaceCallUplinkPacketBytes
    ) {
      final packet = Uint8List.sublistView(
        bytes,
        offset,
        offset + spaceCallUplinkPacketBytes,
      );
      final payload = VoiceAudioPayload(0, _upSeq++, _upOffset, packet);
      _upOffset += spaceCallUplinkPacketBytes ~/ 2;
      // Realtime: a backed-up socket drops new mic audio instead of building latency.
      if (_pendingSends > 25) {
        uplinkDrops++;
        continue;
      }
      unawaited(_seal(voiceFrameAudio, voiceEncodeAudio(payload)));
    }
    if (offset < bytes.length) {
      _upBuffer.add(Uint8List.sublistView(bytes, offset));
    }
  }

  Future<void> _nativeControl(Map<String, dynamic> event) async {
    final g = _byIdentity(_identity(event));
    if (g == null || g.reported) return;
    final played = event['played_ms'];
    final ms = played is int && played >= 0 ? played : g.playedMs;
    g.playedMs = max(g.playedMs, ms);
    switch (event['type']) {
      case 'playback.progress':
        if (!g.started && ms > 0) {
          g.started = true;
          await _receipt('playback.started', g, ms);
        }
        final now = _clock();
        if (now - g.lastProgressAt >= timing.progressInterval.inMilliseconds) {
          g.lastProgressAt = now;
          await _receipt('playback.progress', g, ms);
        }
      case 'playback.done':
        g.reported = true;
        await _receipt(
          g.loss ? 'playback.stopped' : 'playback.done',
          g,
          ms,
          reason: g.loss ? 'loss' : null,
        );
      case 'playback.stopped':
        g.reported = true;
        await _receipt(
          'playback.stopped',
          g,
          ms,
          reason: g.loss ? 'loss' : 'interrupted',
        );
      case 'playback.cleared':
        g.reported = true;
        await _receipt('playback.cleared', g, ms);
    }
  }

  Future<void> _receipt(
    String type,
    _Generation g,
    int playedMs, {
    String? reason,
  }) {
    if (type != 'playback.progress' && type != 'playback.started') {
      g.reported = true;
    }
    return _sendControl({
      'type': type,
      ...g.identity.fields,
      'played_ms': playedMs,
      'reason': ?reason,
    });
  }

  Future<void> _sendControl(Map<String, dynamic> body) =>
      _seal(voiceFrameControl, utf8.encode(jsonEncode(body)));

  /// One sender per direction: frames are sealed and written in order.
  Future<void> _seal(int type, List<int> plaintext) {
    final sender = _sender, socket = _socket, run = _run;
    if (sender == null || socket == null) return Future.value();
    _pendingSends++;
    final write = _outbound.then((_) async {
      if (run != _run || !busy) return;
      // Nothing is written under a key the Host has rotated past.
      if (_epochRotated()) {
        unawaited(_end('epoch_rotated', run: run));
        return;
      }
      final frame = await sender.seal(type, plaintext);
      await socket.send(frame);
    });
    _outbound = write
        .catchError((Object _) {
          if (run == _run && busy) _end('transport_lost', run: run);
        })
        .whenComplete(() => _pendingSends--);
    return _outbound;
  }

  Future<void> setMuted(bool value) async {
    muted = value;
    notifyListeners();
    await _port?.mute(value);
  }

  /// The app left the foreground: v1 calls do not survive suspension.
  void appSuspended() {
    if (busy) _end('suspended');
  }

  /// User hang-up.
  Future<void> stop() async {
    if (!busy) return;
    await _sendControl({'type': 'end'}).catchError((Object _) {});
    await _end('stopped');
  }

  /// Fence first (phase, timers, generations), then release the audio owner
  /// before closing the socket, then zero the keys (§4 teardown).
  Future<void> _end(String reason, {int? run, bool tellHost = true}) {
    if (run != null && run != _run) return _teardown;
    if (!busy) return _teardown;
    // Fence synchronously and take this attempt's resources, so a retry that
    // starts while this teardown awaits can never lose its own.
    final attempt = _attempt;
    phase = SpaceCallPhase.ended;
    endReason = reason;
    _run++;
    for (final timer in _timers) {
      timer.cancel();
    }
    _timers.clear();
    for (final g in _gens.values) {
      g.gapTimer?.cancel();
    }
    final port = _port, events = _audioEvents, frames = _frames;
    final socket = _socket, sender = _sender, receiver = _receiver;
    final epochEvents = _epochEvents;
    _port = null;
    _audioEvents = null;
    _frames = null;
    _socket = null;
    _sender = null;
    _receiver = null;
    _epochEvents = null;
    tearingDown = true;
    notifyListeners();
    final previous = _teardown;
    return _teardown = () async {
      await previous;
      await epochEvents?.cancel();
      await events?.cancel();
      try {
        await port?.dispose();
      } catch (_) {}
      await frames?.cancel();
      try {
        await socket?.close();
      } catch (_) {}
      sender?.destroy();
      receiver?.destroy();
      if (tellHost && attempt != null && reason != 'microphone_denied') {
        final now = _clock();
        final op = _newOpId(Random.secure());
        unawaited(
          signals
              .sendIntent({
                'v': 1,
                'type': 'intent',
                'kind': 'voice.stop',
                'op_id': op,
                'created_at': now,
                'expires_at': now + 15000,
                'input': {'op_id': attempt.opId},
              }, expiresAt: now + 15000)
              .catchError((Object _) {}),
        );
      }
      tearingDown = false;
      if (!_disposed) notifyListeners();
    }();
  }

  void _reset() {
    _attempt = null;
    _gens.clear();
    _upBuffer.clear();
    _upSeq = 0;
    _upOffset = 0;
    _pendingSends = 0;
    _inbound = Future.value();
    _outbound = Future.value();
    _nativeTail = Future.value();
    _startHash = null;
    muted = false;
    replayDrops = 0;
    uplinkDrops = 0;
  }

  void _timer(Duration duration, void Function() run) =>
      _timers.add(Timer(duration, run));

  PlaybackIdentity? _identity(Map<String, dynamic>? body) {
    final utterance = body?['utterance_id'], epoch = body?['generation_epoch'];
    return utterance is String && epoch is int
        ? PlaybackIdentity(utterance, epoch)
        : null;
  }

  _Generation? _byIdentity(PlaybackIdentity? identity) => identity == null
      ? null
      : _gens.values.where((g) => g.identity == identity).firstOrNull;

  static Map<String, dynamic>? _control(Uint8List plaintext) {
    try {
      final value = jsonDecode(utf8.decode(plaintext));
      return value is Map ? Map<String, dynamic>.from(value) : null;
    } catch (_) {
      return null;
    }
  }

  static String _b64(List<int> bytes) =>
      base64Url.encode(bytes).replaceAll('=', '');

  static String _newOpId(Random random) => base64Url
      .encode(List<int>.generate(18, (_) => random.nextInt(256)))
      .replaceAll('=', '');

  /// Constant-time string comparison for handshake hashes.
  static bool _sameString(Object? a, String b) {
    if (a is! String || a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < b.length; i++) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_end('disposed'));
    super.dispose();
  }
}
