import 'dart:async';
import 'dart:typed_data';

class CascadeFailure implements Exception {
  const CascadeFailure(this.code);
  final String code;
  @override
  String toString() => code;
}

/// Cancellation owns network resources; callers still fence every delivered event.
class CascadeCancellation {
  bool _cancelled = false;
  final List<void Function()> _listeners = [];
  bool get isCancelled => _cancelled;
  void check() {
    if (_cancelled) throw const CascadeFailure('cancelled');
  }

  void Function() onCancel(void Function() listener) {
    if (_cancelled) {
      listener();
      return () {};
    }
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    for (final listener in List.of(_listeners)) {
      listener();
    }
    _listeners.clear();
  }
}

class CascadeTranscript {
  const CascadeTranscript(
    this.text, {
    this.isFinal = false,
    this.replace = true,
  });
  final String text;
  final bool isFinal, replace;
}

abstract interface class CascadeAsr {
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm16,
    CascadeCancellation cancel,
  );
}

class CascadeAudio {
  const CascadeAudio(this.pcm, {required this.sampleRate});
  final Uint8List pcm;
  final int sampleRate;
}

abstract interface class CascadeTts {
  Stream<CascadeAudio> synthesize(String text, CascadeCancellation cancel);
}

class CascadeLlmDelta {
  const CascadeLlmDelta({
    this.text = '',
    this.callId,
    this.name,
    this.arguments,
  });
  final String text;
  final String? callId, name;
  final Map<String, dynamic>? arguments;
}

abstract interface class CascadeLlm {
  Stream<CascadeLlmDelta> generate(
    List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>> tools,
    CascadeCancellation cancel,
  );
}
