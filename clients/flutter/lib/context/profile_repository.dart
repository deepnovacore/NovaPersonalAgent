import 'dart:convert';
import '../device/space_authority.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';
import 'source_store.dart';
import 'profile_corrections.dart';

/// Structured, content-free feedback for model output contract violations.
class ProfileValidationFailure extends StateError {
  ProfileValidationFailure(super.message, this.detail);
  final Map<String, dynamic> detail;
}

String? profileRepairReason(Object error) {
  if (error is FormatException) return 'invalid_projection';
  const correctable = {
    'invalid_projection',
    'ungrounded_projection',
    'invalid_projection_kind',
    'invalid_profile_category',
    'profile_requires_self_evidence',
    'timeline_time_not_grounded',
    'invalid_profile_time',
    'unread_context',
    'missing_timeline',
  };
  return error is StateError && correctable.contains(error.message)
      ? error.message
      : null;
}

/// Shared pre-write validation for the writer and persisted projection.
void validateProfileEntries(dynamic entries, Map<dynamic, dynamic> originals) {
  final evidence = originals.keys.toSet();
  if (entries is! List || entries.isEmpty || entries.length > 100) {
    throw StateError('invalid_projection');
  }
  final keys = <String>{};
  for (var index = 0; index < entries.length; index++) {
    final item = entries[index];
    if (item is! Map ||
        item.keys.toSet().difference({
          'key',
          'text',
          'evidence_ids',
          'kind',
          'observed_at',
        }).isNotEmpty ||
        item['key'] is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{1,100}$').hasMatch(item['key']) ||
        !keys.add(item['key']) ||
        item['text'] is! String ||
        (item['text'] as String).trim().isEmpty ||
        (item['text'] as String).length > 4000 ||
        item['evidence_ids'] is! List ||
        (item['evidence_ids'] as List).isEmpty ||
        !(item['evidence_ids'] as List).every(evidence.contains)) {
      throw StateError('ungrounded_projection');
    }
    final kind = item['kind'] ?? 'profile';
    if (!['profile', 'timeline'].contains(kind)) {
      throw StateError('invalid_projection_kind');
    }
    if (kind == 'profile' &&
        !ProfileCorrections.categories.containsKey(item['key'])) {
      throw ProfileValidationFailure('invalid_profile_category', {
        'path': 'entries[$index].key',
        'allowed_values': ProfileCorrections.categories.keys.toList(),
      });
    }
    final refs = (item['evidence_ids'] as List).map((id) => originals[id]!);
    if (kind == 'profile' && refs.any((e) => e['relation'] != 'self')) {
      throw StateError('profile_requires_self_evidence');
    }
    if (kind == 'timeline') {
      final date = item['observed_at'] is String
          ? DateTime.tryParse(item['observed_at'])
          : null;
      if (date == null ||
          !refs.any((e) => e['created_at'] == date.millisecondsSinceEpoch)) {
        throw StateError('timeline_time_not_grounded');
      }
    } else if (item['observed_at'] != null) {
      throw StateError('invalid_profile_time');
    }
  }
}

class ProfileRepository {
  ProfileRepository(
    this.persistence,
    this.authority,
    this.sources, {
    this.corrections,
  });
  final ProfileCorrections? corrections;
  String get correctionScope =>
      '${authority.record['space_id']}|${sources.identity}';
  final LifePersistence persistence;
  final SpaceAuthorityRepository authority;
  final SourceStore sources;
  Map<String, dynamic>? _value;
  Future<void> _tail = Future.value();
  Map<String, dynamic>? get value {
    final current = _value;
    if (current == null ||
        current['space_id'] != authority.record['space_id'] ||
        current['source_revision'] != sources.revision ||
        current['consent_revision'] != sources.processingRevision ||
        current['authority_epoch'] != authority.epoch ||
        current['publication_generation'] != authority.publicationGeneration) {
      return null;
    }
    final evidence = sources.sources
        .expand(sources.messages)
        .where((m) => m['status'] == 'available')
        .map((m) => m['evidence_id'])
        .toSet();
    if (!(current['entries'] as List).every(
      (entry) => (entry['evidence_ids'] as List).every(evidence.contains),
    )) {
      return null;
    }
    final result = copyJson(current);
    final explicit = corrections?.values(correctionScope) ?? <String, String>{};
    result['entries'] = [
      ...(result['entries'] as List).where(
        (e) => e['kind'] == 'timeline' || !explicit.containsKey(e['key']),
      ),
      for (final item in explicit.entries)
        {
          'key': item.key,
          'kind': 'profile',
          'text': item.value,
          'explicit': true,
          'evidence_ids': <String>[],
        },
    ];
    return result;
  }

  Future<void> open() async {
    await corrections?.open();
    final raw = await persistence.read();
    if (raw != null) _value = jsonDecode(raw) as Map<String, dynamic>?;
  }

  Future<Map<String, dynamic>> publish(
    String encoded, {
    required int epoch,
    required int sourceRevision,
    required int consentRevision,
    required String provider,
    int incompleteBatches = 0,
  }) {
    final result = _tail.then((_) async {
      final generation = authority.publicationGeneration;
      authority.validatePublish(epoch);
      sources.validateProcessing(provider, 'profile', consentRevision);
      if (sources.revision != sourceRevision) throw StateError('stale_inputs');
      final entries = jsonDecode(encoded);
      final originals = {
        for (final e in sources.readAuthorizedEvidence(provider, 'profile'))
          e['evidence_id']: e,
      };
      validateProfileEntries(entries, originals);
      final next = {
        'version': 1,
        'space_id': authority.record['space_id'],
        'authority_epoch': epoch,
        'publication_generation': generation,
        'publisher_device_id': authority.deviceId,
        'revision': (_value?['revision'] as int? ?? 0) + 1,
        'source_revision': sourceRevision,
        'consent_revision': consentRevision,
        'entries': entries,
        'incomplete_batches': incompleteBatches,
      };
      await persistence.write(jsonEncode(next));
      try {
        authority.validatePublish(epoch);
        sources.validateProcessing(provider, 'profile', consentRevision);
        if (sources.revision != sourceRevision ||
            generation != authority.publicationGeneration) {
          throw StateError('stale_inputs');
        }
      } catch (_) {
        await persistence.write('null');
        _value = null;
        rethrow;
      }
      _value = next;
      return {'revision': next['revision'], 'entries': entries.length};
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<void> clear() async {
    await _tail;
    await persistence.write('null');
    _value = null;
  }
}
