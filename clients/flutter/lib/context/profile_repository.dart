import 'dart:convert';
import '../device/space_authority.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';
import 'source_store.dart';
import 'profile_corrections.dart';
import 'timeline_brief.dart';
import 'profile_validation.dart';
export 'profile_validation.dart';

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

final _displayAlias = RegExp(
  r'(?<![A-Za-z0-9_])[pc]\d{1,5}(?![A-Za-z0-9_])',
  caseSensitive: false,
);
final _displayIpv4 = RegExp(
  r'(?<![A-Za-z0-9_.])(?:\d{1,3}\.){3}\d{1,3}(?![A-Za-z0-9_.])',
);
final _displayLocalhost = RegExp(
  r'(?<![A-Za-z0-9_-])localhost(?![A-Za-z0-9_-])',
  caseSensitive: false,
);

void _validateDisplayQuality(Map item, int index, Map originals) {
  final citedText = [
    for (final ref in item['evidence_ids'] as List)
      if (originals[ref]['text'] is String) originals[ref]['text'] as String,
  ];
  void check(String text, String field) {
    void reject(String reason) => throw ProfileValidationFailure(
      'ungrounded_projection',
      {'path': 'entries[$index].$field', 'reason': reason},
    );
    for (final alias in _displayAlias.allMatches(text)) {
      final originalToken = RegExp(
        r'(?<![A-Za-z0-9_])' + RegExp.escape(alias[0]!) + r'(?![A-Za-z0-9_])',
        caseSensitive: false,
      );
      if (!citedText.any(originalToken.hasMatch)) {
        reject('internal_alias');
      }
    }
    if (_displayLocalhost.hasMatch(text)) {
      reject('local_address');
    }
    for (final match in _displayIpv4.allMatches(text)) {
      final octets = match[0]!.split('.').map(int.parse).toList();
      if (octets.any((n) => n > 255)) continue;
      final local =
          octets[0] == 10 ||
          octets[0] == 127 ||
          octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31 ||
          octets[0] == 192 && octets[1] == 168;
      if (!local) continue;
      // Explicit, source-backed product versions are not network addresses.
      final prefix = text.substring(
        match.start > 20 ? match.start - 20 : 0,
        match.start,
      );
      final version = RegExp(
        r'(?:版本|version|ver\.?)\s*[:：]?\s*$',
        caseSensitive: false,
      ).hasMatch(prefix);
      if (version && citedText.any((source) => source.contains(match[0]!))) {
        continue;
      }
      reject('local_address');
    }
  }

  final brief = item['brief'];
  if (brief is Map) {
    for (final field in ['title', 'status_label', 'why_now', 'uncertainty']) {
      check(brief[field] as String, 'brief.$field');
    }
    final facts = brief['facts'] as List;
    for (var i = 0; i < facts.length; i++) {
      check(facts[i]['text'] as String, 'brief.facts[$i].text');
    }
    final steps = brief['next_steps'] as List;
    for (var i = 0; i < steps.length; i++) {
      for (final field in ['title', 'detail']) {
        check(steps[i][field] as String, 'brief.next_steps[$i].$field');
      }
    }
    // Host-derived text repeats title/facts; quotes remain exact source data.
  } else {
    check(item['text'] as String, 'text');
  }
}

