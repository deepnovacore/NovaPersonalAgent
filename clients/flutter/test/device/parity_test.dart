// Expected codes/states transcribed from the numbered TS unit tests below.
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/authority.dart' as authority;
import 'package:nova_mobile/device/ownership.dart' as ownership;
import 'package:nova_mobile/device/attempt.dart' as attempt;
import 'package:nova_mobile/device/todo_sync.dart' as todo;

class _Clock implements authority.Clock {
  num value = 0;
  @override
  num now() => value;
}

Map<String, dynamic> _binding() => {
  'task_id': 'task',
  'owner': 'device',
  'todo_version': 1,
  'goal_revision': 0,
  'control_revision': 0,
  'lifecycle_generation': 0,
  'capability_revision': 1,
  'conversation_generation': 0,
  'data_version': 1,
  'observation_version': 1,
  'permission_scope': ['sandbox.command'],
  'effect_class': 'write',
  'proposal_digest': 'action',
  'executable_digest': 'script',
  'expires_at': 100,
};
({
  authority.Authority ledger,
  Map<String, dynamic> state,
  Map<String, dynamic> request,
  _Clock clock,
})
_authority() {
  final state = <String, dynamic>{
    'lifecycle_generation': 0,
    'tasks': [
      {
        'bindings': _binding(),
        'permissions': ['sandbox.command'],
        'stopped': false,
      },
    ],
    'grants': <dynamic>[],
    'receipts': <dynamic>[],
  };
  final clock = _Clock();
  final ledger = authority.Authority(state, clock);
  ledger.createGrant('grant', _binding());
  return (
    ledger: ledger,
    state: state,
    clock: clock,
    request: {
      'grant_ref': 'grant',
      'operation_id': 'op',
      'kind': 'sandbox.command',
      'bindings': _binding(),
    },
  );
}

Matcher _authorityError(String code) => throwsA(
  isA<authority.AuthorityError>().having((e) => e.code, 'code', code),
);
Matcher _ownershipError(String code) => throwsA(
  isA<ownership.OwnershipError>().having((e) => e.code, 'code', code),
);
Matcher _attemptError(String code) =>
    throwsA(isA<attempt.AttemptError>().having((e) => e.code, 'code', code));
