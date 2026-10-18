import 'dart:async';
import 'dart:typed_data';
import 'package:nova_audio/nova_audio.dart';
import 'package:nova_audio/aoq_port.dart';

/// Serializes media startup and shutdown. A foreign stop cannot stop the owner.
class AudioOwner {
  Object? _owner;
  Future<void> _tail = Future.value();
  int _generation = 1000000;
  bool owns(Object owner) => identical(_owner, owner);
  int nextGeneration() => ++_generation;
  Future<void> _serial(Future<void> Function() operation) {
    final result = _tail.then((_) => operation());
    _tail = result.catchError((Object _) {});
    return result;
  }

  Future<void> acquire(Object owner, Future<void> Function() start) =>
      _serial(() async {
        if (_owner != null && !owns(owner)) throw StateError('audio_in_use');
        _owner = owner;
        try {
          await start();
        } catch (_) {
          _owner = null;
          rethrow;
        }
      });
  Future<void> release(Object owner, Future<void> Function() stop) =>
      _serial(() async {
        if (!owns(owner)) return;
        // Hold ownership until the native host confirms teardown.
        await stop();
        _owner = null;
      });
}

/// Two controllers can share one ChannelAudio without sharing its lifetime.
class OwnedAudioPort implements AudioPort, AoqPort {
  OwnedAudioPort(this.native, this.owner) {
    _subscription = native.events.listen(
      (event) {
        if (owner.owns(this) && event['generation'] == _nativeGeneration) {
          _events.add({...event, 'generation': _clientGeneration});
        }
      },
      onError: (Object _) {
        if (owner.owns(this)) {
          _events.add({
            'kind': 'stopped',
            'generation': _clientGeneration,
            'reason': 'audio_failed',
          });
        }
      },
    );
  }
  final AudioPort native;
  final AudioOwner owner;
  final _events = StreamController<Map<String, Object?>>.broadcast(sync: true);
  late final StreamSubscription<Map<String, Object?>> _subscription;
  int? _nativeGeneration, _clientGeneration;
  @override
  Stream<Map<String, Object?>> get events => _events.stream;
  @override
  Future<Map<String, Object?>> capabilities() => native.capabilities();
  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  }) => owner.acquire(this, () async {
    _clientGeneration = generation;
    _nativeGeneration = owner.nextGeneration();
    await native.startRelay(
      generation: _nativeGeneration!,
      capture: capture,
      threshold: threshold,
    );
  });
  @override
  Future<void> startAoq(
    Map<String, Object?> payload, {
    required int generation,
    required bool runtime,
  }) => owner.acquire(this, () async {
    if (native is! AoqPort) throw StateError('aoq_unavailable');
    _clientGeneration = generation;
    _nativeGeneration = owner.nextGeneration();
    await (native as AoqPort).startAoq(
      payload,
      generation: _nativeGeneration!,
      runtime: runtime,
    );
  });
  Future<void> _ifOwner(Future<void> Function() action) async {
    if (owner.owns(this)) await action();
  }

  @override
  Future<void> enqueue(Uint8List frame) =>
      _ifOwner(() => native.enqueue(frame));
  @override
  Future<void> terminal(String utteranceId, int epoch) =>
      _ifOwner(() => native.terminal(utteranceId, epoch));
  @override
  Future<void> clear(String utteranceId, int epoch) =>
      _ifOwner(() => native.clear(utteranceId, epoch));
  @override
  Future<void> mute(bool muted) => _ifOwner(() => native.mute(muted));
  @override
  Future<void> setSpeaker(bool enabled) =>
      _ifOwner(() => native.setSpeaker(enabled));
  @override
  Future<void> aoqCommand(Map<String, dynamic> event) =>
      _ifOwner(() => (native as AoqPort).aoqCommand(event));
  @override
  Future<void> aoqClear() => _ifOwner(() => (native as AoqPort).aoqClear());
  @override
  Future<void> stop() => owner.release(this, native.stop);
  @override
  Future<void> disconnect() => owner.release(this, native.disconnect);
  Future<void> dispose() async {
    await stop();
    await _subscription.cancel();
    await _events.close();
  }
}
