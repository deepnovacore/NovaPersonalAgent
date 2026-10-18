import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/todo_sync.dart';
import '../contract_fixture.dart';

Future<void> _run(ContractCase c) async {
  final given = c['given'] as Map<String, dynamic>;
  final todo = given['todo'] as Map<String, dynamic>;
  final tombstones = (given['tombstones'] as List)
      .map((t) => Tombstone.fromJson(t as Map<String, dynamic>))
      .toList();
  var state = TodoState.fromJson({
    ...todo,
    'base_version': todo['version'],
    'tombstones': given['tombstones'],
    'projection_visible': !tombstones.any((t) => t.entityId == todo['id']),
  });
  String? error;
  for (final step in c['when'] as List) {
    final p = step['params'] as Map<String, dynamic>;
    try {
      switch (step['op']) {
        case 'receive_version':
          state = merge(state, TodoVersion.fromJson(p));
        case 'choose_conflict':
          state = chooseConflict(
            state,
            p['expected_version'] as num,
            p['chosen_version'] as num,
          );
        case 'evict_projection':
          state = evictProjection(state);
          expect(state.projectionVisible, false);
        case 'upload_snapshot':
          state = applySnapshot(state, TodoSnapshot.fromJson(p));
        default:
          fail('Unsupported todo operation: ${step['op']}');
      }
    } on TodoSyncError catch (cause) {
      error = cause.code;
    }
  }
  final matching = state.tombstones.where((t) => t.entityId == state.id);
  final actual = <String, dynamic>{
    'task_phase': given['task']['phase'],
    'attempt_status': given['attempt']['status'],
    'approval_status': given['approval']['status'],
    'effects': given['effects'],
    'error': error,
    'accepted_version': state.version,
    'accepted_content': state.content,
    'conflicts': state.conflicts.map((c) => c.toJson()).toList(),
    'resurrected': state.projectionVisible,
    'tombstone_version': matching.isEmpty
        ? null
        : matching.fold<num>(0, (max, t) => t.version > max ? t.version : max),
  };
  final expected = c['then'] as Map<String, dynamic>;
  for (final entry in expected.entries) {
    expect(
      actual.containsKey(entry.key),
      true,
      reason: 'Unchecked expectation: ${entry.key}',
    );
    expect(actual[entry.key], entry.value, reason: entry.key);
  }
  expect(error, expected['error']);
  if ((c['when'] as List).any((s) => s['op'] == 'evict_projection')) {
    expect(state.projectionVisible, false);
  }
}

final Map<String, ContractAdapter> adapters = {
  for (final id in [
    'todo-conflict-cas',
    'todo-cas-success',
    'completed-projection-eviction',
    'permanent-delete-reconnect',
    'tombstone-equal-version',
  ])
    id: _run,
};
