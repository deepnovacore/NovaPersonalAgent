import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'main identity is durable and does not adopt or merge old chats',
    () async {
      final disk = MemoryLifePersistence();
      final store = ConversationStore(disk);
      await store.open();
      final old = await store.create();
      await store.append(old, {'role': 'user', 'content': 'Old history'});
      expect(await Future.wait([store.ensureMain(), store.ensureMain()]), [
        'chat:main',
        'chat:main',
      ]);
      final reopened = ConversationStore(disk);
      await reopened.open();
      expect(await reopened.ensureMain(), 'chat:main');
      expect(reopened.conversations, hasLength(2));
      expect(reopened.conversation(old)['messages'], hasLength(1));
      expect(reopened.conversation('chat:main')['messages'], isEmpty);
    },
  );
  test(
    'todo task creation is serialized and keeps messages when refreshed',
    () async {
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      final todo = <String, dynamic>{
        'id': 'todo-1',
        'version': 1,
        'title': 'Review',
      };
      final ids = await Future.wait([
        store.taskForTodo(todo),
        store.taskForTodo(todo),
      ]);
      expect(ids[0], ids[1]);
      await store.append(ids[0], {'role': 'user', 'content': 'Keep history'});
      expect(
        await store.taskForTodo({...todo, 'version': 2, 'title': 'Revised'}),
        ids[0],
      );
      expect(store.conversation(ids[0])['source_todo']['version'], 1);
      expect(store.conversation(ids[0])['title'], 'Revised');
      expect(store.conversation(ids[0])['messages'], hasLength(1));
      expect(store.conversations, hasLength(1));
    },
  );
}
