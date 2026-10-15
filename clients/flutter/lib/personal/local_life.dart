import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import '../protocol/request_id.dart';
import 'life_reducer.dart';

abstract interface class LifePersistence {
  Future<String?> read();
  Future<void> write(String value);
}

/// Atomic replacement: the visible state and its outgoing journal are one file.
/// No writer other than LocalLife owns this file; an incomplete temporary file is
/// never treated as an empty store or promoted on restart.
final class FileLifePersistence implements LifePersistence {
  FileLifePersistence(this.file);
  final File file;
  @override
  Future<String?> read() async =>
      await file.exists() ? file.readAsString() : null;
  @override
  Future<void> write(String value) async {
    await file.parent.create(recursive: true);
    final temporary = File('${file.path}.pending');
    await temporary.writeAsString(value, flush: true);
    await temporary.rename(file.path);
  }
}

abstract interface class LifeSyncTransport {
  Future<Map<String, dynamic>> snapshot();
  Future<Map<String, dynamic>> push(Map<String, dynamic> command);
}

final class LifeSyncConflict implements Exception {
  LifeSyncConflict(this.code, this.snapshot);
  final String code;
  final Map<String, dynamic> snapshot;
}

final class LocalLife extends ChangeNotifier {
  LocalLife(this.persistence);
  final LifePersistence persistence;
  Map<String, dynamic> _data = {
    'schema_version': 1,
    'account_id': null,
    'hub_id': null,
    'cursor': 0,
    'base': emptyLife(),
    'view': emptyLife(),
    'pending': <dynamic>[],
    'conflict': null,
    'receipts': <String, dynamic>{},
  };
  Future<void> _tail = Future.value();
  bool ready = false, _disposed = false;
  int revision = 0;
  Map<String, dynamic> get life =>
      projectLife(Map<String, dynamic>.from(_data['view']));
  int get pendingCount => (_data['pending'] as List).length;
  String? get accountId => _data['account_id'] as String?;
  String? get hubId => _data['hub_id'] as String?;

  /// Validate a candidate connection before persisting credentials or uploading.
  void validateSnapshot(Map<String, dynamic> snapshot) =>
      _acceptSnapshot(copyJson(_data), snapshot);
  String? get conflictToken =>
      _data['conflict'] == null ? null : lifeFingerprint(_data['conflict']);
  Map<String, dynamic>? get conflict => _data['conflict'] == null
      ? null
      : copyJson(Map<String, dynamic>.from(_data['conflict']));
  Future<T> _serial<T>(Future<T> Function() run) {
    final future = _tail.then((_) => run());
    _tail = future.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return future;
  }

  Future<void> open() => _serial(() async {
    final raw = await persistence.read();
    if (raw != null) {
      final parsed = jsonDecode(raw) as Map<String, dynamic>;
      if (parsed['schema_version'] != 1 ||
          parsed['pending'] is! List ||
          parsed['base'] is! Map ||
          parsed['view'] is! Map) {
        throw const FormatException('unsupported_local_store');
      }
      _data = parsed;
      _data.putIfAbsent('receipts', () => <String, dynamic>{});
      for (final receipt in (_data['receipts'] as Map).values) {
        if (receipt['input'] != null) {
          receipt['hash'] = lifeFingerprint(receipt['input']);
          receipt.remove('input');
        }
      }
    }
    ready = true;
    _notify();
  });
  void _notify() {
    revision++;
    if (!_disposed) notifyListeners();
  }

  Future<void> _commit(Map<String, dynamic> next) async {
    await persistence.write(jsonEncode(next));
    _data = next;
    _notify();
  }

