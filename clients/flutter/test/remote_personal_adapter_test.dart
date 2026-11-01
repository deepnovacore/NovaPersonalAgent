import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/commands.dart';
import 'package:nova_mobile/space/personal_adapter.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/client_controller.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'space_client_test.dart' show MemorySpacePersistence;
import 'binding_cleanup_isolation_test.dart'
    show CleanupCrypto, CleanupTransport;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'shared personal pages queue versioned Host edits and pending-goal dependencies',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.snapshot = {
        'todos': [
          {'id': 'todo', 'kind': 'todo', 'title': '原待办', 'version': 7},
        ],
        'profile': {'about': '', 'version': 0},
      };
      var syncs = 0;
      final adapter = RemotePersonalAdapter(
        state,
        onSync: () async {
          syncs++;
        },
      );
      expect(adapter.store.local, isNull);
      expect(adapter.store.news, isNull);
      expect(
        await adapter.store.mutate({
          'op': 'create',
          'kind': 'goal',
          'title': '新目标',
        }),
        isNull,
      );
      final create = state.pending.single;
      final goal = adapter.store.snapshot!.object('life')['goals'][0] as Map;
      expect(goal['id'], create['temp_id']);
      await adapter.store.updateItem(
        {'id': 'todo', 'kind': 'todo', 'version': 7},
        {'goal_id': goal['id'], 'title': '修改后的待办'},
      );
      expect(state.pending.last['base_version'], 7);
      expect(state.pending.last['depends_on'], [create['op_id']]);
      expect(state.pending.last['input'], {
        'op': 'update',
        'kind': 'todo',
        'id': 'todo',
        'goal_id': goal['id'],
        'title': '修改后的待办',
      });
      expect(state.cards('todos').single['title'], '原待办');
      await adapter.store.mutate({
        'op': 'profile',
        'about': '我的介绍',
        'expected_version': 0,
      });
      expect(state.pending.last['base_version'], 0);
      expect(state.snapshot['profile'], {'about': '', 'version': 0});
      final count = state.pending.length;
      await expectLater(
        adapter.store.command('tasks.run'),
        throwsA(isA<Exception>()),
      );
      expect(state.pending, hasLength(count));
      expect(syncs, greaterThanOrEqualTo(3));
      adapter.dispose();
      state.dispose();
    },
  );

  test(
    'ordinary Host task chat targets its own conversation without entering the outbox',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      final identity = await SpaceIdentity.generate();
      final transport = CleanupTransport(CleanupCrypto(identity));
      final controller = SpaceClientController(state, transport);
      final id = await controller.sendChat(
        '继续这个任务',
        conversationId: 'topic:host-task',
      );
      expect(
        (transport.sent.single['input'] as Map)['conversation_id'],
        'topic:host-task',
      );
      expect(state.messages.single['conversation_id'], 'topic:host-task');
      expect(state.messages.single['turn_id'], id);
      expect(state.pending, isEmpty);
      await controller.dispose();
    },
  );
}
