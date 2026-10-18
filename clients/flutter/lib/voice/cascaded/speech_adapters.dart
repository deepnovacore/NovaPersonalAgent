import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'ports.dart';
import '../../agent_core/model_client.dart' show compatibleEndpoint;

Uri _endpoint(String value, {bool ws = false}) {
  final uri = Uri.tryParse(value);
  final local =
      uri != null &&
      (uri.host == 'localhost' ||
          (InternetAddress.tryParse(uri.host)?.isLoopback ?? false));
  if (uri == null ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasFragment ||
      !(uri.scheme == (ws ? 'wss' : 'https') ||
          (local && uri.scheme == (ws ? 'ws' : 'http')))) {
    throw const CascadeFailure('invalid_speech_endpoint');
  }
  return uri;
}

void _key(String key) {
  if (key.length > 8192 || key.contains('\r') || key.contains('\n')) {
    throw const CascadeFailure('invalid_speech_key');
  }
}

void _audio(Uint8List pcm) {
  if (pcm.isEmpty || pcm.length.isOdd || pcm.length > 2080000) {
    throw const CascadeFailure('invalid_input_audio');
  }
}

/// One bounded generateContent request per utterance/host-segment.
class _GeminiSpeech {
  _GeminiSpeech({
    required String endpoint,
    required this.model,
    required this.apiKey,
  }) : endpoint = _endpoint(endpoint) {
    _key(apiKey);
    if (model.isEmpty ||
        model.length > 200 ||
        apiKey.isEmpty ||
        this.endpoint.hasQuery) {
      throw const CascadeFailure('invalid_gemini_speech');
    }
  }
  final Uri endpoint;
  final String model, apiKey;
  Future<List<Map<String, dynamic>>> generate(
    Map<String, dynamic> body,
    CascadeCancellation cancel,
  ) async {
    cancel.check();
    final http = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    final remove = cancel.onCancel(() => http.close(force: true));
    final timer = Timer(
      const Duration(seconds: 60),
      () => http.close(force: true),
    );
    try {
      final base = endpoint.toString().replaceFirst(RegExp(r'/$'), '');
      final request = await http.postUrl(
        Uri.parse('$base/models/${Uri.encodeComponent(model)}:generateContent'),
      );
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      request.headers.set('x-goog-api-key', apiKey);
      request.write(jsonEncode(body));
      final response = await request.close();
      if (response.statusCode != 200) {
        throw const CascadeFailure('speech_http_failed');
      }
      final bytes = BytesBuilder();
      await for (final chunk in response) {
        cancel.check();
        if (bytes.length + chunk.length > 20 * 1024 * 1024) {
          throw const CascadeFailure('speech_response_overflow');
        }
        bytes.add(chunk);
      }
      cancel.check();
      final root = jsonDecode(utf8.decode(bytes.takeBytes())) as Map;
      final candidates = root['candidates'] as List;
      if (candidates.length != 1 ||
          candidates.single['finishReason'] != 'STOP') {
        throw const CascadeFailure('speech_incomplete');
      }
      return (candidates.single['content']['parts'] as List)
          .map((p) => Map<String, dynamic>.from(p as Map))
          .where((p) => p['thought'] != true)
          .toList();
    } on CascadeFailure {
      rethrow;
    } catch (_) {
      cancel.check();
      throw const CascadeFailure('speech_request_failed');
    } finally {
      timer.cancel();
      remove();
      http.close(force: true);
    }
  }
}

class GeminiBatchAsr implements CascadeAsr {
  GeminiBatchAsr({
    required String endpoint,
    required String model,
    required String apiKey,
  }) : _speech = _GeminiSpeech(
         endpoint: endpoint,
         model: model,
         apiKey: apiKey,
       );
  final _GeminiSpeech _speech;
  @override
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm16,
    CascadeCancellation cancel,
  ) async* {
    _audio(pcm16);
    final parts = await _speech.generate({
      'contents': [
        {
          'parts': [
            {
              'text':
                  'Transcribe the spoken audio verbatim in its original language. Output only the transcript, with no commentary or translation. If there is no speech, output an empty string.',
            },
            {
              'inlineData': {
                'mimeType': 'audio/wav',
                'data': base64Encode(pcmWav(pcm16, 16000)),
              },
            },
          ],
        },
      ],
      'generationConfig': {'temperature': 0},
    }, cancel);
    final text = parts.map((p) => p['text'] as String? ?? '').join().trim();
    if (text.length > 4000) throw const CascadeFailure('transcript_overflow');
    cancel.check();
    yield CascadeTranscript(text, isFinal: true);
  }
}