  Future<Map<String, dynamic>> mutate(
    Map<String, dynamic> input, {
    String? operationId,
  }) => _serial(() async {
    if (!ready) throw StateError('local_store_not_ready');
    if (conflict != null) {
      throw StateError('Choose a version before making more changes.');
    }
    final next = copyJson(_data), id = operationId ?? requestId();
    final receipt = next['receipts'][id];
    if (receipt != null) {
      if (receipt['hash'] != lifeFingerprint(input)) {
        throw StateError('op_id_conflict');
      }
      if (receipt['discarded'] == true) throw StateError('operation_discarded');
      return Map<String, dynamic>.from(receipt['result']);
    }
    final prior = (next['pending'] as List)
        .where((p) => p['op_id'] == id)
        .firstOrNull;
    if (prior != null) {
      if (jsonEncode(prior['input']) != jsonEncode(input)) {
        throw StateError('op_id_conflict');
      }
      return Map<String, dynamic>.from(prior['result']);
    }
    final reduced = reduceLife(
      Map<String, dynamic>.from(next['view']),
      input,
      id,
    );
    final entity = input['op'] == 'convert'
        ? reduced.result['id']
        : input['id'] ?? reduced.result['id'];
    (next['pending'] as List).add({
      'op_id': id,
      'input': copyJson(input),
      'result': reduced.result,
      'entity_id': entity,
      'local': lifeRow(reduced.state, entity),
    });
    next['view'] = reduced.state;
    next['receipts'][id] = {
      'hash': lifeFingerprint(input),
      'result': reduced.result,
    };
    await _commit(next);
    return reduced.result;
  });
  void _acceptSnapshot(
    Map<String, dynamic> next,
    Map<String, dynamic> snapshot,
  ) {
    if (snapshot['schema_version'] != 1 ||
        snapshot['hub_id'] is! String ||
        snapshot['account_id'] is! String ||
        snapshot['state'] is! Map ||
        snapshot['cursor'] is! int) {
      throw const FormatException('invalid_hub_snapshot');
    }
    if (next['account_id'] != null &&
        next['account_id'] != snapshot['account_id']) {
      throw StateError('account_mismatch');
    }
    if (next['hub_id'] != null && next['hub_id'] != snapshot['hub_id']) {
      throw StateError('hub_identity_changed');
    }
    if (next['account_id'] != null &&
        (snapshot['cursor'] as int) < (next['cursor'] as int)) {
      throw StateError('hub_history_reset');
    }
    next['account_id'] = snapshot['account_id'];
    next['hub_id'] = snapshot['hub_id'];
    next['cursor'] = snapshot['cursor'];
    next['base'] = copyJson(Map<String, dynamic>.from(snapshot['state']));
  }

  void _project(Map<String, dynamic> next) {
    var view = copyJson(Map<String, dynamic>.from(next['base']));
    final blocked = next['conflict']?['entity_id'];
    for (final pending in next['pending'] as List) {
      if (pending['entity_id'] == blocked) continue;
      try {
        view = reduceLife(
          view,
          Map<String, dynamic>.from(pending['input']),
          pending['op_id'],
        ).state;
      } on StateError {
        /* Canonical stays effective until this mutation is reconciled. */
      }
    }
    next['view'] = view;
  }

