import 'dart:convert';
import '../connectors/feishu/message_text.dart';
import 'package:flutter/foundation.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';

/// Content age is independent of access retention. Legacy rows retain their
/// original deadline until fetched again; opening a cache never refreshes access.
int sourceAccessTime(Map message) =>
    (message['fetched_at'] ?? message['created_at']) as int;
DateTime sourceAccessExpiry(Map message) => DateTime.fromMillisecondsSinceEpoch(
  sourceAccessTime(message),
  isUtc: true,
).add(const Duration(days: 30));

Map<String, dynamic> _copySourceMessage(Map<String, dynamic> message) =>
    message.values.any((value) => value is Map || value is List)
    ? copyJson(message)
    : Map<String, dynamic>.from(message);

Map<String, dynamic> _decodeSourceSnapshot(String raw) {
  final value = jsonDecode(raw) as Map<String, dynamic>;
  if (value['version'] != 1) throw StateError('source_schema');
  return value;
}

bool _largeSourceSnapshot(Map<String, dynamic> data) {
  var count = 0, characters = 0;
  for (final message in (data['messages'] as Map).values) {
    final text = message['text'];
    if (text is String) characters += text.length;
    if (++count >= 256 || characters >= 65536) return true;
  }
  return false;
}

({
  String? encoded,
  String previousEncoded,
  int revision,
  bool processingChanged,
  bool permissionChanged,
})
_prepareSourceWrite(
  ({Map<String, dynamic> previous, Map<String, dynamic> next, int maxBytes})
  input,
) {
  final previous = input.previous, next = input.next;
  if (lifeFingerprint(next) == lifeFingerprint(previous)) {
    return (
      encoded: null,
      previousEncoded: '',
      revision: previous['revision'] as int,
      processingChanged: false,
      permissionChanged: false,
    );
  }
  final processingChanged =
      SourceStore._processingFingerprint(next) !=
      SourceStore._processingFingerprint(previous);
  final permissionChanged =
      SourceStore._processingFingerprint({...next, 'messages': {}}) !=
      SourceStore._processingFingerprint({...previous, 'messages': {}});
  final revision = (previous['revision'] as int) + (processingChanged ? 1 : 0);
  final encoded = jsonEncode({...next, 'revision': revision});
  if (utf8.encode(encoded).length > input.maxBytes) {
    throw StateError('source_storage_full');
  }
  return (
    encoded: encoded,
    previousEncoded: jsonEncode(previous),
    revision: revision,
    processingChanged: processingChanged,
    permissionChanged: permissionChanged,
  );
}

List<Map<String, dynamic>> _readSourceEvidence(
  ({Map<String, dynamic> data, int cutoff}) input,
) {
  final selected = input.data['sources'] as Map;
  final byChat = <String, List<Map<String, dynamic>>>{};
  for (final message in (input.data['messages'] as Map).values) {
    if (message['status'] != 'available' ||
        !selected.containsKey(message['chat_id']) ||
        sourceAccessTime(message) <= input.cutoff) {
      continue;
    }
    byChat
        .putIfAbsent(message['chat_id'] as String, () => [])
        .add(_copySourceMessage(message as Map<String, dynamic>));
  }
  // Preserve the previous input order for equal timestamps and run aliases.
  return <Map<String, dynamic>>[
    for (final id in selected.keys) ...?byChat[id],
  ]..sort((a, b) => (a['created_at'] as int).compareTo(b['created_at'] as int));
}

