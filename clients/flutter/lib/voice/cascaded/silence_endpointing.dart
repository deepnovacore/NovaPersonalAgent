import 'dart:math';
import 'dart:typed_data';
import 'ports.dart';

class EndpointEvent {
  const EndpointEvent(this.kind, [this.pcm]);
  final String kind;
  final Uint8List? pcm;
}

/// Fixed 32 ms windows make decisions independent of microphone chunk sizes.
/// Energy endpointing is deliberately not advertised as semantic VAD.
class SilenceEndpointing {
  SilenceEndpointing({
    this.preRollMs = 192,
    this.minSpeechMs = 128,
    this.silenceEndMs = 640,
    this.speechPadMs = 96,
    this.maxUtteranceMs = 30000,
  }) {
    if (preRollMs < 0 ||
        preRollMs > 2000 ||
        minSpeechMs < 1 ||
        minSpeechMs > 10000 ||
        silenceEndMs < 1 ||
        silenceEndMs > 10000 ||
        speechPadMs < 0 ||
        speechPadMs > 2000 ||
        maxUtteranceMs < minSpeechMs ||
        maxUtteranceMs > 60000) {
      throw const CascadeFailure('invalid_endpointing');
    }
  }
  final int preRollMs, minSpeechMs, silenceEndMs, speechPadMs, maxUtteranceMs;
  Uint8List _partial = Uint8List(0), _pre = Uint8List(0);
  final List<int> _candidate = [], _tail = [];
  int _elapsed = 0;
  bool _active = false;
  bool get speaking => _active || _candidate.isNotEmpty;
  List<EndpointEvent> feed(Uint8List pcm) {
    if (pcm.length.isOdd || pcm.length > 64000) {
      throw const CascadeFailure('invalid_input_audio');
    }
    final all = Uint8List.fromList([..._partial, ...pcm]);
    final events = <EndpointEvent>[];
    var offset = 0;
    while (offset + 1024 <= all.length) {
      final window = Uint8List.sublistView(all, offset, offset + 1024);
      offset += 1024;
      final data = ByteData.sublistView(window);
      var squares = 0.0;
      for (var i = 0; i < 1024; i += 2) {
        final s = data.getInt16(i, Endian.little);
        squares += s * s;
      }
      final rms = sqrt(squares / 512) / 32768;
      if (!_active) {
        if (rms < (_candidate.isEmpty ? .035 : .020)) {
          _addPre([..._candidate, ...window]);
          _candidate.clear();
          _elapsed = 0;
          continue;
        }
        _candidate.addAll(window);
        _elapsed += 32;
        if (_elapsed < minSpeechMs) continue;
        _active = true;
        events.add(
          EndpointEvent('start', Uint8List.fromList([..._pre, ..._candidate])),
        );
        _pre = Uint8List(0);
        _candidate.clear();
      } else {
        _elapsed += 32;
        if (rms >= .020) {
          events.add(
            EndpointEvent('audio', Uint8List.fromList([..._tail, ...window])),
          );
          _tail.clear();
        } else {
          _tail.addAll(window);
        }
      }
      if (_elapsed >= maxUtteranceMs || _tail.length >= silenceEndMs * 32) {
        final pad = min(_tail.length, speechPadMs * 32);
        if (pad > 0) {
          events.add(
            EndpointEvent(
              'audio',
              Uint8List.fromList(_tail.take(pad).toList()),
            ),
          );
        }
        _addPre(_tail.skip(pad).toList());
        events.add(const EndpointEvent('end'));
        _tail.clear();
        _elapsed = 0;
        _active = false;
      }
    }
    _partial = Uint8List.fromList(all.sublist(offset));
    return events;
  }

  void _addPre(List<int> bytes) {
    final all = [..._pre, ...bytes];
    _pre = Uint8List.fromList(all.sublist(max(0, all.length - preRollMs * 32)));
  }

  void reset() {
    _partial = Uint8List(0);
    _pre = Uint8List(0);
    _candidate.clear();
    _tail.clear();
    _elapsed = 0;
    _active = false;
  }
}
