import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'adapters/attempt.dart' as attempt;
import 'adapters/authority.dart' as authority;
import 'adapters/ownership.dart' as ownership;
import 'adapters/todo_sync.dart' as todo_sync;
import 'contract_fixture.dart';

void main() {
  final fixture = loadFixture();
  final cases = loadCases();
  final operations = (fixture['operations'] as Map<String, dynamic>)
      .map((k, v) => MapEntry(k, (v as List<dynamic>).cast<String>()));

  final registry = <String, ContractAdapter>{};
  for (final source in [
    authority.adapters,
    ownership.adapters,
    attempt.adapters,
    todo_sync.adapters,
  ]) {
    for (final entry in source.entries) {
      if (registry.containsKey(entry.key)) {
        throw StateError('duplicate adapter for ${entry.key}');
      }
      registry[entry.key] = entry.value;
    }
  }

  test('fixture is independent, structured and covers every semantic', () {
    expect(fixture['contract_version'], 1);
    final ids = cases.map((c) => c['id'] as String).toList();
    expect(ids.toSet().length, ids.length);
    final semantics = <String>{
      for (final c in cases) ...(c['semantics'] as List<dynamic>).cast<String>(),
    };
    expect(semantics.toList()..sort(),
        ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
    for (final c in cases) {
      final given = c['given'] as Map<String, dynamic>;
      final identity = given['identity'] as Map<String, dynamic>;
      expect(
          given['request_key'],
          jsonEncode([
            identity['principal'],
            identity['device_id'],
            identity['request_id'],
          ]),
          reason: c['id'] as String);
      for (final step in c['when'] as List<dynamic>) {
        final s = step as Map<String, dynamic>;
        final op = s['op'] as String;
        expect(operations.containsKey(op), isTrue, reason: op);
        for (final key in (s['params'] as Map<String, dynamic>).keys) {
          expect(operations[op], contains(key), reason: '$op.$key');
        }
      }
    }
  });

  test('every contract case has a Dart adapter (no pending cases)', () {
    final missing = cases
        .map((c) => c['id'] as String)
        .where((id) => !registry.containsKey(id))
        .toList();
    expect(missing, isEmpty);
  });

  for (final c in cases) {
    final id = c['id'] as String;
    test('$id [device]', () async {
      final adapter = registry[id];
      if (adapter == null) fail('no Dart adapter for $id');
      await adapter(c);
    });
  }
}
