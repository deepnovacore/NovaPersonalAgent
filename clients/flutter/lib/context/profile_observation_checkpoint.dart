import 'dart:convert';
import 'package:crypto/crypto.dart';
import '../personal/local_life.dart';
import 'profile_writer.dart';

class ProfileObservationReuse {
  ProfileObservationReuse(this.recordIds, this.facts);
  final Set<String> recordIds;
  final List<Map<String, dynamic>> facts;
}

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
  // The legacy exact-snapshot cache stays untouched during this upgrade.
  static const incrementalStorageKey = 'nova.profile.observations.v2';
  static const algorithm = 'profile-observations-v4-relevance';
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
      if (!now().isBefore(expiresAt)) throw StateError('source_expired');
    } catch (_) {
      await persistence.write('null');
      rethrow;
    }
  }

  Future<bool> _unexpired(Map<String, dynamic> data) async {
    if (now().isBefore(DateTime.parse(data['expires_at'] as String))) {
      return true;
    }
    await persistence.write('null');
    return false;
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
      final cachedExpiry = value is Map && value['expires_at'] is String
          ? DateTime.tryParse(value['expires_at'] as String)
          : null;
      if (value is! Map<String, dynamic> ||
          value['version'] != 1 ||
          value['scope'] != scope ||
          cachedExpiry == null ||
          !now().isBefore(cachedExpiry) ||
          cachedExpiry.isAfter(expiresAt) ||
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
          fact.keys.any(
            (k) => k != 'text' && k != 'refs' && k != 'relevance',
          ) ||
          !profileObservationRelevances.contains(fact['relevance']) ||
          excludedProfileRelevances.contains(fact['relevance']) ||
          fact['text'] is! String ||
          (fact['text'] as String).trim().isEmpty ||
          (fact['text'] as String).length > 400 ||
          fact['refs'] is! List) {
        return null;
      }
      final refs = fact['refs'] as List;
      if (refs.isEmpty ||
          refs.length > ProfileWriter.maxObservationRefs ||
          !refs.every(allowed.contains) ||
          fact['relevance'] == 'repeated_pattern' && refs.toSet().length < 2) {
        return null;
      }
      result.add({
        'text': fact['text'],
        'refs': refs.toSet().toList(),
        'relevance': fact['relevance'],
      });
    }
    return result;
  }

  Future<List<Map<String, dynamic>>?> load(
    List<Map<String, dynamic>> messages,
  ) => _serial(() async {
    await _check();
    final data = await _read(), key = digest(messages);
    await _check();
    if (!await _unexpired(data)) return null;
    final value = (data['batches'] as Map)[key];
    if (value == null) return null;
    final validated = _validated(value, messages);
    if (validated == null) {
      (data['batches'] as Map).remove(key);
      await persistence.write(jsonEncode(data));
      await _check();
      if (!await _unexpired(data)) return null;
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
    final manifests =
        data.putIfAbsent('manifests', () => <String, dynamic>{}) as Map;
    final ids = messages.map((message) => message['evidence_id']).toSet();
    // Replacing an edited batch also removes its old contextual observations.
    for (final key in manifests.keys.toList()) {
      final previous = manifests[key];
      if (previous is! List ||
          previous.any(
            (record) => record is! Map || ids.contains(record['evidence_id']),
          )) {
        manifests.remove(key);
        (data['batches'] as Map).remove(key);
      }
    }
    final key = digest(messages);
    (data['batches'] as Map)[key] = valid;
    manifests[key] = [
      for (final record in messages)
        {'evidence_id': record['evidence_id'], 'digest': digest(record)},
    ];
    final encoded = jsonEncode(data);
    if (utf8.encode(encoded).length > maxBytes) {
      throw StateError('profile_checkpoint_storage_full');
    }
    await _check();
    await persistence.write(encoded);
    // A source revocation during the write must erase the just-written cache.
    await _check();
  });

  /// Reuse only complete original contexts; any edited/deleted member makes
  /// that entire batch eligible for observation again.
  Future<ProfileObservationReuse> loadReusable(
    List<Map<String, dynamic>> messages,
  ) => _serial(() async {
    await _check();
    final data = await _read();
    final current = {
      for (final record in messages) record['evidence_id']: record,
    };
    final manifests = data['manifests'];
    final covered = <String>{}, facts = <Map<String, dynamic>>[];
    var changed = false;
    if (manifests is Map) {
      for (final key in manifests.keys.toList()) {
        final raw = manifests[key];
        final records =
            raw is List && raw.every((item) => item is Map<String, dynamic>)
            ? raw.cast<Map<String, dynamic>>()
            : null;
        final valid =
            records == null ||
                records.any(
                  (record) =>
                      !current.containsKey(record['evidence_id']) ||
                      digest(current[record['evidence_id']]!) !=
                          record['digest'],
                ) ||
                digest([
                      for (final record in records)
                        current[record['evidence_id']],
                    ]) !=
                    key
            ? null
            : _validated((data['batches'] as Map)[key], records);
        if (valid == null) {
          manifests.remove(key);
          (data['batches'] as Map).remove(key);
          changed = true;
          continue;
        }
        covered.addAll(
          records!.map((record) => record['evidence_id'] as String),
        );
        facts.addAll(valid);
      }
    } else if (manifests != null) {
      data.remove('manifests');
      data['batches'] = <String, dynamic>{};
      changed = true;
    }
    await _check();
    if (!await _unexpired(data)) return ProfileObservationReuse({}, []);
    if (changed) {
      await persistence.write(jsonEncode(data));
      await _check();
      if (!await _unexpired(data)) return ProfileObservationReuse({}, []);
    }
    return ProfileObservationReuse(covered, facts);
  });

  Future<void> clear() => invalidate(persistence);
}
