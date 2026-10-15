import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/authority.dart';
import 'package:nova_mobile/device/task_ledger.dart';
import '../contract_fixture.dart';

class _Clock implements Clock {
  @override
  num now() => 0;
}

Map<String, dynamic> _copy(dynamic value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
Matcher _error(String code) =>
    throwsA(isA<TaskLedgerError>().having((e) => e.code, 'code', code));

Future<void> _run(ContractCase c) async {
  final g = c['given'];
  var sequence = 0;
  String id() =>
      sequence++ == 0 ? g['task']['id'] as String : 'effect-$sequence';
  var ledger = TaskLedger(id: id, now: () => 0);
  final task = ledger.delegate(g['request_key'], _copy(g['input']));
  final fence = <String, dynamic>{
    'task_id': task['id'],
    'control_revision': g['fence']['control_revision'],
    'goal_revision': g['fence']['goal_revision'],
  };
  var authority = Authority({
    'lifecycle_generation': g['fence']['lifecycle_generation'],
    'tasks': [
      {
        'bindings': _copy(g['approval']['bindings']),
        'permissions': List<dynamic>.of(g['permissions']),
        'stopped': false,
      },
    ],
    'grants': [
      {
        ..._copy(g['approval']),
        'consumed': g['approval']['status'] == 'consumed',
      },
    ],
    'receipts': <dynamic>[],
  }, _Clock());
  String requestKey(String requestId) => jsonEncode([
    g['identity']['principal'],
    g['identity']['device_id'],
    requestId,
  ]);
  void consume(String operationId) {
    authority.authorizeDispatch({
      'grant_ref': g['approval']['grant_ref'],
      'operation_id': operationId,
      'kind': g['permissions'][0],
      'bindings': _copy(g['approval']['bindings']),
    });
  }

  var effects = g['effects'] as int;
  var effectId = '';
  var sameTask = true;
  var deliveries = 0;
  Map<String, dynamic>? receipt;
  Completer<void>? gate;
  Future<void>? evaluation;
  final extra = <String, dynamic>{};
  for (final step in c['when']) {
    final p = step['params'];
    switch (step['op']) {
      case 'restart':
        ledger = TaskLedger.fromJson(
          _copy(ledger.toJson()),
          id: id,
          now: () => 1,
        );
        authority = Authority.fromJson(_copy(authority.toJson()), _Clock());
      case 'recover_uncertain':
        expect(
          ledger.pendingEffect(task['id'])?['status'] == 'unknown-effect' ||
              ledger
                  .inputReceipts(task['id'])
                  .any((r) => r['status'] == 'unknown-effect'),
          isTrue,
        );
        ledger.recoveryWait(task['id'], p['reason']);
      case 'replay_delegation':
        sameTask =
            ledger.delegate(g['request_key'], _copy(g['input']))['id'] ==
                task['id'] &&
            sameTask;
      case 'conflicting_delegation':
        expect(
          () => ledger.delegate(g['request_key'], {
            ..._copy(g['input']),
            'goal': p['goal'],
          }),
          _error(p['error']),
        );
      case 'persist_intent':
        consume(g['attempt']['id']);
        effectId = ledger.reserveInitial(fence);
      case 'mark_dispatch_started':
        ledger.markEffectDispatching(effectId);
      case 'retry_dispatch':
        expect(() {
          ledger.reserveInitial(fence);
          effects++;
        }, _error(p['error']));
      case 'bind_work':
        void bind() => ledger.bindWork(fence, p['work_id'], p['session_id']);
        if (p['error'] != null) {
          expect(bind, _error(p['error']));
        } else {
          bind();
        }
      case 'deliver_input':
        final result = await ledger.input(
          requestKey(p['request_id']),
          fence,
          p['session_id'],
          p['text'],
          () async {
            consume(p['request_id']);
            effects++;
            return p['result'];
          },
        );
        expect(
          result,
          p['result'] == 'unknown' ? 'unknown-effect' : p['result'],
        );
        final current = ledger.inputReceipts(task['id']).single;
        if (receipt != null) {
          expect(current, receipt);
        } else {
          receipt = current;
        }
        deliveries++;
      case 'revise_goal':
        final revised = ledger.reviseGoal(
          requestKey(p['request_id']),
          fence,
          p['goal'],
          [],
        );
        authority.state['tasks'][0]['bindings']['goal_revision'] =
            revised['goal_revision'];
        expect(
          () => authority.approveGrant(g['approval']['grant_ref']),
          throwsA(
            isA<AuthorityError>().having((e) => e.code, 'code', 'stale_fence'),
          ),
        );
      case 'begin_model_evaluation':
        gate = Completer<void>();
        final captured = _copy(fence);
        evaluation = () async {
          await gate!.future;
          try {
            final effect = ledger.reserveInitial(captured);
            ledger.markEffectDispatching(effect);
            effects++;
            ledger.settleEffect(effect, 'accepted');
          } on TaskLedgerError catch (e) {
            expect(['task_terminal', 'stale_task'], contains(e.code));
          }
        }();
      case 'stop_task':
        authority.revokeForStop(task['id']);
        ledger.cancel(requestKey(p['request_id']), fence);
      case 'deliver_late_correction':
        gate!.complete();
        await evaluation;
      default:
        fail('Missing task ledger operation: ${step['op']}');
    }
  }
  final expected = c['then'] as Map<String, dynamic>;
  if (expected.containsKey('task_count')) {
    extra['task_count'] = ledger.list().length;
  }
  if (expected.containsKey('same_task_id')) extra['same_task_id'] = sameTask;
  if (expected.containsKey('receipt_replayed')) {
    extra['receipt_replayed'] = deliveries == 2;
    final originalId = (jsonDecode(receipt!['request_id']) as List)[2];
    extra['receipt'] = {
      'request_id': originalId,
      'status': receipt['status'],
      'session_id': receipt['session_id'],
      'text': receipt['text'],
    };
    expect(receipt['fence'], fence);
    expect(receipt['actor'], {'kind': 'nova'});
    expect(receipt['task_id'], task['id']);
  }
  expect({
    'task_phase': ledger.get(task['id'])['phase'],
    'attempt_status':
        ledger.pendingEffect(task['id'])?['status'] ??
        receipt?['status'] ??
        'none',
    'approval_status': authority.toJson()['grants'][0]['status'],
    'effects': effects,
    ...extra,
  }, expected);
  expect(
    ledger.get(task['id'])['conversation_id'],
    g['input']['conversation_id'],
  );
  expect(ledger.get(task['id'])['origin_ref'], g['input']['origin_ref']);
}

final Map<String, ContractAdapter> adapters = {
  for (final name in [
    'stop-late-reply',
    'intent-crash',
    'ack-lost',
    'same-input-delegation',
    'stale-goal-fence',
  ])
    name: _run,
};
