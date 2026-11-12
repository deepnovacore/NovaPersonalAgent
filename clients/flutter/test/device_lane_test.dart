import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/agent/native_chat_task.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/tool_owner.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/model_client.dart' show AgentFailure;
import 'package:nova_mobile/personal/life_reducer.dart';
import 'agent_core_test.dart' show MemoryPersistence;

class FakeDevice implements LocalAgent {
  final calls = <String>[];
  final stops = <String>[];
  final runs = <Map<String, dynamic>>[];
  Completer<void>? hold;
  PlatformException? runError;
  Map<String, dynamic> terminal = {
    'phase': 'verifying',
    'summary': 'ok',
    'evidence': 'fp',
  };
  List<Map<String, dynamic>> listed = [];
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    calls.add(method);
    switch (method) {
      case 'stop':
        stops.add(input['id'] as String);
        return {};
      case 'apps':
        return [
          {'package': 'com.xingin.xhs', 'label': '小红书'},
          {'package': 'tv.danmaku.bili', 'label': '哔哩哔哩'},
        ];
      case 'run':
        if (runError != null) throw runError!;
        runs.add(input);
        return {'id': input['id'], 'phase': 'running'};
      case 'tasks':
        await hold?.future;
        return listed.isNotEmpty
            ? listed
            : [
                {
                  'id': runs.last['id'],
                  'goal': runs.last['goal'],
                  'acceptance': runs.last['acceptance'],
                  ...terminal,
                },
              ];
    }
    throw StateError(method);
  }
}

const args = {
  'goal': '打开小红书',
  'target_package': 'com.xingin.xhs',
  'acceptance': '小红书在前台',
};

ToolRunner toolRunner(NativeChatTaskRunner native, ToolJournal journal) =>
    ToolRunner(
      journal: journal,
      registry: ToolRegistry(
        snapshot: emptyLife,
        mutate: (_, {required operationId}) async => {},
        hasConflict: () => false,
        fetch: (_) async => {},
        requestDeviceTask: native.run,
        readDeviceTasks: () async => (await native.agent.call('tasks')) as List,
      ),
    );

Future<Map<String, dynamic>> runTool(
  ToolRunner runner,
  String turn, {
  String owner = ToolOwner.text,
  Map<String, dynamic> input = args,
}) => runner.run(
  turnId: turn,
  callId: 'call',
  name: 'device_run_task',
  arguments: input,
  approve: (_) async => false,
  owner: owner,
);

