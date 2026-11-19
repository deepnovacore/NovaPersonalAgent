// Opt-in live check: after the user stops a delegated task, the real voice
// front brain tells them it stopped, never that it is still running.
// NOVA_VOICE_LIVE_CONFIG as in voice_delegate_live_test.dart; spoken text
// goes only to the private output directory.
@Tags(['live'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:nova_mobile/voice/voice_provider.dart';
import 'package:nova_mobile/voice/voice_provider_factory.dart';
import 'package:nova_mobile/voice/voice_settings.dart';

const _history = [
  VoiceHistoryItem('user', '把网站里作品区整体移到首页最上面，联系方式写得更口语一点。'),
  VoiceHistoryItem('assistant', '好的，我来调整网站。'),
];

// The terminal fact as PhoneVoiceSession injects it after a stop.
const _fact =
    'Execution fact for d-1 (task_id c-site): 任务已停止，没有完成。已经做过的修改会保留，未做完的部分没有继续。';

void main() {
  final configPath = Platform.environment['NOVA_VOICE_LIVE_CONFIG'];
  test(
    'live voice narrates a stopped task as stopped',
    () async {
      final config =
          jsonDecode(await File(configPath!).readAsString())
              as Map<String, dynamic>;
      final settings = VoiceConfiguration.fromJson(
        ((config['profiles'] as List).first as Map)['configuration']
            as Map<String, dynamic>,
      );
      final prompt =
          (jsonDecode(
                    await File(
                      'test/fixtures/phone_voice_client_instructions.json',
                    ).readAsString(),
                  )
                  as String)
              .replaceFirst('<time>', DateTime.now().toIso8601String());
      final trials = int.parse(
        Platform.environment['NOVA_VOICE_LIVE_TRIALS'] ?? '5',
      );
      final evidence = <Map<String, dynamic>>[];
      var stopped = 0, running = 0;
      for (var trial = 0; trial < trials; trial++) {
        final provider = createVoiceProvider(settings);
        var spoken = '';
        final end = Completer<void>();
        final sub = provider.events.listen((e) {
          if (e.kind == VoiceEventKind.text) {
            spoken = e.replace ? (e.text ?? '') : spoken + (e.text ?? '');
          }
          if ((e.kind == VoiceEventKind.responseEnd ||
                  e.kind == VoiceEventKind.error) &&
              !end.isCompleted) {
            end.complete();
          }
        });
        try {
          await provider
              .connect(
                epoch: 1,
                instructions: prompt,
                history: _history,
                tools: voiceDelegateTools,
              )
              .timeout(const Duration(seconds: 30));
          await provider.injectHostItem(
            const VoiceHostItem(id: 'fact', text: _fact),
          );
          await provider.requestHostResponse('fact');
          await end.future.timeout(const Duration(seconds: 45));
        } finally {
          await sub.cancel();
          await provider.close().timeout(
            const Duration(seconds: 5),
            onTimeout: () {},
          );
        }
        final saysStopped = RegExp('停|取消|中断|没有完成|没完成').hasMatch(spoken);
        final saysRunning = RegExp('还在进行|正在进行|还在处理|稍等|再等').hasMatch(spoken);
        if (saysStopped && !saysRunning) stopped++;
        if (saysRunning) running++;
        evidence.add({'trial': trial, 'spoken': spoken});
      }
      final output = config['output'];
      if (output is String) {
        await File(
          '$output/stop-narration.json',
        ).writeAsString(const JsonEncoder.withIndent('  ').convert(evidence));
      }
      // ignore: avoid_print
      print('stop narration: stopped=$stopped running=$running of $trials');
      expect(running, 0);
      expect(stopped, trials);
    },
    skip: configPath == null ? 'NOVA_VOICE_LIVE_CONFIG not set' : false,
    timeout: const Timeout(Duration(minutes: 10)),
  );
}
