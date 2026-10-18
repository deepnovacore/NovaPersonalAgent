// Opt-in real service harness. Never reads application/device secure storage.
// NOVA_VOICE_LIVE_CONFIG points to a private JSON file; no credentials in logs.
// This exercises the production Dart providers, not native microphone/playback,
// PhoneVoiceSession, tool execution, AEC, or physical-device acceptance.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_provider.dart';
import 'package:nova_mobile/voice/voice_provider_factory.dart';
import 'package:nova_mobile/voice/voice_settings.dart';

void main() {
  final configPath = Platform.environment['NOVA_VOICE_LIVE_CONFIG'];
  test(
    'opt-in production provider live acceptance',
    () async {
      final config =
          jsonDecode(await File(configPath!).readAsString())
              as Map<String, dynamic>;
      final profiles = (config['profiles'] as List)
          .cast<Map<String, dynamic>>();
      final secrets = <String>[];
      void collect(Object? value) {
        if (value is Map) {
          for (final entry in value.entries) {
            if (entry.key == 'key' &&
                entry.value is String &&
                (entry.value as String).isNotEmpty) {
              secrets.add(entry.value as String);
            } else {
              collect(entry.value);
            }
          }
        } else if (value is List) {
          value.forEach(collect);
        }
      }

      collect(profiles);
      String sanitize(String value) {
        for (final secret in secrets) {
          value = value.replaceAll(secret, '[REDACTED]');
        }
        return value.replaceAll(RegExp(r'https?://\S+|wss?://\S+'), '[URL]');
      }

      final run = DateTime.now().toUtc().toIso8601String().replaceAll(':', '-');
      final output = Directory('${config['output']}/run-$run');
      await output.create(recursive: true);
      final previousOverrides = HttpOverrides.current;
      if (config['proxy'] is String && (config['proxy'] as String).isNotEmpty) {
        HttpOverrides.global = _ProxyOverrides(
          config['proxy'] as String,
          (config['proxyHosts'] as List?)?.cast<String>(),
        );
      }
      final summaries = <Map<String, dynamic>>[];
      final deadline = DateTime.now().add(const Duration(minutes: 19));
      try {
        for (final profile in profiles) {
          if (config['selectProfile'] != null &&
              config['selectProfile'] != profile['id']) {
            continue;
          }
          if (DateTime.now().isAfter(deadline)) break;
          final id = _safeName(profile['id'] as String);
          final directory = Directory('${output.path}/$id');
          await directory.create();
          final report = <String, dynamic>{
            'profile': id,
            'startedAt': DateTime.now().toUtc().toIso8601String(),
            'scope': 'production Dart provider API; no native audio or device',
            'proxyEnabled': config['proxy'] != null,
            'sessions': <Map<String, dynamic>>[],
          };
          summaries.add(report);
          try {
            final settings = VoiceConfiguration.fromJson(
              profile['configuration'] as Map<String, dynamic>,
            );
            final smoke = await _session(
              settings,
              directory,
              'smoke',
              sanitize,
              (capture) async {
                await capture.text('只说：语音连接正常。', 'smoke');
              },
            );
            (report['sessions'] as List).add(smoke);
            if (smoke['status'] == 'passed' && config['mode'] != 'smoke') {
              if (config['mode'] == 'dialogue' || config['mode'] == 'all') {
                for (final rawCase in (config['cases'] as List? ?? const [])) {
                  if (DateTime.now().isAfter(deadline)) break;
                  final scenario = rawCase as Map<String, dynamic>;
                  final result = await _session(
                    settings,
                    directory,
                    'dialogue-${_safeName(scenario['id'] as String)}',
                    sanitize,
                    (capture) async {
                      final wavs = (scenario['userWavs'] as List)
                          .cast<String>();
                      for (var i = 0; i < wavs.length; i++) {
                        await capture.voice(
                          wavs[i],
                          'turn-${i + 1}',
                          expected: (scenario['turns'] as List?)?[i] as String?,
                        );
                      }
                    },
                  );
                  result['criteria'] = scenario['criteria'];
                  result['asrIncludes'] = scenario['asrIncludes'];
                  result['semanticAcceptance'] =
                      'requires transcript and saved audio review';
                  (report['sessions'] as List).add(result);
                }
              }
              if (config['mode'] == 'cancel' || config['mode'] == 'all') {
                (report['sessions'] as List).add(
                  await _session(
                    settings,
                    directory,
                    'cancel',
                    sanitize,
                    (capture) => capture.cancel(),
                  ),
                );
              }
            }
          } catch (error) {
            report['errorType'] = error.runtimeType.toString();
          }
          report['finishedAt'] = DateTime.now().toUtc().toIso8601String();
          await File(
            '${directory.path}/summary.json',
          ).writeAsString(const JsonEncoder.withIndent('  ').convert(report));
        }
      } finally {
        HttpOverrides.global = previousOverrides;
        await File('${output.path}/summary.json').writeAsString(
          const JsonEncoder.withIndent('  ').convert({'profiles': summaries}),
        );
      }
      // The test runner reports only counts. Detailed sanitized evidence stays in
      // the private output directory, including partial WAVs after failures.
      final failures = summaries
          .where(
            (p) =>
                p['errorType'] != null ||
                (p['sessions'] as List).any((s) => s['status'] == 'failed'),
          )
          .length;
      expect(
        failures,
        0,
        reason: '$failures live profiles have failed evidence',
      );
    },
    skip: configPath == null ? 'NOVA_VOICE_LIVE_CONFIG not set' : false,
    timeout: const Timeout(Duration(minutes: 20)),
  );
}

