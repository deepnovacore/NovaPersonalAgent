import '../personal/local_life.dart';
import '../personal/life_reducer.dart';

/// Completion can update only the Todo version captured when it was delegated.
/// The durable Life receipt makes retries safe after a crash or lost UI reply.
Future<void> completeTaskTodo(LocalLife life, Map task) async {
  if (task['phase'] != 'completed' ||
      task['verified_by'] != 'user' ||
      task['todo_ref'] is! Map) {
    return;
  }
  final reference = task['todo_ref'] as Map;
  await life.mutate({
    'op': 'update',
    'kind': 'todo',
    'id': reference['id'],
    'expected_version': reference['version'],
    'status': 'done',
  }, operationId: lifeId('native-task-complete:${task['id']}'));
}
