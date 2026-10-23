import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/local_life.dart';

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

void main() {
  test('standalone mutations persist once without a network outbox', () async {
    final disk = MemoryLifePersistence();
    final repo = LocalLife(disk);
    await repo.open();
    final input = {'op': 'create', 'kind': 'todo', 'title': 'Local'};
    final first = await repo.mutate(input, operationId: 'stable');
    final saved = jsonDecode(disk.value!) as Map;
    expect(saved.containsKey('pending'), false);
    final reopened = LocalLife(disk);
    await reopened.open();
    expect(await reopened.mutate(input, operationId: 'stable'), first);
    expect(reopened.life['todos'], hasLength(1));
    await expectLater(
      reopened.mutate({...input, 'title': 'Different'}, operationId: 'stable'),
      throwsStateError,
    );
    expect(reopened.life['todos'].single['title'], 'Local');
    repo.dispose();
    reopened.dispose();
  });
  test(
    'failed local writes leave the visible version unchanged and remain retryable',
    () async {
      final disk = MemoryLifePersistence();
      final repo = LocalLife(disk);
      await repo.open();
      disk.fail = true;
      final input = {'op': 'create', 'kind': 'goal', 'title': 'Local goal'};
      await expectLater(
        repo.mutate(input, operationId: 'retry'),
        throwsStateError,
      );
      expect(repo.life['goals'], isEmpty);
      disk.fail = false;
      await repo.mutate(input, operationId: 'retry');
      expect(repo.life['goals'], hasLength(1));
      repo.dispose();
      await expectLater(
        repo.mutate(input, operationId: 'late'),
        throwsStateError,
      );
    },
  );
}