class GeminiBatchTts implements CascadeTts {
  GeminiBatchTts({
    required String endpoint,
    required String model,
    required String apiKey,
    required this.voice,
  }) : _speech = _GeminiSpeech(
         endpoint: endpoint,
         model: model,
         apiKey: apiKey,
       ) {
    if (voice.isEmpty || voice.length > 200) {
      throw const CascadeFailure('invalid_speech_voice');
    }
  }
  final _GeminiSpeech _speech;
  final String voice;
  @override
  Stream<CascadeAudio> synthesize(
    String text,
    CascadeCancellation cancel,
  ) async* {
    if (text.isEmpty || text.length > 256) {
      throw const CascadeFailure('invalid_tts_segment');
    }
    final parts = await _speech.generate({
      'contents': [
        {
          'parts': [
            {'text': text},
          ],
        },
      ],
      'generationConfig': {
        'responseModalities': ['AUDIO'],
        'speechConfig': {
          'voiceConfig': {
            'prebuiltVoiceConfig': {'voiceName': voice},
          },
        },
      },
    }, cancel);
    var found = false;
    for (final part in parts) {
      if (part['inlineData'] == null) continue;
      final data = part['inlineData'] as Map;
      final pcm = decodeGeminiAudio(
        data['mimeType'] as String,
        data['data'] as String,
      );
      found = true;
      for (var i = 0; i < pcm.length; i += 24000) {
        cancel.check();
        yield CascadeAudio(
          Uint8List.fromList(
            pcm.sublist(i, i + 24000 > pcm.length ? pcm.length : i + 24000),
          ),
          sampleRate: 24000,
        );
      }
    }
    if (!found) throw const CascadeFailure('missing_tts_audio');
  }
}

class SelfHostedWsAsr implements CascadeAsr {
  SelfHostedWsAsr({required String endpoint, this.apiKey = ''})
    : endpoint = _endpoint(endpoint, ws: true) {
    _key(apiKey);
  }
  final Uri endpoint;
  final String apiKey;
  @override
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm16,
    CascadeCancellation cancel,
  ) async* {
    _audio(pcm16);
    cancel.check();
    final http = HttpClient()..connectionTimeout = const Duration(seconds: 10);
    WebSocket? socket;
    final remove = cancel.onCancel(() {
      http.close(force: true);
      unawaited(socket?.close());
    });
    final deadline = Timer(const Duration(seconds: 120), () {
      http.close(force: true);
      unawaited(socket?.close());
    });
    StreamIterator<dynamic>? iterator;
    try {
      final pending = WebSocket.connect(
        endpoint.toString(),
        headers: {if (apiKey.isNotEmpty) 'Authorization': 'Bearer $apiKey'},
        customClient: http,
      );
      // A late handshake must not leave a live socket after cancellation/timeout.
      var abandoned = false;
      unawaited(
        pending.then((value) {
          if (abandoned || cancel.isCancelled) unawaited(value.close());
        }, onError: (Object _) {}),
      );
      try {
        socket = await pending.timeout(const Duration(seconds: 10));
      } finally {
        abandoned = true;
      }
      cancel.check();
      iterator = StreamIterator(socket.timeout(const Duration(seconds: 30)));
      if (!await iterator.moveNext()) {
        throw const CascadeFailure('asr_closed_before_ready');
      }
      final ready = _asrMessage(iterator.current);
      if (ready['type'] != 'ready' ||
          ready['sampleRate'] != 16000 ||
          ready['format'] != 's16le') {
        throw const CascadeFailure('invalid_asr_ready');
      }
      // addStream awaits each bounded frame sequence before finish is sent.
      await socket.addStream(
        Stream<Uint8List>.fromIterable([
          for (var i = 0; i < pcm16.length; i += 32000)
            Uint8List.sublistView(
              pcm16,
              i,
              i + 32000 > pcm16.length ? pcm16.length : i + 32000,
            ),
        ]),
      );
      cancel.check();
      socket.add('finish');
      var count = 0;
      while (await iterator.moveNext()) {
        cancel.check();
        if (++count > 256) throw const CascadeFailure('asr_event_overflow');
        final value = _asrMessage(iterator.current);
        if (value['text'] is! String ||
            (value['text'] as String).length > 4000 ||
            value['final'] is! bool ||
            value['replace'] != true ||
            value['error'] != null) {
          throw const CascadeFailure('invalid_asr_transcript');
        }
        yield CascadeTranscript(
          value['text'] as String,
          isFinal: value['final'] == true,
        );
        if (value['final'] == true) return;
      }
      throw const CascadeFailure('asr_closed_before_final');
    } on CascadeFailure {
      rethrow;
    } catch (_) {
      cancel.check();
      throw const CascadeFailure('asr_request_failed');
    } finally {
      deadline.cancel();
      remove();
      await iterator?.cancel();
      unawaited(socket?.close());
      http.close(force: true);
    }
  }

  Map<String, dynamic> _asrMessage(dynamic raw) {
    if (raw is! String || raw.length > 32768) {
      throw const CascadeFailure('invalid_asr_message');
    }
    return jsonDecode(raw) as Map<String, dynamic>;
  }
}

