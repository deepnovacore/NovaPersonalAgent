import 'dart:convert';
import 'package:flutter/foundation.dart' show compute;
import 'profile_text.dart';
import 'profile_observation_checkpoint.dart';
import 'source_store.dart' show sourceAccessExpiry;

ProfileEvidence _buildProfileEvidence(
  ({
    List<Map<String, dynamic>> originals,
    DateTime? validThrough,
    Duration? timezoneOffset,
  })
  input,
) => ProfileEvidence(
  input.originals,
  validThrough: input.validThrough,
  timezoneOffset: input.timezoneOffset,
);

/// Short run-local references keep storage identifiers out of model context.
class ProfileEvidence {
  static Future<ProfileEvidence> build(
    List<Map<String, dynamic>> originals, {
    DateTime? validThrough,
    Duration? timezoneOffset,
  }) => compute(_buildProfileEvidence, (
    originals: originals,
    validThrough: validThrough,
    timezoneOffset: timezoneOffset,
  ));
  ProfileEvidence(
    List<Map<String, dynamic>> originals, {
    DateTime? validThrough,
    Duration? timezoneOffset,
  }) {
    final chats = <String, String>{}, speakers = <String, String>{};
    final included = <Map<String, dynamic>>[];
    String body(Map<String, dynamic> item) => (item['text'] as String)
        .replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    final others = <String, int>{};
    for (final item in originals.where(
      (e) => const {'participant', 'addressed', 'app'}.contains(e['relation']),
    )) {
      final text = body(item), time = item['created_at'] as int;
      if (text.length >= 120 &&
          (others[text] == null || time < others[text]!)) {
        others[text] = time;
      }
    }
    for (final item in originals) {
      final prior = others[body(item)];
      if (item['relation'] == 'self' &&
          prior != null &&
          prior <= (item['created_at'] as int)) {
        copiedCount++;
        continue;
      }
      final safeText = profileSafeText(item['text'] as String);
      if (safeText.replaceAll('[redacted]', '').trim().isEmpty) {
        emptyOrRedactedCount++;
        continue;
      }
      final expiry = sourceAccessExpiry(item);
      if (validThrough != null && !expiry.isAfter(validThrough)) {
        expiringCount++;
        continue;
      }
      if (_expiresAt == null || expiry.isBefore(_expiresAt!)) {
        _expiresAt = expiry;
      }
      final ref = 'e${records.length + 1}';
      _ids[ref] = item['evidence_id'] as String;
      included.add(item);
      final sender = item['sender_id'] as String?;
      final self = item['relation'] == 'self';
      final kind = switch (item['sender_type']) {
        'user' => 'person',
        'app' => 'app',
        _ => 'unknown',
      };
      final relation = kind == 'app'
          ? 'app'
          : self
          ? 'self'
          : item['mention'] == 'direct'
          ? 'addressed'
          : sender != null && sender.isNotEmpty
          ? 'participant'
          : 'unknown';
      final created = DateTime.fromMillisecondsSinceEpoch(
        item['created_at'] as int,
        isUtc: true,
      );
      final local = timezoneOffset == null
          ? created.toLocal()
          : created.add(timezoneOffset);
      records.add({
        'evidence_id': ref,
        'chat': chats.putIfAbsent(
          item['chat_id'] as String,
          () => 'c${chats.length + 1}',
        ),
        'author': {
          'key': self
              ? 'self'
              : sender == null || sender.isEmpty
              ? 'unknown'
              : speakers.putIfAbsent(sender, () => 'p${speakers.length + 1}'),
          'kind': kind,
          'is_user': kind != 'app' && relation == 'self',
        },
        'relation': relation,
        'links': <String, String>{},
        if (item['mention'] == 'direct') 'mentions_user': true,
        'created_at': created.toIso8601String(),
        'local_date': local.toIso8601String().substring(0, 10),
        'text': safeText,
      });
    }
    final messageRefs = <String, String>{
      for (var i = 0; i < included.length; i++)
        if (included[i]['message_id'] is String)
          included[i]['message_id'] as String:
              records[i]['evidence_id'] as String,
    };
    const linkFields = {
      'parent_id': 'parent',
      'root_id': 'root',
      'upper_message_id': 'forwarded_in',
    };
    for (var i = 0; i < included.length; i++) {
      final item = included[i], record = records[i];
      record['links'] = {
        for (final entry in linkFields.entries)
          if (item[entry.key] is String &&
              (item[entry.key] as String).isNotEmpty)
            entry.value: messageRefs[item[entry.key]] ?? 'outside_window',
      };
      timelineEvidenceDigests[item['evidence_id'] as String] =
          ProfileObservationCheckpoint.digest({
            'text': record['text'],
            'status': item['status'],
            'chat': item['chat_id'],
            'author': {...record['author'] as Map, 'key': item['sender_id']},
            'relation': record['relation'],
            'mentions_user': record['mentions_user'],
            'links': {
              for (final entry in linkFields.entries)
                if (item[entry.key] is String &&
                    (item[entry.key] as String).isNotEmpty)
                  entry.value: messageRefs.containsKey(item[entry.key])
                      ? item[entry.key]
                      : 'outside_window',
            },
            'created_at': record['created_at'],
            'local_date': record['local_date'],
          });
      _checkpointRecords[record['evidence_id'] as String] = {
        ...record,
        'evidence_id': item['evidence_id'],
        'chat': item['chat_id'],
        'author': {...record['author'] as Map, 'key': item['sender_id']},
        'links': {
          for (final entry in linkFields.entries)
            if (item[entry.key] is String &&
                (item[entry.key] as String).isNotEmpty)
              entry.value: item[entry.key],
        },
        'source_digest': ProfileObservationCheckpoint.digest({
          'text': item['text'],
          'status': item['status'],
          for (final field in [
            'sender_type',
            'mention',
            'mention_ids',
            'thread_id',
          ])
            field: item[field],
        }),
      };
    }
    checkpointDigest = ProfileObservationCheckpoint.digest({
      'mapping': _ids,
      'records': records,
    });
  }
  final records = <Map<String, dynamic>>[];
  final timelineEvidenceDigests = <String, String>{};
  int expiringCount = 0, copiedCount = 0, emptyOrRedactedCount = 0;
  final _ids = <String, String>{};
  final _checkpointRecords = <String, Map<String, dynamic>>{};
  List<Map<String, dynamic>> checkpointRecords(
    List<Map<String, dynamic>> batch,
  ) => [
    for (final record in batch)
      Map<String, dynamic>.from(_checkpointRecords[record['evidence_id']]!),
  ];
  List<Map<String, dynamic>> checkpointFacts(
    List<Map<String, dynamic>> facts,
  ) => [
    for (final fact in facts)
      {
        'text': fact['text'],
        'refs': [for (final ref in fact['refs'] as List) _ids[ref]!],
        'relevance': fact['relevance'],
      },
  ];
  Set<String> restoreCheckpointIds(Set<String> ids) => {
    for (final entry in _ids.entries)
      if (ids.contains(entry.value)) entry.key,
  };
  List<Map<String, dynamic>> restoreCheckpointFacts(
    List<Map<String, dynamic>> facts,
  ) {
    final refs = {for (final entry in _ids.entries) entry.value: entry.key};
    return [
      for (final fact in facts)
        {
          'text': fact['text'],
          'refs': [for (final ref in fact['refs'] as List) refs[ref]!],
          'relevance': fact['relevance'],
        },
    ];
  }

