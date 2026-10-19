import 'dart:convert';
import 'profile_text.dart';
import 'profile_observation_checkpoint.dart';
import 'source_store.dart' show sourceAccessExpiry;

/// Short run-local references keep storage identifiers out of model context.
class ProfileEvidence {
  ProfileEvidence(
    List<Map<String, dynamic>> originals, {
    DateTime? validThrough,
  }) {
    final chats = <String, String>{}, speakers = <String, String>{};
    String body(Map<String, dynamic> item) => (item['text'] as String)
        .replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    final others = <String, int>{};
    for (final item in originals.where((e) => e['relation'] == 'participant')) {
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
      records.add({
        'evidence_id': ref,
        'chat': chats.putIfAbsent(
          item['chat_id'] as String,
          () => 'c${chats.length + 1}',
        ),
        'speaker': item['sender_id'] == null
            ? 'unknown'
            : speakers.putIfAbsent(
                item['sender_id'] as String,
                () => 'p${speakers.length + 1}',
              ),
        'relation': item['relation'],
        'body_authorship': 'unverified',
        'created_at': DateTime.fromMillisecondsSinceEpoch(
          item['created_at'] as int,
          isUtc: true,
        ).toIso8601String(),
        'text': safeText,
      });
    }
  }
  final records = <Map<String, dynamic>>[];
  int expiringCount = 0, copiedCount = 0, emptyOrRedactedCount = 0;
  final _ids = <String, String>{};
  DateTime? _expiresAt;
  DateTime? get expiresAt => _expiresAt;
  String get checkpointDigest => ProfileObservationCheckpoint.digest({
    'mapping': _ids,
    'records': records,
  });
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
      if (entry['brief'] != null) {
        final brief = entry['brief'];
        if (brief is! Map || brief['facts'] is! List) {
          throw StateError('invalid_projection');
        }
        for (final fact in brief['facts'] as List) {
          if (fact is! Map ||
              !(entry['evidence_ids'] as List).contains(fact['ref'])) {
            throw StateError('ungrounded_projection');
          }
          final id = _ids[fact['ref']];
          if (id == null) throw StateError('ungrounded_projection');
          fact['ref'] = id;
        }
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