Future<Map<String, dynamic>> _session(
  VoiceConfiguration configuration,
  Directory parent,
  String name,
  String Function(String) sanitize,
  Future<void> Function(_Capture) body,
) async {
  final dir = Directory('${parent.path}/$name');
  await dir.create();
  final result = <String, dynamic>{'id': name, 'status': 'failed'};
  VoiceProvider? provider;
  _Capture? capture;
  try {
    provider = createVoiceProvider(configuration);
    capture = _Capture(provider, dir, sanitize);
    result['capabilities'] = {
      'cancelAcknowledged': provider.capabilities.cancelAcknowledged,
      'playbackReport': provider.capabilities.playbackReport,
      'voiceTools': provider.capabilities.voiceTools,
    };
    await provider
        .connect(epoch: 1, instructions: '请用简短自然的中文回答用户，记住本次对话的信息。不要调用任何工具。')
        .timeout(const Duration(seconds: 30));
    await body(capture).timeout(const Duration(minutes: 6));
    result['status'] = 'passed';
  } catch (error) {
    result['errorType'] = error.runtimeType.toString();
  } finally {
    try {
      await provider?.close().timeout(const Duration(seconds: 5));
    } catch (_) {
      result['closeFailed'] = true;
    }
    if (capture != null) {
      await capture.finish();
      result['turns'] = capture.turns;
      result['responses'] = capture.responseSummaries;
      result['providerErrors'] = capture.errors;
      if (capture.errors.isNotEmpty) result['status'] = 'failed';
    }
    await File(
      '${dir.path}/summary.json',
    ).writeAsString(const JsonEncoder.withIndent('  ').convert(result));
  }
  return result;
}

class _Capture {
  _Capture(this.provider, this.directory, this.sanitize) {
    clock.start();
    events = File('${directory.path}/events.jsonl').openWrite();
    subscription = provider.events.listen(
      _event,
      onError: (Object error) {
        errors.add({
          'ms': clock.elapsedMilliseconds,
          'type': error.runtimeType.toString(),
        });
      },
    );
  }
  final VoiceProvider provider;
  final Directory directory;
  final String Function(String) sanitize;
  final clock = Stopwatch();
  late final IOSink events;
  late final StreamSubscription<VoiceEvent> subscription;
  final responses = <String, _Response>{};
  final transcripts = <String, String>{};
  final turns = <Map<String, dynamic>>[];
  final errors = <Map<String, dynamic>>[];
  String? active;
  int terminals = 0, audioBytes = 0;
  int lastResponseActivityMs = 0;
  List<Map<String, dynamic>> get responseSummaries =>
      responses.entries.map((e) => e.value.summary(e.key)).toList();