  DateTime? _expiresAt;
  DateTime? get expiresAt => _expiresAt;
  late final String checkpointDigest;
  bool expired(DateTime now) =>
      _expiresAt != null && !now.isBefore(_expiresAt!);

  List<Map<String, dynamic>> page(int offset) {
    if (offset < 0 || offset > records.length) {
      throw StateError('invalid_offset');
    }
    final result = <Map<String, dynamic>>[];
    var characters = 0;
    for (final item in records.skip(offset).take(200)) {
      final size = jsonEncode(item).length;
      if (result.isNotEmpty && characters + size > 40000) break;
      result.add(item);
      characters += size;
    }
    return result;
  }

  String restoreCitations(String encoded) {
    final entries = jsonDecode(encoded);
    if (entries is! List) throw StateError('invalid_projection');
    for (final entry in entries) {
      if (entry is! Map || entry['evidence_ids'] is! List) {
        throw StateError('ungrounded_projection');
      }
      final citations = <dynamic>[];
      if (entry['brief'] != null) {
        final brief = entry['brief'];
        if (brief is! Map || brief['facts'] is! List) {
          throw StateError('invalid_projection');
        }
        citations.addAll(brief['facts'] as List);
      }
      // Resolved `time` holds only host-derived dates, never citations.
      final temporal = entry['brief']?['temporal'];
      if (temporal != null) {
        if (temporal is! Map || temporal['dates'] is! List) {
          throw StateError('invalid_projection');
        }
        citations.addAll(temporal['dates'] as List);
      }
      for (final citation in citations) {
        if (citation is! Map ||
            !(entry['evidence_ids'] as List).contains(citation['ref'])) {
          throw StateError('ungrounded_projection');
        }
        final id = _ids[citation['ref']];
        if (id == null) throw StateError('ungrounded_projection');
        citation['ref'] = id;
      }
      entry['evidence_ids'] = (entry['evidence_ids'] as List).map((ref) {
        final id = _ids[ref];
        if (id == null) throw StateError('ungrounded_projection');
        return id;
      }).toList();
    }
    return jsonEncode(entries);
  }
}
