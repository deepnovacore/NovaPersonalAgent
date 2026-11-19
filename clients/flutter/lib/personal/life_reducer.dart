import 'dart:convert';
import 'package:crypto/crypto.dart';

Map<String, dynamic> copyJson(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
Map<String, dynamic> emptyLife() => {
  'todos': <dynamic>[],
  'ideas': <dynamic>[],
  'goals': <dynamic>[],
  'profile': {'about': '', 'version': 0},
  'receipts': {},
};
String lifeId(String opId) => sha256.convert(utf8.encode(opId)).toString();
String lifeFingerprint(Object? value) {
  Object? sorted(Object? item) {
    if (item is Map) {
      return {
        for (final key in item.keys.cast<String>().toList()..sort())
          key: sorted(item[key]),
      };
    }
    if (item is List) return item.map(sorted).toList();
    return item;
  }

  return sha256.convert(utf8.encode(jsonEncode(sorted(value)))).toString();
}

String lifeCollection(String kind) => switch (kind) {
  'todo' => 'todos',
  'idea' => 'ideas',
  'goal' => 'goals',
  _ => throw StateError('invalid_kind'),
};
Map<String, dynamic>? lifeRow(Map<String, dynamic> state, String id) {
  if (id == 'profile') return Map<String, dynamic>.from(state['profile']);
  for (final key in ['todos', 'ideas', 'goals']) {
    for (final row in state[key] as List) {
      if (row['id'] == id) return Map<String, dynamic>.from(row);
    }
  }
  return null;
}

/// Local optimistic semantics for the explicit Life commands supported on mobile.
/// Independent Spaces apply these domain mutations to their local state.
({Map<String, dynamic> state, Map<String, dynamic> result}) reduceLife(
  Map<String, dynamic> state,
  Map<String, dynamic> input,
  String opId,
) {
  final next = copyJson(state),
      p = Map<String, dynamic>.from(input),
      op = p['op'];
  final allowed = switch (op) {
    'create' => [
      'op',
      'kind',
      'title',
      'note',
      'importance',
      'goal_id',
      'due',
      'success_criteria',
    ],
    'update' => [
      'op',
      'kind',
      'id',
      'expected_version',
      'title',
      'note',
      'importance',
      'status',
      'goal_id',
      'due',
      'success_criteria',
    ],
    'convert' => ['op', 'id', 'target', 'expected_version'],
    'undo_create' => ['op', 'id', 'expected_version'],
    'profile' => ['op', 'about', 'expected_version'],
    _ => throw StateError('unsupported_local_operation'),
  };
  if (p.keys.any((key) => !allowed.contains(key))) {
    throw StateError('invalid_field');
  }
  void text(String key, int max, {bool required = false, bool trim = false}) {
    if (!p.containsKey(key) && !required) return;
    if (p[key] is! String) throw StateError('invalid_$key');
    final value = trim ? (p[key] as String).trim() : p[key] as String;
    if (value.length > max || (required && value.isEmpty)) {
      throw StateError('invalid_$key');
    }
    p[key] = value;
  }

  text(
    'title',
    200,
    required: op == 'create' || p.containsKey('title'),
    trim: true,
  );
  text('note', 4000);
  text('success_criteria', 2000);
  text('about', 5000);
  if (p.containsKey('importance') &&
      !['normal', 'high'].contains(p['importance'])) {
    throw StateError('invalid_importance');
  }
  if (p['due'] != null) {
    final due = p['due'];
    if (due is! String || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(due)) {
      throw StateError('invalid_due');
    }
    final parsed = DateTime.tryParse(due);
    if (parsed == null || parsed.toIso8601String().substring(0, 10) != due) {
      throw StateError('invalid_due');
    }
  }
  final kind = p['kind'] as String?;
  if (kind != null) {
    lifeCollection(kind);
    if (kind != 'todo' && p['due'] != null) {
      throw StateError('due_only_for_todo');
    }
    if (kind != 'goal' &&
        p['success_criteria'] != null &&
        p['success_criteria'] != '') {
      throw StateError('criteria_only_for_goal');
    }
    if (kind == 'goal' && p['goal_id'] != null) {
      throw StateError('goal_cannot_parent');
    }
    if (p['goal_id'] != null) {
      final previous = op == 'update'
          ? (lifeRow(next, p['id'] as String)?['goal_id'])
          : null;
      if (!(next['goals'] as List).any(
        (g) =>
            g['id'] == p['goal_id'] &&
            (g['status'] != 'archived' || previous == p['goal_id']),
      )) {
        throw StateError('goal_not_found');
      }
    }
  }
  final now = DateTime.now().toUtc().toIso8601String();
  Map<String, dynamic> base(String title, String note) => {
    'id': lifeId(opId),
    'version': 1,
    'title': title,
    'note': note,
    'created_at': now,
    'updated_at': now,
    if (p['importance'] != null) 'importance': p['importance'],
  };
  Map<String, dynamic> result;
  if (op == 'profile') {
    if (p['about'] is! String) throw StateError('invalid_about');
    if (next['profile']['version'] != p['expected_version']) {
      throw StateError('version_conflict');
    }
    next['profile'] = {
      'about': p['about'],
      'version': (p['expected_version'] as int) + 1,
    };
    result = {'id': 'profile', 'version': next['profile']['version']};
  } else if (op == 'create') {
    final row = base(p['title'], p['note'] ?? '');
    row.addAll(switch (kind) {
      'todo' => {
        'status': 'open',
        'due': p['due'],
        'goal_id': p['goal_id'],
        'idea_id': null,
      },
      'idea' => {'status': 'active', 'goal_id': p['goal_id']},
      _ => {
        'status': 'active',
        'success_criteria': p['success_criteria'] ?? '',
        'idea_id': null,
      },
    });
    (next[lifeCollection(kind!)] as List).add(row);
    result = row;
  } else if (op == 'convert') {
    final target = p['target'];
    if (!['todo', 'goal'].contains(target)) throw StateError('invalid_target');
    final idea = (next['ideas'] as List)
        .where((r) => r['id'] == p['id'])
        .firstOrNull;
    if (idea == null) throw StateError('idea_not_found');
    final rows = next[lifeCollection(target)] as List;
    final existing = rows
        .where(
          (r) =>
              r['idea_id'] == p['id'] ||
              (idea['news_source'] != null &&
                  r['news_source']?['article_id'] ==
                      idea['news_source']['article_id']),
        )
        .firstOrNull;
    if (existing != null) {
      result = Map<String, dynamic>.from(existing);
    } else {
      if (idea['version'] != p['expected_version']) {
        throw StateError('version_conflict');
      }
      if (idea['status'] == 'archived') throw StateError('idea_archived');
      final row = base(idea['title'], idea['note']);
      for (final key in ['provenance_refs', 'sources', 'news_source']) {
        if (idea[key] != null) row[key] = idea[key];
      }
      row.addAll(
        target == 'todo'
            ? {
                'status': 'open',
                'due': null,
                'goal_id': idea['goal_id'],
                'idea_id': idea['id'],
              }
            : {
                'status': 'active',
                'success_criteria': '',
                'idea_id': idea['id'],
              },
      );
      rows.add(row);
      result = row;
    }
  } else {
    final rows =
        next[op == 'undo_create' ? 'todos' : lifeCollection(kind!)] as List;
    final row = rows.where((r) => r['id'] == p['id']).firstOrNull;
    if (row == null) throw StateError('item_not_found');
    if (row['version'] != p['expected_version']) {
      throw StateError('version_conflict');
    }
    if (op == 'undo_create') {
      if (p['expected_version'] != 1) throw StateError('version_conflict');
      rows.remove(row);
      result = Map<String, dynamic>.from(row);
    } else {
      final states = kind == 'todo'
          ? ['open', 'doing', 'waiting', 'done', 'cancelled']
          : kind == 'idea'
          ? ['active', 'archived']
          : ['active', 'paused', 'completed', 'archived'];
      if (p.containsKey('status') && !states.contains(p['status'])) {
        throw StateError('invalid_status');
      }
      if (kind != 'todo' && p.containsKey('due') ||
          kind != 'goal' && p.containsKey('success_criteria') ||
          kind == 'goal' && p.containsKey('goal_id')) {
        throw StateError('invalid_field');
      }
      row.addAll(
        Map<String, dynamic>.from(p)..removeWhere(
          (key, _) => ['op', 'kind', 'id', 'expected_version'].contains(key),
        ),
      );
      row['version'] = (row['version'] as int) + 1;
      row['updated_at'] = now;
      result = Map<String, dynamic>.from(row);
    }
  }
  if ((next['todos'] as List).length > 1000 ||
      (next['ideas'] as List).length > 1000 ||
      (next['goals'] as List).length > 200) {
    throw StateError('store_capacity');
  }
  return (
    state: next,
    result: {'id': result['id'], 'version': result['version']},
  );
}

Map<String, dynamic> projectLife(Map<String, dynamic> state) {
  final result = copyJson(state);
  for (final kind in ['todo', 'idea', 'goal']) {
    for (final row in result[lifeCollection(kind)] as List) {
      row['kind'] = kind;
      if (kind == 'goal') {
        final todos = (result['todos'] as List).where(
          (t) => t['goal_id'] == row['id'] && t['status'] != 'cancelled',
        );
        row['progress'] = {
          'done': todos.where((t) => t['status'] == 'done').length,
          'total': todos.length,
        };
      }
    }
  }
  return result;
}