  void _event(VoiceEvent e) {
    final ms = clock.elapsedMilliseconds;
    if (e.kind == VoiceEventKind.responseStart ||
        e.kind == VoiceEventKind.responseEnd ||
        e.kind == VoiceEventKind.cancelled ||
        e.kind == VoiceEventKind.audio ||
        e.kind == VoiceEventKind.text) {
      lastResponseActivityMs = ms;
    }
    if (e.kind == VoiceEventKind.responseStart) active = e.responseId;
    final id = e.responseId ?? active;
    final response = id == null
        ? null
        : responses.putIfAbsent(id, () => _Response(ms));
    if (e.kind == VoiceEventKind.transcript && e.text != null) {
      final item = e.itemId ?? 'unknown';
      transcripts[item] = e.replace || e.isFinal
          ? sanitize(e.text!)
          : '${transcripts[item] ?? ''}${sanitize(e.text!)}';
    }
    if (e.kind == VoiceEventKind.text && e.text != null && response != null) {
      response.text = e.replace
          ? sanitize(e.text!)
          : '${response.text}${sanitize(e.text!)}';
    }
    if (e.kind == VoiceEventKind.audio && e.pcm != null && response != null) {
      if (response.audio.isNotEmpty && response.rate != e.sampleRate) {
        errors.add({'ms': ms, 'code': 'mixed_response_sample_rates'});
        return;
      }
      if (e.pcm!.length.isOdd ||
          response.audio.length > e.sampleRate * 2 * 120) {
        errors.add({'ms': ms, 'code': 'invalid_or_excessive_audio'});
        return;
      }
      response.rate = e.sampleRate;
      response.audio.add(e.pcm!);
      audioBytes += e.pcm!.length;
      response.firstAudioMs ??= ms;
      final data = ByteData.sublistView(e.pcm!);
      double squares = 0;
      for (var i = 0; i + 1 < data.lengthInBytes; i += 2) {
        final sample = data.getInt16(i, Endian.little);
        squares += sample * sample;
      }
      final rms = sqrt(squares / max(1, data.lengthInBytes ~/ 2)) / 32768;
      response.peakRms = max(response.peakRms, rms);
      if (rms >= .003) response.firstSubstantiveAudioMs ??= ms;
    }
    if (e.kind == VoiceEventKind.responseEnd ||
        e.kind == VoiceEventKind.cancelled) {
      terminals++;
      response?.terminal = e.kind.name;
      response?.terminalCode = e.code == null ? null : sanitize(e.code!);
      response?.bytesAtTerminal = response.audio.length;
      if (e.code == 'failed' || e.code == 'incomplete') {
        errors.add({'ms': ms, 'code': 'response_terminal_failed'});
      }
      response?.endMs = ms;
      if (id == active) active = null;
    }
    if (e.kind == VoiceEventKind.error) {
      errors.add({'ms': ms, 'code': sanitize(e.code ?? 'provider_error')});
    }
    events.writeln(
      jsonEncode({
        'ms': ms, 'kind': e.kind.name, 'epoch': e.epoch,
        'responseId': e.responseId, 'itemId': e.itemId,
        'text': e.text == null ? null : sanitize(e.text!),
        'final': e.isFinal, 'replace': e.replace, 'hostOrigin': e.hostOrigin,
        'inputOriginVerified': e.inputOriginVerified,
        'pcmBytes': e.pcm?.length, 'sampleRate': e.sampleRate,
        'code': e.code == null ? null : sanitize(e.code!),
        // Tool arguments intentionally omitted, and no tool execution occurs.
        'toolCallObserved': e.kind == VoiceEventKind.toolCall,
      }),
    );
  }

