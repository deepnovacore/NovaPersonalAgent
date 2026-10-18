import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/task_ledger.dart';

void main() {
  late TaskLedger ledger;
  var seq = 0;
  final input = <String, dynamic>{
    'conversation_id': 'c',
    'origin_ref': 'o',
    'goal': 'g',
    'acceptance': <String>[],
  };
  Map<String, dynamic> fence(String id) => {
    'task_id': id,
    'control_revision': 0,
    'goal_revision': 0,
  };
  Matcher error(String code) =>
      throwsA(isA<TaskLedgerError>().having((e) => e.code, 'code', code));
  setUp(() {
    seq = 0;
    ledger = TaskLedger(id: () => 'id-${seq++}', now: () => 10);
  });
  TaskLedger restart() => TaskLedger.fromJson(
    jsonDecode(jsonEncode(ledger.toJson())) as Map<String, dynamic>,
    id: () => 'id-${seq++}',
    now: () => 11,
  );

  test(
    'delegation replays original receipt, protects snapshots and rejects conflict',
    () {
      final task = ledger.delegate('r', input);
      ledger.cancel('stop', fence(task['id']));
      expect(restart().delegate('r', {...input}), task);
      expect(
        () => ledger.delegate('r', {...input, 'goal': 'other'}),
        error('request_conflict'),
      );
      task['phase'] = 'running';
      expect(ledger.get(task['id'])['phase'], 'cancelled');
    },
  );
  test(
    'prepared restart is failed; dispatching restart is unknown and never retried',
    () {
      final f = fence(ledger.delegate('r', input)['id']);
      final first = ledger.reserveInitial(f);
      ledger = restart();
      expect(ledger.effect(first)['status'], 'failed');
      final second = ledger.reserveInitial(f);
      ledger.markEffectDispatching(second);
      ledger = restart();
      expect(ledger.effect(second)['status'], 'unknown-effect');
      expect(ledger.effect(second)['dispatch_started'], true);
      expect(() => ledger.reserveInitial(f), error('task_effect_unknown'));
      ledger.cancel('stop', f);
      ledger.recoveryWait(f['task_id'], 'uncertain');
      expect(ledger.get(f['task_id'])['phase'], 'cancelled');
      expect(ledger.effect(second)['status'], 'unknown-effect');
    },
  );
  test(
    'input receipt survives restart, duplicate delivery and lost acknowledgement',
    () async {
      final f = fence(ledger.delegate('r', input)['id']);
      ledger.bindWork(f, 'w', 's');
      var sends = 0;
      Future<String> send() async {
        sends++;
        throw StateError('lost');
      }

      expect(
        await ledger.input('write', f, 's', 'text', send),
        'unknown-effect',
      );
      final receipt = ledger.inputReceipts(f['task_id']).single;
      ledger = restart();
      expect(
        await ledger.input('write', f, 's', 'text', send),
        'unknown-effect',
      );
      expect(ledger.inputReceipts(f['task_id']).single, receipt);
      expect(sends, 1);
      await expectLater(
        ledger.input('write', f, 's', 'changed', send),
        error('request_conflict'),
      );
      expect(sends, 1);
    },
  );
  test(
    'in-flight input is recorded before send and duplicates never dispatch',
    () async {
      final f = fence(ledger.delegate('r', input)['id']);
      ledger.bindWork(f, 'w', 's');
      final gate = Completer<String>();
      final pending = ledger.input('write', f, 's', 'text', () => gate.future);
      expect(
        restart().inputReceipts(f['task_id']).single['status'],
        'unknown-effect',
      );
      expect(
        await ledger.input(
          'write',
          f,
          's',
          'text',
          () async => fail('duplicate'),
        ),
        'unknown-effect',
      );
      gate.complete('accepted');
      expect(await pending, 'accepted');
    },
  );
  test('late correction cannot dispatch after stop or goal revision', () {
    final f = fence(ledger.delegate('r', input)['id']);
    ledger.reviseGoal('rev', f, 'new', []);
    expect(() => ledger.bindWork(f, 'late'), error('stale_task'));
    expect(() => ledger.reserveInitial(f), error('stale_task'));
    final current = {...f, 'goal_revision': 1};
    ledger.cancel('stop', current);
    expect(() => ledger.reserveInitial(current), error('task_terminal'));
    expect(ledger.cancel('stop', current)['phase'], 'cancelled');
  });
  test('invalid strings and int53 fences fail without mutation', () {
    expect(() => ledger.delegate('', input), error('request_conflict'));
    expect(
      () => ledger.delegate('r', {...input, 'goal': ''}),
      error('request_conflict'),
    );
    final f = fence(ledger.delegate('r', input)['id']);
    for (final revision in [
      -1,
      0.5,
      double.nan,
      double.infinity,
      9007199254740992,
    ]) {
      expect(
        () => ledger.reserveInitial({...f, 'goal_revision': revision}),
        error('stale_task'),
      );
    }
    expect(() => ledger.bindWork(f, ''), error('request_conflict'));
    expect(ledger.get(f['task_id'])['phase'], 'queued');
  });
  test('failed is terminal and revision overflow is atomic', () {
    final task = ledger.delegate('r', input);
    final snapshot = ledger.toJson();
    snapshot['tasks'][task['id']]['goal_revision'] = 9007199254740991;
    ledger = TaskLedger.fromJson(snapshot, id: () => 'next', now: () => 1);
    final f = {...fence(task['id']), 'goal_revision': 9007199254740991};
    expect(() => ledger.reviseGoal('rev', f, 'new', []), error('stale_task'));
    expect(ledger.get(task['id'])['goal'], 'g');
    snapshot['tasks'][task['id']]['phase'] = 'failed';
    ledger = TaskLedger.fromJson(snapshot, id: () => 'next', now: () => 1);
    expect(() => ledger.reserveInitial(f), error('task_terminal'));
  });
  test('malformed restored dispatch evidence is rejected', () {
    final f = fence(ledger.delegate('r', input)['id']);
    final effectId = ledger.reserveInitial(f);
    final snapshot = ledger.toJson();
    snapshot['effects'][effectId]['dispatch_started'] = true;
    expect(
      () => TaskLedger.fromJson(snapshot, id: () => 'new', now: () => 0),
      error('request_conflict'),
    );
  });
}
