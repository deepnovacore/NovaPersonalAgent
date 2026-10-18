import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';

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
    await prune();
  }

  Future<void> _write(void Function(Map<String, dynamic>) change) {
    final result = _tail.then((_) async {
      if (_disposed) throw StateError('source_disposed');
      final next = copyJson(_data);
      change(next);
      _prune(next);
      if (lifeFingerprint(next) == lifeFingerprint(_data)) return;
      next['revision'] = (next['revision'] as int) + 1;
      final encoded = jsonEncode(next);
      if (utf8.encode(encoded).length > maxBytes) {
        throw StateError('source_storage_full');
      }
      await persistence.write(encoded);
      _data = next;
      await onInvalidated?.call();
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
    if (existing != null && !updateRange) return;
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
      'paused': false,
      'from': from.toUtc().toIso8601String(),
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
        (nextPage != null && nextPage == expected['page_token'])) {
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
      if (timestamp <
          now().subtract(const Duration(days: 30)).millisecondsSinceEpoch) {
        continue;
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
      if (text != null && text.length > 16000) {
        throw StateError('message_too_large');
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
      data['messages'][id] = {
        'evidence_id': id,
        'identity': identity,
        'chat_id': expected['chat_id'],
        'message_id': raw['message_id'],
        'created_at': timestamp,
        'text': text,
        'sender_id': senderId,
        'relation': senderId == null
            ? 'unknown'
            : senderId == identity?.split(':').last
            ? 'self'
            : 'participant',
        'status': raw['deleted'] == true
            ? 'deleted'
            : text != null
            ? 'available'
            : raw['msg_type'] == 'text'
            ? 'missing_body'
            : 'unsupported_type',
      };
    }
    final source = data['sources'][expected['chat_id']];
    source['page_token'] = nextPage;
    source['window_end'] = nextPage == null
        ? null
        : windowEnd.toUtc().toIso8601String();
    if (nextPage == null) {
      source['read_through'] = windowEnd.toUtc().toIso8601String();
      source['from'] = windowEnd.toUtc().toIso8601String();
    }
  });
  void _prune(Map<String, dynamic> data) {
    final cutoff = now()
        .subtract(const Duration(days: 30))
        .millisecondsSinceEpoch;
    (data['messages'] as Map).removeWhere(
      (_, message) => message['created_at'] < cutoff,
    );
  }

  Future<void> prune() => _write((_) {});
  List<Map<String, dynamic>> messages(String id) => (_data['messages'] as Map)
      .values
      .where(
        (m) =>
            m['chat_id'] == id &&
            m['created_at'] >=
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
