import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/widgets.dart';
import 'package:nova_audio/nova_audio.dart';
import '../voice/audio_owner.dart';
import '../voice/cascaded/ports.dart';
import '../voice/voice_provider_factory.dart';
import '../voice/voice_settings.dart';

class _DictationRun {
  _DictationRun(this.generation);
  final int generation;
  final pcm = BytesBuilder(copy: true);
  final cancel = CascadeCancellation();
  CascadeAsr? asr;
  bool startSubmitted = false, accepting = false;
  Future<void>? stopping;
}

/// Explicit microphone capture followed by configured API ASR. The only output
/// is draft text: this controller never sends messages or invokes LLM/tools/TTS.
class PhoneDictation extends ChangeNotifier with WidgetsBindingObserver {
  PhoneDictation({
    required this.onText,
    required AudioPort audio,
    required this.requestMicrophone,
    required AudioOwner audioOwner,
    Future<VoiceConfiguration?> Function()? readConfiguration,
    CascadeAsr Function(VoiceConfiguration)? createAsr,
  }) : _audio = OwnedAudioPort(
         audio is OwnedAudioPort ? audio.native : audio,
         audioOwner,
       ),
       readConfiguration =
           readConfiguration ?? VoiceSettings().readForDictation,
       createAsr = createAsr ?? createVoiceAsr {
    WidgetsBinding.instance.addObserver(this);
    _events = _audio.events.listen(
      _onAudio,
      onError: (Object _) {
        if (_run != null) _fail('dictation_unavailable');
      },
    );
  }
  final ValueChanged<String> onText;
  final Future<bool> Function() requestMicrophone;
  final Future<VoiceConfiguration?> Function() readConfiguration;
  final CascadeAsr Function(VoiceConfiguration) createAsr;
  final OwnedAudioPort _audio;
  late final StreamSubscription<Map<String, Object?>> _events;
  static const _maxCaptureBytes = 16000 * 2 * 45;
  _DictationRun? _run;
  int _generation = 0;
  Future<void> _teardown = Future.value();
  bool _teardownFailed = false;
  String partial = '', notice = '';
  bool starting = false,
      recording = false,
      transcribing = false,
      _disposed = false;
  Timer? _limit;
  bool get busy => starting || recording || transcribing;
  bool _owns(_DictationRun run) =>
      !_disposed && identical(_run, run) && !run.cancel.isCancelled;
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// Language is retained for composer compatibility; ASR detects speech language.
  Future<void> begin(String language) async {
    if (busy || _disposed) return;
    final run = _run = _DictationRun(++_generation);
    starting = true;
    notice = '';
    partial = '';
    _changed();
    try {
      await _teardown;
      if (!_owns(run)) return;
      if (_teardownFailed) throw const CascadeFailure('dictation_unavailable');
      final VoiceConfiguration? configuration;
      try {
        configuration = await readConfiguration();
      } catch (_) {
        throw const CascadeFailure('dictation_settings_required');
      }
      if (!_owns(run)) return;
      if (configuration == null) {
        throw const CascadeFailure('dictation_settings_required');
      }
      try {
        run.asr = createAsr(configuration);
      } catch (_) {
        throw const CascadeFailure('dictation_settings_required');
      }
      if (!await requestMicrophone()) {
        throw const CascadeFailure('microphone_denied');
      }
      if (!_owns(run)) return;
      run.startSubmitted = true;
      run.accepting = true;
      await _audio.startRelay(
        generation: run.generation,
        capture: true,
        threshold: .035,
      );
      if (!_owns(run)) {
        await _stop(run);
        return;
      }
      starting = false;
      recording = true;
      _limit = Timer(const Duration(seconds: 45), () => unawaited(finish()));
      _changed();
    } catch (error) {
      if (_owns(run)) {
        notice =
            error is CascadeFailure &&
                [
                  'dictation_settings_required',
                  'microphone_denied',
                ].contains(error.code)
            ? error.code
            : error is StateError && error.message == 'audio_in_use'
            ? 'audio_in_use'
            : 'dictation_unavailable';
        await cancel();
      }
    }
  }