/// Shared pre-write validation for the writer and persisted projection.
void validateProfileEntries(
  dynamic entries,
  Map<dynamic, dynamic> originals, {
  int maxEntries = 100,
}) {
  final evidence = originals.keys.toSet();
  if (entries is! List || entries.length > maxEntries) {
    throw StateError('invalid_projection');
  }
  final keys = <String>{};
  for (var index = 0; index < entries.length; index++) {
    final item = entries[index];
    Never reject(String reason, String field) => throw ProfileValidationFailure(
      'ungrounded_projection',
      {'reason': reason, 'path': 'entries[$index]$field'},
    );
    if (item is! Map ||
        item.keys.toSet().difference({
          'key',
          'text',
          'evidence_ids',
          'kind',
          'observed_at',
          'brief',
        }).isNotEmpty) {
      reject('entry_schema', '');
    }
    if (item['key'] is! String) {
      reject('entry_key_type', '.key');
    }
    if (!RegExp(r'^[A-Za-z0-9_-]{1,100}$').hasMatch(item['key'])) {
      reject('entry_key_format', '.key');
    }
    if (!keys.add(item['key'])) {
      reject('entry_key_duplicate', '.key');
    }
    if (item['text'] is! String) {
      reject('entry_text_type', '.text');
    }
    if ((item['text'] as String).trim().isEmpty) {
      reject('entry_text_empty', '.text');
    }
    if ((item['text'] as String).length > 4000) {
      reject('entry_text_too_long', '.text');
    }
    if (item['evidence_ids'] is! List) {
      reject('evidence_ids_type', '.evidence_ids');
    }
    final evidenceIds = item['evidence_ids'] as List;
    if (evidenceIds.isEmpty) {
      reject('evidence_ids_empty', '.evidence_ids');
    }
    for (var i = 0; i < evidenceIds.length; i++) {
      if (!evidence.contains(evidenceIds[i])) {
        reject('evidence_id_unknown', '.evidence_ids[$i]');
      }
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
    if (item.containsKey('brief')) {
      if (kind != 'timeline') throw StateError('invalid_projection_kind');
      final brief = normalizeTimelineBrief(
        item['brief'],
        item['evidence_ids'] as List,
        Map<String, dynamic>.from(originals),
        path: 'entries[$index].brief',
      );
      if (item['text'] != timelineBriefText(brief)) {
        reject('brief_text_mismatch', '.text');
      }
      item['brief'] = brief;
    }
    final refs = (item['evidence_ids'] as List).map((id) => originals[id]!);
    if ((kind == 'profile' || kind == 'todo_candidate') &&
        refs.any((e) => e['relation'] != 'self')) {
      final invalid = (item['evidence_ids'] as List)
          .where((id) => originals[id]!['relation'] != 'self')
          .toList();
      throw ProfileValidationFailure('profile_requires_self_evidence', {
        'path': 'entries[$index].evidence_ids',
        'entry_kind': kind,
        'entry_key': item['key'],
        'invalid_reference_count': invalid.length,
        'invalid_references': [
          for (final id in invalid.take(120))
            {
              'evidence_id': id,
              'relation': originals[id]!['relation'] == 'participant'
                  ? 'participant'
                  : 'unknown',
            },
        ],
        'allowed_values': originals.entries
            .where((e) => e.value['relation'] == 'self')
            .map((e) => e.key)
            .take(120)
            .toList(),
      });
    }
    _validateDisplayQuality(item, index, originals);
    if (kind == 'todo_candidate' && (item['text'] as String).length > 200) {
      reject('todo_text_too_long', '.text');
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
        (current['preserved_history'] as int? ?? 0) > 0 ||
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
    bool mergeTimelineHistory = false,
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
      // Model responses stay capped at 100 per batch. A host-assembled snapshot
      // can contain many independently validated batches.
      if (entries is List && entries.length > 10000) {
        throw StateError('profile_result_capacity');
      }
      validateProfileEntries(entries, originals, maxEntries: 10000);
      if (partial &&
          (entries as List).any((entry) => entry['kind'] == 'todo_candidate')) {
        throw StateError('partial_profile_todo_unsupported');
      }
      final retained = value;
      final noNewContent = (entries as List).isEmpty && retained != null;
      // value gates account/authority ownership. Preserve the underlying
      // publication, not its temporary overlay of explicit user corrections.
      final oldEntries = retained == null
          ? <dynamic>[]
          : _value!['entries'] as List;
      final newProfileKeys = entries
          .where((e) => (e['kind'] ?? 'profile') == 'profile')
          .map((e) => e['key'])
          .toSet();
      final hasNewTimeline = entries.any((e) => e['kind'] == 'timeline');
      // A null/omitted profile category or an empty Timeline is not a deletion.
      // Prior suggestions never become current actionable candidates again.
      String timelineIdentity(dynamic entry) {
        final refs = List<String>.from(entry['evidence_ids'] as List)..sort();
        return jsonEncode(refs);
      }

      final newTimelineEvidence = entries
          .where((e) => e['kind'] == 'timeline')
          .map(timelineIdentity)
          .toSet();
      final preserved = oldEntries.where((e) {
        final kind = e['kind'] ?? 'profile';
        return kind == 'timeline'
            ? !hasNewTimeline ||
                  mergeTimelineHistory &&
                      !newTimelineEvidence.contains(timelineIdentity(e))
            : kind == 'profile' &&
                  ProfileCorrections.categories.containsKey(e['key']) &&
                  !newProfileKeys.contains(e['key']);
      }).toList();
      final publishedKeys = entries.map((e) => e['key'] as String).toSet();
      for (var index = 0; index < preserved.length; index++) {
        final entry = preserved[index] as Map;
        var key = entry['key'] as String;
        if (publishedKeys.contains(key)) {
          // Timeline keys are display identifiers; keep fixed profile category
          // keys and current candidate identifiers intact. Hash without the old
          // key so a subsequent publication never grows history prefixes.
          if (entry['kind'] != 'timeline') {
            throw StateError('invalid_projection');
          }
          final basis = Map<String, dynamic>.from(entry)..remove('key');
          final base = 'timeline_history_${lifeFingerprint(basis)}';
          key = base;
          var suffix = 1;
          while (publishedKeys.contains(key)) {
            key = '${base}_${suffix++}';
          }
          preserved[index] = {...entry, 'key': key};
        }
        publishedKeys.add(key);
      }
      final publishedEntries = [...entries, ...preserved];
      if (publishedEntries.length > 10000) {
        throw StateError('profile_result_capacity');
      }
      final oldFingerprints = _value?['evidence_fingerprints'] as Map? ?? {};
      final fingerprints = {
        for (final id
            in entries.expand((e) => e['evidence_ids'] as List).toSet())
          id: _evidenceFingerprint(originals[id]!),
        for (final id
            in preserved.expand((e) => e['evidence_ids'] as List).toSet())
          if (oldFingerprints.containsKey(id)) id: oldFingerprints[id],
      };
      final next = {
        'version': 1,
        'space_id': authority.record['space_id'],
        'authority_epoch': epoch,
        'publication_generation': generation,
        'publisher_device_id': authority.deviceId,
        'revision': (_value?['revision'] as int? ?? 0) + 1,
        'generated_at': noNewContent
            ? _value!['generated_at']
            : sources.now().toUtc().toIso8601String(),
        'processing_provider': provider,
        'source_identity': sources.identity,
        'source_generation': sources.generation,
        'history_schema': 1,
        'evidence_fingerprints': fingerprints,
        'source_revision': noNewContent
            ? _value!['source_revision']
            : sourceRevision,
        'consent_revision': noNewContent
            ? _value!['consent_revision']
            : consentRevision,
        'entries': publishedEntries,
        'preserved_history': preserved.length,
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
      return {'revision': next['revision'], 'entries': publishedEntries.length};
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
