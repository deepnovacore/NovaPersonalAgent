// Opt-in live check that the production voice prompt still makes the real
// model call delegate_task when the seeded history holds only spoken
// acknowledgements (the text-only history a reconnected call sees).
// NOVA_VOICE_LIVE_CONFIG points to a private JSON file; credentials, URLs and
// model text never reach the test log, only counts.
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
  VoiceHistoryItem('user', '打开小红书，搜索今天的天气，然后给第一条笔记点赞。'),
  VoiceHistoryItem('assistant', '好的，我来打开小红书看看。'),
  VoiceHistoryItem(
    'assistant',
    '已在小红书搜索"今天的天气"，并给第一条笔记点了赞，点赞按钮已变成红色实心红心，计数 1。',
  ),
  VoiceHistoryItem('user', '打开小红书。'),
  VoiceHistoryItem('assistant', '好的，我来打开小红书。'),
  VoiceHistoryItem('user', '打开小红书，呃，搜索今天的天气，然后给第一条笔记点赞。'),
  VoiceHistoryItem('assistant', '好的，我来打开小红书并搜索天气。'),
];

const _requests = ['打开小红书，搜索今天的天气，给第一条笔记点赞。', '打开小红书。'];

void main() {
  final configPath = Platform.environment['NOVA_VOICE_LIVE_CONFIG'];
  test(
    'live voice model delegates after acknowledgement-only history',
    () async {
      late final Map<String, dynamic> config;
      late final VoiceConfiguration settings;
      try {
        config =
            jsonDecode(await File(configPath!).readAsString())
                as Map<String, dynamic>;
        final profile = (config['profiles'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere(
              (p) =>
                  config['selectProfile'] == null ||
                  p['id'] == config['selectProfile'],
            );
        settings = VoiceConfiguration.fromJson(
          profile['configuration'] as Map<String, dynamic>,
        );
      } catch (_) {
        // Parse errors can quote the private file; report only that it failed.
        fail('live config unreadable');
      }
      final instructions =
          Platform.environment['NOVA_VOICE_LIVE_INSTRUCTIONS'] ??
          'test/fixtures/phone_voice_client_instructions.json';
      final prompt =
          (jsonDecode(await File(instructions).readAsString()) as String)
              .replaceFirst('<time>', DateTime.now().toIso8601String());
      final trials = int.parse(
        Platform.environment['NOVA_VOICE_LIVE_TRIALS'] ?? '3',
      );
      final outcomes = <String, int>{};
      final evidence = <Map<String, dynamic>>[];
      for (var trial = 0; trial < trials; trial++) {
        for (final request in _requests) {
          final provider = createVoiceProvider(settings);
          if (!provider.capabilities.voiceTools) {
            await provider.close();
            fail('selected profile has no voice tools');
          }
          var called = false, valid = false;
          String? callId;
          var spoken = '', ack = '';
          var end = Completer<void>();
          var receipt = false, errored = false;
          final sub = provider.events.listen((e) {
            if (e.kind == VoiceEventKind.toolCall &&
                e.name == 'delegate_task') {
              called = true;
              callId = e.callId;
              valid =
                  e.arguments?.keys.length == 1 &&
                  e.arguments?['request'] is String;
            }
            if (e.kind == VoiceEventKind.text) {
              final text = e.text ?? '';
              if (receipt) {
                ack = e.replace ? text : ack + text;
              } else {
                spoken = e.replace ? text : spoken + text;
              }
            }
            if (e.kind == VoiceEventKind.error) errored = true;
            if ((e.kind == VoiceEventKind.responseEnd ||
                    e.kind == VoiceEventKind.error) &&
                !end.isCompleted) {
              end.complete();
            }
          });
          String outcome;
          String? ackOutcome, failure;
          try {
            await provider
                .connect(
                  epoch: 1,
                  instructions: prompt,
                  history: _history,
                  tools: voiceDelegateTools,
                )
                .timeout(const Duration(seconds: 30));
            await provider.submitText(request);
            await end.future.timeout(const Duration(seconds: 45));
            if (errored) throw StateError('provider_error');
            outcome = called
                ? (valid ? 'delegated' : 'invalid_arguments')
                : 'spoke_only';
            // Like production, narrate the tool result only when the call
            // response spoke nothing; otherwise that speech is the receipt.
            if (outcome == 'delegated' && spoken.trim().isNotEmpty) {
              ackOutcome = 'ack_in_call';
            } else if (outcome == 'delegated' &&
                provider.capabilities.hostItems) {
              receipt = true;
              end = Completer<void>();
              await provider.injectHostItem(
                VoiceHostItem(
                  id: 'live-result-$trial',
                  callId: callId,
                  text: voiceDelegateAccepted('live-task-$trial'),
                ),
              );
              await provider.requestHostResponse('live-result-$trial');
              await end.future.timeout(const Duration(seconds: 45));
              if (errored) throw StateError('provider_error');
              ackOutcome = ack.trim().isEmpty ? 'ack_silent' : 'ack_spoken';
            }
          } catch (error) {
            outcome =
                'error_${receipt ? 'receipt' : 'call'}_${error.runtimeType}';
            failure = '$error';
          } finally {
            await sub.cancel();
            await provider.close().timeout(
              const Duration(seconds: 5),
              onTimeout: () {},
            );
          }
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
          if (ackOutcome != null) {
            outcomes[ackOutcome] = (outcomes[ackOutcome] ?? 0) + 1;
          }
          evidence.add({
            'request': request,
            'outcome': outcome,
            'spoken': spoken,
            'ack': ack,
            'failure': ?failure,
          });
        }
      }
      final output = config['output'];
      if (output is String) {
        final run = DateTime.now().toUtc().toIso8601String().replaceAll(
          ':',
          '-',
        );
        final file = File('$output/delegate-$run.json');
        await file.parent.create(recursive: true);
        await file.writeAsString(
          const JsonEncoder.withIndent('  ').convert(evidence),
        );
      }
      // Counts only; spoken text stays in the private output file.
      // ignore: avoid_print
      print('delegate outcomes: $outcomes');
      expect(outcomes['delegated'], trials * _requests.length);
      expect(
        (outcomes['ack_spoken'] ?? 0) + (outcomes['ack_in_call'] ?? 0),
        trials * _requests.length,
      );
    },
    skip: configPath == null ? 'NOVA_VOICE_LIVE_CONFIG not set' : false,
    timeout: const Timeout(Duration(minutes: 15)),
  );
}