  void _onAudio(Map<String, Object?> event) {
    final run = _run;
    if (run == null ||
        !_owns(run) ||
        !run.accepting ||
        event['generation'] != run.generation) {
      return;
    }
    if (event['kind'] == 'stopped') {
      _fail('dictation_unavailable');
      return;
    }
    if (event['kind'] != 'pcm') return;
    final pcm = event['pcm'];
    if (pcm is! Uint8List ||
        pcm.isEmpty ||
        pcm.length.isOdd ||
        pcm.length > 65536) {
      _fail('dictation_unavailable');
      return;
    }
    final remaining = _maxCaptureBytes - run.pcm.length;
    run.pcm.add(
      pcm.length > remaining ? Uint8List.sublistView(pcm, 0, remaining) : pcm,
    );
    if (run.pcm.length == _maxCaptureBytes) {
      run.accepting = false;
      unawaited(finish());
    }
  }

  void _fail(String code) {
    notice = code;
    unawaited(cancel());
  }

  Future<void> _stop(_DictationRun run) {
    run.accepting = false;
    final existing = run.stopping;
    if (existing != null) return existing;
    final stop = run.stopping = run.startSubmitted
        ? _audio.stop()
        : Future<void>.value();
    _teardown = stop.catchError((Object _) {
      _teardownFailed = true;
    });
    return stop;
  }

  Future<void> finish() async {
    if (starting) {
      await cancel();
      return;
    }
    final run = _run;
    if (run == null || !recording) return;
    recording = false;
    transcribing = true;
    _limit?.cancel();
    _changed();
    try {
      // The capture owner is released before any audio reaches the ASR service.
      await _stop(run);
      if (!_owns(run)) return;
      final pcm = run.pcm.takeBytes();
      if (pcm.isEmpty) {
        notice = 'dictation_empty';
        return;
      }
      final text = (await _transcribe(run, pcm)).trim();
      if (!_owns(run)) return;
      if (text.isEmpty) {
        notice = 'dictation_empty';
      } else {
        onText(text);
      }
    } catch (_) {
      if (_owns(run)) notice = 'dictation_unavailable';
    } finally {
      run.cancel.cancel();
      run.pcm.clear();
      if (identical(_run, run)) {
        _run = null;
        starting = recording = transcribing = false;
        partial = '';
        _changed();
      }
    }
  }

  Future<String> _transcribe(_DictationRun run, Uint8List pcm) async {
    final done = Completer<String>();
    var text = '', count = 0;
    void fail() {
      if (!done.isCompleted) {
        done.completeError(const CascadeFailure('dictation_unavailable'));
      }
    }

    final remove = run.cancel.onCancel(fail);
    final timer = Timer(const Duration(seconds: 120), fail);
    StreamSubscription<CascadeTranscript>? subscription;
    try {
      subscription = run.asr!
          .transcribe(pcm, run.cancel)
          .listen(
            (event) {
              if (!_owns(run) || done.isCompleted) return;
              if (++count > 256 || event.text.length > 4000) {
                fail();
                return;
              }
              text = event.replace ? event.text : text + event.text;
              if (text.length > 4000) {
                fail();
                return;
              }
              partial = text;
              _changed();
              if (event.isFinal && !done.isCompleted && _owns(run)) {
                done.complete(text);
              }
            },
            onError: (Object _) => fail(),
            onDone: fail,
          );
      return await done.future;
    } finally {
      timer.cancel();
      remove();
      // Cancellation must settle the UI even if a provider ignores cancellation.
      unawaited(subscription?.cancel().catchError((Object _) {}));
    }
  }

  Future<void> cancel() async {
    final run = _run;
    _run = null;
    _limit?.cancel();
    run?.cancel.cancel();
    run?.pcm.clear();
    starting = recording = transcribing = false;
    partial = '';
    _changed();
    if (run != null) {
      try {
        await _stop(run);
      } catch (_) {
        if (!_disposed) notice = 'dictation_unavailable';
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The microphone permission prompt itself can temporarily make iOS inactive.
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(cancel());
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    unawaited(() async {
      await cancel();
      await _events.cancel();
      try {
        await _audio.dispose();
      } catch (_) {}
    }());
    super.dispose();
  }
}