  Future<void> wait(
    bool Function() predicate, {
    int seconds = 90,
    bool silence = false,
  }) async {
    final end = DateTime.now().add(Duration(seconds: seconds));
    while (!predicate()) {
      if (errors.isNotEmpty) throw StateError('provider_error');
      if (DateTime.now().isAfter(end)) {
        throw TimeoutException('live_turn_timeout');
      }
      if (silence) {
        await provider
            .sendAudio(Uint8List(640))
            .timeout(const Duration(seconds: 5));
      }
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    if (errors.isNotEmpty) throw StateError('provider_error');
  }

  Future<void> text(String text, String label) async {
    final before = terminals, beforeAudio = audioBytes;
    final turn = <String, dynamic>{
      'id': label,
      'inputText': text,
      'startMs': clock.elapsedMilliseconds,
    };
    turns.add(turn);
    await provider.submitText(text).timeout(const Duration(seconds: 15));
    await wait(() => terminals > before);
    turn['endMs'] = clock.elapsedMilliseconds;
    turn['audioBytes'] = audioBytes - beforeAudio;
    if (audioBytes == beforeAudio) throw StateError('no_audio_response');
    await saveWavs();
  }

  Future<void> voice(String path, String label, {String? expected}) async {
    final pcm = _read16kWav(await File(path).readAsBytes());
    final before = terminals, beforeAudio = audioBytes;
    final turn = <String, dynamic>{
      'id': label,
      'inputWav': path,
      'expectedInput': expected,
      'inputBytes': pcm.length,
      'startMs': clock.elapsedMilliseconds,
    };
    turns.add(turn);
    final pacing = Stopwatch()..start();
    // 20 ms capture frames, including two seconds of trailing silence. No
    // manual response.create: endpointing belongs to the production provider.
    final all = Uint8List(pcm.length + 64000)..setRange(0, pcm.length, pcm);
    for (var offset = 0; offset < all.length; offset += 640) {
      await provider
          .sendAudio(
            Uint8List.sublistView(all, offset, min(offset + 640, all.length)),
          )
          .timeout(const Duration(seconds: 5));
      final due = ((offset + 640) / 32).round();
      final delay = due - pacing.elapsedMilliseconds;
      if (delay > 0) await Future<void>.delayed(Duration(milliseconds: delay));
    }
    turn['inputEndMs'] = clock.elapsedMilliseconds;
    // An utterance may produce multiple server turns. An earlier terminal
    // must not complete capture while a later response is still streaming.
    await wait(
      () =>
          terminals > before &&
          active == null &&
          clock.elapsedMilliseconds - lastResponseActivityMs >= 750,
      silence: true,
    );
    turn['endMs'] = clock.elapsedMilliseconds;
    turn['audioBytes'] = audioBytes - beforeAudio;
    turn['transcripts'] = Map<String, String>.from(transcripts);
    if (audioBytes == beforeAudio) throw StateError('no_audio_response');
    await saveWavs();
    // Without a physical playback clock, space subsequent utterances by the
    // generated duration (bounded) so ordinary dialogue is not a barge-in test.
    final generatedMs = responses.values.fold<int>(
      0,
      (n, r) => max(n, r.audio.length * 1000 ~/ (r.rate * 2)),
    );
    await Future<void>.delayed(Duration(milliseconds: min(generatedMs, 15000)));
  }

  Future<void> cancel() async {
    final turn = <String, dynamic>{
      'id': 'cancel',
      'startMs': clock.elapsedMilliseconds,
    };
    turns.add(turn);
    await provider
        .submitText('请从一数到五十，每个数字之间稍作停顿。')
        .timeout(const Duration(seconds: 15));
    await wait(
      () => responses.values.any(
        (r) => r.firstSubstantiveAudioMs != null && r.audio.length >= r.rate,
      ),
    );
    final id = active;
    if (id == null) {
      turn['cancelCoverage'] = 'not_covered_response_already_terminal';
      return;
    }
    final before = terminals, beforeAudio = audioBytes;
    turn['responseId'] = id;
    turn['requestMs'] = clock.elapsedMilliseconds;
    try {
      await provider.cancelResponse(id).timeout(const Duration(seconds: 10));
      turn['apiReturn'] = 'returned';
    } on UnsupportedError {
      turn['cancelCoverage'] = 'unsupported';
      await wait(() => terminals > before);
      return;
    }
    final afterReturnBytes = responses[id]!.audio.length;
    turn['apiReturnMs'] = clock.elapsedMilliseconds;
    await wait(() => terminals > before, seconds: 15);
    turn['terminal'] = responses[id]?.terminal;
    await Future<void>.delayed(const Duration(milliseconds: 1200));
    turn['bytesAfterCancelRequest'] = audioBytes - beforeAudio;
    turn['bytesAfterApiReturn'] =
        responses[id]!.audio.length - afterReturnBytes;
    turn['bytesAfterTerminal'] =
        responses[id]!.audio.length -
        (responses[id]!.bytesAtTerminal ?? responses[id]!.audio.length);
    turn['endMs'] = clock.elapsedMilliseconds;
    await text('只说：现在恢复正常。', 'after-cancel-recovery');
  }

  Future<void> saveWavs() async {
    for (final entry in responses.entries) {
      final r = entry.value;
      if (r.audio.isEmpty) continue;
      await File(
        '${directory.path}/${_safeName(entry.key)}.wav',
      ).writeAsBytes(_wav(r.audio.toBytes(), r.rate));
    }
  }

  Future<void> finish() async {
    await subscription.cancel();
    await saveWavs();
    await events.close();
  }
}

class _Response {
  _Response(this.startMs);
  final int startMs;
  final audio = BytesBuilder(copy: false);
  int rate = 24000;
  int? firstAudioMs, firstSubstantiveAudioMs, endMs;
  double peakRms = 0;
  String text = '', terminal = 'pending';
  String? terminalCode;
  int? bytesAtTerminal;
  Map<String, dynamic> summary(String id) => {
    'responseId': id,
    'startMs': startMs,
    'firstAudioMs': firstAudioMs,
    'firstSubstantiveAudioMs': firstSubstantiveAudioMs,
    'endMs': endMs,
    'terminal': terminal,
    'terminalCode': terminalCode,
    'sampleRate': rate,
    'audioBytes': audio.length,
    'audioMs': audio.length * 1000 ~/ (rate * 2),
    'peakRms': peakRms,
    'text': text,
  };
}

String _safeName(String value) =>
    value.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '_');
