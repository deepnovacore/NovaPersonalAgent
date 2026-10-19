import 'dart:convert';
import '../personal/local_life.dart';

/// Stores completed pipeline stages, separately from published results.
/// Callers must revalidate the model contract when reusing a stage.
class ProfilePipelineCheckpoint {
  ProfilePipelineCheckpoint(
    this.persistence, {
    required this.scope,
    required this.expiresAt,
    required this.authorize,
    DateTime Function()? now,
    this.maxBytes = 4 * 1024 * 1024,
  }) : now = now ?? DateTime.now;

  static const storageKey = 'nova.profile.timeline_pipeline.v1';
  static Future<void> _tail = Future.value();
  final LifePersistence persistence;
  final String scope;
  final DateTime expiresAt;
  final Future<void> Function() authorize;
  final DateTime Function() now;
  final int maxBytes;

  static Future<T> _serial<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  static Future<void> invalidate(LifePersistence persistence) =>
      _serial(() => persistence.write('null'));

  Future<void> _check() async {
    try {
      if (!now().isBefore(expiresAt)) throw StateError('source_expired');
      await authorize();
      if (!now().isBefore(expiresAt)) throw StateError('source_expired');
    } catch (_) {
      await persistence.write('null');
      rethrow;
    }
  }

  // Accept JSON itself, not arbitrary objects with a toJson implementation.
  // The depth bound also rejects cycles without overflowing the stack.
  static Object? _copyJson(Object? value, [int depth = 0]) {
    if (depth > 64) throw StateError('invalid_profile_pipeline_checkpoint');
    if (value == null || value is String || value is bool) return value;
    if (value is num && value.isFinite) return value;
    if (value is List) {
      return [for (final item in value) _copyJson(item, depth + 1)];
    }
    if (value is Map && value.keys.every((key) => key is String)) {
      return <String, dynamic>{
        for (final entry in value.entries)
          entry.key as String: _copyJson(entry.value, depth + 1),
      };
    }
    throw StateError('invalid_profile_pipeline_checkpoint');
  }

  Map<String, dynamic> _empty() => {
    'version': 1,
    'scope': scope,
    'expires_at': expiresAt.toUtc().toIso8601String(),
    'entries': <String, dynamic>{},
  };

  Future<Map<String, dynamic>> _read({bool saving = false}) async {
    final raw = await persistence.read();
    if (raw == null || raw == 'null') return _empty();
    if (utf8.encode(raw).length > maxBytes) {
      // Lowering the quota must not erase previously successful stages
      // merely because a new save cannot fit.
      if (saving) throw StateError('profile_checkpoint_storage_full');
      await persistence.write('null');
      return _empty();
    }
    try {
      final value = jsonDecode(raw);
      final expiry = value is Map && value['expires_at'] is String
          ? DateTime.tryParse(value['expires_at'] as String)
          : null;
      if (value is! Map<String, dynamic> ||
          value['version'] != 1 ||
          value['scope'] != scope ||
          expiry == null ||
          !expiry.isAtSameMomentAs(expiresAt) ||
          !now().isBefore(expiry) ||
          value['entries'] is! Map<String, dynamic> ||
          !(value['entries'] as Map).values.every(
            (entry) => entry is Map<String, dynamic>,
          )) {
        throw const FormatException('invalid pipeline checkpoint');
      }
      return _copyJson(value) as Map<String, dynamic>;
    } catch (_) {
      await persistence.write('null');
      return _empty();
    }
  }

  Future<Map<String, dynamic>?> load(String key) => _serial(() async {
    await _check();
    final data = await _read();
    await _check();
    final value = (data['entries'] as Map<String, dynamic>)[key];
    return value == null ? null : _copyJson(value) as Map<String, dynamic>;
  });

  Future<void> save(String key, Map<String, dynamic> value) {
    // Snapshot before joining the queue: a caller may mutate its response
    // while another stage is still writing.
    late final Map<String, dynamic> snapshot;
    try {
      snapshot = _copyJson(value) as Map<String, dynamic>;
      if (utf8.encode(jsonEncode(snapshot)).length > maxBytes) {
        throw StateError('profile_checkpoint_storage_full');
      }
    } catch (error, stack) {
      return Future<void>.error(error, stack);
    }
    return _serial(() async {
      await _check();
      final data = await _read(saving: true);
      await _check();
      (data['entries'] as Map<String, dynamic>)[key] = snapshot;
      final encoded = jsonEncode(data);
      if (utf8.encode(encoded).length > maxBytes) {
        throw StateError('profile_checkpoint_storage_full');
      }
      await _check();
      await persistence.write(encoded);
      // Revocation or expiry while writing erases the just-written response.
      await _check();
    });
  }

  Future<void> clear() => invalidate(persistence);
}
