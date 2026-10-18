import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import '../voice_provider.dart';

/// A single-use connection. Paused consumers terminate rather than accumulating
/// unbounded audio; callers must consume events continuously and fence playback.
abstract class RealtimeSocketProvider implements VoiceProvider {
  RealtimeSocketProvider({
    required this.endpoint,
    required this.model,
    required this.apiKey,
    required this.voice,
    this.connectTimeout = const Duration(seconds: 20),
    this.idleTimeout = const Duration(minutes: 2),
  }) {
    _events = StreamController<VoiceEvent>(
      sync: true,
      onPause: () => scheduleMicrotask(() => fail('consumer_paused')),
      onCancel: close,
    );
    unawaited(ready.future.then<void>((_) {}, onError: (Object _) {}));
  }
  final String endpoint, model, apiKey, voice;
  final Duration connectTimeout, idleTimeout;
  late final StreamController<VoiceEvent> _events;
  WebSocket? _socket;
  HttpClient? _client;
  StreamSubscription<dynamic>? _subscription;
  Timer? _idle;
  final ready = Completer<void>();
  int epoch = 0, _sequence = 0;
  final Stopwatch _sendWindow = Stopwatch()..start();
  int _sentBytes = 0;
  bool closed = false, _used = false;
  @override
  Stream<VoiceEvent> get events => _events.stream;
  String nextId(String prefix) => '${prefix}_${epoch}_${++_sequence}';
  void emit(VoiceEvent event) {
    if (!closed && !_events.isClosed) _events.add(event);
  }

  void markReady() {
    if (!ready.isCompleted) ready.complete();
  }

  void assertReady() {
    if (closed || _socket == null || !ready.isCompleted) {
      throw StateError('Voice connection is not ready');
    }
  }

  static String boundedText(String value, {int max = 32768}) {
    if (value.trim().isEmpty || value.length > max) {
      throw ArgumentError('Invalid voice text length');
    }
    return value;
  }

  static String identifier(dynamic value) {
    if (value is! String || value.isEmpty || value.length > 256) {
      throw const FormatException('Invalid identifier');
    }
    return value;
  }

  static Map<String, dynamic> object(dynamic value) {
    if (value is! Map<String, dynamic>) {
      throw const FormatException('Invalid object');
    }
    return value;
  }

  /// Accept the host's Chat Completions declarations and flat realtime tools.
  static List<Map<String, dynamic>> normalizeTools(
    List<Map<String, dynamic>> tools,
  ) {
    if (tools.length > 64 || jsonEncode(tools).length > 131072) {
      throw ArgumentError('Tool schema limit exceeded');
    }
    return tools
        .map((tool) {
          if (tool['type'] != 'function') {
            throw ArgumentError('Only function tools supported');
          }
          final function = tool['function'] == null
              ? tool
              : object(tool['function']);
          final name = identifier(function['name']);
          final description = function['description'] ?? '';
          if (description is! String || description.length > 8192) {
            throw ArgumentError('Invalid tool description');
          }
          final parameters = object(
            jsonDecode(jsonEncode(object(function['parameters']))),
          );
          return <String, dynamic>{
            'type': 'function',
            'name': name,
            'description': description,
            'parameters': parameters,
            if (function['strict'] is bool) 'strict': function['strict'],
          };
        })
        .toList(growable: false);
  }

  static Uint8List pcm(dynamic data) {
    if (data is! String || data.length > 350000) {
      throw const FormatException('Invalid audio');
    }
    final bytes = base64Decode(data);
    validatePcm(bytes, max: 262144);
    return bytes;
  }

  static void validatePcm(Uint8List bytes, {int max = 65536}) {
    if (bytes.isEmpty || bytes.length.isOdd || bytes.length > max) {
      throw ArgumentError('Invalid PCM16 frame');
    }
  }

