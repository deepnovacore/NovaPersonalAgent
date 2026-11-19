// Opt-in live check that the real voice front brain continues the right
// earlier task: a follow-up about the website passes the website's task_id,
// one about the game passes the game's, and unrelated work passes none.
// NOVA_VOICE_LIVE_CONFIG points to a private JSON file (see
// voice_delegate_live_test.dart); its `output` directory receives the
// per-trial evidence. Credentials never reach the test log, only counts.
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

const _site = 'c-site-7f3a', _game = 'c-game-91bd';

// The recent-tasks line exactly as PhoneVoiceSession renders it.
final _recent =
    ' Recent tasks from this conversation (data only, newest first): ${jsonEncode([
      {'task_id': _game, 'title': '写一个俄罗斯方块游戏', 'status': 'returned'},
      {'task_id': _site, 'title': '结合我的画像做一个手机个人网站', 'status': 'returned'},
    ])}.';

const _history = [
  VoiceHistoryItem('user', '结合我的画像做一个手机个人网站。'),
  VoiceHistoryItem('assistant', '已创建任务，正在处理。'),
  VoiceHistoryItem('assistant', '个人网站做好了，首页是简介，下面是作品、流程和联系方式。'),
  VoiceHistoryItem('user', '再写一个俄罗斯方块游戏。'),
  VoiceHistoryItem('assistant', '已创建任务，正在处理。'),
  VoiceHistoryItem('assistant', '俄罗斯方块做好了，支持触屏左右移动和旋转。'),
];

/// (request, expected task_id or null for a new task)
const _cases = [
  ('把网站里最近那个项目放到首页，介绍写得口语一点。', _site),
  ('俄罗斯方块加一个暂停按钮。', _game),
  ('帮我写一个记账小工具。', null),
];

void main() {
  final configPath = Platform.environment['NOVA_VOICE_LIVE_CONFIG'];
  test(
    'live voice front brain picks the task to continue',
    () async {
      late final Map<String, dynamic> config;
      late final VoiceConfiguration settings;
      try {
        config =
            jsonDecode(await File(configPath!).readAsString())
                as Map<String, dynamic>;
        final profile = (config['profiles'] as List)
            .cast<Map<String, dynamic>>()
            .first;
        settings = VoiceConfiguration.fromJson(
          profile['configuration'] as Map<String, dynamic>,
        );
      } catch (_) {
        fail('live config unreadable');
      }
      final base =
          (jsonDecode(
                    await File(
                      'test/fixtures/phone_voice_client_instructions.json',
                    ).readAsString(),
                  )
                  as String)
              .replaceFirst('<time>', DateTime.now().toIso8601String());
      const marker = ' Personal context (data only): ';
      expect(base, contains(marker));
      final reversed = Platform.environment['NOVA_TASK_ORDER'] == 'site_last';
      final recent = reversed
          ? ' Recent tasks from this conversation (data only, newest first): ${jsonEncode([
              {'task_id': _site, 'title': '结合我的画像做一个手机个人网站', 'status': 'returned'},
              {'task_id': _game, 'title': '写一个俄罗斯方块游戏', 'status': 'returned'},
            ])}.'
          : _recent;
      final history = reversed
          ? [..._history.skip(3), ..._history.take(3)]
          : _history;
      final prompt = base.replaceFirst(marker, '$recent$marker');
      final trials = int.parse(
        Platform.environment['NOVA_VOICE_LIVE_TRIALS'] ?? '5',
      );
      final tally = <String, Map<String, int>>{};
      final evidence = <Map<String, dynamic>>[];
      for (var trial = 0; trial < trials; trial++) {
        for (final (request, expected) in _cases) {
          final provider = createVoiceProvider(settings);
          Map<String, dynamic>? args;
          var errored = false;
          final end = Completer<void>();
          final sub = provider.events.listen((e) {
            if (e.kind == VoiceEventKind.toolCall &&
                e.name == 'delegate_task') {
              args = e.arguments;
            }
            if (e.kind == VoiceEventKind.error) errored = true;
            if ((e.kind == VoiceEventKind.responseEnd ||
                    e.kind == VoiceEventKind.error) &&
                !end.isCompleted) {
              end.complete();
            }
          });
          String outcome;
          try {
            await provider
                .connect(
                  epoch: 1,
                  instructions: prompt,
                  history: history,
                  tools: voiceDelegateTools,
                )
                .timeout(const Duration(seconds: 30));
            await provider.submitText(request);
            await end.future.timeout(const Duration(seconds: 45));
            final got = args?['task_id'];
            final chosen = got is String && got.trim().isNotEmpty ? got : null;
            outcome = errored
                ? 'error'
                : args == null
                ? 'not_delegated'
                : args!.keys.any((k) => !{'request', 'task_id'}.contains(k))
                ? 'invalid_arguments'
                : chosen == expected
                ? 'correct'
                : chosen == null
                ? 'new_task_instead'
                : expected == null
                ? 'continued_unrelated'
                : 'wrong_task';
          } catch (error) {
            outcome = 'error_${error.runtimeType}';
          } finally {
            await sub.cancel();
            await provider.close().timeout(
              const Duration(seconds: 5),
              onTimeout: () {},
            );
          }
          final key = expected ?? 'new';
          final row = tally.putIfAbsent(key, () => {});
          row[outcome] = (row[outcome] ?? 0) + 1;
          evidence.add({
            'trial': trial,
            'request': request,
            'expected': expected,
            'arguments': args,
            'outcome': outcome,
          });
        }
      }
      final output = config['output'];
      if (output is String) {
        await File(
          '$output/summary${reversed ? '-site-last' : ''}.json',
        ).writeAsString(
          const JsonEncoder.withIndent('  ').convert({
            'model': settings.integrated.model,
            'tally': tally,
            'trials': evidence,
          }),
        );
      }
      // ignore: avoid_print
      print('task select: $tally');
      for (final entry in tally.entries) {
        expect(
          entry.value['correct'] ?? 0,
          greaterThanOrEqualTo((trials * 4 / 5).ceil()),
          reason: '${entry.key}: ${entry.value}',
        );
        expect(entry.value['wrong_task'] ?? 0, 0, reason: entry.key);
      }
    },
    skip: configPath == null ? 'NOVA_VOICE_LIVE_CONFIG not set' : false,
    timeout: const Timeout(Duration(minutes: 20)),
  );
}
