import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'ports.dart';
import 'volc_wire.dart';

String _id() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final h = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

class _VolcConfig {
  _VolcConfig(String endpoint, this.apiKey, this.resourceId, this.timeout)
    : endpoint = Uri.parse(endpoint) {
    final host = this.endpoint.host.replaceAll('[', '').replaceAll(']', '');
    final local =
        host == 'localhost' ||
        (InternetAddress.tryParse(host)?.isLoopback ?? false);
    if (!(this.endpoint.scheme == 'wss' ||
            local && this.endpoint.scheme == 'ws') ||
        host.isEmpty ||
        this.endpoint.hasQuery ||
        this.endpoint.hasFragment ||
        this.endpoint.userInfo.isNotEmpty ||
        apiKey.trim().isEmpty ||
        apiKey.length > 8192 ||
        resourceId.trim().isEmpty ||
        resourceId.length > 256 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch('$apiKey$resourceId') ||
        timeout <= Duration.zero) {
      throw const CascadeFailure('invalid_volc_configuration');
    }
  }
  final Uri endpoint;
  final String apiKey, resourceId;
  final Duration timeout;
  Future<_VolcSocket> open(CascadeCancellation cancel) async {
    cancel.check();
    final http = HttpClient()..connectionTimeout = timeout;
    final abort = Completer<WebSocket>();
    final remove = cancel.onCancel(() {
      http.close(force: true);
      if (!abort.isCompleted) {
        abort.completeError(const CascadeFailure('cancelled'));
      }
    });
    WebSocket? socket;
    var abandoned = false;
    try {
      final pending = WebSocket.connect(
        endpoint.toString(),
        customClient: http,
        headers: {
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': _id(),
        },
      );
      unawaited(
        pending.then((value) {
          if (abandoned || cancel.isCancelled) unawaited(value.close());
        }, onError: (Object _) {}),
      );
      socket = await Future.any([pending, abort.future]).timeout(timeout);
      cancel.check();
      return _VolcSocket(socket, http, cancel, timeout);
    } catch (_) {
      abandoned = true;
      http.close(force: true);
      unawaited(socket?.close());
      cancel.check();
      throw const CascadeFailure('volc_connect_failed');
    } finally {
      remove();
    }
  }
}

/// Eager bounded queue prevents a paused consumer from accumulating WS frames.
class _VolcSocket {
  _VolcSocket(this.socket, this.http, this.cancel, this.timeout) {
    subscription = socket.listen(
      (raw) {
        if (raw is! List<int> ||
            raw.length > maxVolcFrameBytes ||
            queue.length >= 32 ||
            queuedBytes + raw.length > maxVolcFrameBytes) {
          fail(const CascadeFailure('volc_frame_overflow'));
          return;
        }
        if (closed) return;
        final bytes = Uint8List.fromList(raw);
        queuedBytes += bytes.length;
        queue.add(bytes);
        wake();
      },
      onError: (Object _) => fail(const CascadeFailure('volc_socket_failed')),
      onDone: () {
        closed = true;
        wake();
      },
    );
    remove = cancel.onCancel(() {
      beforeCancel?.call();
      fail(const CascadeFailure('cancelled'));
    });
    deadline = Timer(
      const Duration(minutes: 2),
      () => fail(const CascadeFailure('volc_timeout')),
    );
  }
  final WebSocket socket;
  final HttpClient http;
  final CascadeCancellation cancel;
  final Duration timeout;
  final queue = Queue<Uint8List>();
  int queuedBytes = 0;
  bool closed = false;
  Object? failure;
  void Function()? beforeCancel;
  Completer<void>? waiter;
  late final StreamSubscription<dynamic> subscription;
  late final void Function() remove;
  late final Timer deadline;
  void wake() {
    final value = waiter;
    waiter = null;
    value?.complete();
  }

  void fail(Object error) {
    failure ??= error;
    closed = true;
    queue.clear();
    queuedBytes = 0;
    wake();
    http.close(force: true);
    unawaited(socket.close());
  }

  void send(List<int> bytes) {
    cancel.check();
    if (closed || failure != null) throw const CascadeFailure('volc_closed');
    socket.add(bytes);
  }

  Future<Uint8List> receive() async {
    cancel.check();
    if (queue.isEmpty && !closed && failure == null) {
      waiter = Completer<void>();
      try {
        await waiter!.future.timeout(timeout);
      } on TimeoutException {
        fail(const CascadeFailure('volc_timeout'));
      }
    }
    cancel.check();
    if (failure != null) throw failure!;
    if (queue.isEmpty) throw const CascadeFailure('volc_closed_before_final');
    final value = queue.removeFirst();
    queuedBytes -= value.length;
    return value;
  }

  Future<void> close() async {
    closed = true;
    deadline.cancel();
    remove();
    wake();
    queue.clear();
    try {
      await socket.close().timeout(const Duration(seconds: 1));
    } catch (_) {}
    await subscription.cancel();
    http.close(force: true);
  }
}