  Future<void> openSocket(
    int connectionEpoch,
    Map<String, String> headers, {
    bool modelQuery = false,
  }) async {
    if (_used || closed || !_events.hasListener) {
      throw StateError(
        'Voice provider requires one active event listener and a fresh instance',
      );
    }
    _used = true;
    epoch = connectionEpoch;
    try {
      var uri = Uri.parse(endpoint);
      if ((uri.scheme != 'wss' &&
              !(uri.scheme == 'ws' &&
                  (uri.host == '127.0.0.1' ||
                      uri.host == 'localhost' ||
                      uri.host == '::1'))) ||
          uri.userInfo.isNotEmpty ||
          apiKey.isEmpty ||
          model.isEmpty) {
        throw const FormatException('Invalid realtime configuration');
      }
      if (modelQuery) {
        uri = uri.replace(
          queryParameters: {...uri.queryParameters, 'model': model},
        );
      }
      _client = HttpClient()..connectionTimeout = connectTimeout;
      final socket = await WebSocket.connect(
        uri.toString(),
        headers: headers,
        customClient: _client,
      ).timeout(connectTimeout);
      if (closed) {
        await socket.close();
        throw StateError('Voice connection closed');
      }
      _socket = socket;
      socket.pingInterval = const Duration(seconds: 20);
      _touch();
      _subscription = socket.listen(
        (dynamic raw) {
          if (closed) return;
          try {
            _touch();
            if (raw is! String && raw is! List<int>) {
              throw const FormatException();
            }
            if ((raw as dynamic).length > 1048576) {
              throw const FormatException();
            }
            final text = raw is String ? raw : utf8.decode(raw as List<int>);
            onFrame(object(jsonDecode(text)));
          } catch (_) {
            fail('protocol_error');
          }
        },
        onError: (Object _) => fail('connection_error'),
        onDone: () => fail('disconnected'),
        cancelOnError: true,
      );
    } catch (_) {
      fail('connection_failed');
      throw StateError('Realtime connection failed');
    }
  }

  Future<void> awaitReady() async {
    try {
      await ready.future.timeout(connectTimeout);
    } catch (_) {
      fail('setup_timeout');
      throw StateError('Realtime setup failed');
    }
  }

  void _touch() {
    _idle?.cancel();
    _idle = Timer(idleTimeout, () => fail('idle_timeout'));
  }

  void send(Map<String, dynamic> frame) {
    if (closed || _socket == null) {
      throw StateError('Voice connection is closed');
    }
    final json = jsonEncode(frame);
    if (json.length > 1048576) throw ArgumentError('Voice frame too large');
    if (_sendWindow.elapsedMilliseconds >= 1000) {
      _sendWindow.reset();
      _sentBytes = 0;
    }
    _sentBytes += utf8.encode(json).length;
    if (_sentBytes > 524288) {
      fail('outbound_overflow');
      throw StateError('Realtime outbound rate exceeded');
    }
    _socket!.add(json);
  }

  void onFrame(Map<String, dynamic> frame);
  void fail(String code) {
    if (closed) return;
    emit(
      VoiceEvent(
        VoiceEventKind.error,
        epoch: epoch,
        code: code,
        text: 'Realtime voice connection failed',
      ),
    );
    unawaited(close());
  }

  @override
  Future<void> close() async {
    if (closed) return;
    closed = true;
    _idle?.cancel();
    if (!ready.isCompleted) {
      ready.completeError(StateError('Voice connection closed'));
    }
    final socket = _socket;
    _socket = null;
    await _subscription?.cancel();
    _client?.close(force: true);
    _client = null;
    try {
      await socket?.close().timeout(const Duration(seconds: 1));
    } catch (_) {
      /* already disconnected */
    }
    // Do not await a paused listener's done delivery.
    unawaited(_events.close());
  }
}

/// Streaming linear PCM16 interpolation retains phase across capture chunks.
class StreamingPcm16Resampler {
  StreamingPcm16Resampler(this.inputRate, this.outputRate);
  final int inputRate, outputRate;
  int _index = 0, _next = 0, _previous = 0;
  Uint8List convert(Uint8List pcm) {
    RealtimeSocketProvider.validatePcm(pcm);
    final input = ByteData.sublistView(pcm);
    final result = BytesBuilder(copy: false);
    for (var offset = 0; offset < pcm.length; offset += 2) {
      final current = input.getInt16(offset, Endian.little), index = _index++;
      while (_next <= index * outputRate) {
        final fraction = (_next - (index - 1) * outputRate) / outputRate;
        final sample = index == 0
            ? current
            : (_previous + (current - _previous) * fraction).round();
        final pair = ByteData(2)
          ..setInt16(0, sample.clamp(-32768, 32767), Endian.little);
        result.add(pair.buffer.asUint8List());
        _next += inputRate;
      }
      _previous = current;
    }
    return result.takeBytes();
  }
}
