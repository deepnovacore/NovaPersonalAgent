import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/attempt.dart';
import '../contract_fixture.dart';

String _id(dynamic value) {
  expect(value, isA<String>());
  expect(value as String, isNotEmpty);
  return value;
}

Future<void> _run(ContractCase c) async {
  final g = c['given'] as Map<String, dynamic>;
  var state = AttemptState.fromJson({
    'task_phase': g['task']['phase'],
    'attempt': g['attempt'],
    'effects': g['effects'],
    'evidence': <String>[],
    'action_grant_ref': g['approval']['grant_ref'],
  });
  Map<String, dynamic>? grant;
  String? errorCode;
  for (final step in c['when'] as List) {
    final p = step['params'] as Map<String, dynamic>;
    try {
      switch (step['op']) {
        case 'prove_not_dispatched':
          state = advanceAttempt(state, {
            'op': step['op'],
            'evidence_ref': _id(p['evidence_ref']),
          });
        case 'authorize_verification':
          grant = {
            'grant_ref': _id(p['grant_ref']),
            'scope': _id(p['scope']),
            'status': 'approved',
            'attempt_id': state.toJson()['attempt']['id'],
          };
        case 'verify_outcome':
          expect(p['outcome'], isIn(['completed', 'failed']));
          state = advanceAttempt(state, {
            'op': step['op'],
            'outcome': p['outcome'],
            'evidence_ref': _id(p['evidence_ref']),
            'grant': ?grant,
          });
        default:
          fail('unsupported operation ${step['op']}');
      }
    } on AttemptError catch (error) {
      errorCode = error.code;
    }
  }
  final data = state.toJson();
  final actual = <String, dynamic>{
    'task_phase': data['task_phase'],
    'attempt_status': data['attempt']['status'],
    'approval_status': g['approval']['status'],
    'effects': data['effects'],
    'error': errorCode,
  };
  for (final entry in (c['then'] as Map<String, dynamic>).entries) {
    expect(actual[entry.key], entry.value, reason: entry.key);
  }
}

final Map<String, ContractAdapter> adapters = {
  'prepared-failed': _run,
  'unknown-resolved-completed': _run,
  'unknown-resolved-failed': _run,
};
