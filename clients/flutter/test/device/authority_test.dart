import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/authority.dart';

Map<String, dynamic> binding() => {
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

class FakeClock implements Clock {
  num value = 0;
  @override
  num now() => value;
}

class Setup {
  final current = binding();
  final clock = FakeClock();
  late final state = <String, dynamic>{
    'lifecycle_generation': 0,
    'tasks': [
      {
        'bindings': current,
        'permissions': ['sandbox.command'],
        'stopped': false,
      },
    ],
    'grants': <dynamic>[],
    'receipts': <dynamic>[],
  };
  late final ledger = Authority(state, clock);
  final request = <String, dynamic>{
    'grant_ref': 'grant',
    'operation_id': 'op',
    'kind': 'sandbox.command',
    'bindings': binding(),
  };
  Setup() {
    ledger.createGrant('grant', current);
  }
  dynamic get grant => state['grants'][0];
}

Matcher code(String value) =>
    throwsA(isA<AuthorityError>().having((e) => e.code, 'code', value));

void main() {
  test('pending exec rejects; exact replay never dispatches twice', () {
    final s = Setup();
    expect(
      () => s.ledger.authorizeDispatch(s.request),
      code('approval_required'),
    );
    s.ledger.approveGrant('grant');
    expect(s.ledger.authorizeDispatch(s.request)['replayed'], false);
    expect(s.ledger.authorizeDispatch(s.request), {
      'intent': 'prepared',
      'replayed': true,
    });
    expect(s.state['receipts'], hasLength(1));
    expect(
      () => s.ledger.authorizeDispatch({...s.request, 'operation_id': 'op2'}),
      code('approval_consumed'),
    );
    expect(
      () =>
          s.ledger.authorizeDispatch({...s.request, 'kind': 'calendar.write'}),
      code('request_conflict'),
    );
  });
  test('every binding change expires even consumed grants', () {
    for (final key in binding().keys) {
      final s = Setup();
      s.ledger.approveGrant('grant');
      s.ledger.authorizeDispatch(s.request);
      final value = s.current[key];
      s.current[key] = value is List
          ? ['changed']
          : value is num
          ? value + 1
          : '$value-new';
      expect(
        () =>
            s.ledger.authorizeDispatch({...s.request, 'operation_id': 'next'}),
        throwsA(isA<AuthorityError>()),
      );
      expect(s.grant['status'], 'expired', reason: key);
      s.current.addAll(binding());
      expect(
        () => s.ledger.approveGrant('grant'),
        throwsA(isA<AuthorityError>()),
      );
      expect(
        () =>
            s.ledger.authorizeDispatch({...s.request, 'operation_id': 'next'}),
        throwsA(isA<AuthorityError>()),
      );
    }
  });
  test('inclusive deadline and terminal expiry', () {
    final s = Setup();
    s.clock.value = 100;
    expect(() => s.ledger.approveGrant('grant'), code('approval_expired'));
    expect(s.grant['status'], 'expired');
    s.clock.value = 0;
    expect(() => s.ledger.approveGrant('grant'), code('approval_expired'));
  });
  test('stop revokes all grants and increments once', () {
    final s = Setup();
    s.ledger.createGrant('second', s.current);
    s.ledger.approveGrant('grant');
    s.ledger.revokeForStop('task');
    expect(s.current['control_revision'], 1);
    expect(
      (s.state['grants'] as List).every((g) => g['status'] == 'revoked'),
      true,
    );
    s.ledger.revokeForStop('task');
    expect(s.current['control_revision'], 1);
    expect(
      () => s.ledger.authorizeDispatch(s.request),
      code('approval_revoked'),
    );
  });
  test('permission withdrawal revokes without capability revision change', () {
    final s = Setup();
    s.ledger.approveGrant('grant');
    s.state['tasks'][0]['permissions'] = <String>[];
    expect(
      () => s.ledger.authorizeDispatch(s.request),
      code('permission_denied'),
    );
    expect(s.grant['status'], 'revoked');
    s.state['tasks'][0]['permissions'] = ['sandbox.command'];
    expect(
      () => s.ledger.authorizeDispatch(s.request),
      code('approval_revoked'),
    );
  });
  test('background expires grants and restored old replies stay late', () {
    final s = Setup();
    s.ledger.approveGrant('grant');
    s.ledger.authorizeDispatch(s.request);
    expect(s.ledger.bumpLifecycleGeneration(), 1);
    expect(s.grant['status'], 'expired');
    expect(s.ledger.classifyReply(s.request['bindings'])['late'], true);
    final restored = Authority.fromJson(
      jsonDecode(jsonEncode(s.ledger.toJson())),
      FakeClock(),
    );
    expect(restored.classifyReply(s.request['bindings'])['late'], true);
    expect(
      () => restored.authorizeDispatch({...s.request, 'operation_id': 'next'}),
      throwsA(isA<AuthorityError>()),
    );
  });
  test('invalid int53, IDs, scope and digest cannot dispatch', () {
    for (final value in [
      -1,
      0.5,
      9007199254740992,
      double.nan,
      double.infinity,
    ]) {
      final s = Setup();
      expect(
        () =>
            s.ledger.createGrant('bad', {...s.current, 'data_version': value}),
        code('stale_fence'),
      );
    }
    final s = Setup();
    s.ledger.approveGrant('grant');
    expect(
      () => s.ledger.authorizeDispatch({...s.request, 'operation_id': ''}),
      code('stale_fence'),
    );
    expect(
      () =>
          s.ledger.authorizeDispatch({...s.request, 'kind': 'calendar.write'}),
      code('permission_denied'),
    );
    expect(
      () => s.ledger.authorizeDispatch({
        ...s.request,
        'bindings': {...binding(), 'executable_digest': ''},
      }),
      code('stale_fence'),
    );
    expect(
      () => s.ledger.createGrant('bad', {...binding(), 'permission_scope': []}),
      code('permission_denied'),
    );
    expect(s.state['receipts'], isEmpty);
  });
  test('overflow has no partial mutations', () {
    final s = Setup();
    s.state['lifecycle_generation'] = 9007199254740991;
    expect(() => s.ledger.bumpLifecycleGeneration(), code('stale_fence'));
    s.current['control_revision'] = 9007199254740991;
    expect(() => s.ledger.revokeForStop('task'), code('stale_fence'));
    expect(s.state['tasks'][0]['stopped'], false);
  });
  test(
    'future fences cannot upgrade authority; replay survives stop and restore',
    () {
      final s = Setup();
      s.ledger.approveGrant('grant');
      expect(
        () => s.ledger.authorizeDispatch({
          ...s.request,
          'bindings': {...binding(), 'capability_revision': 2},
        }),
        code('stale_fence'),
      );
      expect(s.current['capability_revision'], 1);
      s.ledger.authorizeDispatch(s.request);
      s.ledger.revokeForStop('task');
      final restored = Authority.fromJson(s.ledger.toJson(), FakeClock());
      expect(restored.authorizeDispatch(s.request)['replayed'], true);
      expect(
        () => restored.authorizeDispatch({...s.request, 'operation_id': 'new'}),
        code('approval_revoked'),
      );
      expect(
        () => restored.createGrant('grant', s.current),
        code('request_conflict'),
      );
      expect(s.grant['consumed'], true);
    },
  );
  test('every fence, missing task and device generations classify replies', () {
    final s = Setup();
    expect(s.ledger.classifyReply(binding())['late'], false);
    for (final key in [
      'todo_version',
      'goal_revision',
      'control_revision',
      'lifecycle_generation',
      'capability_revision',
    ]) {
      expect(
        s.ledger.classifyReply({...binding(), key: binding()[key] + 1})['late'],
        true,
      );
      expect(
        s.ledger.classifyReply({...binding(), key: 9007199254740992})['late'],
        true,
      );
    }
    expect(
      s.ledger.classifyReply({...binding(), 'task_id': 'missing'})['late'],
      true,
    );
    final second = {...binding(), 'task_id': 'other'};
    s.state['tasks'].add({
      'bindings': second,
      'permissions': ['sandbox.command'],
      'stopped': false,
    });
    s.ledger.createGrant('second', second);
    s.ledger.bumpLifecycleGeneration();
    expect(second['lifecycle_generation'], 1);
    expect(
      (s.state['grants'] as List).every((g) => g['status'] == 'expired'),
      true,
    );
  });
  test(
    'JSON key order irrelevant, scope order significant, snapshots independent',
    () {
      final s = Setup();
      s.ledger.approveGrant('grant');
      final reverse = Map<String, dynamic>.fromEntries(
        binding().entries.toList().reversed,
      );
      expect(
        s.ledger.authorizeDispatch({
          ...s.request,
          'bindings': reverse,
        })['replayed'],
        false,
      );
      final saved = s.ledger.toJson();
      saved['tasks'][0]['bindings']['permission_scope'].clear();
      expect(s.current['permission_scope'], ['sandbox.command']);
      final t = Setup();
      t.current['permission_scope'] = ['sandbox.command', 'calendar.write'];
      t.state['tasks'][0]['permissions'] = [
        'sandbox.command',
        'calendar.write',
      ];
      t.ledger.createGrant('second', t.current);
      t.ledger.approveGrant('second');
      expect(
        () => t.ledger.authorizeDispatch({
          ...t.request,
          'grant_ref': 'second',
          'bindings': {
            ...t.current,
            'permission_scope': ['calendar.write', 'sandbox.command'],
          },
        }),
        code('stale_fence'),
      );
    },
  );
}