class VolcAsr implements CascadeAsr {
  VolcAsr({
    required String endpoint,
    required String apiKey,
    required String resourceId,
    Duration timeout = const Duration(seconds: 15),
  }) : _config = _VolcConfig(endpoint, apiKey, resourceId, timeout);
  final _VolcConfig _config;
  @override
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm16,
    CascadeCancellation cancel,
  ) async* {
    if (pcm16.isEmpty || pcm16.length.isOdd || pcm16.length > 2080000) {
      throw const CascadeFailure('invalid_input_audio');
    }
    final socket = await _config.open(cancel);
    try {
      socket.send(volcAsrRequest(_id()));
      decodeVolcAsr(await socket.receive());
      unawaited(() async {
        try {
          var sequence = 2;
          // TS defaults use 200ms PCM chunks; the port receives one committed utterance.
          for (var i = 0; i < pcm16.length; i += 6400) {
            final end = min(i + 6400, pcm16.length);
            socket.send(
              volcAsrAudio(
                Uint8List.sublistView(pcm16, i, end),
                sequence++,
                finalFrame: end == pcm16.length,
              ),
            );
            // Let the socket drain between bounded writes.
            await Future<void>.delayed(Duration.zero);
          }
        } catch (_) {
          if (!socket.closed) {
            socket.fail(const CascadeFailure('volc_asr_send_failed'));
          }
        }
      }());
      for (var count = 0; count < 512; count++) {
        final event = decodeVolcAsr(await socket.receive());
        if (event == null) continue;
        cancel.check();
        yield event;
        if (event.isFinal) return;
      }
      throw const CascadeFailure('volc_event_overflow');
    } on CascadeFailure {
      rethrow;
    } catch (_) {
      cancel.check();
      throw const CascadeFailure('volc_asr_failed');
    } finally {
      await socket.close();
    }
  }
}

class VolcTts implements CascadeTts {
  VolcTts({
    required String endpoint,
    required String apiKey,
    required String resourceId,
    required this.voice,
    Duration timeout = const Duration(seconds: 15),
  }) : _config = _VolcConfig(endpoint, apiKey, resourceId, timeout) {
    if (voice.trim().isEmpty ||
        voice.length > 200 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(voice)) {
      throw const CascadeFailure('invalid_speech_voice');
    }
  }
  final _VolcConfig _config;
  final String voice;
  @override
  Stream<CascadeAudio> synthesize(
    String text,
    CascadeCancellation cancel,
  ) async* {
    if (text.trim().isEmpty || text.length > 4000) {
      throw const CascadeFailure('invalid_tts_segment');
    }
    final socket = await _config.open(cancel), sessionId = _id();
    var sessionStarted = false;
    void send(
      int event, {
      bool session = true,
      Map<String, dynamic>? payload,
    }) => socket.send(
      VolcFrame(
        type: 1,
        event: event,
        sessionId: session ? sessionId : null,
        payload: Uint8List.fromList(utf8.encode(jsonEncode(payload ?? {}))),
      ).encode(),
    );
    Map<String, dynamic> payload(int event, {String? text}) => {
      'event': event,
      'user': {'uid': _id()},
      'namespace': 'BidirectionalTTS',
      'req_params': {
        'speaker': voice,
        'audio_params': {
          'format': 'pcm',
          'sample_rate': 24000,
          'enable_timestamp': false,
        },
        'additions': jsonEncode({'disable_markdown_filter': false}),
        'text': ?text,
      },
    };
    // Best effort protocol cancel followed by socket disposal; no false server ack.
    socket.beforeCancel = () {
      if (sessionStarted && socket.socket.readyState == WebSocket.open) {
        socket.socket.add(
          VolcFrame(
            type: 1,
            event: 101,
            sessionId: sessionId,
            payload: Uint8List.fromList(utf8.encode('{}')),
          ).encode(),
        );
      }
    };
    Future<void> expectEvent(int event, {bool session = true}) async {
      final frame = VolcFrame.decode(await socket.receive());
      if (frame.type != 9 ||
          frame.event != event ||
          session && frame.sessionId != sessionId) {
        throw const CascadeFailure('volc_tts_handshake');
      }
    }

    try {
      send(1, session: false);
      await expectEvent(50, session: false);
      send(100, payload: payload(100));
      await expectEvent(150);
      sessionStarted = true;
      send(200, payload: payload(200, text: text));
      send(102);
      var total = 0;
      for (var count = 0; count < 4096; count++) {
        final frame = VolcFrame.decode(await socket.receive());
        if (frame.sessionId != null && frame.sessionId != sessionId) continue;
        if (frame.type == 15 || frame.event == 51 || frame.event == 153) {
          throw const CascadeFailure('volc_tts_failed');
        }
        if (frame.type == 11) {
          if (frame.payload.length.isOdd) {
            throw const CascadeFailure('invalid_tts_pcm');
          }
          total += frame.payload.length;
          if (total > 24000 * 2 * 120) {
            throw const CascadeFailure('tts_audio_overflow');
          }
          for (var i = 0; i < frame.payload.length; i += 24000) {
            cancel.check();
            yield CascadeAudio(
              Uint8List.sublistView(
                frame.payload,
                i,
                min(i + 24000, frame.payload.length),
              ),
              sampleRate: 24000,
            );
          }
        }
        if (frame.event == 152) {
          if (total == 0) throw const CascadeFailure('missing_tts_audio');
          return;
        }
        if (frame.event == 151) {
          throw const CascadeFailure('volc_tts_cancelled');
        }
      }
      throw const CascadeFailure('volc_event_overflow');
    } on CascadeFailure {
      rethrow;
    } catch (_) {
      cancel.check();
      throw const CascadeFailure('volc_tts_failed');
    } finally {
      socket.beforeCancel = null;
      if (!cancel.isCancelled && !socket.closed) send(2, session: false);
      await socket.close();
    }
  }
}