void main() {
  test('cancel stops a task only for its owner', () async {
    final device = FakeDevice()..hold = Completer();
    final native = NativeChatTaskRunner(
      agent: device,
      pollInterval: Duration.zero,
    );
    final running = ToolOwner.run(
      'text',
      () => native.run({
        'scope': 'calendar',
        'goal': 'g',
        'acceptance': 'a',
      }, 'a'),
    );
    await Future<void>.delayed(Duration.zero);
    expect(native.activeOwner, 'text');
    await native.cancel(owner: 'voice:delegate');
    expect(device.stops, isEmpty);
    await native.cancel(owner: 'text');
    expect(device.stops, ['a']);
    device.hold!.complete();
    expect((await running)['status'], 'outcome_unknown');
    expect(native.activeOwner, isNull);
  });

  test('second device task is device_busy, never an unknown outcome', () async {
    final device = FakeDevice()..hold = Completer();
    final native = NativeChatTaskRunner(
      agent: device,
      pollInterval: Duration.zero,
    );
    final journal = ToolJournal(MemoryPersistence());
    await journal.open();
    final runner = toolRunner(native, journal);
    final voice = runTool(runner, 'v', owner: 'voice:delegate');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final text = await runTool(runner, 't');
    expect(text['status'], 'failed');
    expect(text['data']['reason'], 'device_busy');
    expect(text['data']['held_by'], 'voice');
    expect(journal.hasUnresolved, isTrue); // only the running voice call
    device.hold!.complete();
    expect((await voice)['status'], 'completed');
    expect(journal.hasUnresolved, isFalse);
    // The refused call left no block: it can run now.
    expect((await runTool(runner, 't2'))['status'], 'completed');
  });

  test('a long device task in one lane does not reject another lane', () async {
    final device = FakeDevice()..hold = Completer();
    final native = NativeChatTaskRunner(
      agent: device,
      pollInterval: Duration.zero,
    );
    final journal = ToolJournal(MemoryPersistence());
    await journal.open();
    final runner = toolRunner(native, journal);
    final voice = runTool(runner, 'v', owner: 'voice:delegate');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final list = await runner.run(
      turnId: 't',
      callId: 'c',
      name: 'life_list',
      arguments: {'kind': 'todo'},
      approve: (_) async => false,
    );
    expect(list['status'], 'completed');
    await expectLater(
      runTool(runner, 'v2', owner: 'voice:delegate'),
      throwsA(isA<AgentFailure>()),
    );
    device.hold!.complete();
    await voice;
  });

  for (final reason in [
    'another_task_is_active',
    'accessibility_required',
    'accessibility_flags_failed',
    'helper_unavailable',
    'model_settings_required',
  ]) {
    test('admission failure $reason does not block the next turn', () async {
      final device = FakeDevice()
        ..runError = PlatformException(
          code: 'local_agent_error',
          message: reason,
        );
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = toolRunner(native, journal);
      final first = await runTool(runner, 'one');
      expect(first['status'], 'failed');
      expect(first['data']['reason'], reason);
      expect(first['data']['effects'], 'none');
      if (reason == 'helper_unavailable') {
        expect(first['data']['summary'], contains('无线调试'));
      } else {
        expect(first['data'], isNot(contains('summary')));
      }
      expect(device.stops, isEmpty);
      expect(journal.hasUnresolved, isFalse);
      device.runError = null;
      expect((await runTool(runner, 'two'))['status'], 'completed');
    });
  }

  test(
    'an IPC timeout after sending stays unknown and blocks replay',
    () async {
      final device = FakeDevice()..runError = null;
      final native = NativeChatTaskRunner(
        agent: _Timeout(device),
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = toolRunner(native, journal);
      final first = await runTool(runner, 'one');
      expect(first['status'], 'outcome_unknown');
      expect(journal.hasUnresolved, isTrue);
    },
    timeout: const Timeout(Duration(seconds: 40)),
  );

  test(
    'interrupted with every action confirmed releases the replay block',
    () async {
      final device = FakeDevice()
        ..terminal = {
          'phase': 'interrupted',
          'reason': 'accessibility_unavailable',
          'cause': 'a11y_destroyed',
          'action_in_flight': false,
          'unresolved_actions': 0,
          'dispatched_actions': 0,
        };
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = toolRunner(native, journal);
      final first = await runTool(runner, 'one');
      expect(first['status'], 'failed');
      expect(first['data']['reason'], 'accessibility_unavailable');
      expect(journal.hasUnresolved, isFalse);
      expect((await runTool(runner, 'two'))['status'], 'failed');
      expect(device.runs, hasLength(2));
    },
  );

  test(
    'a recorded unknown is released once native shows nothing unconfirmed',
    () async {
      final device = FakeDevice();
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = toolRunner(native, journal);
      await journal.put('old:${_fpOf(runner)}', {
        'tool': 'device.run_task',
        'arguments': args,
        'operation_id': 'prior',
        'status': 'outcome_unknown',
      });
      device.listed = [
        {
          'id': 'prior',
          ...args,
          'phase': 'interrupted',
          'reason': 'execution_interrupted',
          'action_in_flight': false,
          'unresolved_actions': 0,
          'dispatched_actions': 0,
        },
      ];
      final result = await runTool(runner, 'new');
      // The prior record stays; the new request went through to native.
      expect(device.runs, hasLength(1));
      expect(
        journal.get('old:${_fpOf(runner)}')!['status'],
        'ended_reconciled',
      );
      expect(
        journal.get('old:${_fpOf(runner)}')!['original_status'],
        'outcome_unknown',
      );
      expect(result['status'], isNot('blocked'));
    },
  );

  test(
    'an action possibly in flight keeps the block and explains it',
    () async {
      final device = FakeDevice();
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = toolRunner(native, journal);
      await journal.put('old:${_fpOf(runner)}', {
        'tool': 'device.run_task',
        'arguments': args,
        'operation_id': 'prior',
        'status': 'outcome_unknown',
      });
      device.listed = [
        {
          'id': 'prior',
          ...args,
          'phase': 'interrupted',
          'reason': 'accessibility_unavailable',
          'action_in_flight': true,
          'unresolved_actions': 0,
          'dispatched_actions': 0,
          'summary': '需要核对',
        },
      ];
      final result = await runTool(runner, 'new');
      expect(result['error'], 'blocked_by_unresolved_prior_action');
      expect(result['reason'], 'prior_task_unverified');
      expect(result['prior_task']['native']['summary'], '需要核对');
      expect(device.runs, isEmpty);
      expect(await journal.confirmDeviceTaskChecked('other'), 0);
      expect(journal.hasUnresolved, isTrue);
      expect(await journal.confirmDeviceTaskChecked('prior'), 1);
      expect(journal.hasUnresolved, isFalse);
      expect(
        journal.get('old:${_fpOf(runner)}')!['original_status'],
        'outcome_unknown',
      );
    },
  );

  test('dispatched actions or missing counters keep the block', () async {
    for (final extra in [
      {
        'action_in_flight': false,
        'unresolved_actions': 0,
        'dispatched_actions': 3,
      },
      {
        'action_in_flight': false,
        'unresolved_actions': 1,
        'dispatched_actions': 0,
      },
      {'action_in_flight': false},
    ]) {
      final device = FakeDevice()
        ..terminal = {
          'phase': 'interrupted',
          'reason': 'accessibility_unavailable',
          ...extra,
        };
      final native = NativeChatTaskRunner(
        agent: device,
        pollInterval: Duration.zero,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final runner = toolRunner(native, journal);
      final first = await runTool(runner, 'one');
      expect(first['status'], 'outcome_unknown', reason: '$extra');
      final second = await runTool(runner, 'two');
      expect(second['reason'], 'prior_task_unverified');
      expect(second['message'], contains('我核对过了，可以重新做'));
      expect(device.runs, hasLength(1));
    }
  });

  test('restart turns awaiting approval into not executed', () async {
    final persistence = MemoryPersistence();
    final journal = ToolJournal(persistence);
    await journal.open();
    await journal.put('t:abc', {
      'tool': 'life.create',
      'status': 'awaiting_approval',
    });
    await journal.put('t:def', {'tool': 'file.write', 'status': 'executing'});
    final restored = ToolJournal(persistence);
    await restored.open();
    expect(restored.get('t:abc')!['status'], 'cancelled_before_execution');
    expect(restored.get('t:def')!['status'], 'outcome_unknown');
    expect(restored.hasUnknown('abc'), isFalse);
  });

  test('verifying with evidence completes without a target_package', () async {
    final device = FakeDevice();
    final result = await NativeChatTaskRunner(
      agent: device,
      pollInterval: Duration.zero,
    ).run({'scope': 'calendar', 'goal': 'g', 'acceptance': 'a'}, 'id');
    expect(result['status'], 'completed');
  });

  test('app_name resolves through the installed apps', () async {
    final device = FakeDevice();
    final native = NativeChatTaskRunner(
      agent: device,
      pollInterval: Duration.zero,
    );
    final ok = await native.run({
      'goal': '搜索',
      'app_name': '小红书',
      'acceptance': '看到结果',
    }, 'id');
    expect(ok['status'], 'completed');
    expect(device.runs.single['target_package'], 'com.xingin.xhs');
    final missing = await native.run({
      'goal': 'g',
      'app_name': '不存在',
      'acceptance': 'a',
    }, 'id2');
    expect(missing['error'], 'target_app_not_installed');
    final none = await native.run({'goal': 'g', 'acceptance': 'a'}, 'id3');
    expect(none['error'], 'app_name_required');
  });

  test('a host cancels the device task only as its own owner', () async {
    final owners = <String?>[];
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final registry = ToolRegistry(
      snapshot: emptyLife,
      mutate: (_, {required operationId}) async => {},
      hasConflict: () => false,
      fetch: (_) async => {},
      cancelChatTask: ({String? owner}) async => owners.add(owner),
    );
    final runner = ToolRunner(
      registry: registry,
      journal: ToolJournal(MemoryPersistence()),
    );
    final text = AgentCoreHost(
      store: store,
      settings: ModelSettings(),
      tools: runner,
    );
    final voice = AgentCoreHost(
      store: store,
      settings: ModelSettings(),
      tools: runner,
      owner: 'voice:delegate',
    );
    text.cancel();
    voice.cancel();
    expect(owners, ['text', 'voice:delegate']);
    text.dispose();
    voice.dispose();
  });
}

String _fpOf(ToolRunner runner) =>
    lifeFingerprint({'name': 'device_run_task', 'arguments': args});

class _Timeout implements LocalAgent {
  _Timeout(this.inner);
  final FakeDevice inner;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    if (method == 'run') {
      await inner.call(method, input);
      throw TimeoutException('run');
    }
    return inner.call(method, input);
  }
}
