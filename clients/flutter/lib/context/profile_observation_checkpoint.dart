import 'dart:convert';
import 'package:crypto/crypto.dart';
import '../personal/local_life.dart';
import 'profile_writer.dart';

/// Only fully validated observations persist, separate from published profiles.
/// All operations and invalidation share one queue across instances.
class ProfileObservationCheckpoint {
  ProfileObservationCheckpoint(
    this.persistence, {
    required this.scope,
    required this.expiresAt,
    required this.authorize,
    DateTime Function()? now,
    this.maxBytes = 2 * 1024 * 1024,
  }) : now = now ?? DateTime.now;
  static const storageKey = 'nova.profile.observations.v1';
  static const algorithm = 'profile-observations-v2-refs24';
  static Future<void> _tail = Future.value();
  final LifePersistence persistence;
  final String scope;
  final DateTime expiresAt;
  final Future<void> Function() authorize;
  final DateTime Function() now;
  final int maxBytes;
  static String digest(Object value) =>
      sha256.convert(utf8.encode(jsonEncode(value))).toString();

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
    } catch (_) {
      await persistence.write('null');
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _read() async {
    final empty = <String, dynamic>{
      'version': 1,
      'scope': scope,
      'expires_at': expiresAt.toUtc().toIso8601String(),
      'batches': <String, dynamic>{},
    };
    final raw = await persistence.read();
    if (raw == null || raw == 'null') return empty;
    try {
      if (utf8.encode(raw).length > maxBytes) {
        throw const FormatException('size');
      }
      final value = jsonDecode(raw);
      if (value is! Map<String, dynamic> ||
          value['version'] != 1 ||
          value['scope'] != scope ||
          value['expires_at'] != empty['expires_at'] ||
          value['batches'] is! Map<String, dynamic>) {
        throw const FormatException('scope');
      }
      return value;
    } catch (_) {
      await persistence.write('null');
      return empty;
    }
  }

  static List<Map<String, dynamic>>? _validated(
    Object? value,
    List<Map<String, dynamic>> messages,
  ) {
    final allowed = messages.map((m) => m['evidence_id']).toSet();
    if (value is! List || value.length > 24) return null;
    final result = <Map<String, dynamic>>[];
    for (final fact in value) {
      if (fact is! Map ||
          fact.keys.any((k) => k != 'text' && k != 'refs') ||
          fact['text'] is! String ||
          (fact['text'] as String).trim().isEmpty ||
          (fact['text'] as String).length > 400 ||
          fact['refs'] is! List) {
        return null;
      }
      final refs = fact['refs'] as List;
      if (refs.isEmpty ||
          refs.length > ProfileWriter.maxObservationRefs ||
          !refs.every(allowed.contains)) {
        return null;
      }
      result.add({'text': fact['text'], 'refs': refs.toSet().toList()});
    }
    return result;
  }

  Future<List<Map<String, dynamic>>?> load(
    List<Map<String, dynamic>> messages,
  ) => _serial(() async {
    await _check();
    final data = await _read(), key = digest(messages);
    await _check();
    final value = (data['batches'] as Map)[key];
    if (value == null) return null;
    final validated = _validated(value, messages);
    if (validated == null) {
      (data['batches'] as Map).remove(key);
      await persistence.write(jsonEncode(data));
      await _check();
    }
    return validated;
  });

  Future<void> save(
    List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>> facts,
  ) => _serial(() async {
    await _check();
    final valid = _validated(facts, messages);
    if (valid == null) throw StateError('invalid_profile_observations');
    final data = await _read();
    (data['batches'] as Map)[digest(messages)] = valid;
    final encoded = jsonEncode(data);
    if (utf8.encode(encoded).length > maxBytes) {
      throw StateError('profile_checkpoint_storage_full');
    }
    await _check();
    await persistence.write(encoded);
    // A source revocation during the write must erase the just-written cache.
    await _check();
  });

  Future<void> clear() => invalidate(persistence);
}
