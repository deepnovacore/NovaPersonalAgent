import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/authority.dart';
import '../contract_fixture.dart';

class _Clock implements Clock {
  @override
  num now() => 0;
}

Map<String, dynamic> _copy(dynamic value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;

Future<void> _run(ContractCase c) async {
  final g = c['given'];
  final state = <String, dynamic>{
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
  };
  final authority = Authority(state, _Clock());
  final current = state['tasks'][0];
  var phase = g['task']['phase'];
  var attempt = g['attempt']['status'];
  var effects = g['effects'];
  final extra = <String, dynamic>{};
  for (final step in c['when']) {
    final p = step['params'];
    switch (step['op']) {
      case 'approve':
        authority.approveGrant(g['approval']['grant_ref']);
      case 'change_binding':
        expect((current['bindings'] as Map).containsKey(p['field']), isTrue);
        current['bindings'][p['field']] = p['value'];
      case 'revoke_permission':
        current['permissions'] = (current['permissions'] as List)
            .where((s) => s != p['scope'])
            .toList();
      case 'dispatch':
        try {
          final result = authority.authorizeDispatch({
            'grant_ref': g['approval']['grant_ref'],
            'operation_id': p['operation_id'],
            'kind':
                p['kind'] ?? g['approval']['bindings']['permission_scope'][0],
            'bindings': {
              ..._copy(g['approval']['bindings']),
              'executable_digest':
                  p['executable_digest'] ??
                  g['approval']['bindings']['executable_digest'],
            },
          });
          if (result['replayed'] == false) {
            effects++;
            phase = 'running';
            attempt = 'accepted';
          }
        } on AuthorityError catch (error) {
          extra['error'] = error.code;
        }
      case 'stop_task':
        authority.revokeForStop(g['task']['id']);
        expect(
          current['bindings']['control_revision'],
          g['fence']['control_revision'] + 1,
        );
        phase = 'cancelled';
      case 'observe_stop_ack':
        expect(current['stopped'], isTrue);
        expect(
          (state['grants'] as List).every(
            (grant) => grant['status'] == 'revoked',
          ),
          isTrue,
        );
        extra['stop_ack_grant_status'] = state['grants'][0]['status'];
      case 'background':
        expect(authority.bumpLifecycleGeneration(), p['lifecycle_generation']);
      case 'foreground':
        break;
      case 'deliver_old_reply':
        final late = authority.classifyReply({
          ..._copy(g['fence']),
          'task_id': g['task']['id'],
          'lifecycle_generation': p['lifecycle_generation'],
        })['late']!;
        extra['late'] = late;
        if (late && g['attempt']['dispatch_started'] == true) {
          attempt = 'unknown-effect';
          if (phase != 'cancelled') phase = 'waiting';
        }
      default:
        fail('unsupported authority operation: ${step['op']}');
    }
  }
  final actual = {
    'task_phase': phase,
    'attempt_status': attempt,
    'approval_status': state['grants'][0]['status'],
    'effects': effects,
    ...extra,
  };
  for (final entry in (c['then'] as Map<String, dynamic>).entries) {
    expect(actual[entry.key], entry.value, reason: entry.key);
  }
}

final Map<String, ContractAdapter> adapters = {
  for (final id in [
    'approval-version-expiry',
    'approval-single-consumption',
    'stop-revokes-before-ack',
    'permission-recheck',
    'capability-revision-recheck',
    'exec-requires-approval',
    'ios-background-reply',
  ])
    id: _run,
};
