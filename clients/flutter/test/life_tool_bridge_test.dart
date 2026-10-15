import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/life_tool_bridge.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'native Life tools use the existing durable outbox and reject stale writes',
    () async {
      final storage = MemoryLifePersistence();
      final actual = LocalLife(storage);
      await actual.open();
      final bridge = LifeToolBridge(actual);
      final input = {'op': 'create', 'kind': 'todo', 'title': 'Once'};
      await bridge.handle('validate', {'input': input});
      expect(actual.pendingCount, 0);
      final first = await bridge.handle('mutate', {
        'input': input,
        'operation_id': 'one',
      });
      final restored = LocalLife(storage);
      await restored.open();
      final resumed = LifeToolBridge(restored);
      expect(
        await resumed.handle('mutate', {'input': input, 'operation_id': 'one'}),
        first,
      );
      expect(restored.life['todos'].length, 1);
      expect(restored.pendingCount, 1);
      await expectLater(
        resumed.handle('mutate', {
          'input': {
            'op': 'update',
            'kind': 'todo',
            'id': first['id'],
            'expected_version': 0,
            'status': 'done',
          },
          'operation_id': 'stale',
        }),
        throwsStateError,
      );
      expect(restored.life['todos'][0]['status'], 'open');
      await expectLater(
        resumed.handle('validate', {
          'input': {'op': 'profile', 'about': 'not allowed'},
        }),
        throwsStateError,
      );
      actual.dispose();
      restored.dispose();
    },
  );
}
