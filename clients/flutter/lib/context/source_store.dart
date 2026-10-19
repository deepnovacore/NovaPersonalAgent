import 'dart:convert';
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

/// Bounded encrypted snapshots in production. A page and checkpoint commit
/// together; storage exhaustion stops ingestion without advancing the cursor.
class SourceStore extends ChangeNotifier {
  SourceStore(
    this.persistence, {
    DateTime Function()? now,
    this.onInvalidated,
    this.maxBytes = 16 * 1024 * 1024,
  }) : now = now ?? DateTime.now;
  final Future<void> Function()? onInvalidated;
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
      final value = jsonDecode(raw) as Map<String, dynamic>;
      if (value['version'] != 1) throw StateError('source_schema');
      _data = value;
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
  }) {
    final result = _tail.then((_) async {
      if (_disposed) throw StateError('source_disposed');
      final next = copyJson(_data);
      // Pin legacy selection boundaries before any cursor advances. The old
      // fingerprint uses this same fallback, so migration preserves paid work.
      for (final source in (next['sources'] as Map).values) {
        source['history_from'] ??= source['from'];
      }
      change(next);
      _prune(next, refreshExpired: refreshExpired);
      if (lifeFingerprint(next) == lifeFingerprint(_data)) return;
      final processingChanged =
          _processingFingerprint(next) != _processingFingerprint(_data);
      if (processingChanged) next['revision'] = (next['revision'] as int) + 1;
      final encoded = jsonEncode(next);
      if (utf8.encode(encoded).length > maxBytes) {
        throw StateError('source_storage_full');
      }
      await persistence.write(encoded);
      _data = next;
      if (processingChanged) await onInvalidated?.call();
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
      'seen_pages': <String>[],
      'page_token': null,
      'window_end': null,
      'read_through': null,
    };
    data['grants'] = {};
    data['processing_revision'] = (data['processing_revision'] as int) + 1;
  });
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

  Map<String, dynamic> fence(String id) {
    final source = checkpoint(id);
    if (source['paused'] == true || identity == null) {
      throw StateError('source_paused');
    }
    return {
      'identity': identity,
      'generation': generation,
      'chat_id': id,
      'scope_revision': source['scope_revision'],
      'page_token': source['page_token'],
      'from': source['from'],
    };
  }

  void _validateFence(
    Map<String, dynamic> data,
    Map<String, dynamic> expected,
  ) {
    final source = data['sources'][expected['chat_id']];
    if (data['identity'] != expected['identity'] ||
        data['generation'] != expected['generation'] ||
        source == null ||
        source['paused'] == true ||
        source['scope_revision'] != expected['scope_revision'] ||
        source['page_token'] != expected['page_token'] ||
        source['from'] != expected['from']) {
      throw StateError('stale_source');
    }
  }

  Future<void> ingestPage(
    Map<String, dynamic> expected,
    List<dynamic> messages, {
    required String? nextPage,
    required DateTime windowEnd,
  }) => _write((data) {
    _validateFence(data, expected);
    if (messages.length > 50 ||
        nextPage == '' ||
        (nextPage != null &&
            (nextPage == expected['page_token'] ||
                (data['sources'][expected['chat_id']]['seen_pages'] as List? ??
                        [])
                    .contains(nextPage)))) {
      throw StateError('invalid_page');
    }
    for (final raw in messages) {
      if (raw is! Map ||
          raw['message_id'] is! String ||
          (raw['message_id'] as String).isEmpty) {
        throw StateError('invalid_message');
      }
      final timestamp = int.tryParse('${raw['create_time']}');
      if (timestamp == null) throw StateError('invalid_message_time');
      if (timestamp < 0 ||
          timestamp >
              now().add(const Duration(minutes: 5)).millisecondsSinceEpoch) {
        throw StateError('invalid_message_time');
      }
      String? text;
      if (raw['deleted'] != true && raw['msg_type'] == 'text') {
        try {
          final content = jsonDecode(raw['body']['content'] as String);
          if (content['text'] is String) text = content['text'] as String;
        } catch (_) {
          /* Explicit missing-body state below. */
        }
      }
      final tooLarge = text != null && text.length > 16000;
      if (tooLarge) text = null;
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
      data['messages'][id] = {
        'evidence_id': id,
        'identity': identity,
        'chat_id': expected['chat_id'],
        'message_id': raw['message_id'],
        'created_at': timestamp,
        'fetched_at': now().millisecondsSinceEpoch,
        'text': text,
        'sender_id': senderId,
        'relation': senderId == null
            ? 'unknown'
            : senderId == identity?.split(':').last
            ? 'self'
            : 'participant',
        'status': raw['deleted'] == true
            ? 'deleted'
            : tooLarge
            ? 'too_large'
            : text != null
            ? 'available'
            : raw['msg_type'] == 'text'
            ? 'missing_body'
            : 'unsupported_type',
      };
    }
    final source = data['sources'][expected['chat_id']];
    final seen = List<String>.from(source['seen_pages'] as List? ?? []);
    if (nextPage != null) seen.add(nextPage);
    source['seen_pages'] = nextPage == null ? <String>[] : seen;
    source['page_token'] = nextPage;
    source['window_end'] = nextPage == null
        ? null
        : windowEnd.toUtc().toIso8601String();
    if (nextPage == null) {
      source['read_through'] = windowEnd.toUtc().toIso8601String();
      source['from'] = windowEnd.toUtc().toIso8601String();
    }
  });
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

  Map<String, int> get statusCounts {
    final counts = <String, int>{};
    for (final message in sources.expand(messages)) {
      final status = message['status'] as String;
      counts.update(status, (count) => count + 1, ifAbsent: () => 1);
    }
    return counts;
  }

  String get skippedSummary {
    const reasons = {
      'too_large': '正文超过16000字',
      'missing_body': '正文不可用',
      'unsupported_type': '非文本消息',
      'deleted': '消息已删除',
    };
    final counts = statusCounts;
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
      .map((m) => copyJson(m))
      .toList();
  Future<void> grantProcessing(String provider, String purpose, bool enabled) =>
      _write((data) {
        if (provider.isEmpty || purpose != 'profile' || sources.isEmpty) {
          throw StateError('invalid_processing_grant');
        }
        final key = lifeFingerprint({'provider': provider, 'purpose': purpose});
        if (enabled) {
          data['grants'][key] = {'provider': provider, 'purpose': purpose};
        } else {
          (data['grants'] as Map).remove(key);
        }
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
    return sources
        .expand(messages)
        .where((m) => m['status'] == 'available')
        .toList()
      ..sort(
        (a, b) => (a['created_at'] as int).compareTo(b['created_at'] as int),
      );
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
