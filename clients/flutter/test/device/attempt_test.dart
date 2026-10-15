import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/attempt.dart';

Map<String, dynamic> stateJson() => {
  'task_phase': 'running',
  'attempt': {'id': 'a', 'status': 'prepared', 'dispatch_started': false},
  'effects': 0,
  'evidence': <String>[],
  'action_grant_ref': 'write',
};
AttemptState state() => AttemptState.fromJson(stateJson());
Map<String, dynamic> grant() => {
  'grant_ref': 'read',
  'status': 'approved',
  'scope': 'sandbox.fs.read',
  'attempt_id': 'a',
};
Matcher error(String code) =>
    throwsA(isA<AttemptError>().having((e) => e.code, 'code', code));
void main() {
  test(
    'prepared failure requires proof, never claims a started dispatch had no effect',
    () {
      expect(
        () => advanceAttempt(state(), {
          'op': 'prove_not_dispatched',
          'evidence_ref': '',
        }),
        error('stale_fence'),
      );
      final failed = advanceAttempt(state(), {
        'op': 'prove_not_dispatched',
        'evidence_ref': 'journal',
      }).toJson();
      expect(failed['task_phase'], 'failed');
      expect(failed['attempt']['status'], 'failed');
      expect(failed['evidence'], ['journal']);
      final started = AttemptState.fromJson({
        ...stateJson(),
        'attempt': {'id': 'a', 'status': 'prepared', 'dispatch_started': true},
      });
      expect(
        () => advanceAttempt(started, {
          'op': 'prove_not_dispatched',
          'evidence_ref': 'journal',
        }),
        error('unknown_effect'),
      );
    },
  );
  test('dispatch recovery is uncertain, serializable and cannot retry', () {
    final original = state();
    final dispatched = advanceAttempt(original, {
      'op': 'mark_dispatch_started',
    });
    expect(dispatched.toJson()['attempt']['dispatch_started'], true);
    final recovered = advanceAttempt(dispatched, {'op': 'restart'});
    expect(recovered.toJson()['attempt']['status'], 'unknown-effect');
    expect(recovered.toJson()['task_phase'], 'waiting');
    for (final op in [
      'mark_dispatch_started',
      'retry_dispatch',
      'persist_intent',
    ]) {
      expect(
        () => advanceAttempt(recovered, {'op': op}),
        error('unknown_effect'),
      );
    }
    expect(
      AttemptState.fromJson(
        jsonDecode(jsonEncode(recovered.toJson())) as Map<String, dynamic>,
      ).toJson(),
      recovered.toJson(),
    );
    expect(
      advanceAttempt(original, {'op': 'restart'}).toJson()['attempt']['status'],
      'prepared',
    );
    expect(original.toJson(), stateJson());
  });
  test(
    'reconciliation requires separate approved read, preserves effects and cancellation',
    () {
      final unknownJson = {
        ...stateJson(),
        'effects': 1,
        'attempt': {
          'id': 'a',
          'status': 'unknown-effect',
          'dispatch_started': true,
        },
      };
      final unknown = AttemptState.fromJson(unknownJson);
      final event = <String, dynamic>{
        'op': 'verify_outcome',
        'outcome': 'failed',
        'evidence_ref': 'proof',
      };
      expect(() => advanceAttempt(unknown, event), error('approval_required'));
      for (final invalid in [
        {...grant(), 'grant_ref': 'write'},
        {...grant(), 'grant_ref': ''},
        {...grant(), 'scope': 'sandbox.command'},
        {...grant(), 'attempt_id': 'other'},
        for (final status in ['pending', 'revoked', 'expired', 'consumed'])
          {...grant(), 'status': status},
      ]) {
        expect(
          () => advanceAttempt(unknown, {...event, 'grant': invalid}),
          error('approval_required'),
        );
      }
      for (final outcome in ['completed', 'failed']) {
        final resolved = advanceAttempt(unknown, {
          ...event,
          'outcome': outcome,
          'grant': grant(),
        });
        expect(resolved.toJson()['task_phase'], outcome);
        expect(
          resolved.toJson()['attempt']['status'],
          outcome == 'completed' ? 'accepted' : 'failed',
        );
        expect(resolved.toJson()['effects'], 1);
        expect(resolved.toJson()['evidence'], ['proof']);
        expect(resolved.toJson()['consumed_verification_grants'], ['read']);
        expect(
          advanceAttempt(
            AttemptState.fromJson({...unknownJson, 'task_phase': 'cancelled'}),
            {...event, 'outcome': outcome, 'grant': grant()},
          ).toJson()['task_phase'],
          'cancelled',
        );
        expect(
          () => advanceAttempt(resolved, {...event, 'grant': grant()}),
          error('stale_fence'),
        );
      }
      expect(
        () => advanceAttempt(
          AttemptState.fromJson({
            ...unknownJson,
            'consumed_verification_grants': ['read'],
          }),
          {...event, 'grant': grant()},
        ),
        error('approval_required'),
      );
      expect(
        () => advanceAttempt(unknown, {
          ...event,
          'outcome': 'other',
          'grant': grant(),
        }),
        error('stale_fence'),
      );
      expect(
        () => advanceAttempt(unknown, {
          ...event,
          'evidence_ref': '',
          'grant': grant(),
        }),
        error('stale_fence'),
      );
    },
  );
  test('unknown events and invalid counters fail closed', () {
    expect(
      () => advanceAttempt(state(), {'op': 'future_event'}),
      error('stale_fence'),
    );
    for (final effects in [
      -1,
      0.5,
      9007199254740992,
      double.nan,
      double.infinity,
    ]) {
      expect(
        () => advanceAttempt(
          AttemptState.fromJson({...stateJson(), 'effects': effects}),
          {'op': 'restart'},
        ),
        error('stale_fence'),
      );
    }
    expect(
      advanceAttempt(
        AttemptState.fromJson({...stateJson(), 'effects': 9007199254740991}),
        {'op': 'restart'},
      ).toJson()['effects'],
      9007199254740991,
    );
  });
  test('intent, acceptance and terminal state ordering match TS', () {
    final none = AttemptState.fromJson({
      ...stateJson(),
      'task_phase': 'queued',
      'attempt': {'id': 'a', 'status': 'none', 'dispatch_started': false},
    });
    final prepared = advanceAttempt(none, {'op': 'persist_intent'});
    final dispatched = advanceAttempt(prepared, {'op': 'retry_dispatch'});
    final accepted = advanceAttempt(dispatched, {'op': 'accept'});
    expect(accepted.toJson()['task_phase'], 'verifying');
    expect(accepted.toJson()['attempt']['status'], 'accepted');
    for (final phase in ['completed', 'cancelled', 'failed']) {
      final terminal = AttemptState.fromJson({
        ...stateJson(),
        'task_phase': phase,
      });
      expect(
        () => advanceAttempt(terminal, {'op': 'mark_dispatch_started'}),
        error('stale_fence'),
      );
      final restarted = advanceAttempt(
        AttemptState.fromJson({...dispatched.toJson(), 'task_phase': phase}),
        {'op': 'restart'},
      );
      expect(restarted.toJson()['task_phase'], phase);
    }
  });
}