class SelfHostedPcmTts implements CascadeTts {
  SelfHostedPcmTts({
    required String endpoint,
    this.apiKey = '',
    this.instruction = '',
    this.sampleRate = 24000,
  }) : endpoint = _endpoint(endpoint) {
    _key(apiKey);
    if (![16000, 22050, 24000, 44100, 48000].contains(sampleRate) ||
        instruction.length > 4000) {
      throw const CascadeFailure('invalid_tts_settings');
    }
  }
  final Uri endpoint;
  final String apiKey, instruction;
  final int sampleRate;
  @override
  Stream<CascadeAudio> synthesize(
    String text,
    CascadeCancellation cancel,
  ) async* {
    if (text.isEmpty || text.length > 256) {
      throw const CascadeFailure('invalid_tts_segment');
    }
    cancel.check();
    final http = HttpClient()..connectionTimeout = const Duration(seconds: 10);
    final remove = cancel.onCancel(() => http.close(force: true));
    final timer = Timer(
      const Duration(seconds: 60),
      () => http.close(force: true),
    );
    try {
      final request = await http.postUrl(endpoint);
      request.followRedirects = false;
      if (apiKey.isNotEmpty) {
        request.headers.set('Authorization', 'Bearer $apiKey');
      }
      // Match the generic TS adapter's multipart text/instruction contract.
      final boundary = 'nova-${DateTime.now().microsecondsSinceEpoch}';
      request.headers.set(
        'Content-Type',
        'multipart/form-data; boundary=$boundary',
      );
      for (final entry in {'text': text, 'instruction': instruction}.entries) {
        request.write(
          '--$boundary\r\nContent-Disposition: form-data; name="${entry.key}"\r\n\r\n${entry.value}\r\n',
        );
      }
      request.write('--$boundary--\r\n');
      final response = await request.close();
      if (response.statusCode != 200) {
        throw const CascadeFailure('tts_http_failed');
      }
      if (response.headers.value('x-sample-rate') != '$sampleRate' ||
          response.headers.value('x-sample-format') != 's16le' ||
          response.headers.contentType?.mimeType != 'audio/pcm') {
        throw const CascadeFailure('invalid_tts_audio_format');
      }
      var bytes = 0;
      int? odd;
      await for (final chunk in response) {
        cancel.check();
        bytes += chunk.length;
        if (bytes > sampleRate * 2 * 120) {
          throw const CascadeFailure('tts_audio_overflow');
        }
        final joined = Uint8List.fromList([?odd, ...chunk]);
        final end = joined.length - joined.length % 2;
        odd = end < joined.length ? joined.last : null;
        for (var i = 0; i < end; i += 24000) {
          yield CascadeAudio(
            Uint8List.fromList(
              joined.sublist(i, i + 24000 > end ? end : i + 24000),
            ),
            sampleRate: sampleRate,
          );
        }
      }
      if (odd != null || bytes == 0) {
        throw const CascadeFailure('incomplete_tts_audio');
      }
    } on CascadeFailure {
      rethrow;
    } catch (_) {
      cancel.check();
      throw const CascadeFailure('tts_request_failed');
    } finally {
      timer.cancel();
      remove();
      http.close(force: true);
    }
  }
}