/// Bounded encrypted snapshots in production. A page and checkpoint commit
/// together; storage exhaustion stops ingestion without advancing the cursor.
class SourceStore extends ChangeNotifier {
  SourceStore(
    this.persistence, {
    DateTime Function()? now,
    this.onInvalidated,
    this.onContentChanged,
    this.maxBytes = 16 * 1024 * 1024,
  }) : now = now ?? DateTime.now;
  final Future<void> Function()? onInvalidated;
  final Future<void> Function()? onContentChanged;
  final LifePersistence persistence;
  final int maxBytes;
  final DateTime Function() now;
  Map<String, dynamic> _data = {
    'version': 1,
    'history_policy': 'fetch-v1',
    'identity': null,
    'generation': 0,
    'revision': 0,
    'processing_revision': 0,
    'sources': {},
    'tombstones': {},
    'grants': {},
    'messages': {},
  };
  Future<void> _tail = Future.value();
  bool _disposed = false;
  int get revision => _data['revision'] as int;
  int get processingRevision => _data['processing_revision'] as int;
  String? get identity => _data['identity'] as String?;
  int get generation => _data['generation'] as int;
  List<String> get sources =>
      (_data['sources'] as Map).keys.cast<String>().toList();
  bool get allAccessible => _data['chat_scope'] != 'selected';
  bool excluded(String id) => (_data['tombstones'] as Map).containsKey(id);
  Future<void> setAllAccessible(bool value) => _write((data) {
    data['chat_scope'] = value ? 'all' : 'selected';
  });
  Future<void> open() async {
    final raw = await persistence.read();
    if (raw != null) {
      _data = raw.length >= 65536
          ? await compute(_decodeSourceSnapshot, raw)
          : _decodeSourceSnapshot(raw);
    }
    await _write((data) {
      if (data['history_policy'] == 'fetch-v1') return;
      // Upgrade the previous implicit 30-day default once. Keep messages for
      // deduplication, pauses and exclusions; explicit selected ranges survive.
      if (data['chat_scope'] != 'selected') {
        for (final source in (data['sources'] as Map).values) {
          source['from'] = DateTime.utc(1970).toIso8601String();
          source['history_from'] = source['from'];
          source['full_history'] = true;
          source['page_token'] = null;
          source['window_end'] = null;
          source['read_through'] = null;
          source['seen_pages'] = <String>[];
          source['scope_revision'] = (source['scope_revision'] as int) + 1;
        }
      }
      data['grants'] = {};
      data['processing_revision'] = (data['processing_revision'] as int) + 1;
      data['history_policy'] = 'fetch-v1';
    });
  }

  // Processing scope follows evidence and permission, not ingestion cursors.
  // Duplicate fetches can renew source access without invalidating paid work.
  static String _processingFingerprint(Map<String, dynamic> data) {
    final view = Map<String, dynamic>.from(data)..remove('revision');
    const cursorFields = {
      'from',
      'page_token',
      'window_end',
      'read_through',
      'seen_pages',
      'history_refresh_pending',
      'scope_revision',
      'head',
      'order',
      'invalid_records',
      'metadata_revision',
      'metadata',
    };
    view['sources'] = {
      for (final entry in (data['sources'] as Map).entries)
        entry.key: {
          for (final item in (entry.value as Map).entries)
            if (!cursorFields.contains(item.key)) item.key: item.value,
          // Legacy scopes retain their original boundary until migration.
          if (!(entry.value as Map).containsKey('history_from'))
            'history_from': entry.value['from'],
        },
    };
    view['messages'] = {
      for (final entry in (data['messages'] as Map).entries)
        entry.key: {
          for (final item in (entry.value as Map).entries)
            if (item.key != 'fetched_at') item.key: item.value,
        },
    };
    return lifeFingerprint(view);
  }

