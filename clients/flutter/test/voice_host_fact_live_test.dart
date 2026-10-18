// Opt-in Qwen protocol acceptance using synthetic task facts; no microphone.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/voice/voice_provider.dart';
import 'package:nova_mobile/voice/providers/qwen_realtime_voice_provider.dart';

class ObservedQwen extends QwenRealtimeVoiceProvider {
  ObservedQwen({
    required super.endpoint,
    required super.model,
    required super.apiKey,
    required super.voice,
  });
  @override
  void onFrame(Map<String, dynamic> frame) {
    if (frame['type'] == 'error') {
      final safe = jsonEncode(frame['error']).replaceAll(apiKey, '[REDACTED]');
      stderr.writeln('Qwen protocol error: $safe');
    }
    super.onFrame(frame);
  }
}

void main() {
  final configPath = Platform.environment['NOVA_VOICE_LIVE_CONFIG'];
  test(
    'live Qwen narrates the selected fact rather than the previous receipt',
    () async {
      final config = jsonDecode(File(configPath!).readAsStringSync()) as Map;
      final profile = (config['profiles'] as List).cast<Map>().firstWhere(
        (p) => p['id'] == 'qwen-live',
      );
      final settings = profile['configuration']['integrated'] as Map;
      final provider = ObservedQwen(
        endpoint: settings['endpoint'] as String,
        model: settings['model'] as String,
        apiKey: settings['key'] as String,
        voice: settings['voice'] as String,
      );
      var text = '';
      Completer<void>? end;
      final sub = provider.events.listen((e) {
        if (e.kind == VoiceEventKind.text) {
          text = e.replace ? (e.text ?? '') : text + (e.text ?? '');
        }
        if (e.kind == VoiceEventKind.responseEnd && end?.isCompleted == false) {
          end!.complete();
        }
        if (e.kind == VoiceEventKind.error && end?.isCompleted == false) {
          end!.completeError(StateError(e.code ?? 'provider error'));
        }
      });
      addTearDown(() async {
        await provider.close();
        await sub.cancel();
      });
      await provider.connect(epoch: 1, instructions: '请用简体中文简短汇报指定的执行结果。');
      end = Completer<void>();
      await provider.submitText('我们用计数器网页作演示。接下来请汇报主机提供的任务状态。现在只说收到。');
      await end.future.timeout(const Duration(seconds: 30));
      const accepted = VoiceHostItem(
        id: 'synthetic-accepted',
        text: '计数器网页任务已接单，正在执行，还没有完成。',
      );
      const completed = VoiceHostItem(
        id: 'synthetic-completed',
        text: '计数器网页已经完成；加一按钮经过测试，点击后数字从0变成1。',
      );
      await provider.injectHostItem(accepted);
      await provider.injectHostItem(completed);
      final outputs = <String, String>{};
      for (final item in [accepted, completed]) {
        text = '';
        end = Completer<void>();
        await provider.requestHostResponse(item.id);
        await end.future.timeout(const Duration(seconds: 45));
        outputs[item.id] = text;
      }
      final outputPath = Platform.environment['NOVA_HOST_FACT_OUTPUT'];
      if (outputPath != null) {
        File(outputPath).writeAsStringSync(
          const JsonEncoder.withIndent('  ').convert(outputs),
        );
      }
      expect(outputs[accepted.id], contains('接单'));
      expect(outputs[completed.id], contains('完成'));
      expect(outputs[completed.id], contains('测试'));
      expect(outputs[completed.id], isNot(contains('未完成')));
      expect(outputs[completed.id], isNot(contains('正在执行')));
      expect(outputs[completed.id], isNot(outputs[accepted.id]));
    },
    skip: configPath == null,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