Uint8List pcmWav(Uint8List pcm, int rate) {
  final out = Uint8List(44 + pcm.length), data = ByteData(44);
  out.setAll(0, ascii.encode('RIFF'));
  data.setUint32(4, 36 + pcm.length, Endian.little);
  out.setAll(8, ascii.encode('WAVEfmt '));
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little);
  data.setUint16(22, 1, Endian.little);
  data.setUint32(24, rate, Endian.little);
  data.setUint32(28, rate * 2, Endian.little);
  data.setUint16(32, 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  out.setAll(36, ascii.encode('data'));
  data.setUint32(40, pcm.length, Endian.little);
  for (final range in [
    [4, 8],
    [16, 36],
    [40, 44],
  ]) {
    out.setRange(range[0], range[1], data.buffer.asUint8List(), range[0]);
  }
  out.setAll(44, pcm);
  return out;
}

Uint8List decodeGeminiAudio(String mime, String encoded) {
  final bytes = base64Decode(encoded);
  if (RegExp(
    r'^audio/(pcm|L16);(?:codec=pcm;)?rate=24000$',
    caseSensitive: false,
  ).hasMatch(mime.replaceAll(RegExp(r'\s'), ''))) {
    if (bytes.isEmpty || bytes.length.isOdd) {
      throw const CascadeFailure('invalid_tts_pcm');
    }
    return bytes;
  }
  if (!['audio/wav', 'audio/x-wav'].contains(mime) ||
      bytes.length < 44 ||
      ascii.decode(bytes.sublist(0, 4)) != 'RIFF' ||
      ascii.decode(bytes.sublist(8, 12)) != 'WAVE') {
    throw const CascadeFailure('invalid_tts_wav');
  }
  final data = ByteData.sublistView(bytes);
  if (data.getUint32(4, Endian.little) != bytes.length - 8) {
    throw const CascadeFailure('invalid_tts_wav');
  }
  final pcm = BytesBuilder();
  var valid = false;
  for (var i = 12; i + 8 <= bytes.length;) {
    final tag = ascii.decode(bytes.sublist(i, i + 4)),
        size = data.getUint32(i + 4, Endian.little),
        start = i + 8;
    if (start + size > bytes.length) {
      throw const CascadeFailure('invalid_tts_wav');
    }
    if (tag == 'fmt ') {
      if (size < 16 ||
          data.getUint16(start, Endian.little) != 1 ||
          data.getUint16(start + 2, Endian.little) != 1 ||
          data.getUint32(start + 4, Endian.little) != 24000 ||
          data.getUint16(start + 14, Endian.little) != 16) {
        throw const CascadeFailure('unsupported_tts_wav');
      }
      valid = true;
    }
    if (tag == 'data') pcm.add(bytes.sublist(start, start + size));
    i = start + size + size % 2;
  }
  if (!valid || pcm.length == 0 || pcm.length.isOdd) {
    throw const CascadeFailure('invalid_tts_wav');
  }
  return pcm.takeBytes();
}

/// Bounded HTTP audio transport shared by the two compatible speech stages.
Future<(Uint8List, String)> _compatibleSpeechRequest(
  String endpoint,
  String route,
  String apiKey,
  CascadeCancellation cancel,
  void Function(HttpClientRequest) write,
) async {
  if (_endpoint(endpoint).hasQuery) {
    throw const CascadeFailure('invalid_speech_endpoint');
  }
  _key(apiKey);
  cancel.check();
  final http = HttpClient()..connectionTimeout = const Duration(seconds: 15);
  final stopped = Completer<void>();
  void stop() {
    http.close(force: true);
    if (!stopped.isCompleted) stopped.complete();
  }

  final remove = cancel.onCancel(stop);
  var expired = false;
  final timer = Timer(const Duration(seconds: 60), () {
    expired = true;
    stop();
  });
  Future<T> wait<T>(Future<T> pending) => Future.any([
    pending,
    stopped.future.then<T>((_) {
      cancel.check();
      throw const CascadeFailure('speech_timeout');
    }),
  ]);
  try {
    final request = await wait(
      http.postUrl(compatibleEndpoint(endpoint, route)),
    );
    request.followRedirects = false;
    request.headers.set('Authorization', 'Bearer $apiKey');
    write(request);
    final response = await wait(request.close());
    if (response.statusCode != 200) {
      throw const CascadeFailure('speech_http_failed');
    }
    final bytes = BytesBuilder();
    await for (final chunk in response) {
      cancel.check();
      if (bytes.length + chunk.length > 6 * 1024 * 1024) {
        throw const CascadeFailure('speech_response_overflow');
      }
      bytes.add(chunk);
    }
    cancel.check();
    if (expired) {
      throw const CascadeFailure('speech_timeout');
    }
    return (bytes.takeBytes(), response.headers.contentType?.mimeType ?? '');
  } on CascadeFailure {
    rethrow;
  } catch (_) {
    cancel.check();
    throw const CascadeFailure('speech_request_failed');
  } finally {
    timer.cancel();
    remove();
    http.close(force: true);
  }
}