  Future<void> sync(LifeSyncTransport transport) => _serial(() async {
    if (!ready) throw StateError('local_store_not_ready');
    // Authenticate/account-check before sending any local data to a new endpoint.
    final remote = await transport.snapshot();
    final checked = copyJson(_data);
    _acceptSnapshot(checked, remote);
    if (conflict != null) {
      final old = Map<String, dynamic>.from(checked['conflict']);
      old['synced'] = lifeRow(
        Map<String, dynamic>.from(checked['base']),
        old['entity_id'],
      );
      checked['conflict'] = old;
      _project(checked);
      await _commit(checked);
      return;
    }
    if (pendingCount == 0) {
      _project(checked);
      await _commit(checked);
      return;
    }
    // Persist account binding even when the first acknowledgement is lost.
    if (accountId == null) {
      final bound = copyJson(_data);
      bound['account_id'] = remote['account_id'];
      bound['hub_id'] = remote['hub_id'];
      await _commit(bound);
    }
    while (pendingCount > 0) {
      final head = Map<String, dynamic>.from((_data['pending'] as List).first);
      try {
        final reply = await transport.push({
          'op_id': head['op_id'],
          'input': head['input'],
        });
        final next = copyJson(_data);
        _acceptSnapshot(next, Map<String, dynamic>.from(reply['snapshot']));
        (next['pending'] as List).removeAt(0);
        if (next['receipts'][head['op_id']] != null) {
          next['receipts'][head['op_id']]['result'] = reply['result'];
        }
        final oldId = head['result']['id'], newId = reply['result']['id'];
        if (oldId != newId) {
          for (final p in next['pending'] as List) {
            for (final field in ['id', 'goal_id', 'idea_id']) {
              if (p['input'][field] == oldId) p['input'][field] = newId;
            }
            if (p['entity_id'] == oldId) {
              p['entity_id'] = newId;
              p['local']?['id'] = newId;
            }
            for (final field in ['id', 'goal_id', 'idea_id']) {
              if (p['local']?[field] == oldId) p['local'][field] = newId;
            }
          }
        }
        _project(next);
        await _commit(next);
      } on LifeSyncConflict catch (error) {
        final next = copyJson(_data);
        _acceptSnapshot(next, error.snapshot);
        final same = (next['pending'] as List).where(
          (p) => p['entity_id'] == head['entity_id'],
        );
        next['conflict'] = {
          'entity_id': head['entity_id'],
          'code': error.code,
          'input': head['input'],
          'local': same.last['local'],
          'synced': lifeRow(
            Map<String, dynamic>.from(next['base']),
            head['entity_id'],
          ),
        };
        _project(next);
        await _commit(next);
        return;
      }
    }
  });
  Future<void> resolveConflict({
    required bool useLocal,
    required String expectedConflict,
    bool unlinkGoal = false,
  }) => _serial(() async {
    if (conflictToken != expectedConflict) throw StateError('conflict_changed');
    final current = conflict;
    if (current == null) return;
    final next = copyJson(_data), entity = current['entity_id'];
    final input = Map<String, dynamic>.from(current['input']),
        synced = current['synced'],
        local = current['local'];
    Map<String, dynamic>? replacement;
    if (useLocal) {
      final independentCreate =
          unlinkGoal &&
          current['code'] == 'goal_not_found' &&
          input['op'] == 'create' &&
          ['todo', 'idea'].contains(input['kind']);
      if ((!independentCreate && synced == null) ||
          local == null ||
          (!independentCreate &&
              !['update', 'profile'].contains(input['op']))) {
        throw StateError(
          'This operation needs a new explicit edit; it cannot restore deleted data.',
        );
      }
      replacement = {
        'op': input['op'],
        if (!independentCreate) 'expected_version': synced['version'],
      };
      if (input['op'] == 'profile') {
        replacement['about'] = local['about'];
      } else {
        replacement.addAll({
          'kind': input['kind'],
          if (!independentCreate) 'id': entity,
        });
        final fields = [
          'title',
          'note',
          if (!independentCreate) 'status',
          'importance',
          if (input['kind'] != 'goal') 'goal_id',
          if (input['kind'] == 'todo') 'due',
          if (input['kind'] == 'goal') 'success_criteria',
        ];
        for (final field in fields) {
          if (local.containsKey(field)) replacement[field] = local[field];
        }
        replacement['importance'] = local['importance'] ?? 'normal';
        if (unlinkGoal) {
          if (!['todo', 'idea'].contains(input['kind']) ||
              current['code'] != 'goal_not_found') {
            throw StateError('invalid_relation_choice');
          }
          replacement['goal_id'] = null;
        }
      }
      // Validate the chosen whole editable version against current relationships.
      reduceLife(
        Map<String, dynamic>.from(next['base']),
        replacement,
        requestId(),
      );
    }
    for (final p in next['pending'] as List) {
      if (p['entity_id'] == entity && next['receipts'][p['op_id']] != null) {
        next['receipts'][p['op_id']]['discarded'] = true;
      }
    }
    (next['pending'] as List).removeWhere((p) => p['entity_id'] == entity);
    next['conflict'] = null;
    if (replacement != null) {
      final id = requestId(),
          r = reduceLife(
            Map<String, dynamic>.from(next['base']),
            replacement,
            id,
          );
      (next['pending'] as List).insert(0, {
        'op_id': id,
        'input': replacement,
        'result': r.result,
        'entity_id': r.result['id'],
        'local': lifeRow(r.state, r.result['id']),
      });
      if (replacement['op'] == 'create') {
        final created = lifeRow(r.state, r.result['id'])!;
        if (created['status'] != local['status']) {
          final updateId = requestId();
          final update = {
            'op': 'update',
            'kind': replacement['kind'],
            'id': r.result['id'],
            'expected_version': 1,
            'status': local['status'],
          };
          final changed = reduceLife(r.state, update, updateId);
          (next['pending'] as List).insert(1, {
            'op_id': updateId,
            'input': update,
            'result': changed.result,
            'entity_id': r.result['id'],
            'local': lifeRow(changed.state, r.result['id']),
          });
        }
      }
    }
    _project(next);
    await _commit(next);
  });
  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
