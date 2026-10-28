import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'space_storage.dart';

Map<String, dynamic> _copy(Map value) =>
    Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);

/// Only Host projections are authoritative. Pending edits are separate and are
/// retained through conflicts, process death, and transport retries.
class SpaceClientState extends ChangeNotifier {
  SpaceClientState(this.persistence);
  final SpacePersistence persistence;
  Map<String, dynamic> snapshot = {};
  final List<Map<String, dynamic>> pending = [];
  final Map<String, Map<String, dynamic>> previews = {};
  final List<Map<String, dynamic>> messages = [];
  final Map<String, Map<String, dynamic>> chatRequests = {};
  final Map<String, Map<String, dynamic>> clientSources = {};
  final Map<String, Map<String, dynamic>> effects = {};
  final Set<String> completedOperations = {};
  final Map<String, Map<String, dynamic>> chunks = {};
  int cursor = 0;
  bool hostOnline = false;
  String? error;
  Future<void> _tail = Future.value();
  bool _disposed = false;
  void changed() {
    if (!_disposed) notifyListeners();
  }

  Future<T> transaction<T>(Future<T> Function() body) {
    final result = _tail.then((_) => body());
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<void> open() async {
    final raw = await persistence.read();
    if (raw != null) {
      final value = jsonDecode(raw) as Map;
      snapshot = _copy(value['snapshot'] as Map? ?? {});
      pending.addAll(
        (value['pending'] as List? ?? []).map((v) => _copy(v as Map)),
      );
      messages.addAll(
        (value['messages'] as List? ?? []).map((v) => _copy(v as Map)),
      );
      clientSources.addAll(
        (value['client_sources'] as Map? ?? {}).map(
          (k, v) => MapEntry(k as String, _copy(v as Map)),
        ),
      );
      chatRequests.addAll(
        (value['chat_requests'] as Map? ?? {}).map(
          (k, v) => MapEntry(k as String, _copy(v as Map)),
        ),
      );
      for (final request in chatRequests.values) {
        if (['sending', 'sent'].contains(request['status'])) {
          request['status'] = 'unknown';
        }
      }
      for (final message in messages) {
        if (message['role'] == 'user' &&
            chatRequests[message['turn_id']]?['status'] == 'unknown') {
          message['status'] = 'unknown';
        }
      }
      effects.addAll(
        (value['effects'] as Map? ?? {}).map(
          (k, v) => MapEntry(k as String, _copy(v as Map)),
        ),
      );
      completedOperations.addAll(
        (value['completed'] as List? ?? []).cast<String>(),
      );
      cursor = value['cursor'] as int? ?? 0;
      chunks.addAll(
        (value['chunks'] as Map? ?? {}).map(
          (k, v) => MapEntry(k as String, _copy(v as Map)),
        ),
      );
      // A process died after durable admission but before a durable receipt.
      // The system effect may already have happened; never repeat it.
      for (final entry in effects.values) {
        if (entry['status'] == 'executing') {
          entry.addAll({'status': 'unknown', 'error': 'interrupted_effect'});
        }
      }
      await save();
    }
    changed();
  }

  Future<void> save() => persistence.write(
    jsonEncode({
      'v': 1,
      'snapshot': snapshot,
      'pending': pending,
      'messages': messages,
      'chat_requests': chatRequests,
      'client_sources': clientSources,
      'effects': effects,
      'cursor': cursor,
      'completed': completedOperations.toList(),
      'chunks': chunks,
    }),
  );
  List<Map<String, dynamic>> cards(String collection) =>
      (snapshot[collection] as List? ?? [])
          .whereType<Map>()
          .map((v) => Map<String, dynamic>.from(v))
          .toList();
  Future<String> enqueue(
    String kind,
    Map<String, dynamic> input, {
    String? tempId,
    List<String> dependsOn = const [],
    int? baseVersion,
    String? operationId,
  }) => transaction(() async {
    if (kind == 'chat.send' || kind == 'chat.cancel') {
      throw StateError('chat_is_online_only');
    }
    final id = operationId ?? newSpaceId();
    if (completedOperations.contains(id) ||
        pending.any((p) => p['op_id'] == id)) {
      return id;
    }
    pending.add({
      'v': 1,
      'type': 'intent',
      'op_id': id,
      'kind': kind,
      'input': _copy(input),
      'created_at': DateTime.now().millisecondsSinceEpoch,
      'temp_id': ?tempId,
      if (dependsOn.isNotEmpty) 'depends_on': dependsOn,
      'base_version': ?baseVersion,
      'status': 'pending',
    });
    await save();
    changed();
    return id;
  });
  Map<String, dynamic> wireIntent(Map<String, dynamic> intent) => {
    for (final key in [
      'v',
      'type',
      'op_id',
      'kind',
      'input',
      'created_at',
      'expires_at',
      'base_version',
      'temp_id',
      'depends_on',
    ])
      if (intent.containsKey(key)) key: intent[key],
  };
  Future<void> discard(String opId) => transaction(() async {
    // Dependent edits are retained for explicit user resolution too.
    pending.removeWhere((p) => p['op_id'] == opId);
    for (final p in pending) {
      if ((p['depends_on'] as List? ?? []).contains(opId)) {
        p.addAll({'status': 'rejected', 'error': 'dependency_discarded'});
      }
    }
    await save();
    changed();
  });
  Future<void> acceptHostVersion(String opId) => discard(opId);
  Future<String> collectSource({
    required String name,
    required String text,
    required String provider,
    required bool allowProcessing,
    String? sourceId,
  }) => transaction(() async {
    if (text.trim().isEmpty ||
        text.length > 16000 ||
        provider.isEmpty ||
        provider.length > 256) {
      throw StateError('invalid_source_input');
    }
    final id = sourceId ?? newSpaceId(),
        grantId = newSpaceId(),
        factId = newSpaceId();
    final previous = clientSources[id];
    final revision = (previous?['revision'] as int? ?? 0) + 1;
    final sourceVersion = (previous?['source_version'] as int? ?? 0) + 1;
    clientSources[id] = {
      'id': id,
      'name': name,
      'provider': provider,
      'revision': revision,
      'source_version': sourceVersion,
      'status': 'pending',
      'allow_processing': allowProcessing,
    };
    final now = DateTime.now().millisecondsSinceEpoch;
    pending.add({
      'v': 1,
      'type': 'intent',
      'op_id': grantId,
      'kind': 'source.input',
      'created_at': now,
      'status': 'pending',
      'input': {
        'kind': 'grant',
        'source_id': id,
        'revision': revision,
        'provider': provider,
        'allow_upload': true,
        'allow_processing': allowProcessing,
      },
    });
    pending.add({
      'v': 1,
      'type': 'intent',
      'op_id': factId,
      'kind': 'source.input',
      'created_at': now,
      'status': 'pending',
      'depends_on': [grantId],
      'input': {
        'kind': 'source_fact',
        'source_id': id,
        'grant_revision': revision,
        'resource_id': 'manual_$id',
        'source_version': '$sourceVersion',
        'text': text.trim(),
        'relation': 'self',
        'occurred_at': DateTime.now().toUtc().toIso8601String(),
      },
    });
    await save();
    changed();
    return id;
  });
  Future<void> revokeSource(String id, {bool delete = false}) =>
      transaction(() async {
        final source = clientSources[id];
        if (source == null) throw StateError('unknown_source');
        pending.removeWhere(
          (p) =>
              p['kind'] == 'source.input' &&
              (p['input'] as Map)['source_id'] == id &&
              p['envelope'] == null,
        );
        final revision = (source['revision'] as int) + 1, op = newSpaceId();
        source.addAll({
          'revision': revision,
          'status': delete ? 'deleting' : 'revoking',
          'allow_processing': false,
        });
        pending.add({
          'v': 1,
          'type': 'intent',
          'op_id': op,
          'kind': 'source.input',
          'created_at': DateTime.now().millisecondsSinceEpoch,
          'status': 'pending',
          'input': {
            'kind': 'grant',
            'source_id': id,
            'revision': revision,
            'provider': source['provider'],
            'allow_upload': false,
            'allow_processing': false,
          },
        });
        if (delete) {
          pending.add({
            'v': 1,
            'type': 'intent',
            'op_id': newSpaceId(),
            'kind': 'source.input',
            'created_at': DateTime.now().millisecondsSinceEpoch,
            'status': 'pending',
            'depends_on': [op],
            'input': {'kind': 'delete_source', 'source_id': id},
          });
        }
        await save();
        changed();
      });
  Future<void> beginChat(String id, String text, int now) =>
      transaction(() async {
        chatRequests[id] = {'status': 'sending', 'created_at': now};
        messages.add({
          'id': 'user_$id',
          'turn_id': id,
          'role': 'user',
          'conversation_id': 'chat:main',
          'text': text,
          'created_at': now,
          'status': 'sending',
        });
        await save();
        changed();
      });
  Future<void> markChat(String id, String status, {String? error}) =>
      transaction(() async {
        final request = chatRequests[id];
        if (request == null) return;
        if (['sending', 'sent', 'unknown'].contains(request['status'])) {
          request.addAll({'status': status, 'error': ?error});
        }
        for (final message in messages) {
          if (message['role'] == 'user' && message['turn_id'] == id) {
            message['status'] = request['status'];
          }
        }
        await save();
        changed();
      });
  Future<void> apply(
    Map<String, dynamic> event, {
    int? sequence,
  }) => transaction(() async {
    if (event['v'] != 1) throw StateError('unsupported_business_version');
    switch (event['type']) {
      case 'snapshot.chunk':
        _chunk(event);
      case 'snapshot':
        _replaceSnapshot(_copy(event['snapshot'] as Map));
      case 'receipt':
        _receipt(event);
      case 'chat.delta':
        final id = event['op_id'] as String;
        if (!messages.any(
              (m) => m['turn_id'] == id && m['role'] == 'assistant',
            ) &&
            (event['sequence'] as int? ?? 0) >
                (previews[id]?['sequence'] as int? ?? -1)) {
          previews[id] = _copy(event);
        }
      case 'chat.final':
        final id = event['message_id'] as String;
        previews.remove(event['op_id']);
        chatRequests[event['op_id']]?.addAll({'status': event['status']});
        final item = {
          'id': id,
          'turn_id': event['op_id'],
          'conversation_id': event['conversation_id'],
          'role': 'assistant',
          'text': event['text'],
          'status': event['status'],
        };
        final existing = messages.indexWhere((m) => m['id'] == id);
        if (existing < 0) {
          messages.add(item);
        } else {
          messages[existing] = item;
        }
      case 'notification':
        final cards = this.cards('notifications');
        cards.removeWhere((c) => c['id'] == event['id']);
        cards.add(_copy(event));
        snapshot['notifications'] = cards;
      default:
        // Additive unknown business events are safe to skip after authentication.
        break;
    }
    if (sequence != null && sequence > cursor) cursor = sequence;
    await save();
    changed();
  });
  void _chunk(Map<String, dynamic> event) {
    final id = event['snapshot_id'] as String;
    final index = event['index'] as int, total = event['total'] as int;
    final data = event['data'] as String;
    if (total < 1 ||
        total > 512 ||
        index < 0 ||
        index >= total ||
        utf8.encode(data).length > 96 * 1024) {
      throw StateError('invalid_snapshot_chunk');
    }
    if (!chunks.containsKey(id) && chunks.length >= 2) {
      chunks.remove(chunks.keys.first);
    }
    final group = chunks.putIfAbsent(
      id,
      () => {'total': total, 'parts': <String, dynamic>{}, 'bytes': 0},
    );
    if (group['total'] != total) throw StateError('snapshot_chunk_mismatch');
    final parts = group['parts'] as Map;
    if (parts.containsKey('$index') && parts['$index'] != data) {
      throw StateError('snapshot_chunk_conflict');
    }
    final bytes =
        (group['bytes'] as int? ??
            parts.values.fold<int>(
              0,
              (n, v) => n + utf8.encode(v as String).length,
            )) +
        (parts.containsKey('$index') ? 0 : utf8.encode(data).length);
    if (bytes > 16 * 1024 * 1024) throw StateError('snapshot_too_large');
    group['bytes'] = bytes;
    parts['$index'] = data;
    if (parts.length == total) {
      final serialized = List.generate(
        total,
        (i) => parts['$i'] as String,
      ).join();
      if (utf8.encode(serialized).length > 16 * 1024 * 1024) {
        throw StateError('snapshot_too_large');
      }
      _replaceSnapshot(_copy(jsonDecode(serialized) as Map));
      chunks.remove(id);
    }
  }

  void _replaceSnapshot(Map<String, dynamic> value) {
    if (value['schema_version'] != 1) {
      throw StateError('unsupported_display_version');
    }
    if ((value['revision'] as int? ?? 0) <
        (snapshot['revision'] as int? ?? 0)) {
      return;
    }
    final processing = value['source_processing'];
    snapshot = {
      for (final key in [
        'schema_version',
        'revision',
        'goals',
        'todos',
        'ideas',
        'profile',
        'timeline',
        'feed',
        'notifications',
        'chat',
        'processing_provider',
      ])
        if (value.containsKey(key)) key: value[key],
      if (processing is Map)
        'source_processing': {
          'status':
              const [
                'idle',
                'working',
                'ready',
                'failed',
              ].contains(processing['status'])
              ? processing['status']
              : 'idle',
          'needs_update': processing['needs_update'] == true,
        },
    };
    for (final raw in (value['chat'] as List? ?? []).whereType<Map>()) {
      final item = _copy(raw);
      final index = messages.indexWhere(
        (m) =>
            m['id'] == item['id'] ||
            (item['turn_id'] != null &&
                m['turn_id'] == item['turn_id'] &&
                m['role'] == item['role']),
      );
      if (index < 0) {
        messages.add(item);
      } else {
        messages[index] = item;
      }
      if (item['role'] == 'assistant') previews.remove(item['turn_id']);
    }
  }

  void _receipt(Map<String, dynamic> event) {
    final opId = event['op_id'];
    final chatRequest = chatRequests[opId];
    if (chatRequest != null) {
      chatRequest.addAll({
        'status': event['status'] == 'accepted'
            ? 'accepted'
            : event['status'] == 'pending'
            ? 'sent'
            : 'failed',
        'error': event['error'],
      });
      for (final message in messages) {
        if (message['turn_id'] == opId && message['role'] == 'user') {
          message.addAll({
            'status': chatRequest['status'],
            'error': event['error'],
          });
        }
      }
    }
    final item = pending.where((p) => p['op_id'] == opId).firstOrNull;
    if (event['snapshot'] is Map) {
      _replaceSnapshot(_copy(event['snapshot'] as Map));
    }
    if (item == null) return;
    if (item['kind'] == 'source.input') {
      final input = item['input'] as Map;
      final source = clientSources[input['source_id']];
      if (source != null) {
        if (event['status'] == 'accepted') {
          if (input['kind'] == 'source_fact') source['status'] = 'accepted';
          if (input['kind'] == 'grant' && input['allow_upload'] == false) {
            source['status'] = 'revoked';
          }
          if (input['kind'] == 'delete_source') source['status'] = 'deleted';
        } else if (event['status'] == 'conflict' ||
            event['status'] == 'rejected') {
          source['status'] = event['status'];
          source['error'] = event['error'];
        }
      }
    }
    if (event['status'] == 'accepted') {
      completedOperations.add(opId as String);
      pending.remove(item);
      final remaps = event['id_map'] as Map? ?? {};
      for (final p in pending) {
        // Sent wire bodies are immutable. Host also performs dependency remap.
        if (p['envelope'] == null) {
          p['input'] = _remap(_copy(p['input'] as Map), remaps);
        }
      }
    } else if (event['status'] == 'conflict' || event['status'] == 'rejected') {
      item['status'] = event['status'];
      item['error'] = event['error'];
    }
  }

  Map<String, dynamic> _remap(Map<String, dynamic> input, Map remaps) {
    for (final key in ['id', 'goal_id', 'idea_id']) {
      if (remaps.containsKey(input[key])) input[key] = remaps[input[key]];
    }
    return input;
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
