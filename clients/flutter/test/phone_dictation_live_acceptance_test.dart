// Opt-in synthetic audio acceptance of production PhoneDictation + API ASR.
// Native capture/permissions are injected, so this is NOT microphone, acoustic,
// device, AEC, speech-playback, LLM, TTS, or message-send acceptance.
// Reads only NOVA_DICTATION_LIVE_CONFIG, never application secure storage.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/phone_dictation.dart';
import 'package:nova_mobile/voice/audio_owner.dart';
import 'package:nova_mobile/voice/cascaded/ports.dart';
import 'package:nova_mobile/voice/voice_provider_factory.dart';
import 'package:nova_mobile/voice/voice_settings.dart';

import 'support/fake_audio.dart';

// Widget observer support is needed by PhoneDictation, but the live API must
// not be replaced by Flutter tests' default HTTP-400 client.
class _ApiBinding extends AutomatedTestWidgetsFlutterBinding {
  @override
  bool get overrideHttpClient => false;
}

class _SyntheticCapture extends FakeAudio {
  int? generation;
  bool capturing = false;
  int playbackCalls = 0;

  @override
  Future<void> startRelay({
    required int generation,
    required bool capture,
    required double threshold,
  }) async {
    if (!capture || capturing) throw StateError('invalid_synthetic_capture');
    this.generation = generation;
    capturing = true;
    await super.startRelay(
      generation: generation,
      capture: capture,
      threshold: threshold,
    );
  }

  void feed(Uint8List pcm) {
    if (!capturing) throw StateError('capture_not_started');
    for (var start = 0; start < pcm.length; start += 6400) {
      final end = start + 6400 > pcm.length ? pcm.length : start + 6400;
      controller.add({
        'kind': 'pcm',
        'generation': generation,
        'pcm': Uint8List.sublistView(pcm, start, end),
      });
    }
  }

  @override
  Future<void> stop() async {
    capturing = false;
    await super.stop();
  }

  @override
  Future<void> enqueue(Uint8List frame) async {
    playbackCalls++;
  }
}

// Instrumentation passes through to the real factory adapter unchanged.
class _ObservedAsr implements CascadeAsr {
  _ObservedAsr(this.delegate, this.beforeUpload);
  final CascadeAsr delegate;
  final void Function(int) beforeUpload;
  @override
  Stream<CascadeTranscript> transcribe(
    Uint8List pcm16,
    CascadeCancellation cancel,
  ) {
    beforeUpload(pcm16.length);
    return delegate.transcribe(pcm16, cancel);
  }
}