  Future<void> _write(
    void Function(Map<String, dynamic>) change, {
    bool refreshExpired = false,
    void Function()? authorize,
  }) {
    final result = _tail.then((_) async {
      if (_disposed) throw StateError('source_disposed');
      authorize?.call();
      final metadata = Map<String, dynamic>.from(_data)..remove('messages');
      // Stored rows are replaced whole, never mutated; outgoing reads copy them.
      final next = copyJson(metadata)
        ..['messages'] = Map<String, dynamic>.from(_data['messages'] as Map);
      // Pin legacy selection boundaries before any cursor advances. The old
      // fingerprint uses this same fallback, so migration preserves paid work.
      for (final source in (next['sources'] as Map).values) {
        source['history_from'] ??= source['from'];
      }
      change(next);
      _prune(next, refreshExpired: refreshExpired);
      final input = (previous: _data, next: next, maxBytes: maxBytes);
      final prepared = _largeSourceSnapshot(_data) || _largeSourceSnapshot(next)
          ? await compute(_prepareSourceWrite, input)
          : _prepareSourceWrite(input);
      if (_disposed) throw StateError('source_disposed');
      authorize?.call();
      final encoded = prepared.encoded;
      if (encoded == null) return;
      next['revision'] = prepared.revision;
      await persistence.write(encoded);
      try {
        authorize?.call();
      } catch (error, stack) {
        // The queue still owns the prior snapshot; never publish a page whose
        // authorization changed while encrypted storage was writing it.
        await persistence.write(prepared.previousEncoded);
        Error.throwWithStackTrace(error, stack);
      }
      _data = next;
      if (prepared.processingChanged) {
        await (prepared.permissionChanged
                ? onInvalidated
                : onContentChanged ?? onInvalidated)
            ?.call();
      }
      if (!_disposed) notifyListeners();
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<void> bind(String? identity, int generation) => _write((data) {
    if (data['identity'] != identity || data['generation'] != generation) {
      data['identity'] = identity;
      data['generation'] = generation;
      data['sources'] = {};
      data['messages'] = {};
      data['grants'] = {};
      data['tombstones'] = {};
      data['chat_scope'] = 'all';
      data['processing_revision'] = (data['processing_revision'] as int) + 1;
    }
  });
  Future<void> select(
    String id,
    DateTime from, {
    String? expectedIdentity,
    int? expectedGeneration,
    bool requireAllAccessible = false,
    bool updateRange = false,
    void Function()? authorize,
  }) => _write((data) {
    if ((expectedGeneration != null &&
            (data['identity'] != expectedIdentity ||
                data['generation'] != expectedGeneration)) ||
        (requireAllAccessible &&
            (data['chat_scope'] == 'selected' ||
                (data['tombstones'] as Map).containsKey(id)))) {
      throw StateError('stale_source');
    }
    if (data['identity'] == null ||
        id.isEmpty ||
        id.length > 200 ||
        from.isAfter(now())) {
      throw StateError('invalid_source');
    }
    final existing = data['sources'][id];
    final expandHistory =
        requireAllAccessible && existing?['full_history'] != true;
    if (existing != null && !updateRange && !expandHistory) return;
    if (updateRange) {
      (data['messages'] as Map).removeWhere(
        (_, message) =>
            message['chat_id'] == id &&
            message['created_at'] < from.millisecondsSinceEpoch,
      );
    }
    data['sources'][id] = {
      'scope_revision':
          (existing?['scope_revision'] as int? ??
              data['tombstones'][id] as int? ??
              0) +
          1,
      'paused': expandHistory && (existing?['paused'] == true),
      'from': from.toUtc().toIso8601String(),
      'history_from': from.toUtc().toIso8601String(),
      'full_history': requireAllAccessible,
      'metadata_revision': existing == null ? 1 : existing['metadata_revision'],
      'seen_pages': <String>[],
      'page_token': null,
      'window_end': null,
      'read_through': null,
    };
    data['grants'] = {};
    data['processing_revision'] = (data['processing_revision'] as int) + 1;
  }, authorize: authorize);
  Future<void> pause(String id, bool paused) => _write((data) {
    final source = data['sources'][id];
    if (source == null) throw StateError('source_missing');
    source['paused'] = paused;
    source['scope_revision'] = (source['scope_revision'] as int) + 1;
  });
  Future<void> remove(String id) => _write((data) {
    final source = (data['sources'] as Map).remove(id);
    if (source == null) return;
    data['tombstones'][id] = source['scope_revision'];
    (data['messages'] as Map).removeWhere((_, item) => item['chat_id'] == id);
    data['grants'] = {};
    data['processing_revision'] = (data['processing_revision'] as int) + 1;
  });
  Map<String, dynamic> checkpoint(String id) {
    final source = _data['sources'][id];
    if (source == null) throw StateError('source_missing');
    return copyJson(source);
  }

  Future<void> prepareWindow(
    String id,
    DateTime end, {
    bool head = false,
    void Function()? authorize,
  }) => _write((data) {
    final source = data['sources'][id];
    if (source == null ||
        source['paused'] == true ||
        data['identity'] == null) {
      throw StateError('source_paused');
    }
    if (source['metadata_revision'] != 1) {
      final boundary = DateTime.parse(source['history_from'] ?? source['from']);
      final recent = end.subtract(const Duration(days: 14));
      source['metadata'] ??= {
        'from': (recent.isBefore(boundary) ? boundary : recent)
            .toUtc()
            .toIso8601String(),
        'page_token': null,
        'window_end': end.toUtc().toIso8601String(),
        'seen_pages': <String>[],
        'order': 'desc',
      };
      return;
    }
    if (head && source['head'] == null) {
      final base = source['read_through'] ?? source['window_end'];
      if (base == null) throw StateError('source_missing_window');
      final overlap = DateTime.parse(base).subtract(const Duration(minutes: 1));
      final boundary = DateTime.parse(source['history_from'] ?? source['from']);
      source['head'] = {
        'from': (overlap.isBefore(boundary) ? boundary : overlap)
            .toUtc()
            .toIso8601String(),
        'page_token': null,
        'window_end': null,
        'seen_pages': <String>[],
        'order': 'desc',
      };
    }
    final cursor = head ? source['head'] : source;
    // Existing opaque tokens are tied to their original ascending window.
    cursor['order'] = cursor['window_end'] == null
        ? 'desc'
        : cursor['order'] ?? 'asc';
    cursor['window_end'] ??= end.toUtc().toIso8601String();
  }, authorize: authorize);

  Map<String, dynamic> fence(String id, {bool head = false}) {
    final source = checkpoint(id);
    if (source['paused'] == true || identity == null) {
      throw StateError('source_paused');
    }
    final metadata = source['metadata'] != null;
    final cursor = metadata
        ? source['metadata'] as Map
        : head
        ? source['head'] as Map
        : source;
    return {
      'identity': identity,
      'generation': generation,
      'chat_id': id,
      'scope_revision': source['scope_revision'],
      'head': head,
      'metadata': metadata,
      'page_token': cursor['page_token'],
      'from': cursor['from'],
      'window_end': cursor['window_end'],
      'order': cursor['order'],
    };
  }

  void _validateFence(
    Map<String, dynamic> data,
    Map<String, dynamic> expected,
  ) {
    final source = data['sources'][expected['chat_id']];
    final cursor = expected['metadata'] == true
        ? (source?['metadata'])
        : expected['head'] == true
        ? (source?['head'])
        : source;
    if (data['identity'] != expected['identity'] ||
        data['generation'] != expected['generation'] ||
        source == null ||
        cursor == null ||
        source['paused'] == true ||
        source['scope_revision'] != expected['scope_revision'] ||
        cursor['page_token'] != expected['page_token'] ||
        cursor['from'] != expected['from'] ||
        cursor['window_end'] != expected['window_end'] ||
        cursor['order'] != expected['order']) {
      throw StateError('stale_source');
    }
  }

  Future<void> ingestPage(
    Map<String, dynamic> expected,
    List<dynamic> messages, {
    required String? nextPage,
    required DateTime windowEnd,
    void Function()? authorize,
  }) => _write((data) {
    _validateFence(data, expected);
    final source = data['sources'][expected['chat_id']];
    final cursor = expected['metadata'] == true
        ? source['metadata']
        : expected['head'] == true
        ? source['head']
        : source;
    if (messages.length > 50 ||
        nextPage == '' ||
        (nextPage != null &&
            (nextPage == expected['page_token'] ||
                (cursor['seen_pages'] as List? ?? []).contains(nextPage)))) {
      throw StateError('invalid_page');
    }
    for (final raw in messages) {
      if (raw is Map &&
          raw['chat_id'] != null &&
          raw['chat_id'] != expected['chat_id']) {
        throw StateError('invalid_message_chat');
      }
      if (raw is! Map ||
          raw['message_id'] is! String ||
          (raw['message_id'] as String).isEmpty) {
        source['invalid_records'] =
            (source['invalid_records'] as int? ?? 0) + 1;
        continue;
      }
      final timestamp = int.tryParse('${raw['create_time']}');
      if (timestamp == null ||
          timestamp < 0 ||
          timestamp >
              now().add(const Duration(minutes: 5)).millisecondsSinceEpoch) {
        source['invalid_records'] =
            (source['invalid_records'] as int? ?? 0) + 1;
        continue;
      }
      String? text;
      var tooLarge = false;
      if (raw['deleted'] != true) {
        try {
          text = feishuMessageText(raw);
        } on FormatException catch (error) {
          tooLarge = const {
            'feishu_message_too_large',
            'feishu_message_structure_limit',
          }.contains(error.message);
        }
      }
      final id = lifeFingerprint({
        'identity': identity,
        'chat_id': expected['chat_id'],
        'message_id': raw['message_id'],
      });
      final sender = raw['sender'] is Map ? raw['sender'] as Map : null;
      final senderId =
          sender?['id_type'] == 'open_id' && sender?['id'] is String
          ? sender!['id'] as String
          : null;
      final senderType = const ['user', 'app'].contains(sender?['sender_type'])
          ? sender!['sender_type'] as String
          : 'unknown';
      final self = senderId != null && senderId == identity?.split(':').last;
      final mentions = raw['mentions'];
      final mentionIds = mentions is List
          ? mentions
                .whereType<Map>()
                .map((item) => item['id'])
                .whereType<String>()
                .where((id) => id.startsWith('ou_'))
                .take(50)
                .toList()
          : <String>[];
      final mention = self
          ? 'none'
          : mentions is! List
          ? 'unknown'
          : mentions.whereType<Map>().any(
              (item) =>
                  (item['id_type'] == null || item['id_type'] == 'open_id') &&
                  item['id'] == identity?.split(':').last,
            )
          ? 'direct'
          : mentions.whereType<Map>().any((item) => item['id'] == 'all')
          ? 'all'
          : 'none';
      data['messages'][id] = {
        'evidence_id': id,
        'identity': identity,
        'chat_id': expected['chat_id'],
        'message_id': raw['message_id'],
        'created_at': timestamp,
        'fetched_at': now().millisecondsSinceEpoch,
        'text': text,
        'sender_id': senderId,
        'sender_type': senderType,
        'mention': mention,
        'mention_ids': mentionIds,
        for (final key in [
          'parent_id',
          'root_id',
          'thread_id',
          'upper_message_id',
        ])
          if (raw[key] is String &&
              (raw[key] as String).isNotEmpty &&
              (raw[key] as String).length <= 256)
            key: raw[key],
        'relation': senderType == 'app'
            ? 'app'
            : self
            ? 'self'
            : mention == 'direct'
            ? 'addressed'
            : senderId != null
            ? 'participant'
            : 'unknown',
        'status': raw['deleted'] == true
            ? 'deleted'
            : tooLarge
            ? 'too_large'
            : text != null
            ? 'available'
            : const [
                'text',
                'post',
                'interactive',
              ].contains(raw['msg_type'] ?? raw['message_type'])
            ? 'missing_body'
            : 'unsupported_type',
      };
    }
    final seen = List<String>.from(cursor['seen_pages'] as List? ?? []);
    if (nextPage != null) seen.add(nextPage);
    cursor['seen_pages'] = nextPage == null ? <String>[] : seen;
    cursor['page_token'] = nextPage;
    cursor['window_end'] = nextPage == null
        ? null
        : windowEnd.toUtc().toIso8601String();
    if (nextPage == null) {
      cursor['read_through'] = windowEnd.toUtc().toIso8601String();
      if (expected['metadata'] == true) {
        source['metadata_revision'] = 1;
        source.remove('metadata');
      } else if (expected['head'] == true) {
        final overlap = windowEnd.subtract(const Duration(minutes: 1));
        final boundary = DateTime.parse(
          source['history_from'] ?? source['from'],
        );
        cursor['from'] = (overlap.isBefore(boundary) ? boundary : overlap)
            .toUtc()
            .toIso8601String();
        if (source['page_token'] == null &&
            source['window_end'] == null &&
            windowEnd.isAfter(DateTime.parse(source['from']))) {
          source['from'] = windowEnd.toUtc().toIso8601String();
          source['read_through'] = source['from'];
        }
      } else {
        final headThrough = DateTime.tryParse(
          source['head']?['read_through'] as String? ?? '',
        );
        final through = headThrough != null && headThrough.isAfter(windowEnd)
            ? headThrough
            : windowEnd;
        source['read_through'] = through.toUtc().toIso8601String();
        source['from'] = source['read_through'];
      }
    }
  }, authorize: authorize);
  void _prune(Map<String, dynamic> data, {bool refreshExpired = false}) {
    final cutoff = now()
        .subtract(const Duration(days: 30))
        .millisecondsSinceEpoch;
    final expiredChats = <String>{};
    (data['messages'] as Map).removeWhere((_, message) {
      if (sourceAccessTime(message) > cutoff) return false;
      expiredChats.add(message['chat_id'] as String);
      return true;
    });
    // Erase expired content immediately, but never rewrite a page's committed
    // cursor. Refresh history at the next explicit prune/collection boundary,
    // after any resumed pagination completes.
    for (final id in expiredChats) {
      final source = data['sources'][id];
      if (source != null) source['history_refresh_pending'] = true;
    }
    if (!refreshExpired) return;
    for (final source in (data['sources'] as Map).values) {
      if (source['history_refresh_pending'] != true ||
          source['page_token'] != null) {
        continue;
      }
      source.remove('history_refresh_pending');
      source['from'] = source['history_from'] ?? source['from'];
      source['page_token'] = null;
      source['window_end'] = null;
      source['read_through'] = null;
      source['seen_pages'] = <String>[];
      source['scope_revision'] = (source['scope_revision'] as int) + 1;
    }
  }

  Future<void> prune() => _write((_) {}, refreshExpired: true);

  ({Map<String, int> byStatus, Map<String, int> byChat}) get messageCounts {
    final counts = <String, int>{}, byChat = <String, int>{};
    final selected = _data['sources'] as Map;
    final invalid = selected.values.fold<int>(
      0,
      (sum, source) => sum + (source['invalid_records'] as int? ?? 0),
    );
    if (invalid > 0) counts['invalid_record'] = invalid;
    final cutoff = now()
        .subtract(const Duration(days: 30))
        .millisecondsSinceEpoch;
    for (final message in (_data['messages'] as Map).values) {
      if (!selected.containsKey(message['chat_id']) ||
          sourceAccessTime(message) <= cutoff) {
        continue;
      }
      final status = message['status'] as String;
      final chat = message['chat_id'] as String;
      counts[status] = (counts[status] ?? 0) + 1;
      byChat[chat] = (byChat[chat] ?? 0) + 1;
    }
    return (byStatus: counts, byChat: byChat);
  }

  Map<String, int> get statusCounts => messageCounts.byStatus;

  String get skippedSummary => skippedSummaryFor(statusCounts);

  String skippedSummaryFor(Map<String, int> counts) {
    const reasons = {
      'too_large': '正文超过16000字',
      'missing_body': '正文不可用',
      'unsupported_type': '非文本消息',
      'deleted': '消息已删除',
      'invalid_record': '消息记录格式异常',
    };
    return reasons.entries
        .where((entry) => (counts[entry.key] ?? 0) > 0)
        .map((entry) => '${counts[entry.key]} 条${entry.value}')
        .join('；');
  }

  List<Map<String, dynamic>> messages(String id) => (_data['messages'] as Map)
      .values
      .where(
        (m) =>
            m['chat_id'] == id &&
            sourceAccessTime(m) >
                now().subtract(const Duration(days: 30)).millisecondsSinceEpoch,
      )
      .map((m) => _copySourceMessage(m))
      .toList();

  /// Resolve only the referenced originals, rechecking access on every read.
  List<Map<String, dynamic>> messagesByEvidenceIds(Iterable<Object?> ids) {
    final cutoff = now()
        .subtract(const Duration(days: 30))
        .millisecondsSinceEpoch;
    final stored = _data['messages'] as Map;
    final selected = _data['sources'] as Map;
    final result = <Map<String, dynamic>>[];
    for (final id in ids.whereType<String>().toSet()) {
      final message = stored[id];
      if (message is Map<String, dynamic> &&
          message['evidence_id'] == id &&
          selected.containsKey(message['chat_id']) &&
          sourceAccessTime(message) > cutoff) {
        result.add(_copySourceMessage(message));
      }
    }
    return result;
  }

  Future<void> grantProcessing(String provider, String purpose, bool enabled) =>
      _write((data) {
        if (provider.isEmpty ||
            purpose != 'profile' ||
            enabled && sources.isEmpty) {
          throw StateError('invalid_processing_grant');
        }
        final key = lifeFingerprint({'provider': provider, 'purpose': purpose});
        // Explicitly stopping processing survives restarts and source changes.
        // Older stores have no decision marker and use the product default.
        data['processing_disabled'] = !enabled;
        if (enabled) {
          data['grants'][key] = {'provider': provider, 'purpose': purpose};
        } else {
          data['grants'] = {};
        }
        data['processing_revision'] = (data['processing_revision'] as int) + 1;
      });

  /// Apply the default only to the configured model before starting a round.
  /// Validation within a running round never creates or renews permissions.
  Future<void> enableDefaultProcessing(String provider) => _write((data) {
    if (provider.isEmpty) throw StateError('invalid_processing_grant');
    if (data['processing_disabled'] == true ||
        (data['sources'] as Map).isEmpty) {
      return;
    }
    final key = lifeFingerprint({'provider': provider, 'purpose': 'profile'});
    if ((data['grants'] as Map).containsKey(key)) return;
    data['grants'][key] = {'provider': provider, 'purpose': 'profile'};
    data['processing_revision'] = (data['processing_revision'] as int) + 1;
  });
  void validateProcessing(String provider, String purpose, int expected) {
    if (expected != processingRevision ||
        !_data['grants'].containsKey(
          lifeFingerprint({'provider': provider, 'purpose': purpose}),
        )) {
      throw StateError('processing_consent_required');
    }
  }

  List<Map<String, dynamic>> readAuthorizedEvidence(
    String provider,
    String purpose,
  ) {
    validateProcessing(provider, purpose, processingRevision);
    return _readSourceEvidence((
      data: _data,
      cutoff: now().subtract(const Duration(days: 30)).millisecondsSinceEpoch,
    ));
  }

  Future<List<Map<String, dynamic>>> readAuthorizedEvidenceAsync(
    String provider,
    String purpose,
  ) async {
    final expectedIdentity = identity,
        expectedGeneration = generation,
        expectedRevision = revision,
        consent = processingRevision;
    validateProcessing(provider, purpose, consent);
    final input = (
      data: _data,
      cutoff: now().subtract(const Duration(days: 30)).millisecondsSinceEpoch,
    );
    final rows = _largeSourceSnapshot(_data)
        ? await compute(_readSourceEvidence, input)
        : _readSourceEvidence(input);
    validateProcessing(provider, purpose, consent);
    if (_disposed ||
        identity != expectedIdentity ||
        generation != expectedGeneration ||
        revision != expectedRevision) {
      throw StateError('stale_inputs');
    }
    final cutoff = now()
        .subtract(const Duration(days: 30))
        .millisecondsSinceEpoch;
    return rows.where((message) => sourceAccessTime(message) > cutoff).toList();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