Uint8List _read16kWav(Uint8List bytes) {
  final b = ByteData.sublistView(bytes);
  if (bytes.length < 44 ||
      ascii.decode(bytes.sublist(0, 4)) != 'RIFF' ||
      ascii.decode(bytes.sublist(8, 12)) != 'WAVE') {
    throw const FormatException('invalid_input_wav');
  }
  bool valid = false;
  Uint8List? pcm;
  for (var p = 12; p + 8 <= bytes.length;) {
    final tag = ascii.decode(bytes.sublist(p, p + 4));
    final n = b.getUint32(p + 4, Endian.little), start = p + 8;
    if (start + n > bytes.length) throw const FormatException('truncated_wav');
    if (tag == 'fmt ' && n >= 16) {
      valid =
          b.getUint16(start, Endian.little) == 1 &&
          b.getUint16(start + 2, Endian.little) == 1 &&
          b.getUint32(start + 4, Endian.little) == 16000 &&
          b.getUint16(start + 14, Endian.little) == 16;
    }
    if (tag == 'data') pcm = Uint8List.sublistView(bytes, start, start + n);
    p = start + n + n % 2;
  }
  if (!valid ||
      pcm == null ||
      pcm.isEmpty ||
      pcm.length.isOdd ||
      pcm.length > 16000 * 2 * 60) {
    throw const FormatException('unsupported_wav');
  }
  return pcm;
}

Uint8List _wav(Uint8List pcm, int rate) {
  final bytes = Uint8List(44 + pcm.length), b = ByteData(44);
  bytes.setRange(0, 4, ascii.encode('RIFF'));
  b.setUint32(4, 36 + pcm.length, Endian.little);
  bytes.setRange(8, 16, ascii.encode('WAVEfmt '));
  b.setUint32(16, 16, Endian.little);
  b.setUint16(20, 1, Endian.little);
  b.setUint16(22, 1, Endian.little);
  b.setUint32(24, rate, Endian.little);
  b.setUint32(28, rate * 2, Endian.little);
  b.setUint16(32, 2, Endian.little);
  b.setUint16(34, 16, Endian.little);
  bytes.setRange(36, 40, ascii.encode('data'));
  b.setUint32(40, pcm.length, Endian.little);
  for (final range in [
    [4, 8],
    [16, 36],
    [40, 44],
  ]) {
    bytes.setRange(range[0], range[1], b.buffer.asUint8List(), range[0]);
  }
  bytes.setRange(44, bytes.length, pcm);
  return bytes;
}

class _ProxyOverrides extends HttpOverrides {
  _ProxyOverrides(String value, this.hosts) : proxy = Uri.parse(value) {
    if (proxy.scheme != 'http' ||
        proxy.host.isEmpty ||
        proxy.userInfo.isNotEmpty) {
      throw const FormatException('invalid_proxy');
    }
  }
  final Uri proxy;
  final List<String>? hosts;
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context)
        ..findProxy = (uri) => hosts == null || hosts!.contains(uri.host)
            ? 'PROXY ${proxy.host}:${proxy.port}'
            : 'DIRECT';
}
