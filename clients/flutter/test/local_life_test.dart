import 'dart:io';
import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/local_life.dart';

void main() {
  test(
    'a different Hub cannot replace data merely by reusing the account name',
    () async {
      final repo = LocalLife(MemoryLifePersistence());
      await repo.open();
      await repo.mutate({'op': 'create', 'kind': 'todo', 'title': 'My todo'});
      final hub = TestHub(Map<String, dynamic>.from(repo.life['todos'][0]));
      await repo.sync(hub);
      hub.identity = 'another-hub';
      hub.row = {...hub.row, 'version': 10, 'title': 'Unrelated'};
      await expectLater(repo.sync(hub), throwsStateError);
      expect(repo.life['todos'][0]['title'], 'My todo');
    },
  );
  test(
    'a queued version choice cannot overwrite a version received while sync was in flight',
    () async {
      final repo = LocalLife(MemoryLifePersistence());
      await repo.open();
      final id = (await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Original',
      }))['id'];
      final hub = TestHub(Map<String, dynamic>.from(repo.life['todos'][0]));
      await repo.sync(hub);
      await repo.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': id,
        'expected_version': 1,
        'title': 'Phone',
      });
      hub.row = {...hub.row, 'version': 2, 'title': 'Desktop'};
      await repo.sync(hub);
      final seen = repo.conflictToken!;
      final blocked = BlockedSnapshot(hub), sync = repo.sync(blocked);
      await blocked.entered.future;
      final choice = repo.resolveConflict(
        useLocal: true,
        expectedConflict: seen,
      );
      final rejected = expectLater(choice, throwsStateError);
      hub.row = {...hub.row, 'version': 3, 'title': 'Unseen'};
      blocked.release.complete();
      await sync;
      await rejected;
      expect(repo.conflict!['synced']['title'], 'Unseen');
      expect(repo.pendingCount, 1);
    },
  );
  test(
    'a local command retry remains idempotent after its outbox entry was acknowledged',
    () async {
      final persistence = MemoryLifePersistence();
      final repo = LocalLife(persistence);
      await repo.open();
      final input = {'op': 'create', 'kind': 'todo', 'title': 'Once'};
      final first = await repo.mutate(input, operationId: 'stable-operation');
      final hub = TestHub(Map<String, dynamic>.from(repo.life['todos'][0]));
      await repo.sync(hub);
      final restored = LocalLife(persistence);
      await restored.open();
      expect(
        await restored.mutate(input, operationId: 'stable-operation'),
        first,
      );
      expect(restored.life['todos'].length, 1);
      expect(restored.pendingCount, 0);
    },
  );
  test(
    'offline edits persist together with outbox and derived goal progress',
    () async {
      final dir = await Directory.systemTemp.createTemp('nova-life-');
      addTearDown(() => dir.delete(recursive: true));
      final file = File('${dir.path}/life.json');
      final repo = LocalLife(FileLifePersistence(file));
      await repo.open();
      final goal = await repo.mutate({
        'op': 'create',
        'kind': 'goal',
        'title': 'Read',
      });
      final todo = await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Chapter',
        'goal_id': goal['id'],
      });
      await repo.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': todo['id'],
        'expected_version': 1,
        'status': 'done',
      });
      final restored = LocalLife(FileLifePersistence(file));
      await restored.open();
      expect(restored.pendingCount, 3);
      expect(restored.life['todos'][0]['status'], 'done');
      expect(restored.life['goals'][0]['progress'], {'done': 1, 'total': 1});
      expect(restored.life['goals'][0]['status'], 'active');
    },
  );

  test(
    'failed durable write does not publish a todo or enqueue its mutation',
    () async {
      final persistence = MemoryLifePersistence();
      final repo = LocalLife(persistence);
      await repo.open();
      persistence.fail = true;
      await expectLater(
        repo.mutate({'op': 'create', 'kind': 'todo', 'title': 'Not durable'}),
        throwsStateError,
      );
      expect(repo.life['todos'], isEmpty);
      expect(repo.pendingCount, 0);
    },
  );

  test(
    'conflicts ask for a choice; selecting synced discards all pending edits for that object',
    () async {
      final persistence = MemoryLifePersistence();
      final repo = LocalLife(persistence);
      await repo.open();
      final id = (await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Original',
      }))['id'];
      final original = Map<String, dynamic>.from(repo.life['todos'][0]);
      final hub = TestHub(original);
      await repo.sync(hub);
      await repo.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': id,
        'expected_version': 1,
        'title': 'Phone',
      });
      await repo.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': id,
        'expected_version': 2,
        'note': 'Later edit',
      });
      hub.row = {...original, 'title': 'Desktop', 'version': 2};
      await repo.sync(hub);
      expect(repo.conflict, isNotNull);
      expect(repo.life['todos'][0]['title'], 'Desktop');
      expect(repo.conflict!['local']['note'], 'Later edit');
      await repo.resolveConflict(
        useLocal: false,
        expectedConflict: repo.conflictToken!,
      );
      expect(repo.pendingCount, 0);
      expect(repo.conflict, isNull);
      expect(repo.life['todos'][0]['title'], 'Desktop');
      expect(persistence.value, isNot(contains('Later edit')));
      expect(persistence.value, isNot(contains('Phone')));
    },
  );

  test(
    'choosing local compares the displayed version again and cannot overwrite an unseen edit',
    () async {
      final repo = LocalLife(MemoryLifePersistence());
      await repo.open();
      final id = (await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Original',
      }))['id'];
      final original = Map<String, dynamic>.from(repo.life['todos'][0]);
      final hub = TestHub(original);
      await repo.sync(hub);
      await repo.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': id,
        'expected_version': 1,
        'title': 'Phone',
      });
      hub.row = {...original, 'title': 'Desktop', 'version': 2};
      await repo.sync(hub);
      await repo.resolveConflict(
        useLocal: true,
        expectedConflict: repo.conflictToken!,
      );
      hub.row = {...original, 'title': 'Unseen', 'version': 3};
      await repo.sync(hub);
      expect(repo.conflict, isNotNull);
      expect(hub.row['title'], 'Unseen');
      await repo.resolveConflict(
        useLocal: true,
        expectedConflict: repo.conflictToken!,
      );
      await repo.sync(hub);
      expect(repo.conflict, isNull);
      expect(hub.row['title'], 'Phone');
      expect(repo.pendingCount, 0);
    },
  );
}

