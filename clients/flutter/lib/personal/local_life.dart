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
