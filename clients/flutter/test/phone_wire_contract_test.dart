// Dart half of the shared wire fixture test/fixtures/phone_wire_contract.json;
// the native half is android/app/src/test/.../phone/PhoneWireContractTest.kt.
import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final fixture =
      jsonDecode(
            File('test/fixtures/phone_wire_contract.json').readAsStringSync(),
          )
          as Map<String, dynamic>;
  Map<String, dynamic> object(String key) =>
      fixture[key] as Map<String, dynamic>;
  List<String> wires(String name) =>
      (object('enums')[name] as List).cast<String>();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const phone = MethodChannel('nova/phone/v1');
  const agent = MethodChannel('nova/local_agent/v1');

  tearDown(() {
    messenger.setMockMethodCallHandler(phone, null);
    messenger.setMockMethodCallHandler(agent, null);
  });

  test('status decodes every fixture field', () {
    final status = PhoneStatus.fromJson(object('status'));
    expect(status.apiLevel, 33);
    expect(status.tier, PhoneTier.virtual);
    expect(status.experimental, isTrue);
    expect(status.experimentalAck, isTrue);
    expect(status.accessibility, isTrue);
    expect(status.overlay, isFalse);
    expect(status.batteryWhitelisted, isTrue);
    expect(status.notificationsAllowed, isTrue);
    expect(status.pairing, PairingState.paired);
    expect(status.pairingStage, PairingStage.done);
    expect(status.pairingPort, 37123);
    expect(status.helper, HelperState.running);
    expect(status.helperFailure, HelperFailure.wrongCode);
    expect(status.helperFix, HelperFix.rePair);
  });

  test('every native enum wire decodes to its own Dart value', () {
    String snake(Enum value) => value.name.replaceAllMapped(
      RegExp('[A-Z]'),
      (m) => '_${m[0]!.toLowerCase()}',
    );
    void same<T extends Enum>(
      String name,
      List<T> values,
      T Function(String) decode,
    ) {
      expect(values.map(snake).toSet(), wires(name).toSet(), reason: name);
      for (final wire in wires(name)) {
        expect(snake(decode(wire)), wire, reason: '$name $wire');
      }
    }

    PhoneStatus status(String key, String wire) =>
        PhoneStatus.fromJson({key: wire});
    same('tier', PhoneTier.values, (w) => status('tier', w).tier);
    same('pairing', PairingState.values, (w) => status('pairing', w).pairing);
    same(
      'pairing_stage',
      PairingStage.values,
      (w) => status('pairing_stage', w).pairingStage,
    );
    same('helper', HelperState.values, (w) => status('helper', w).helper);
    same(
      'helper_failure',
      HelperFailure.values,
      (w) => status('helper_failure', w).helperFailure!,
    );
    same(
      'helper_fix',
      HelperFix.values,
      (w) => status('helper_fix', w).helperFix!,
    );
    same(
      'step_status',
      StepStatus.values,
      (w) =>
          (PhoneEvent.parse({...object('events')['step'] as Map, 'status': w})
                  as PhoneStepEvent)
              .status,
    );
    same(
      'takeover_state',
      TakeoverState.values,
      (w) =>
          (PhoneEvent.parse({
                    ...object('events')['takeover'] as Map,
                    'state': w,
                  })
                  as PhoneTakeoverEvent)
              .state,
    );
    expect(
      PhoneSettingsKind.values.map(snake).toSet(),
      wires('settings_kind').toSet(),
    );
  });

  test('events decode every fixture field', () {
    final events = object('events');
    final step = PhoneEvent.parse(jsonEncode(events['step'])) as PhoneStepEvent;
    expect(
      (step.taskId, step.step, step.tool, step.label),
      ('task-1', 2, 'tap', 'Open search'),
    );
    expect(
      (step.status, step.changed, step.ref, step.tier),
      (StepStatus.completed, true, '@e4', PhoneTier.virtual),
    );
    final takeover =
        PhoneEvent.parse(jsonEncode(events['takeover'])) as PhoneTakeoverEvent;
    expect(
      (takeover.taskId, takeover.state, takeover.byModel, takeover.reason),
      ('task-1', TakeoverState.timedOut, false, 'secure_page'),
    );
    final done = PhoneEvent.parse(jsonEncode(events['done'])) as PhoneDoneEvent;
    expect(
      (done.taskId, done.outcome, done.reason, done.summary),
      ('task-1', 'interrupted', 'tool_ref_expired', 'Stopped'),
    );
    expect((done.steps, done.durationMs), (5, 1234));
    for (final outcome in wires('done_outcome')) {
      final parsed = PhoneEvent.parse({
        ...events['done'] as Map,
        'outcome': outcome,
      });
      expect((parsed as PhoneDoneEvent).outcome, outcome);
    }
    final status = PhoneEvent.parse({
      ...events['status'] as Map,
      'status': object('status'),
    });
    expect((status as PhoneStatusEvent).status.helper, HelperState.running);
  });

  test('method arguments, replies and errors match the native side', () async {
    final sent = <String, Object?>{};
    messenger.setMockMethodCallHandler(phone, (call) async {
      sent[call.method] = jsonDecode(call.arguments as String);
      return switch (call.method) {
        'selfCheck' => jsonEncode(object('self_check')),
        'takeover' || 'handBack' => '{"state":"active"}',
        'openSettings' => '{"opened":true}',
        'setPreview' || 'setStopCovered' => '{}',
        _ => jsonEncode(object('status')),
      };
    });
    const channel = NativePhoneChannel();
    final methods = object('methods');
    for (final kind in PhoneSettingsKind.values) {
      await channel.openSettings(kind);
      expect(
        wires('settings_kind'),
        contains((sent['openSettings'] as Map)['kind']),
      );
    }
    await channel.openSettings(PhoneSettingsKind.wirelessDebugging);
    await channel.setExperimentalAck(true);
    await channel.setPreview(true);
    await channel.submitCode('123456', port: 37123);
    await channel.takeover('task-1');
    await channel.handBack('task-1');
    await channel.setStopCovered('task-1', true);
    for (final method in [
      'openSettings',
      'setExperimentalAck',
      'setPreview',
      'submitCode',
      'takeover',
      'handBack',
      'setStopCovered',
    ]) {
      expect(sent[method], methods[method], reason: method);
    }
    final checks = await channel.selfCheck();
    expect(
      [for (final c in checks) (c.id, c.ok, c.detail)],
      [('helper', true, null), ('main_focus', false, 'shared_focus')],
    );
    expect(
      (fixture['self_check_ids'] as List).every(
        (id) => id is String && id.isNotEmpty,
      ),
      isTrue,
    );

    for (final code in (fixture['safe_errors'] as List).cast<String>()) {
      messenger.setMockMethodCallHandler(
        phone,
        (_) async =>
            throw PlatformException(code: 'phone_error', message: code),
      );
      await expectLater(
        channel.takeover('task-1'),
        throwsA(
          isA<PhoneChannelException>().having((e) => e.code, 'code', code),
        ),
      );
    }
  });

  test('tasks and stop use the local agent wire', () async {
    final sent = <String, Object?>{};
    messenger.setMockMethodCallHandler(agent, (call) async {
      sent[call.method] = jsonDecode(call.arguments as String);
      return call.method == 'tasks' ? jsonEncode(fixture['tasks']) : null;
    });
    const channel = NativePhoneChannel();
    final active = (fixture['active_phases'] as List).toSet();
    expect(await channel.activeTaskIds(), {
      for (final task in (fixture['tasks'] as List).cast<Map>())
        if (active.contains(task['phase'])) task['id'],
    });
    await channel.stopTask('task-1');
    expect(sent['stop'], object('methods')['stop']);
  });
}