class MemoryLifePersistence implements LifePersistence {
  String? value;
  bool fail = false;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String next) async {
    if (fail) throw StateError('disk failure');
    value = next;
  }
}

// A remote concurrency boundary, not a mocked local repository: accepts exact
// versions and exposes a separately editable canonical record.
class TestHub implements LifeSyncTransport {
  TestHub(this.row);
  Map<String, dynamic> row;
  String identity = 'test-hub';
  @override
  Future<Map<String, dynamic>> snapshot() async => {
    'schema_version': 1,
    'hub_id': identity,
    'account_id': 'alice',
    'cursor': row['version'],
    'state': {
      'todos': [row],
      'ideas': [],
      'goals': [],
      'profile': {'about': '', 'version': 0},
      'receipts': {},
    },
    'tombstones': {},
  };
  @override
  Future<Map<String, dynamic>> push(Map<String, dynamic> command) async {
    final input = command['input'] as Map;
    if (input['op'] == 'update') {
      if (input['expected_version'] != row['version']) {
        throw LifeSyncConflict('version_conflict', await snapshot());
      }
      row = {
        ...row,
        ...Map<String, dynamic>.from(input)..removeWhere(
          (key, _) => ['op', 'kind', 'expected_version'].contains(key),
        ),
        'version': (row['version'] as int) + 1,
      };
    }
    return {
      'snapshot': await snapshot(),
      'result': {'id': row['id'], 'version': row['version']},
    };
  }
}

class BlockedSnapshot implements LifeSyncTransport {
  BlockedSnapshot(this.inner);
  final LifeSyncTransport inner;
  final entered = Completer<void>(), release = Completer<void>();
  @override
  Future<Map<String, dynamic>> snapshot() async {
    entered.complete();
    await release.future;
    return inner.snapshot();
  }

  @override
  Future<Map<String, dynamic>> push(Map<String, dynamic> command) =>
      inner.push(command);
}
