import 'dart:typed_data';

enum VoiceEventKind {
  ready,
  speechStart,
  speechEnd,
  transcript,
  responseStart,
  text,
  audio,
  toolCall,
  responseEnd,
  cancelled,
  hostAck,
  error,
}

/// All provider audio is mono PCM16 LE. Capture is always 16 kHz;
/// output declares its rate. Epoch belongs to a connection, not capture/playback.
class VoiceEvent {
  const VoiceEvent(
    this.kind, {
    required this.epoch,
    this.responseId,
    this.itemId,
    this.text,
    this.pcm,
    this.sampleRate = 24000,
    this.hostOrigin,
    this.inputOriginVerified,
    this.isFinal = false,
    this.replace = false,
    this.callId,
    this.name,
    this.arguments,
    this.code,
  });
  final VoiceEventKind kind;
  final int epoch;
  final String? responseId, itemId, text, callId, name, code;
  final Uint8List? pcm;
  final int sampleRate;
  final bool isFinal, replace;

  /// null is reserved for adapters that cannot identify response origin.
  final bool? hostOrigin;

  /// False means ASR text has no verified utterance ownership, even when final.
  /// Such observed text may be shown but never replayed as a user instruction.
  final bool? inputOriginVerified;
  final Map<String, dynamic>? arguments;
}

class VoiceCapabilities {
  const VoiceCapabilities({
    required this.automaticResponse,
    required this.serverEndpointing,
    this.hostItems = false,
    this.voiceTools = true,
    this.playbackReport = false,
    this.history = false,
    this.hostItemAcknowledged = false,
    this.cancelAcknowledged = false,
  });
  final bool automaticResponse,
      serverEndpointing,
      hostItems,
      voiceTools,
      playbackReport,
      history,
      hostItemAcknowledged,
      cancelAcknowledged;
}

class VoiceHistoryItem {
  const VoiceHistoryItem(this.role, this.text);
  final String role, text;
}

/// Host facts describe execution, never authorize another tool invocation.
class VoiceHostItem {
  const VoiceHostItem({required this.id, required this.text, this.callId});
  final String id, text;
  final String? callId;
}

/// The selected fact is valid but the provider cannot activate it yet.
/// Identity/consumption errors are permanent and must not be retried as busy.
class VoiceHostBusy extends StateError {
  VoiceHostBusy(super.message);
}

abstract interface class VoiceProvider {
  VoiceCapabilities get capabilities;
  Stream<VoiceEvent> get events;
  Future<void> connect({
    required int epoch,
    required String instructions,
    List<VoiceHistoryItem> history = const [],
    List<Map<String, dynamic>> tools = const [],
  });
  Future<void> sendAudio(Uint8List pcm16);
  Future<void> submitText(String text);
  Future<void> cancelResponse(String responseId);
  Future<void> injectHostItem(VoiceHostItem item);

  /// Narrate one identified fact; returns all items consumed by this activation
  /// (some providers require an atomic tool-result batch). Never retries a fact.
  Future<Set<String>> requestHostResponse(String itemId);
  Future<void> reportPlayback(
    String responseId,
    int playedMs, {
    required bool interrupted,
  });
  Future<void> close();
}