void main() {
  final path = Platform.environment['NOVA_DICTATION_LIVE_CONFIG'];
  final enabled = path != null && path.isNotEmpty;
  if (enabled) _ApiBinding();
  test(
    'opt-in API-only dictation: two synthetic passes with local cancellation',
    () async {
      final clock = Stopwatch()..start();
      Duration remaining() {
        final left = const Duration(seconds: 115) - clock.elapsed;
        if (left <= Duration.zero) {
          throw TimeoutException('acceptance_deadline');
        }
        return left;
      }

      final report = <String, Object?>{
        'scope':
            'production PhoneDictation and Volc ASR; injected synthetic PCM/native permissions; no physical microphone or auto-send',
        'profile': 'volc-deepseek-volc',
        'status': 'failed',
        'passes': <Map<String, Object?>>[],
      };
      PhoneDictation? dictation;
      _SyntheticCapture? audio;
      String secret = '';
      final output = Platform.environment['NOVA_DICTATION_LIVE_OUTPUT'];
      try {
        final file = File(path!);
        if (await file.length() > 2 * 1024 * 1024) {
          throw StateError('acceptance_config_too_large');
        }
        final root =
            jsonDecode(await file.readAsString()) as Map<String, dynamic>;
        final profile = (root['profiles'] as List)
            .cast<Map<String, dynamic>>()
            .singleWhere((item) => item['id'] == 'volc-deepseek-volc');
        final configuration = VoiceConfiguration.fromJson(
          profile['configuration'] as Map<String, dynamic>,
        );
        if (configuration.asrProvider != SpeechProvider.volcengine) {
          throw StateError('expected_volc_asr');
        }
        configuration.validateAsr();
        secret = configuration.asr.key;
        final scenario = (root['cases'] as List).first as Map<String, dynamic>;
        final wavPath = (scenario['userWavs'] as List).first as String;
        final includes = ((scenario['asrIncludes'] as List).first as List)
            .cast<String>();
        if (includes.isEmpty || includes.any((word) => word.isEmpty)) {
          throw StateError('missing_synthetic_expectation');
        }
        final wavFile = File(wavPath);
        if (await wavFile.length() > 16000 * 2 * 45 + 65536) {
          throw StateError('synthetic_wav_too_large');
        }
        final pcm = _readSynthetic16kWav(await wavFile.readAsBytes());
        final capture = audio = _SyntheticCapture();
        final drafts = <String>[];
        var uploads = 0, permissionCalls = 0;
        final controller = dictation = PhoneDictation(
          onText: drafts.add,
          audio: capture,
          audioOwner: AudioOwner(),
          requestMicrophone: () async {
            permissionCalls++;
            return true;
          },
          readConfiguration: () async => configuration,
          createAsr: (config) => _ObservedAsr(createVoiceAsr(config), (bytes) {
            if (capture.capturing || bytes != pcm.length) {
              throw StateError('capture_upload_contract_failed');
            }
            uploads++;
          }),
        );
        for (var pass = 0; pass < 2; pass++) {
          final started = clock.elapsedMilliseconds;
          await controller.begin('zh').timeout(remaining());
          expect(
            controller.recording,
            true,
            reason: 'synthetic capture did not start',
          );
          expect(drafts.length, pass);
          capture.feed(pcm);
          expect(
            drafts.length,
            pass,
            reason: 'capture must not insert or send text',
          );
          await controller.finish().timeout(remaining());
          expect(
            controller.notice.isEmpty,
            true,
            reason: 'API dictation did not finish successfully',
          );
          expect(
            drafts.length,
            pass + 1,
            reason: 'exactly one final draft per successful pass',
          );
          final text = drafts.last;
          expect(
            includes.every(text.contains),
            true,
            reason: 'saved synthetic case keywords missing',
          );
          expect(controller.busy, false);
          (report['passes'] as List).add({
            'pass': pass + 1,
            'durationMs': clock.elapsedMilliseconds - started,
            'audioBytes': pcm.length,
            'sampleRate': 16000,
            'expectedKeywordsMatched': true,
            'finalDraft': secret.isEmpty
                ? text
                : text.replaceAll(secret, '[REDACTED]'),
          });
          if (pass == 0) {
            // Cancel an explicit second capture before finish: no ASR upload,
            // no draft insertion, then restart for the second successful pass.
            await controller.begin('zh').timeout(remaining());
            expect(controller.recording, true);
            capture.feed(
              Uint8List.sublistView(
                pcm,
                0,
                pcm.length < 6400 ? pcm.length : 6400,
              ),
            );
            await controller.cancel().timeout(remaining());
            expect(uploads, 1);
            expect(drafts.length, 1);
            expect(controller.busy, false);
            expect(capture.capturing, false);
            report['localCancelBeforeUpload'] = true;
          }
        }
        expect(uploads, 2);
        expect(permissionCalls, 3);
        expect(capture.startCount, 3);
        expect(capture.stopCount, 3);
        expect(capture.playbackCalls, 0);
        report.addAll({
          'status': 'passed',
          'apiAsrUploads': uploads,
          'finalDraftCount': drafts.length,
          'captureStarts': capture.startCount,
          'captureStops': capture.stopCount,
          'playbackCalls': capture.playbackCalls,
          'autoSend': 'not wired; only onText final-draft callback',
        });
      } catch (error) {
        report['failureType'] = error.runtimeType.toString();
        // Do not expose config parse failures, filesystem paths, keys or raw
        // service exceptions through the test runner.
        fail(
          'API dictation synthetic acceptance failed; inspect optional sanitized report',
        );
      } finally {
        await dictation?.cancel().timeout(const Duration(seconds: 2));
        dictation?.dispose();
        await audio?.controller.close().timeout(const Duration(seconds: 2));
        report['durationMs'] = clock.elapsedMilliseconds;
        if (output != null && output.isNotEmpty) {
          final target = File(output);
          await target.parent.create(recursive: true);
          await target.writeAsString(
            const JsonEncoder.withIndent('  ').convert(report),
          );
        }
      }
    },
    skip: enabled ? false : 'NOVA_DICTATION_LIVE_CONFIG not set',
    timeout: const Timeout(Duration(seconds: 120)),
  );
}

Uint8List _readSynthetic16kWav(Uint8List bytes) {
  if (bytes.length < 44 ||
      ascii.decode(bytes.sublist(0, 4)) != 'RIFF' ||
      ascii.decode(bytes.sublist(8, 12)) != 'WAVE') {
    throw const FormatException('invalid_synthetic_wav');
  }
  final view = ByteData.sublistView(bytes);
  var valid = false;
  Uint8List? pcm;
  for (var position = 12; position + 8 <= bytes.length;) {
    final tag = ascii.decode(bytes.sublist(position, position + 4));
    final size = view.getUint32(position + 4, Endian.little);
    final start = position + 8;
    if (start + size > bytes.length) {
      throw const FormatException('truncated_wav');
    }
    if (tag == 'fmt ' && size >= 16) {
      valid =
          view.getUint16(start, Endian.little) == 1 &&
          view.getUint16(start + 2, Endian.little) == 1 &&
          view.getUint32(start + 4, Endian.little) == 16000 &&
          view.getUint16(start + 14, Endian.little) == 16;
    }
    if (tag == 'data') pcm = Uint8List.sublistView(bytes, start, start + size);
    position = start + size + size % 2;
  }
  if (!valid ||
      pcm == null ||
      pcm.isEmpty ||
      pcm.length.isOdd ||
      pcm.length >= 16000 * 2 * 45) {
    throw const FormatException('unsupported_synthetic_wav');
  }
  return pcm;
}
