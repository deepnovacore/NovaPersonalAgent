import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/task_todo_completion.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'verified task updates its captured todo once and never overwrites a newer edit',
    () async {
      final store = MemoryLifePersistence();
      final actual = LocalLife(store);
      await actual.open();
      final todo = await actual.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Fixture',
      });
      final task = {
        'id': 'task',
        'phase': 'verifying',
        'verified_by': 'user',
        'todo_ref': todo,
      };
      await completeTaskTodo(actual, task);
      expect(actual.life['todos'][0]['status'], 'open');
      task['phase'] = 'completed';
      await completeTaskTodo(actual, task);
      final restored = LocalLife(store);
      await restored.open();
      await completeTaskTodo(restored, task);
      expect(restored.life['todos'][0]['version'], 2);
      expect(restored.life['todos'][0]['status'], 'done');
      final other = {...task, 'id': 'other-task'};
      await expectLater(completeTaskTodo(restored, other), throwsStateError);
      expect(restored.life['todos'][0]['version'], 2);
      actual.dispose();
      restored.dispose();
    },
  );
}
