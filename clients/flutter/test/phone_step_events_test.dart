import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';
import 'package:nova_mobile/agent/phone_run.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/phone_tool_steps.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'package:nova_mobile/ui/tool_timeline.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'support/fake_phone_channel.dart';

String _event(Map<String, Object?> json) => jsonEncode(json);

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  group('PhoneEvent.parse', () {
    test('step events carry the contract fields', () {
      final event = PhoneEvent.parse(
        _event({
          'type': 'step',
          'task_id': 'a',
          'step': 3,
          'tool': 'tap',
          'label': '点搜索',
          'status': 'running',
          'changed': true,
          'ref': '@e4',
          'tier': 'virtual',
        }),
      );
      expect(event, isA<PhoneStepEvent>());
      final step = event! as PhoneStepEvent;
      expect(
        (step.taskId, step.step, step.tool, step.label, step.ref, step.changed),
        ('a', 3, 'tap', '点搜索', '@e4', true),
      );
      expect(step.status, StepStatus.running);
      expect(step.tier, PhoneTier.virtual);
    });

    test('status, takeover and done events', () {
      final status = PhoneEvent.parse(
        _event({
          'type': 'status',
          'status': {
            'api_level': 33,
            'tier': 'virtual',
            'experimental': true,
            'accessibility': true,
            'notifications_allowed': true,
            'pairing_stage': 'waiting_code',
            'pairing': 'searching',
            'pairing_port': 41235,
            'helper': 'failed',
            'helper_failure': 'wrong_code',
            'helper_fix': 're_pair',
          },
        }),
      );
      final s = (status! as PhoneStatusEvent).status;
      expect(s.pairingStage, PairingStage.waitingCode);
      expect(s.helperFailure, HelperFailure.wrongCode);
      expect(s.helperFix, HelperFix.rePair);
      expect(s.pairingPort, 41235);
      expect(s.experimental, isTrue);

      final takeover =
          PhoneEvent.parse(
                _event({
                  'type': 'takeover',
                  'task_id': 'a',
                  'state': 'timed_out',
                  'by': 'user',
                }),
              )!
              as PhoneTakeoverEvent;
      expect(takeover.state, TakeoverState.timedOut);
      expect(takeover.byModel, isFalse);

      final done =
          PhoneEvent.parse(
                _event({
                  'type': 'done',
                  'task_id': 'a',
                  'outcome': 'interrupted',
                  'reason': 'helper_unavailable',
                  'steps': 4,
                  'duration_ms': 1200,
                }),
              )!
              as PhoneDoneEvent;
      expect(
        (done.outcome, done.reason, done.steps),
        ('interrupted', 'helper_unavailable', 4),
      );
    });

    test('malformed or unknown events are dropped', () {
      expect(PhoneEvent.parse('not json'), isNull);
      expect(PhoneEvent.parse(_event({'type': 'mystery'})), isNull);
      expect(PhoneEvent.parse(_event({'type': 'step', 'step': 1})), isNull);
    });
  });

  group('step -> ToolStep', () {
    test('maps tool, label, ref, index and status', () {
      ToolStep map(StepStatus status) => phoneStepToToolStep(
        stepEvent(
          step: 7,
          tool: 'type',
          label: '输入关键词',
          ref: '@e2',
          status: status,
        ),
        'zh',
      );
      final step = map(StepStatus.running);
      expect(step.name, 'type');
      expect(step.narration, '输入关键词');
      expect(step.refLabel, '@e2');
      expect(step.stepIndex, 7);
      expect(
        [
          map(StepStatus.running).status,
          map(StepStatus.completed).status,
          map(StepStatus.failed).status,
          map(StepStatus.unknown).status,
        ],
        ['running', 'completed', 'failed', 'outcome_unknown'],
      );
      expect(map(StepStatus.unknown).state, '结果待核实');
      expect(map(StepStatus.running).state, '进行中');
      expect(step.label, '输入文字');
    });

    test('an empty label leaves the tool label as the title', () {
      final step = phoneStepToToolStep(
        stepEvent(label: '  ', tool: 'back'),
        'zh',
      );
      expect(step.narration, isNull);
      final rows = buildToolSteps([step]);
      expect(rows.single.text, '返回');
    });

    test('the live last step is a running dot; earlier ones are done', () {
      final rows = buildToolSteps([
        phoneStepToToolStep(stepEvent(step: 1, label: '打开小红书'), 'zh'),
        phoneStepToToolStep(
          stepEvent(step: 2, label: '点搜索', status: StepStatus.running),
          'zh',
        ),
      ], running: true);
      expect(rows.map((r) => r.step), [1, 2]);
      expect(rows.map((r) => r.state), [ToolStepState.ok, ToolStepState.run]);
    });
  });

  group('PhoneRunTracker', () {
    test('folds a step into running then final, keeping order', () async {
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      channel.emit(stepEvent(step: 2, status: StepStatus.running));
      channel.emit(stepEvent(step: 1));
      channel.emit(stepEvent(step: 2));
      await pumpEventQueue();
      final run = tracker.run('t1')!;
      expect(run.stepEvents.map((e) => e.step), [1, 2]);
      expect(run.stepEvents.last.status, StepStatus.completed);
      expect(phoneRunToolSteps(run, 'zh'), hasLength(2));
      expect(tracker.activeVirtual, same(run));
    });

    test('main-tier runs and finished runs are not virtual', () async {
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      channel.emit(stepEvent(taskId: 'm', tier: PhoneTier.main));
      await pumpEventQueue();
      expect(tracker.activeVirtual, isNull);
      channel.emit(stepEvent(taskId: 'v'));
      await pumpEventQueue();
      expect(tracker.activeVirtual?.taskId, 'v');
      channel.emit(doneEvent(taskId: 'v'));
      await pumpEventQueue();
      expect(tracker.activeVirtual, isNull);
      expect(tracker.run('v')!.done!.outcome, 'completed');
    });

    test('takeover events drive needsUser; a stray done is ignored', () async {
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      channel.emit(doneEvent(taskId: 'ghost'));
      channel.emit(stepEvent());
      channel.emit(takeoverEvent(TakeoverState.requested));
      await pumpEventQueue();
      expect(tracker.run('ghost'), isNull);
      expect(tracker.activeVirtual!.needsUser, isTrue);
      channel.emit(takeoverEvent(TakeoverState.active));
      await pumpEventQueue();
      expect(tracker.activeVirtual!.takeoverActive, isTrue);
      channel.emit(takeoverEvent(TakeoverState.returned));
      await pumpEventQueue();
      expect(tracker.activeVirtual!.needsUser, isFalse);
    });

    test(
      'takeover and handBack call the channel and apply its state',
      () async {
        final channel = FakePhoneChannel();
        final tracker = PhoneRunTracker(channel)..start();
        addTearDown(tracker.dispose);
        channel.emit(stepEvent());
        await pumpEventQueue();
        await tracker.takeover('t1');
        expect(channel.calls, contains('takeover:t1'));
        expect(tracker.run('t1')!.takeoverActive, isTrue);
        await tracker.handBack('t1');
        expect(channel.calls, contains('handBack:t1'));
        expect(tracker.run('t1')!.needsUser, isFalse);
        channel.takeoverResult = TakeoverState.failed;
        await tracker.takeover('t1');
        expect(tracker.actionFailed, isTrue);
      },
    );

    test('markEnded closes a run whose done event never came', () async {
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      channel.emit(stepEvent());
      await pumpEventQueue();
      expect(tracker.activeVirtual, isNotNull);
      var notified = 0;
      tracker.addListener(() => notified++);
      tracker.markEnded('unknown');
      expect(notified, 0);
      tracker.markEnded('t1');
      expect(tracker.activeVirtual, isNull);
      expect(tracker.run('t1')!.active, isFalse);
      expect(notified, 1);
    });

    test('on resume a run native no longer lists is over', () async {
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      channel.emit(stepEvent(taskId: 'gone'));
      channel.emit(stepEvent(taskId: 'alive'));
      await pumpEventQueue();
      channel.activeIds = null;
      tracker.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await pumpEventQueue();
      expect(tracker.run('gone')!.active, isTrue, reason: 'unknown keeps runs');
      channel.activeIds = {'alive'};
      tracker.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await pumpEventQueue();
      expect(tracker.run('gone')!.active, isFalse);
      expect(tracker.run('alive')!.active, isTrue);
    });

    test('keeps only the most recent runs', () async {
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      for (var i = 0; i < 12; i++) {
        channel.emit(stepEvent(taskId: 'r$i'));
      }
      await pumpEventQueue();
      expect(tracker.run('r0'), isNull);
      expect(tracker.run('r11'), isNotNull);
    });
  });

  group('PhonePreview', () {
    test(
      'first holder turns the preview on, last one off, frames stop',
      () async {
        final channel = FakePhoneChannel();
        final preview = PhonePreview(channel);
        addTearDown(preview.dispose);
        preview.retain();
        preview.retain();
        await pumpEventQueue();
        expect(channel.previews, [true]);
        channel.frameController.add(tinyFrame);
        await pumpEventQueue();
        expect(preview.frame.value, isNotNull);
        preview.release();
        expect(channel.previews, [true]);
        preview.release();
        await pumpEventQueue();
        expect(channel.previews, [true, false]);
        expect(preview.frame.value, isNull);
        expect(channel.frameController.hasListener, isFalse);
      },
    );

    test('jpegSize reads the frame header', () {
      final jpeg = Uint8List.fromList([
        0xff, 0xd8, //
        0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        0x03,
        0xc0,
        0x01,
        0xb0,
        0x03,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ]);
      expect(jpegSize(jpeg), (432, 960));
      expect(jpegSize(Uint8List.fromList([1, 2, 3, 4])), isNull);
    });
  });

  group('chat grouping', () {
    Future<(ConversationStore, String)> openStore() async {
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      return (store, await store.create());
    }

    Future<void> pump(
      WidgetTester tester,
      ConversationStore store,
      String id,
      PhoneRunTracker tracker, {
      bool running = false,
      String? activeTool = 'device_run_task',
    }) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      if (running) {
        host
          ..busy = true
          ..activeTool = activeTool
          ..activeConversationId = id;
      }
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: id,
              phoneRun: tracker,
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }

    testWidgets('a finished phone task becomes one group of its steps', (
      tester,
    ) async {
      final (store, id) = await openStore();
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      await store.append(id, {'role': 'user', 'content': '在小红书搜索猫'});
      await store.append(id, {
        'role': 'assistant',
        'content': '',
        'tool_calls': [
          {
            'id': 'c1',
            'function': {'name': 'device_run_task', 'arguments': '{}'},
          },
        ],
      });
      await store.append(id, {
        'role': 'tool',
        'tool_name': 'device_run_task',
        'tool_call_id': 'c1',
        'content': jsonEncode({
          'status': 'completed',
          'data': {'status': 'completed', 'task_id': 't1'},
        }),
      });
      await store.append(id, {'role': 'assistant', 'content': '搜到了'});
      channel
        ..emit(stepEvent(step: 1, tool: 'open_app', label: '打开小红书'))
        ..emit(stepEvent(step: 2, tool: 'tap', label: '点搜索', ref: '@e3'))
        ..emit(stepEvent(step: 3, tool: 'type', label: '输入猫'));
      await tester.runAsync(pumpEventQueue);
      await pump(tester, store, id, tracker);
      final groups = tester.widgetList<ToolStepGroup>(
        find.byType(ToolStepGroup),
      );
      expect(groups, hasLength(1));
      expect(groups.single.steps.map((s) => s.name), [
        'open_app',
        'tap',
        'type',
      ]);
      expect(groups.single.steps.map((s) => s.stepIndex), [1, 2, 3]);
      expect(groups.single.steps[1].refLabel, '@e3');
      expect(find.textContaining('3 次工具调用'), findsOneWidget);
    });

    testWidgets('a running phone task shows live steps as a running group', (
      tester,
    ) async {
      final (store, id) = await openStore();
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      await store.append(id, {'role': 'user', 'content': '搜一下'});
      channel
        ..emit(stepEvent(step: 1, label: '打开小红书', tool: 'open_app'))
        ..emit(stepEvent(step: 2, label: '点搜索', status: StepStatus.running));
      await tester.runAsync(pumpEventQueue);
      await pump(tester, store, id, tracker, running: true);
      final group = tester.widget<ToolStepGroup>(find.byType(ToolStepGroup));
      expect(group.running, isTrue);
      expect(group.steps.map((s) => s.status), ['completed', 'running']);
      expect(find.text('打开小红书'), findsOneWidget);
      expect(find.text('点搜索'), findsOneWidget);
    });

    testWidgets('the live group stays after done until the result is stored', (
      tester,
    ) async {
      final (store, id) = await openStore();
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      await store.append(id, {'role': 'user', 'content': '搜一下'});
      channel
        ..emit(stepEvent(step: 1, label: '打开小红书', tool: 'open_app'))
        ..emit(doneEvent());
      await tester.runAsync(pumpEventQueue);
      await pump(tester, store, id, tracker, running: true);
      final group = tester.widget<ToolStepGroup>(find.byType(ToolStepGroup));
      expect(group.steps.single.name, 'open_app');
      expect(group.running, isFalse);
    });

    testWidgets('another tool running here gets no phone group', (
      tester,
    ) async {
      final (store, id) = await openStore();
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      await store.append(id, {'role': 'user', 'content': '搜一下'});
      channel.emit(stepEvent(step: 1, label: '打开小红书', tool: 'open_app'));
      await tester.runAsync(pumpEventQueue);
      await pump(
        tester,
        store,
        id,
        tracker,
        running: true,
        activeTool: 'web_fetch',
      );
      expect(find.byType(ToolStepGroup), findsNothing);
    });

    testWidgets('a task that did not complete keeps its own row after steps', (
      tester,
    ) async {
      final (store, id) = await openStore();
      final channel = FakePhoneChannel();
      final tracker = PhoneRunTracker(channel)..start();
      addTearDown(tracker.dispose);
      await store.append(id, {'role': 'user', 'content': 'x'});
      await store.append(id, {
        'role': 'tool',
        'tool_name': 'device_run_task',
        'tool_call_id': 'c1',
        'content': jsonEncode({
          'status': 'outcome_unknown',
          'data': {'status': 'outcome_unknown', 'task_id': 't1'},
        }),
      });
      channel
        ..emit(stepEvent(step: 1, tool: 'open_app', label: '打开'))
        ..emit(stepEvent(step: 2, tool: 'tap', label: '点'));
      await tester.runAsync(pumpEventQueue);
      await pump(tester, store, id, tracker);
      final group = tester.widget<ToolStepGroup>(find.byType(ToolStepGroup));
      expect(group.steps.map((s) => s.name), [
        'open_app',
        'tap',
        'device_run_task',
      ]);
    });

    testWidgets('a task without recorded steps keeps its single line', (
      tester,
    ) async {
      final (store, id) = await openStore();
      final tracker = PhoneRunTracker(FakePhoneChannel())..start();
      addTearDown(tracker.dispose);
      await store.append(id, {'role': 'user', 'content': 'x'});
      await store.append(id, {
        'role': 'tool',
        'tool_name': 'device_run_task',
        'tool_call_id': 'c1',
        'content': jsonEncode({
          'status': 'completed',
          'data': {'task_id': 'old'},
        }),
      });
      await pump(tester, store, id, tracker);
      final group = tester.widget<ToolStepGroup>(find.byType(ToolStepGroup));
      expect(group.steps.single.name, 'device_run_task');
    });
  });

  group('NativePhoneChannel', () {
    const method = MethodChannel('nova/phone/v1');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    tearDown(() => messenger.setMockMethodCallHandler(method, null));

    test('stays silent without a bridge', () async {
      const channel = NativePhoneChannel();
      final seen = <Object>[];
      final events = channel.events.listen(seen.add, onError: seen.add);
      final frames = channel.frames.listen(seen.add, onError: seen.add);
      await pumpEventQueue();
      await events.cancel();
      await frames.cancel();
      expect(seen, isEmpty);
      // A host without the ack handler did not record it.
      await expectLater(
        channel.setExperimentalAck(true),
        throwsA(isA<PhoneChannelException>()),
      );
    });

    test('encodes arguments as JSON strings and decodes replies', () async {
      final seen = <String, Object?>{};
      messenger.setMockMethodCallHandler(method, (call) async {
        seen[call.method] = call.arguments;
        return switch (call.method) {
          'openSettings' => jsonEncode({'opened': true}),
          'selfCheck' => jsonEncode({
            'checks': [
              {'id': 'helper', 'ok': true},
              {'id': 'tap', 'ok': false, 'detail': 'tap_refused'},
            ],
          }),
          'takeover' => jsonEncode({'state': 'active'}),
          'setPreview' => jsonEncode({}),
          'setExperimentalAck' => jsonEncode({'experimental_ack': true}),
          _ => jsonEncode({'api_level': 34, 'helper': 'running'}),
        };
      });
      const channel = NativePhoneChannel();
      expect((await channel.status()).helperRunning, isTrue);
      expect(
        await channel.openSettings(PhoneSettingsKind.wirelessDebugging),
        isTrue,
      );
      expect(jsonDecode(seen['openSettings']! as String), {
        'kind': 'wireless_debugging',
      });
      await channel.submitCode('123456', port: 4242);
      expect(jsonDecode(seen['submitCode']! as String), {
        'code': '123456',
        'port': 4242,
      });
      await channel.submitCode('654321');
      expect(jsonDecode(seen['submitCode']! as String), {'code': '654321'});
      final checks = await channel.selfCheck();
      expect(checks.map((c) => (c.id, c.ok, c.detail)), [
        ('helper', true, null),
        ('tap', false, 'tap_refused'),
      ]);
      expect(await channel.takeover('t1'), TakeoverState.active);
      expect(jsonDecode(seen['takeover']! as String), {'task_id': 't1'});
      await channel.setPreview(true);
      expect(jsonDecode(seen['setPreview']! as String), {'visible': true});
      expect((await channel.setExperimentalAck(true)).experimentalAck, isTrue);
      expect(jsonDecode(seen['setExperimentalAck']! as String), {
        'acknowledged': true,
      });
    });

    test('a native error becomes a PhoneChannelException', () async {
      messenger.setMockMethodCallHandler(method, (call) async {
        throw PlatformException(code: 'phone_error', message: 'unsupported');
      });
      const channel = NativePhoneChannel();
      await expectLater(
        channel.startPairing(),
        throwsA(
          isA<PhoneChannelException>().having(
            (e) => e.code,
            'code',
            'unsupported',
          ),
        ),
      );
      // A native handler that errors on the ack is a failure the UI shows.
      await expectLater(
        channel.setExperimentalAck(true),
        throwsA(isA<PhoneChannelException>()),
      );
    });
  });
}