class OpenAiCompatibleAsr implements CascadeAsr {
  OpenAiCompatibleAsr({
    required this.endpoint,
    required this.model,
    required this.apiKey,
    this.sendResponseFormat = true,
  });
  final String endpoint, model, apiKey;
  final bool sendResponseFormat;
  @override
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm16,
    CascadeCancellation cancel,
  ) async* {
    _audio(pcm16);
    if (model.isEmpty ||
        model.length > 200 ||
        RegExp(r'[\r\n]').hasMatch(model)) {
      throw const CascadeFailure('invalid_speech_model');
    }
    final (bytes, mime) = await _compatibleSpeechRequest(
      endpoint,
      'audio/transcriptions',
      apiKey,
      cancel,
      (request) {
        final boundary = 'nova-${DateTime.now().microsecondsSinceEpoch}';
        request.headers.set(
          'Content-Type',
          'multipart/form-data; boundary=$boundary',
        );
        request.write(
          '--$boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\n$model\r\n',
        );
        if (sendResponseFormat) {
          request.write(
            '--$boundary\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n',
          );
        }
        request.write(
          '--$boundary\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n',
        );
        request.add(pcmWav(pcm16, 16000));
        request.write('\r\n--$boundary--\r\n');
      },
    );
    if (mime != 'application/json') {
      throw const CascadeFailure('invalid_asr_response');
    }
    final dynamic root;
    try {
      root = jsonDecode(utf8.decode(bytes));
    } catch (_) {
      throw const CascadeFailure('invalid_asr_response');
    }
    if (root is! Map ||
        root['text'] is! String ||
        (root['text'] as String).length > 4000) {
      throw const CascadeFailure('invalid_asr_response');
    }
    cancel.check();
    yield CascadeTranscript((root['text'] as String).trim(), isFinal: true);
  }
}

class OpenAiCompatibleTts implements CascadeTts {
  OpenAiCompatibleTts({
    required this.endpoint,
    required this.model,
    required this.apiKey,
    required this.voice,
    this.requestSampleRate = false,
  });
  final String endpoint, model, apiKey, voice;
  final bool requestSampleRate;
  @override
  Stream<CascadeAudio> synthesize(
    String text,
    CascadeCancellation cancel,
  ) async* {
    if (text.isEmpty || text.length > 256 || model.isEmpty || voice.isEmpty) {
      throw const CascadeFailure('invalid_tts_segment');
    }
    final (bytes, mime) = await _compatibleSpeechRequest(
      endpoint,
      'audio/speech',
      apiKey,
      cancel,
      (request) {
        request.headers.contentType = ContentType.json;
        request.write(
          jsonEncode({
            'model': model,
            'voice': voice,
            'input': text,
            'response_format': 'pcm',
            if (requestSampleRate) 'sample_rate': 24000,
          }),
        );
      },
    );
    final Uint8List pcm;
    if (['audio/wav', 'audio/x-wav'].contains(mime)) {
      pcm = decodeGeminiAudio(mime, base64Encode(bytes));
    } else if (['audio/pcm', 'application/octet-stream'].contains(mime) &&
        bytes.isNotEmpty &&
        bytes.length.isEven) {
      // Raw PCM is explicitly requested at 24 kHz; compressed/JSON MIME is rejected.
      pcm = bytes;
    } else {
      throw const CascadeFailure('invalid_tts_audio_format');
    }
    for (var i = 0; i < pcm.length; i += 24000) {
      cancel.check();
      yield CascadeAudio(
        Uint8List.sublistView(
          pcm,
          i,
          i + 24000 > pcm.length ? pcm.length : i + 24000,
        ),
        sampleRate: 24000,
      );
    }
  }
}
