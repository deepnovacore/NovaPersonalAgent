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
    'partial_profile_todo_unsupported',
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
    if (!['profile', 'timeline', 'todo_candidate'].contains(kind)) {
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
    if ((kind == 'profile' || kind == 'todo_candidate') &&
        refs.any((e) => e['relation'] != 'self')) {
      throw StateError('profile_requires_self_evidence');
    }
    if (kind == 'todo_candidate' && (item['text'] as String).length > 200) {
      throw StateError('ungrounded_projection');
    }
    if (kind == 'timeline' || kind == 'todo_candidate') {
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
        current['authority_epoch'] != authority.epoch ||
        current['publication_generation'] != authority.publicationGeneration) {
      return null;
    }
    final historicalSnapshot =
        current['history_schema'] == 1 &&
        current['evidence_fingerprints'] is Map;
    if (historicalSnapshot) {
      if (current['source_identity'] != sources.identity) {
        return null;
      }
    } else if (current['source_revision'] != sources.revision ||
        current['consent_revision'] != sources.processingRevision) {
      // Legacy output cannot be assigned an identity or original content digest
      // retroactively after its original generation fence has changed.
      return null;
    }
    var evidenceAllowed = true;
    if (historicalSnapshot) {
      final provider = current['processing_provider'];
      if (provider is String) {
        try {
          sources.validateProcessing(
            provider,
            'profile',
            sources.processingRevision,
          );
        } catch (_) {
          evidenceAllowed = false;
        }
      } else {
        evidenceAllowed =
            current['consent_revision'] == sources.processingRevision;
      }
    }
    final originals = {
      for (final m in sources.sources.expand(sources.messages))
        if (evidenceAllowed && m['status'] == 'available') m['evidence_id']: m,
    };
    final refs = (current['entries'] as List)
        .expand((entry) => entry['evidence_ids'] as List)
        .toSet();
    final available = refs
        .where(
          (id) =>
              originals.containsKey(id) &&
              (!historicalSnapshot ||
                  current['evidence_fingerprints'][id] ==
                      _evidenceFingerprint(originals[id]!)),
        )
        .toList();
    if (!historicalSnapshot && available.length != refs.length) return null;
    final result = copyJson(current);
    result['available_evidence_ids'] = available;
    result['historical'] =
        current['source_revision'] != sources.revision ||
        current['consent_revision'] != sources.processingRevision ||
        available.length != refs.length;
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

  static String _evidenceFingerprint(Map original) => lifeFingerprint({
    for (final entry in original.entries)
      if (entry.key != 'fetched_at') entry.key: entry.value,
  });

  Future<void> open() {
    final result = _tail.then((_) async {
      await corrections?.open();
      final raw = await persistence.read();
      if (raw != null) _value = jsonDecode(raw) as Map<String, dynamic>?;
      final legacy = _value;
      if (legacy != null && legacy['history_schema'] == null && value != null) {
        // Only the original fences and still-readable references can establish a
        // legacy snapshot's ownership. Do not invent its missing generation time.
        final originals = {
          for (final m in sources.sources.expand(sources.messages))
            if (m['status'] == 'available') m['evidence_id']: m,
        };
        final migrated = {
          ...legacy,
          'source_identity': sources.identity,
          'source_generation': sources.generation,
          'history_schema': 1,
          'evidence_fingerprints': {
            for (final id
                in (legacy['entries'] as List)
                    .expand((e) => e['evidence_ids'] as List)
                    .toSet())
              id: _evidenceFingerprint(originals[id]!),
          },
        };
        await persistence.write(jsonEncode(migrated));
        _value = migrated;
      }
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  /// A useful published result must not regress when reusing a smaller checkpoint.
  /// History remains visible while a different generation is being prepared.
  void validatePartialCoverage(
    Map<String, int>? coverage, {
    String? generationScope,
  }) {
    final previous = value;
    if (previous == null) return;
    if (generationScope != null &&
        previous['generation_scope'] != generationScope) {
      return;
    }
    final oldCoverage = previous['coverage'];
    final oldVerified = oldCoverage is Map
        ? oldCoverage['validated_observation_records']
        : null;
    final oldOriginals = oldCoverage is Map
        ? oldCoverage['final_original_records']
        : null;
    final verified = coverage?['validated_observation_records'];
    final originals = coverage?['final_original_records'];
    if (previous['partial'] != true ||
        oldVerified is! int ||
        oldOriginals is! int ||
        verified == null ||
        originals == null ||
        verified < oldVerified ||
        (verified == oldVerified && originals < oldOriginals)) {
      throw StateError('profile_result_more_complete');
    }
  }

  Future<Map<String, dynamic>> publish(
    String encoded, {
    required int epoch,
    required int sourceRevision,
    required int consentRevision,
    required String provider,
    int incompleteBatches = 0,
    bool partial = false,
    Map<String, int>? coverage,
    String? generationScope,
  }) {
    final result = _tail.then((_) async {
      final previous = _value;
      final generation = authority.publicationGeneration;
      authority.validatePublish(epoch);
      sources.validateProcessing(provider, 'profile', consentRevision);
      if (sources.revision != sourceRevision) throw StateError('stale_inputs');
      if (partial) {
        validatePartialCoverage(coverage, generationScope: generationScope);
      }
      final entries = jsonDecode(encoded);
      final originals = {
        for (final e in sources.readAuthorizedEvidence(provider, 'profile'))
          e['evidence_id']: e,
      };
      validateProfileEntries(entries, originals);
      if (partial &&
          (entries as List).any((entry) => entry['kind'] == 'todo_candidate')) {
        throw StateError('partial_profile_todo_unsupported');
      }
      final next = {
        'version': 1,
        'space_id': authority.record['space_id'],
        'authority_epoch': epoch,
        'publication_generation': generation,
        'publisher_device_id': authority.deviceId,
        'revision': (_value?['revision'] as int? ?? 0) + 1,
        'generated_at': sources.now().toUtc().toIso8601String(),
        'processing_provider': provider,
        'source_identity': sources.identity,
        'source_generation': sources.generation,
        'history_schema': 1,
        'evidence_fingerprints': {
          for (final id
              in (entries as List)
                  .expand((e) => e['evidence_ids'] as List)
                  .toSet())
            id: _evidenceFingerprint(originals[id]!),
        },
        'source_revision': sourceRevision,
        'consent_revision': consentRevision,
        'entries': entries,
        'incomplete_batches': incompleteBatches,
        'partial': partial,
        'generation_scope': ?generationScope,
        if (coverage != null) 'coverage': Map<String, int>.from(coverage),
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
        // A failed replacement must not erase the prior committed success.
        await persistence.write(jsonEncode(previous));
        _value = previous;
        rethrow;
      }
      _value = next;
      return {'revision': next['revision'], 'entries': entries.length};
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  /// Only an explicit user adoption calls this method. The existing Life mutation
  /// owns persistence, synchronization and operation-id deduplication.
  Future<Map<String, dynamic>> adoptTodo(
    String key, {
    required String expectedText,
    required Future<Map<String, dynamic>> Function(Map<String, dynamic>, String)
    mutate,
  }) async {
    final current = value;
    final candidates = current == null
        ? <dynamic>[]
        : current['entries'] as List;
    final matching = candidates.where(
      (e) =>
          e['kind'] == 'todo_candidate' &&
          e['key'] == key &&
          e['text'] == expectedText,
    );
    if (matching.length != 1) throw StateError('stale_todo_candidate');
    final candidate = matching.single as Map;
    final available = (current!['available_evidence_ids'] as List).toSet();
    if (current['historical'] == true ||
        !(candidate['evidence_ids'] as List).every(available.contains)) {
      throw StateError('stale_todo_candidate');
    }
    final operation = lifeFingerprint({
      'kind': 'adopt_feishu_todo',
      'scope': correctionScope,
      'text': candidate['text'],
      'evidence': (candidate['evidence_ids'] as List).cast<String>().toList()
        ..sort(),
    });
    return mutate({
      'op': 'create',
      'kind': 'todo',
      'title': candidate['text'],
    }, operation);
  }

  Future<void> clear() {
    final result = _tail.then((_) async {
      await persistence.write('null');
      _value = null;
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }
}
