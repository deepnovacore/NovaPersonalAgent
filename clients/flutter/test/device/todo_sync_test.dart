import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/todo_sync.dart';
import 'adapters/todo_sync.dart' as contract;
import 'contract_fixture.dart';

TodoState initial() => TodoState(
  id: 'todo',
  version: 1,
  baseVersion: 1,
  content: 'original',
  conflicts: [],
  tombstones: [],
  projectionVisible: true,
);
TodoState roundtrip(TodoState state) =>
    TodoState.fromJson(jsonDecode(jsonEncode(state)) as Map<String, dynamic>);
final conflict = throwsA(
  isA<TodoSyncError>().having((e) => e.code, 'code', 'version_conflict'),
);
void main() {
  test(
    'merge preserves base, immutability, idempotence and displaced content',
    () {
      final original = initial();
      const incoming = TodoVersion(
        version: 2,
        baseVersion: 1,
        content: 'other',
      );
      final merged = merge(original, incoming);
      expect(original.version, 1);
      expect(merge(merged, incoming).toJson(), merged.toJson());
      final chosen = chooseConflict(merged, 2, 1);
      expect(chosen.version, 3);
      expect(chosen.content, 'original');
      expect(chosen.conflicts.map((c) => c.toJson()), [incoming.toJson()]);
      expect(() => chooseConflict(chosen, 2, 2), conflict);
      expect(() => chooseConflict(chosen, 3, 99), conflict);
    },
  );
  test(
    'older and equal divergent revisions are retained, ambiguous choices reject',
    () {
      var state = merge(
        initial(),
        const TodoVersion(version: 3, baseVersion: 1, content: 'new'),
      );
      state = merge(
        state,
        const TodoVersion(version: 2, baseVersion: 1, content: 'offline'),
      );
      state = merge(
        state,
        const TodoVersion(version: 2, baseVersion: 1, content: 'divergent'),
      );
      expect(state.version, 3);
      expect(state.conflicts.length, 3);
      expect(() => chooseConflict(state, 3, 2), conflict);
    },
  );
  test('permanent deletion survives JSON and blocks newer snapshots', () {
    final state = initial().copyWith(
      tombstones: [
        const Tombstone(entityId: 'todo', version: 2, permanent: true),
      ],
    );
    for (final version in [0, 1, 2, 3]) {
      final result = applySnapshot(
        roundtrip(state),
        TodoSnapshot(version: version, phase: 'running'),
      );
      expect(result.projectionVisible, false);
      expect(result.toJson()['tombstones'], state.toJson()['tombstones']);
      expect(result.version, 1);
    }
    expect(
      applySnapshot(
        initial().copyWith(
          tombstones: [
            const Tombstone(entityId: 'other', version: 2, permanent: true),
          ],
        ),
        const TodoSnapshot(version: 2, phase: 'queued'),
      ).projectionVisible,
      true,
    );
  });
  test('evicted projection stays evicted without deleting content', () {
    final state = evictProjection(initial());
    final restored = applySnapshot(
      roundtrip(state),
      const TodoSnapshot(version: 4, phase: 'running'),
    );
    expect(restored.toJson(), state.toJson());
    expect(restored.content, 'original');
  });
  test('int53 validation and overflow fail without mutation', () {
    for (final version in [
      -1,
      0.5,
      double.nan,
      double.infinity,
      9007199254740992,
    ]) {
      expect(
        () => merge(
          initial(),
          TodoVersion(version: version, baseVersion: 1, content: 'bad'),
        ),
        conflict,
      );
      expect(
        () => applySnapshot(
          initial(),
          TodoSnapshot(version: version, phase: 'queued'),
        ),
        conflict,
      );
    }
    final state = initial().copyWith(version: 9007199254740991);
    expect(() => chooseConflict(state, state.version, state.version), conflict);
    expect(state.content, 'original');
  });
  test('tombstones retain greatest revision, cannot be undone by replay', () {
    const tombstone = Tombstone(entityId: 'todo', version: 2, permanent: true);
    final deleted = applyTombstone(initial(), tombstone);
    expect(deleted.projectionVisible, false);
    expect(
      applyTombstone(
        deleted,
        const Tombstone(entityId: 'todo', version: 1, permanent: true),
      ).toJson(),
      deleted.toJson(),
    );
    expect(applyTombstone(deleted, tombstone).toJson(), deleted.toJson());
    expect(
      applyTombstone(
        deleted,
        const Tombstone(entityId: 'todo', version: 3, permanent: true),
      ).tombstones.single.version,
      3,
    );
    expect(
      merge(
        deleted,
        const TodoVersion(version: 4, baseVersion: 1, content: 'resurrection'),
      ).content,
      'original',
    );
    expect(() => chooseConflict(deleted, 1, 1), conflict);
  });
  test('Dart JSON key order and integral doubles preserve transitions', () {
    final reordered = Map<String, dynamic>.fromEntries(
      initial().toJson().entries.toList().reversed,
    );
    expect(TodoState.fromJson(reordered).toJson(), initial().toJson());
    expect(
      merge(
        initial(),
        const TodoVersion(version: 2.0, baseVersion: 1.0, content: 'next'),
      ).version,
      2,
    );
    final largest = merge(
      initial(),
      const TodoVersion(
        version: 9007199254740991,
        baseVersion: 1,
        content: 'last',
      ),
    );
    expect(largest.version, 9007199254740991);
    expect(roundtrip(largest).toJson(), largest.toJson());
  });
  test('invalid state, base, phase and tombstones reject before mutation', () {
    expect(
      () => merge(
        initial(),
        const TodoVersion(version: 1, baseVersion: 2, content: 'bad'),
      ),
      conflict,
    );
    expect(
      () => merge(
        initial(),
        const TodoVersion(version: 1, baseVersion: 1, content: ''),
      ),
      conflict,
    );
    expect(
      () => applySnapshot(
        initial(),
        const TodoSnapshot(version: 1, phase: 'unknown'),
      ),
      conflict,
    );
    expect(
      () => applyTombstone(
        initial(),
        const Tombstone(entityId: '', version: 1, permanent: true),
      ),
      conflict,
    );
    expect(
      () => applyTombstone(
        initial(),
        const Tombstone(entityId: 'todo', version: 1, permanent: false),
      ),
      conflict,
    );
    final state = initial().copyWith(
      conflicts: [
        const TodoVersion(
          version: 9007199254740991,
          baseVersion: 1,
          content: 'future',
        ),
      ],
    );
    expect(() => chooseConflict(state, 1, 1), conflict);
    expect(state.version, 1);
  });
  for (final c in loadCases().where(
    (c) => contract.adapters.containsKey(c['id']),
  )) {
    test('todo contract ${c['id']}', () => contract.adapters[c['id']]!(c));
  }
}
