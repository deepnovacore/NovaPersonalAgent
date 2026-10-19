import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:nova_mobile/protocol/request_id.dart';

// Isolated .autonomy entrypoint: real model, screenshots and native gestures.
// Never calls approve or substitutes model output with test-generated actions.
void main() => runApp(const MaterialApp(home: LiveModelFixture()));

class LiveModelFixture extends StatefulWidget {
  const LiveModelFixture({super.key});
  @override
  State<LiveModelFixture> createState() => _LiveModelFixtureState();
}

class _LiveModelFixtureState extends State<LiveModelFixture> {
  static const channel = MethodChannel('nova/local_agent/v1');
  static const ownPackage = 'com.nova.nova_mobile.autonomy';
  int counter = 0;
  String status = '等待开始验收';
  bool running = false;
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    final raw = await channel.invokeMethod<String>(method, jsonEncode(input));
    return raw == null ? null : jsonDecode(raw);
  }

  void check(bool value, String message) {
    if (!value) throw StateError(message);
  }

  Future<void> run(String scenario) async {
    if (running) return;
    setState(() {
      running = true;
      counter = 0;
      status = '真实模型验收进行中';
    });
    final root = await getApplicationSupportDirectory();
    final result = <String, dynamic>{
      'started_at': DateTime.now().toUtc().toIso8601String(),
      'scenario': scenario,
      'approval_calls': 0,
    };
    String? id;
    Future<void> save() async {
      await File(
        '${root.path}/native-auto-$scenario.json',
      ).writeAsString(jsonEncode(result), flush: true);
    }

    try {
      check(
        (await call('capabilities'))['accessibility'] == true,
        'accessibility_required',
      );
      final settings = await call('modelSettings') as Map;
      check(settings['configured'] == true, 'model_configuration_required');
      result['model'] = settings['model'];
      result['model_endpoint'] = settings['endpoint'];
      await Future<void>.delayed(const Duration(milliseconds: 700));
      id = requestId();
      result['task_id'] = id;
      final input = <String, dynamic>{
        'id': id,
        'goal': scenario == 'calculator'
            ? 'Use the standard calculator to calculate 17 multiplied by 23. Clear the current expression first if necessary, enter 17 × 23, then press equals. Do not open settings, history or other apps. Finish when the result is visible.'
            : scenario == 'stop'
            ? 'Tap Toggle fixture repeatedly until Counter: 20. This is a synthetic counter test.'
            : 'Tap Toggle fixture exactly three times until Counter: 3. This is a synthetic counter test.',
        'acceptance': scenario == 'calculator'
            ? 'The calculator visibly shows the result 391 for 17 × 23.'
            : scenario == 'stop'
            ? 'Counter: 20 is visible.'
            : 'Counter: 3 is visible.',
        'target_package': scenario == 'calculator'
            ? 'com.miui.calculator'
            : ownPackage,
      };
      await save();
      await call('run', input);
      final deadline = DateTime.now().add(const Duration(minutes: 4));
      Map task = {};
      final phases = <String>[];
      var stopSent = false;
      int? stoppedCount, stoppedActionCount;
      while (DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 250));
        task = (await call('tasks') as List).cast<Map>().firstWhere(
          (t) => t['id'] == id,
        );
        if (phases.isEmpty || phases.last != task['phase']) {
          phases.add(task['phase'] as String);
        }
        check(
          task['phase'] != 'waiting_approval' && task['proposal'] == null,
          'unexpected_step_approval',
        );
        if (scenario == 'stop' &&
            !stopSent &&
            (task['actions'] as List).isNotEmpty) {
          final stopped = await call('stop', {'id': id}) as Map;
          stoppedCount = counter;
          stoppedActionCount = (stopped['actions'] as List).length;
          check(stopped['phase'] == 'cancelled', 'stop_not_acknowledged');
          stopSent = true;
        }
        if ([
          'verifying',
          'completed',
          'cancelled',
          'interrupted',
        ].contains(task['phase'])) {
          break;
        }
      }
      result.addAll({
        'phases': phases,
        'counter': counter,
        'native_phase': task['phase'],
        'reason': task['reason'],
        'summary': task['summary'],
        'authorization_mode': task['authorization_mode'],
        'actions': task['actions'],
      });
      check(
        task['authorization_mode'] == 'automatic',
        'automatic_authority_missing',
      );
      if (scenario == 'stop') {
        check(stopSent && task['phase'] == 'cancelled', 'stop_not_observed');
        check(
          counter == stoppedCount &&
              (task['actions'] as List).length == stoppedActionCount,
          'action_after_stop_acknowledgement',
        );
        await Future<void>.delayed(const Duration(seconds: 5));
        final fresh = (await call('tasks') as List).cast<Map>().firstWhere(
          (t) => t['id'] == id,
        );
        check(
          counter == stoppedCount &&
              (fresh['actions'] as List).length == stoppedActionCount,
          'action_after_stop',
        );
        result['stopped_count'] = stoppedCount;
      } else {
        check(
          task['phase'] == 'verifying',
          'native_loop_did_not_reach_verification',
        );
        if (scenario == 'counter') {
          check(
            counter == 3 && (task['actions'] as List).length == 3,
            'counter_not_exactly_three',
          );
        } else {
          check(
            (task['actions'] as List).length >= 3,
            'calculator_not_multistep',
          );
          result['external_ui_verification_required'] = true;
        }
      }
      // A model claim is not silently promoted to user verification by this test.
      final replay = await call('run', input) as Map;
      check(replay['phase'] == task['phase'], 'replay_did_not_return_receipt');
      await Future<void>.delayed(const Duration(seconds: 2));
      final fresh = (await call('tasks') as List).cast<Map>().firstWhere(
        (t) => t['id'] == id,
      );
      check(
        (fresh['actions'] as List).length == (task['actions'] as List).length,
        'replay_dispatched_twice',
      );
      if (scenario == 'counter') check(counter == 3, 'replay_changed_counter');
      result['replay_no_new_actions'] = true;
      result['passed'] = true;
      if (mounted) setState(() => status = '$scenario 验收通过（外部 App 需另行核对画面）');
    } catch (error) {
      result['passed'] = false;
      result['error'] = error.toString();
      if (mounted) setState(() => status = '验收未通过：$error');
    } finally {
      if (id != null) {
        final task = (await call('tasks') as List)
            .cast<Map>()
            .where((t) => t['id'] == id)
            .firstOrNull;
        if (task != null && task['phase'] == 'running') {
          await call('stop', {'id': id});
        }
      }
      result['finished_at'] = DateTime.now().toUtc().toIso8601String();
      await save();
      debugPrint('NATIVE AUTO RESULT: ${jsonEncode(result)}');
      if (mounted) setState(() => running = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Nova 自动执行验收')),
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Counter: $counter', style: const TextStyle(fontSize: 28)),
          SizedBox(
            width: 260,
            height: 80,
            child: FilledButton(
              onPressed: () => setState(() => counter++),
              child: const Text('Toggle fixture'),
            ),
          ),
          Padding(padding: const EdgeInsets.all(20), child: Text(status)),
          if (!running) ...[
            TextButton(
              onPressed: () => unawaited(call('accessibilitySettings')),
              child: const Text('开启无障碍服务'),
            ),
            FilledButton(
              onPressed: () => unawaited(run('counter')),
              child: const Text('连续三步验收'),
            ),
            FilledButton(
              onPressed: () => unawaited(run('calculator')),
              child: const Text('计算器跨 App 验收'),
            ),
            FilledButton(
              onPressed: () => unawaited(run('stop')),
              child: const Text('执行中停止验收'),
            ),
          ],
        ],
      ),
    ),
  );
}