Matcher _todoError() => throwsA(
  isA<todo.TodoSyncError>().having((e) => e.code, 'code', 'version_conflict'),
);
todo.TodoState _todo() => todo.TodoState(
  id: 'todo',
  version: 1,
  baseVersion: 1,
  content: 'original',
  conflicts: [],
  tombstones: [],
  projectionVisible: true,
);
attempt.AttemptState _attempt({
  bool started = false,
  String status = 'prepared',
}) => attempt.AttemptState.fromJson({
  'task_phase': 'running',
  'attempt': {'id': 'a', 'status': status, 'dispatch_started': started},
  'effects': 0,
  'evidence': <String>[],
  'action_grant_ref': 'write',
});
void main() {
  group('authority TS parity', () {
    // runtime/test/device-authority.test.ts:87-91 (four numeric boundary inputs).
    for (final value in [-1, 0.5, 9007199254740992, double.nan]) {
      test('invalid data_version $value', () {
        final s = _authority();
        expect(
          () => s.ledger.createGrant('bad', {
            ..._binding(),
            'data_version': value,
          }),
          _authorityError('stale_fence'),
        );
        expect(s.state['receipts'], isEmpty);
        expect((s.state['grants'] as List).length, 1);
      });
    }
    // runtime/test/device-authority.test.ts:23-32.
    test('pending dispatch', () {
      final s = _authority();
      expect(
        () => s.ledger.authorizeDispatch(s.request),
        _authorityError('approval_required'),
      );
      expect(s.state['receipts'], isEmpty);
    });
    test('exact replay and consumed grant', () {
      final s = _authority();
      s.ledger.approveGrant('grant');
      expect(s.ledger.authorizeDispatch(s.request)['replayed'], false);
      expect(s.ledger.authorizeDispatch(s.request)['replayed'], true);
      expect(
        () => s.ledger.authorizeDispatch({...s.request, 'operation_id': 'op2'}),
        _authorityError('approval_consumed'),
      );
      expect((s.state['receipts'] as List).length, 1);
    });
    // runtime/test/device-authority.test.ts:48-54.
    test('inclusive deadline and no reapproval', () {
      final s = _authority();
      s.clock.value = 100;
      expect(
        () => s.ledger.approveGrant('grant'),
        _authorityError('approval_expired'),
      );
      expect(s.state['grants'][0]['status'], 'expired');
      s.clock.value = 0;
      expect(
        () => s.ledger.approveGrant('grant'),
        _authorityError('approval_expired'),
      );
    });
    // runtime/test/device-authority.test.ts:56-65.
    test('stop is idempotent and revokes', () {
      final s = _authority();
      s.ledger.approveGrant('grant');
      s.ledger.revokeForStop('task');
      s.ledger.revokeForStop('task');
      expect(s.state['tasks'][0]['bindings']['control_revision'], 1);
      expect(s.state['grants'][0]['status'], 'revoked');
      expect(
        () => s.ledger.authorizeDispatch(s.request),
        _authorityError('approval_revoked'),
      );
    });
  });
  group('ownership TS parity', () {
    // runtime/test/device-ownership.test.ts:8-9 (four noncanonical identities).
    for (final key in [
      'a:b:c',
      '["a", "b","c"]',
      '["a","b",""]',
      '["a","b","c",0]',
    ]) {
      test(
        'reject identity $key',
        () => expect(
          () => ownership.decodeIdentity(key),
          _ownershipError('request_conflict'),
        ),
      );
    }
    // runtime/test/device-ownership.test.ts:21-28.
    for (final input in [
      (device: 'other', generation: 2, context: 3, code: 'owner_mismatch'),
      (device: 'd', generation: 1, context: 3, code: 'stale_fence'),
    ]) {
      test('session fence $input', () {
        final state = ownership.SessionOwnership.fromJson({
          'id': 's',
          'owner': 'd',
          'generation': 2,
          'context_version': 3,
        });
        expect(
          () => ownership.processInput(
            state,
            input.device,
            input.generation,
            input.context,
          ),
          _ownershipError(input.code),
        );
        expect(state.toJson()['context_version'], 3);
      });
    }
    test('context advances once', () {
      final state = ownership.SessionOwnership.fromJson({
        'id': 's',
        'owner': 'd',
        'generation': 2,
        'context_version': 3,
      });
      final next = ownership.processInput(state, 'd', 2, 3);
      expect(next.toJson()['context_version'], 4);
      expect(
        () => ownership.processInput(next, 'd', 2, 3),
        _ownershipError('stale_fence'),
      );
    });
    // runtime/test/device-ownership.test.ts:40-41; Dart insertion order must not matter.
    test('canonical maps, ordered arrays', () {
      expect(
        ownership.canonicalPayload({
          'b': [1, 2],
          'a': 1,
        }),
        ownership.canonicalPayload({
          'a': 1,
          'b': [1, 2],
        }),
      );
      expect(
        ownership.canonicalPayload([1, 2]),
        isNot(ownership.canonicalPayload([2, 1])),
      );
    });
  });
  group('attempt TS parity', () {
    // runtime/test/device-attempt.test.ts:8-14.
    test(
      'empty evidence',
      () => expect(
        () => attempt.advanceAttempt(_attempt(), {
          'op': 'prove_not_dispatched',
          'evidence_ref': '',
        }),
        _attemptError('stale_fence'),
      ),
    );
    test('proof before dispatch', () {
      final result = attempt.advanceAttempt(_attempt(), {
        'op': 'prove_not_dispatched',
        'evidence_ref': 'journal',
      }).toJson();
      expect(result['task_phase'], 'failed');
      expect(result['attempt']['status'], 'failed');
      expect(result['evidence'], ['journal']);
    });
    test(
      'started dispatch cannot prove no effect',
      () => expect(
        () => attempt.advanceAttempt(_attempt(started: true), {
          'op': 'prove_not_dispatched',
          'evidence_ref': 'journal',
        }),
        _attemptError('unknown_effect'),
      ),
    );
    // runtime/test/device-attempt.test.ts:17-25.
    test('restart after dispatch becomes uncertain, cannot retry', () {
      final dispatched = attempt.advanceAttempt(_attempt(), {
        'op': 'mark_dispatch_started',
      });
      final recovered = attempt.advanceAttempt(dispatched, {'op': 'restart'});
      expect(recovered.toJson()['attempt']['status'], 'unknown-effect');
      expect(recovered.toJson()['task_phase'], 'waiting');
      expect(
        () =>
            attempt.advanceAttempt(recovered, {'op': 'mark_dispatch_started'}),
        _attemptError('unknown_effect'),
      );
    });
    test(
      'prepared restart remains prepared',
      () => expect(
        attempt.advanceAttempt(_attempt(), {
          'op': 'restart',
        }).toJson()['attempt']['status'],
        'prepared',
      ),
    );
    // runtime/test/device-attempt.test.ts:28-33 (four invalid verification grants).
    for (final change in [
      {'grant_ref': 'write'},
      {'scope': 'sandbox.command'},
      {'attempt_id': 'other'},
      {'status': 'revoked'},
    ]) {
      test('verification grant $change', () {
        final state = _attempt(started: true, status: 'unknown-effect');
        expect(
          () => attempt.advanceAttempt(state, {
            'op': 'verify_outcome',
            'outcome': 'failed',
            'evidence_ref': 'proof',
            'grant': {
              'grant_ref': 'read',
              'status': 'approved',
              'scope': 'sandbox.fs.read',
              'attempt_id': 'a',
              ...change,
            },
          }),
          _attemptError('approval_required'),
        );
        expect(state.toJson()['attempt']['status'], 'unknown-effect');
        expect(state.toJson()['effects'], 0);
      });
    }
    // runtime/test/device-attempt.test.ts:46-48.
    test(
      'unknown event',
      () => expect(
        () => attempt.advanceAttempt(_attempt(), {'op': 'future_event'}),
        _attemptError('stale_fence'),
      ),
    );
  });
  group('todo TS parity', () {
    // runtime/test/device-todo-sync.test.ts:50-58 (five numeric boundary inputs).
    for (final version in [
      -1,
      0.5,
      double.nan,
      double.infinity,
      9007199254740992,
    ]) {
      test('invalid version $version', () {
        final state = _todo();
        expect(
          () => todo.merge(
            state,
            todo.TodoVersion(version: version, baseVersion: 1, content: 'bad'),
          ),
          _todoError(),
        );
        expect(
          () => todo.applySnapshot(
            state,
            todo.TodoSnapshot(version: version, phase: 'queued'),
          ),
          _todoError(),
        );
        expect(state.version, 1);
        expect(state.content, 'original');
      });
    }
    test('CAS overflow', () {
      final state = _todo().copyWith(version: 9007199254740991);
      expect(
        () => todo.chooseConflict(state, state.version, state.version),
        _todoError(),
      );
      expect(state.content, 'original');
    });
    // runtime/test/device-todo-sync.test.ts:8-20.
    test('stale CAS and missing choice', () {
      final merged = todo.merge(
        _todo(),
        const todo.TodoVersion(version: 2, baseVersion: 1, content: 'other'),
      );
      final chosen = todo.chooseConflict(merged, 2, 1);
      expect(chosen.version, 3);
      expect(chosen.content, 'original');
      expect(() => todo.chooseConflict(chosen, 2, 2), _todoError());
      expect(() => todo.chooseConflict(chosen, 3, 99), _todoError());
    });
    // runtime/test/device-todo-sync.test.ts:31-41.
    test('tombstone blocks snapshots at and beyond deletion revision', () {
      final state = _todo().copyWith(
        tombstones: [
          const todo.Tombstone(entityId: 'todo', version: 2, permanent: true),
        ],
      );
      for (final version in [0, 1, 2, 3]) {
        final result = todo.applySnapshot(
          state,
          todo.TodoSnapshot(version: version, phase: 'running'),
        );
        expect(result.projectionVisible, false);
        expect(result.version, 1);
      }
    });
  });
}
