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

/// Atomic replacement keeps each local state and its idempotency receipts together.
/// The owning store serializes writes; an incomplete temporary file is never
/// treated as an empty store or promoted on restart.
class FileLifePersistence implements LifePersistence {
  FileLifePersistence(this.file);
  final File file;
  final String _pendingId = requestId();
  static final _inFlightPending = <String>{};
  String get _pendingPath => '${file.path}.$_pendingId.pending';

  /// Identify the directory entry, not its spelling or the current file inode
  /// (atomic rename replaces that inode). Missing parents inherit the identity
  /// of their deepest existing ancestor. Ownership and pending cleanup must use
  /// this same rule, including before the first write creates the directory.
  static Future<String> canonicalIdentity(File file) async {
    var ancestor = file.absolute.parent;
    final remaining = <String>[file.uri.pathSegments.last];
    while (await FileSystemEntity.type(ancestor.path) ==
        FileSystemEntityType.notFound) {
      remaining.insert(
        0,
        ancestor.uri.pathSegments.where((s) => s.isNotEmpty).last,
      );
      final parent = ancestor.parent;
      if (parent.path == ancestor.path) {
        throw const FileSystemException('missing_storage_ancestor');
      }
      ancestor = parent;
    }
    final resolved = Directory(await ancestor.resolveSymbolicLinks());
    final identity = File(
      [resolved.path, ...remaining].join(Platform.pathSeparator),
    ).absolute.uri.normalizePath().toFilePath();
    return await _caseInsensitive(resolved) ? identity.toLowerCase() : identity;
  }

  static Future<bool> _caseInsensitive(Directory directory) async {
    var probe = directory;
    while (probe.parent.path != probe.path) {
      final name = probe.uri.pathSegments.where((s) => s.isNotEmpty).last;
      final alternate = name.replaceFirstMapped(
        RegExp('[a-zA-Z]'),
        (m) => m[0] == m[0]!.toLowerCase()
            ? m[0]!.toUpperCase()
            : m[0]!.toLowerCase(),
      );
      if (alternate != name) {
        final alias = '${probe.parent.path}/$alternate';
        try {
          final type = await FileSystemEntity.type(alias, followLinks: false);
          if (type == FileSystemEntityType.notFound) {
            return false; // An existing name has no case alias: proven sensitive.
          }
          if (type == FileSystemEntityType.link) break; // Not a case probe.
          return await FileSystemEntity.identical(probe.path, alias);
        } on FileSystemException {
          break; // Cannot probe: fail conservatively on Apple volumes.
        }
      }
      probe = probe.parent;
    }
    return Platform.isIOS || Platform.isMacOS;
  }

  @override
  Future<String?> read() async =>
      await file.exists() ? file.readAsString() : null;
  @override
  Future<void> write(String value) async {
    final temporary = File(_pendingPath);
    final pendingKey = await canonicalIdentity(temporary);
    _inFlightPending.add(pendingKey);
    try {
      await file.parent.create(recursive: true);
      await temporary.writeAsString(value, flush: true);
      await replacePending(temporary);
    } catch (_) {
      try {
        await temporary.delete();
      } catch (_) {
        // Preserve the write failure; abandoned files are purged on recovery.
      }
      rethrow;
    } finally {
      _inFlightPending.remove(pendingKey);
    }
  }

  @protected
  Future<void> replacePending(File temporary) async {
    await temporary.rename(file.path);
  }

  /// Call only as the sole live ledger owner, inside its idle write queue.
  /// Never follow links or delete any registered in-process pending write.
  Future<void> purgeAbandonedPendingFiles() async {
    if (_inFlightPending.contains(
      await canonicalIdentity(File(_pendingPath)),
    )) {
      return;
    }
    final name = file.uri.pathSegments.last;
    final pattern = RegExp(
      '^${RegExp.escape(name)}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-'
      '[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.pending\$',
    );
    if (!await file.parent.exists()) return;
    await for (final entity in file.parent.list(followLinks: false)) {
      if (entity is File &&
          pattern.hasMatch(entity.uri.pathSegments.last) &&
          !_inFlightPending.contains(await canonicalIdentity(entity))) {
        await entity.delete();
      }
    }
  }
}

/// The sole local writer in an independent Space. Client intent queues live in
/// space/client_state.dart and never share this mutable dataset.
final class LocalLife extends ChangeNotifier {
  LocalLife(this.persistence);
  final LifePersistence persistence;
  Map<String, dynamic> _data = {
    'schema_version': 2,
    'state': emptyLife(),
    'receipts': <String, dynamic>{},
  };
  Future<void> _tail = Future.value();
  bool ready = false, _disposed = false;
  int revision = 0;
  Map<String, dynamic> get life =>
      projectLife(Map<String, dynamic>.from(_data['state']));
  Future<T> _serial<T>(Future<T> Function() work) {
    final result = _tail.then((_) {
      if (_disposed) throw StateError('local_store_disposed');
      return work();
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<void> open() => _serial(() async {
    if (ready) return;
    final raw = await persistence.read();
    if (raw != null) {
      final parsed = jsonDecode(raw) as Map<String, dynamic>;
      if (parsed['schema_version'] != 2 ||
          parsed['state'] is! Map ||
          parsed['receipts'] is! Map) {
        throw const FormatException('unsupported_local_store');
      }
      _data = parsed;
    }
    ready = true;
    _notify();
  });
  void _notify() {
    revision++;
    if (!_disposed) notifyListeners();
  }

  Future<Map<String, dynamic>> mutate(
    Map<String, dynamic> input, {
    String? operationId,
  }) => _serial(() async {
    if (!ready) throw StateError('local_store_not_ready');
    final next = copyJson(_data),
        id = operationId ?? requestId(),
        receipt = next['receipts'][id];
    if (receipt != null) {
      if (receipt['hash'] != lifeFingerprint(input)) {
        throw StateError('op_id_conflict');
      }
      return Map<String, dynamic>.from(receipt['result']);
    }
    final reduced = reduceLife(
      Map<String, dynamic>.from(next['state']),
      input,
      id,
    );
    next['state'] = reduced.state;
    next['receipts'][id] = {
      'hash': lifeFingerprint(input),
      'result': reduced.result,
    };
    await persistence.write(jsonEncode(next));
    _data = next;
    _notify();
    return reduced.result;
  });
  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
