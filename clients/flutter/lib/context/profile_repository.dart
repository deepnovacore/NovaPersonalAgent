import 'dart:convert';

import '../context/local_publication.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';
import 'source_store.dart';
import 'profile_corrections.dart';
import 'timeline_brief.dart';
import 'timeline_time.dart';
import 'profile_validation.dart';
export 'profile_validation.dart';

bool _trustedTimeline(dynamic entry) =>
    entry is Map &&
    (entry['kind'] != 'timeline' ||
        entry['policy_revision'] is int && entry['policy_revision'] >= 2);

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
          'time',
          'policy_revision',
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
    if ((item.containsKey('policy_revision') &&
            (kind != 'timeline' || item['policy_revision'] is! int)) ||
        (item.containsKey('time') &&
            (kind != 'timeline' || item['time'] is! Map))) {
      reject('entry_schema', '');
    }
    final time = item['time'];
    if (time is Map) {
      const dates = {
        'anchor_date',
        'occurred_on',
        'started_on',
        'due_on',
        'scheduled_on',
        'last_reported_on',
        'evidence_from',
        'evidence_to',
        'as_of',
      };
      bool validDate(dynamic value) {
        if (value == null) return true;
        if (value is! String ||
            !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) {
          return false;
        }
        final parsed = DateTime.tryParse('${value}T00:00:00Z');
        return parsed != null &&
            parsed.toIso8601String().substring(0, 10) == value;
      }

      if (time.length != dates.length + 2 ||
          !time.keys.every({...dates, 'kind', 'anchor_basis'}.contains) ||
          !const {
            'event',
            'ongoing',
            'deadline',
            'scheduled',
            'synthesis',
            'unknown',
          }.contains(time['kind']) ||
          !const {
            'occurred',
            'deadline',
            'scheduled',
            'reported',
            'unknown',
          }.contains(time['anchor_basis']) ||
          time['as_of'] == null ||
          !dates.every((field) => validDate(time[field]))) {
        reject('invalid_time', '.time');
      }
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
      if (brief.containsKey('temporal')) {
        if (time is! Map || time['as_of'] is! String) {
          reject('invalid_temporal', '.brief.temporal');
        }
        final resolved = resolveTimelineTime(brief['temporal'], [
          for (final id in evidenceIds)
            {
              ...Map<String, dynamic>.from(originals[id] as Map),
              'evidence_id': id,
              'local_date':
                  originals[id]['local_date'] ??
                  DateTime.fromMillisecondsSinceEpoch(
                    originals[id]['created_at'] as int,
                  ).toIso8601String().substring(0, 10),
            },
        ], localDate: time['as_of'] as String);
        if (resolved == null ||
            lifeFingerprint(resolved) != lifeFingerprint(time)) {
          reject('invalid_temporal', '.brief.temporal');
        }
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
              'relation': const {
                'participant',
                'addressed',
                'app',
              }.contains(originals[id]!['relation'])
                  ? originals[id]!['relation']
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
    this.publication,
    this.sources, {
    this.corrections,
  });
  final ProfileCorrections? corrections;
  String get correctionScope => '${publication.spaceId}|${sources.identity}';
  final LifePersistence persistence;
  final LocalPublicationContext publication;
  final SourceStore sources;
  Map<String, dynamic>? _value;
  int _revision = 0;
  int get revision => _revision;
  void _replace(Map<String, dynamic>? next) {
    if (identical(_value, next)) return;
    _value = next;
    _revision++;
  }

  Future<void> _tail = Future.value();
  Map<String, dynamic>? get value {
    final current = _value;
    if (!publication.canPublish ||
        current == null ||
        current['space_id'] != publication.spaceId ||
        current['publisher_device_id'] != publication.deviceId) {
      return null;
    }
    final historicalSnapshot =
        const {1, 2}.contains(current['history_schema']) &&
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
    final trustedEntries = (current['entries'] as List)
        .where(_trustedTimeline)
        .toList();
    final refs = trustedEntries
        .expand((entry) => entry['evidence_ids'] as List)
        .toSet();
    final originals = {
      if (evidenceAllowed)
        for (final m in sources.messagesByEvidenceIds(refs))
          if (m['status'] == 'available') m['evidence_id']: m,
    };
    final available = refs
        .where(
          (id) =>
              originals.containsKey(id) &&
              (!historicalSnapshot ||
                  _verifiedEvidence(
                    current['history_schema'] as int,
                    current['evidence_fingerprints'][id],
                    originals[id]!,
                  )),
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
      ...(result['entries'] as List)
          .where(_trustedTimeline)
          .where(
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

  /// Whether this device holds a stored projection at all, even when [value]
  /// hides it because it belongs to another Space, device or identity.
  bool get hasStoredResult => _value != null;

  /// Content identity only: author metadata (sender_type, mentions, relation,
  /// reply links) can be enriched later without changing what was said.
  static const _fingerprintFields = {
    'evidence_id',
    'identity',
    'chat_id',
    'message_id',
    'created_at',
    'sender_id',
    'text',
    'status',
  };
  static String _evidenceFingerprint(Map original) => lifeFingerprint({
    for (final field in _fingerprintFields) field: original[field],
  });

  static const _metadataFields = {
    'sender_type',
    'mention',
    'mention_ids',
    'parent_id',
    'root_id',
    'thread_id',
    'upper_message_id',
  };

  /// Schema 1 hashed every stored field except fetched_at. Its digest still
  /// verifies a message whose only change is the later metadata enrichment,
  /// by recomputing it as stored then or as stored before enrichment existed.
  static bool _verifiedEvidence(int schema, Object? stored, Map original) {
    if (schema == 2) return stored == _evidenceFingerprint(original);
    String full(Map record) => lifeFingerprint({
      for (final entry in record.entries)
        if (entry.key != 'fetched_at') entry.key: entry.value,
    });
    if (stored == full(original)) return true;
    final self = original['relation'] == 'self';
    final legacy = {
      for (final entry in original.entries)
        if (!_metadataFields.contains(entry.key)) entry.key: entry.value,
      'relation': original['sender_id'] == null
          ? 'unknown'
          : self
          ? 'self'
          : 'participant',
    };
    // Before the re-read, records either lacked the metadata keys (older
    // builds) or carried their unknown defaults (builds with the new ingest).
    return stored == full(legacy) ||
        stored ==
            full({
              ...legacy,
              'sender_type': 'unknown',
              'mention': self ? 'none' : 'unknown',
              'mention_ids': <String>[],
            });
  }

  Future<void> open() {
    final result = _tail.then((_) async {
      await corrections?.open();
      final raw = await persistence.read();
      if (raw != null) _replace(jsonDecode(raw) as Map<String, dynamic>?);
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
          'history_schema': 2,
          'evidence_fingerprints': {
            for (final id
                in (legacy['entries'] as List)
                    .expand((e) => e['evidence_ids'] as List)
                    .toSet())
              id: _evidenceFingerprint(originals[id]!),
          },
        };
        await persistence.write(jsonEncode(migrated));
        _replace(migrated);
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
    required int sourceRevision,
    required int consentRevision,
    required String provider,
    int incompleteBatches = 0,
    bool partial = false,
    Map<String, int>? coverage,
    String? generationScope,
    bool mergeTimelineHistory = false,
    Map<String, String>? timelineInputBasis,
    String? timelineBasisCorrections,
  }) {
    final result = _tail.then((_) async {
      final previous = _value;
      publication.requireCurrent();
      sources.validateProcessing(provider, 'profile', consentRevision);
      if (sources.revision != sourceRevision) throw StateError('stale_inputs');
      if (partial) {
        validatePartialCoverage(coverage, generationScope: generationScope);
      }
      var entries = jsonDecode(encoded);
      final evidence = await sources.readAuthorizedEvidenceAsync(
        provider,
        'profile',
      );
      publication.requireCurrent();
      sources.validateProcessing(provider, 'profile', consentRevision);
      if (sources.revision != sourceRevision) throw StateError('stale_inputs');
      final originals = {for (final e in evidence) e['evidence_id']: e};
      // Model responses stay capped at 100 per batch. A host-assembled snapshot
      // can contain many independently validated batches.
      if (entries is List && entries.length > 10000) {
        throw StateError('profile_result_capacity');
      }
      validateProfileEntries(entries, originals, maxEntries: 10000);
      entries = (entries as List).where(_trustedTimeline).toList();
      if (partial &&
          entries.any((entry) => entry['kind'] == 'todo_candidate')) {
        throw StateError('partial_profile_todo_unsupported');
      }
      final retained = value;
      final noNewContent = entries.isEmpty && retained != null;
      // value gates account/publication ownership. Preserve the underlying
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
      final newTimelineKeys = entries.where((e) => e['kind'] == 'timeline')
          .map((e) => e['key']).toSet();
      final preserved = oldEntries.where((e) {
        if (!_trustedTimeline(e)) return false;
        final kind = e['kind'] ?? 'profile';
        return kind == 'timeline'
            ? !newTimelineKeys.contains(e['key']) &&
                  (!hasNewTimeline || mergeTimelineHistory)
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
      // Preserved evidence that verified under the old schema is re-keyed to
      // the content digest; unverified evidence keeps a digest that can never
      // match again, so it stays historical rather than becoming available.
      final verified = Set<String>.from(
        retained?['available_evidence_ids'] as List? ?? const [],
      );
      final preservedIds = preserved
          .expand((e) => e['evidence_ids'] as List)
          .toSet();
      final reverify = preservedIds.where(verified.contains).toSet();
      final current = {
        if (reverify.isNotEmpty)
          for (final m in sources.messagesByEvidenceIds(reverify))
            if (m['status'] == 'available') m['evidence_id']: m,
      };
      final fingerprints = {
        for (final id in preservedIds)
          if (current.containsKey(id))
            id: _evidenceFingerprint(current[id]!)
          else if (oldFingerprints.containsKey(id))
            id: oldFingerprints[id],
        for (final id
            in entries.expand((e) => e['evidence_ids'] as List).toSet())
          id: _evidenceFingerprint(originals[id]!),
      };
      final next = {
        'version': 1,
        'space_id': publication.spaceId,
        'publisher_device_id': publication.deviceId,
        'revision': (_value?['revision'] as int? ?? 0) + 1,
        'generated_at': noNewContent
            ? _value!['generated_at']
            : sources.now().toUtc().toIso8601String(),
        'processing_provider': provider,
        'source_identity': sources.identity,
        'source_generation': sources.generation,
        'history_schema': 2,
        'evidence_fingerprints': fingerprints,
        if (timelineInputBasis != null) ...{
          'timeline_input_basis': Map<String, String>.from(timelineInputBasis),
          'timeline_basis_corrections': timelineBasisCorrections,
        }
        else if (retained?['processing_provider'] == provider &&
            retained?['consent_revision'] == consentRevision &&
            retained?['source_generation'] == sources.generation &&
            retained?['timeline_input_basis'] is Map) ...{
          'timeline_input_basis': retained!['timeline_input_basis'],
          'timeline_basis_corrections': retained['timeline_basis_corrections'],
        },
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
        publication.requireCurrent();
        sources.validateProcessing(provider, 'profile', consentRevision);
        if (sources.revision != sourceRevision || !publication.canPublish) {
          throw StateError('stale_inputs');
        }
      } catch (_) {
        // A failed replacement must not erase the prior committed success.
        await persistence.write(jsonEncode(previous));
        _replace(previous);
        rethrow;
      }
      _replace(next);
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
      _replace(null);
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }
}
