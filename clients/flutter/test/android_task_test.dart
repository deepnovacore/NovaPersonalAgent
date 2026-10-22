import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'package:nova_mobile/agent/native_chat_task.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/personal/life_reducer.dart';

class Device implements LocalAgent {
  final calls = <String>[];
  Map<String, dynamic>? dispatched;
  bool appsFail = false;
  Completer<void>? appsGate;
  Completer<Map<String, dynamic>>? runGate;
  Map<String, dynamic> terminal = {
    'phase': 'verifying',
    'summary': '小红书已在前台',
    'evidence': 'screen-fingerprint',
  };
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    calls.add(method);
    if (method == 'stop') return {};
    if (method == 'apps') {
      await appsGate?.future;
      if (appsFail) throw StateError('channel unavailable');
      return [
        {'package': 'com.xingin.xhs', 'label': '小红书'},
      ];
    }
    if (method == 'run') {
      dispatched = input;
      return runGate == null
          ? {'id': input['id'], 'phase': 'running'}
          : await runGate!.future;
    }
    if (method == 'tasks') {
      return [
        {'id': dispatched!['id'], ...terminal},
      ];
    }
    throw StateError(method);
  }
}

void main() {
  test('chat completion requires native screen evidence', () async {
    final device = Device()
      ..terminal = {'phase': 'verifying', 'summary': 'unverified'};
    final result =
        await NativeChatTaskRunner(
          agent: device,
          pollInterval: Duration.zero,
        ).run({
          'goal': 'open',
          'target_package': 'com.xingin.xhs',
          'acceptance': 'visible',
        }, 'id');
    expect(result['status'], 'outcome_unknown');
  });

  for (final reason in [
    'model_http_401',
    'observation_screen_unavailable',
    'tool_screen_changed_during_capture',
    'launch_outcome_unknown',
    'tool_timeout',
    'execution_interrupted',
  ]) {
    test(
      'native terminal classification and legacy reconciliation: $reason',
      () async {
        final device = Device()
          ..terminal = {'phase': 'interrupted', 'reason': reason};
        final args = {
          'goal': '打开小红书',
          'target_package': 'com.xingin.xhs',
          'acceptance': '小红书在前台',
        };
        final result = await NativeChatTaskRunner(
          agent: device,
          pollInterval: Duration.zero,
        ).run(args, 'id');
        expect(result['status'], 'outcome_unknown');
        expect(result['reason'], reason);
        final journal = ToolJournal(MemoryPersistence());
        await journal.open();
        await journal.put('legacy', {
          'tool': 'device.run_task',
          'arguments': args,
          'operation_id': 'id',
          'status': 'outcome_unknown',
        });
        expect(
          await journal.reconcileNativeTasks([
            {'id': 'id', ...args, ...device.terminal},
          ]),
          0,
        );
        expect(journal.get('legacy')!['status'], 'outcome_unknown');
      },
    );
  }

  for (final phase in ['running', 'cancelled', 'completed']) {
    test(
      'cancellation after dispatch preserves native terminal evidence: $phase',
      () async {
        final device = Device()..runGate = Completer<Map<String, dynamic>>();
        final native = NativeChatTaskRunner(
          agent: device,
          pollInterval: Duration.zero,
        );
        final running = native.run({
          'scope': 'calendar',
          'goal': 'create',
          'acceptance': 'visible',
        }, 'dispatched');
        expect(device.calls, ['run']);
        await native.cancel();
        device.runGate!.complete({'id': 'dispatched', 'phase': phase});
        final result = await running;
        expect(
          result['status'],
          phase == 'completed' ? 'completed' : 'outcome_unknown',
        );
        expect(device.calls.where((call) => call == 'run').length, 1);
      },
    );
  }

  test(
    'cancel during installed-app lookup never dispatches and releases ownership',
    () async {
      final device = Device()..appsGate = Completer<void>();
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final args = {
        'target_package': 'com.xingin.xhs',
        'goal': 'open',
        'acceptance': 'visible',
      };
      final running = native.run(args, 'cancel-before-dispatch');
      expect((await native.run(args, 'competing'))['reason'], 'task_busy');
      await native.cancel();
      device.appsGate!.complete();
      expect((await running)['status'], 'cancelled');
      expect(device.calls.where((call) => call == 'run'), isEmpty);
      expect(
        (await native.run(args, 'new-explicit-request'))['status'],
        'completed',
      );
      expect(device.calls.where((call) => call == 'run').length, 1);
    },
  );

  test(
    'model failure after native dispatch blocks cross-turn replay',
    () async {
      final device = Device()
        ..terminal = {'phase': 'interrupted', 'reason': 'model_timeout'};
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = ToolRunner(
        journal: journal,
        registry: ToolRegistry(
          snapshot: emptyLife,
          mutate: (_, {required operationId}) async => {},
          hasConflict: () => false,
          fetch: (_) async => {},
          requestDeviceTask: native.run,
        ),
      );
      Future<Map<String, dynamic>> run(String turn) => runner.run(
        turnId: turn,
        callId: 'call',
        name: 'device_run_task',
        arguments: {
          'goal': 'open',
          'target_package': 'com.xingin.xhs',
          'acceptance': 'visible',
        },
        approve: (_) async => false,
      );
      expect((await run('first'))['data']['status'], 'outcome_unknown');
      final second = await run('second');
      expect(second.toString(), contains('blocked_by_unresolved_prior_action'));
      expect(device.calls.where((call) => call == 'run').length, 1);
    },
  );

  test(
    'apps preflight failure never dispatches or becomes an unknown action',
    () async {
      final device = Device()..appsFail = true;
      final result = await NativeChatTaskRunner(
        agent: device,
      ).run({'target_package': 'com.xingin.xhs'}, 'id');
      expect(result, {
        'status': 'failed',
        'error': 'installed_apps_unavailable',
      });
      expect(device.calls, ['apps']);
    },
  );

  test(
    'observed chat completion does not poison a new explicit task',
    () async {
      final device = Device();
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = ToolRunner(
        journal: journal,
        registry: ToolRegistry(
          snapshot: emptyLife,
          mutate: (_, {required operationId}) async => {},
          hasConflict: () => false,
          fetch: (_) async => {},
          requestDeviceTask: native.run,
        ),
      );
      Future<Map<String, dynamic>> run(String turn) => runner.run(
        turnId: turn,
        callId: 'call',
        name: 'device_run_task',
        arguments: {
          'goal': '打开小红书',
          'target_package': 'com.xingin.xhs',
          'acceptance': '小红书在前台',
        },
        approve: (_) async => false,
      );
      expect((await run('first'))['data']['status'], 'completed');
      await run('first');
      expect(device.calls.where((c) => c == 'run').length, 1);
      await run('new-explicit-request');
      expect(device.calls.where((c) => c == 'run').length, 2);
    },
  );

  test(
    'Android tasks dispatch without approval and retain installed scope and stable id',
    () async {
      final device = Device();
      final registry = ToolRegistry(
        snapshot: emptyLife,
        mutate: (input, {required operationId}) async => {},
        hasConflict: () => false,
        fetch: (_) async => {},
        listDeviceApps: () async => {'apps': await device.call('apps')},
        requestDeviceTask: (input, id) => NativeChatTaskRunner(
          agent: device,
          pollInterval: Duration.zero,
        ).run(input, id),
      );
      final input = {
        'goal': '打开小红书',
        'target_package': 'com.xingin.xhs',
        'acceptance': '小红书在前台',
      };
      final tool = registry.resolve('device_run_task', input);
      expect(registry.needsApproval(tool, input), false);
      final result = await registry.execute(tool, input, 'operation-1');
      expect(device.calls, ['apps', 'run', 'tasks']);
      expect(device.dispatched, {
        ...input,
        'id': 'operation-1',
        'interaction_mode': 'chat',
      });
      expect(result['status'], 'completed');
      expect(result['summary'], '小红书已在前台');
    },
  );
  test('uninstalled target never dispatches', () async {
    final device = Device();
    final result = await NativeChatTaskRunner(
      agent: device,
    ).run({'target_package': 'invented.app'}, 'operation-1');
    expect(result['error'], 'target_app_not_installed');
    expect(device.calls, ['apps']);
  });
}
