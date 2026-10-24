import 'dart:convert';
import '../personal/local_life.dart';
import '../protocol/request_id.dart';

class ConversationStore {
  ConversationStore(this.persistence);
  final LifePersistence persistence;
  Map<String, dynamic> _data = {
    'schema_version': 1,
    'conversations': <dynamic>[],
  };
  Future<void> _tail = Future.value();
  bool _ready = false;

  List<Map<String, dynamic>> get conversations =>
      (jsonDecode(jsonEncode(_data['conversations'])) as List)
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();

  Future<void> open() async {
    final raw = await persistence.read();
    if (raw != null) {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      if (data['schema_version'] != 1) {
        throw const FormatException('unsupported_conversation_schema');
      }
      final conversations = data['conversations'] as List;
      for (final item in conversations) {
        if (item is! Map ||
            item['id'] is! String ||
            !['computer', 'local'].contains(item['backend']) ||
            item['messages'] is! List) {
          throw const FormatException('invalid_conversation');
        }
        for (final message in item['messages'] as List) {
          if (message is! Map ||
              !['user', 'assistant', 'tool'].contains(message['role']) ||
              message['content'] is! String ||
              message['time'] is! String) {
            throw const FormatException('invalid_conversation_message');
          }
        }
      }
      final repaired = _recover(data);
      if (repaired) await persistence.write(jsonEncode(data));
      _data = data;
    }
    _ready = true;
  }

  Future<void> recoverInterruptedCalls() => _write((data) {
    _recover(data);
  });

  bool _recover(Map<String, dynamic> data) {
    var repaired = false;
    for (final item in data['conversations'] as List) {
      if (item['backend'] == 'computer') {
        item['backend'] = 'local';
        repaired = true;
      }
      final deliveries = item['voice_deliveries'];
      if (deliveries is Map) {
        for (final value in deliveries.values) {
          if (value['injection'] == 'pending') {
            value['injection'] = 'unknown';
            repaired = true;
          }
          if (value['activation'] == 'deferred' ||
              value['activation'] == 'requested') {
            value['activation'] = 'interrupted';
            repaired = true;
          }
        }
      }
      final pending = <String>{};
      final recovered = <dynamic>[];
      void closePending() {
        for (final id in pending) {
          recovered.add({
            'role': 'tool',
            'tool_call_id': id,
            'content': jsonEncode({
              'untrusted': true,
              'status': 'outcome_unknown',
            }),
            'time': DateTime.now().toUtc().toIso8601String(),
          });
          repaired = true;
        }
        pending.clear();
      }

      for (final message in item['messages'] as List) {
        if (message['role'] != 'tool') closePending();
        recovered.add(message);
        if (message['tool_calls'] is List) {
          for (final call in message['tool_calls'] as List) {
            if (call is! Map ||
                call['id'] is! String ||
                (call['id'] as String).isEmpty) {
              throw const FormatException('invalid_tool_call');
            }
            pending.add(call['id'] as String);
          }
        }
        if (message['role'] == 'tool') {
          pending.remove(message['tool_call_id']);
        }
      }
      closePending();
      final active = item.remove('active_turn');
      if (active is Map) {
        recovered.add({
          'role': 'assistant',
          'content': active['draft'] is String ? active['draft'] : '',
          'interrupted': true,
          'error': 'process_interrupted',
          'progress': active,
          'time': DateTime.now().toUtc().toIso8601String(),
        });
        repaired = true;
      }
      item['messages'] = recovered;
    }
    return repaired;
  }

  Future<T> _write<T>(T Function(Map<String, dynamic>) change) {
    final result = _tail.then((_) async {
      if (!_ready) throw StateError('conversation_store_not_open');
      final next = jsonDecode(jsonEncode(_data)) as Map<String, dynamic>;
      final value = change(next);
      await persistence.write(jsonEncode(next));
      _data = next;
      return value;
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  static const mainId = 'chat:main';

  Future<String> ensureMain() => _write((data) {
    final rows = data['conversations'] as List;
    if (!rows.any((row) => row['id'] == mainId)) {
      rows.add({'id': mainId, 'backend': 'local', 'messages': <dynamic>[]});
    }
    return mainId;
  });

  Future<String> taskForTodo(Map<String, dynamic> todo) => _write((data) {
    if (todo['id'] is! String ||
        (todo['id'] as String).isEmpty ||
        todo['title'] is! String) {
      throw const FormatException('invalid_source_todo');
    }
    final rows = data['conversations'] as List;
    final existing = rows
        .where((row) => row['source_todo']?['id'] == todo['id'])
        .firstOrNull;
    final row =
        existing ??
        {'id': requestId(), 'backend': 'local', 'messages': <dynamic>[]};
    row['title'] = todo['title'];
    row['source_todo'] ??= {'id': todo['id'], 'version': todo['version']};
    if (existing == null) rows.add(row);
    return row['id'] as String;
  });

  Future<String> create() => _write((data) {
    final id = requestId();
    (data['conversations'] as List).add({
      'id': id,
      'backend': 'local',
      'messages': <dynamic>[],
    });
    return id;
  });

  Map<String, dynamic> conversation(String id) =>
      conversations.firstWhere((e) => e['id'] == id);

  Future<void> checkpointTurn(String id, Map<String, dynamic> progress) =>
      _write((data) {
        final item = (data['conversations'] as List).firstWhere(
          (e) => e['id'] == id,
        );
        item['active_turn'] = {
          ...progress,
          'time': DateTime.now().toUtc().toIso8601String(),
        };
      });
  Future<void> endTurn(String id) => _write((data) {
    (data['conversations'] as List)
        .firstWhere((e) => e['id'] == id)
        .remove('active_turn');
  });

  /// Voice projections never enter a backbrain's tool call wire history.
  /// A late ASR final is inserted before the assistant response for its turn.
  Future<void> upsertVoiceMessage(
    String id, {
    required String itemId,
    required String role,
    required String text,
    required String turnId,
    bool interrupted = false,
    bool hasAudio = false,
    int? playedMs,
    bool transcriptFinal = true,
    bool inputOriginVerified = true,
  }) => _write((data) {
    if (!['user', 'assistant'].contains(role)) {
      throw ArgumentError('invalid_voice_role');
    }
    final item = (data['conversations'] as List).firstWhere(
      (e) => e['id'] == id,
    );
    final messages = item['messages'] as List;
    final found = messages.where((e) => e['voice_item'] == itemId).firstOrNull;
    final value = <String, dynamic>{
      'role': role,
      'content': text,
      'voice_item': itemId,
      'voice_turn': turnId,
      'interrupted': interrupted,
      'voice_audio': hasAudio,
      'voice_played_ms': ?playedMs,
      if (role == 'user') 'voice_transcript_final': transcriptFinal,
      if (role == 'user') 'voice_input_origin_verified': inputOriginVerified,
      'time': found?['time'] ?? DateTime.now().toUtc().toIso8601String(),
    };
    if (found != null) {
      found.addAll(value);
    } else {
      final before = role == 'user'
          ? messages.indexWhere(
              (e) => e['voice_turn'] == turnId && e['role'] == 'assistant',
            )
          : -1;
      if (before < 0) {
        messages.add(value);
      } else {
        messages.insert(before, value);
      }
    }
  });

  Future<void> recordVoiceDelivery(
    String id,
    String itemId, {
    String? injection,
    String? activation,
  }) => _write((data) {
    final conversation = (data['conversations'] as List).firstWhere(
      (e) => e['id'] == id,
    );
    final journal =
        conversation.putIfAbsent('voice_deliveries', () => <String, dynamic>{})
            as Map;
    final record =
        journal.putIfAbsent(itemId, () => <String, dynamic>{}) as Map;
    if (injection != null) record['injection'] = injection;
    if (activation != null) record['activation'] = activation;
  });

  Future<void> voicePlayback(
    String id,
    String itemId,
    int playedMs, {
    required bool interrupted,
  }) => _write((data) {
    final item = (data['conversations'] as List).firstWhere(
      (e) => e['id'] == id,
    );
    final message = (item['messages'] as List)
        .where((e) => e['voice_item'] == itemId)
        .firstOrNull;
    if (message != null) {
      message['voice_played_ms'] = playedMs;
      if (interrupted) message['interrupted'] = true;
    }
  });

  Future<void> append(String id, Map<String, dynamic> message) =>
      _write((data) {
        if (!['user', 'assistant', 'tool'].contains(message['role']) ||
            message['content'] is! String) {
          throw ArgumentError('invalid_message');
        }
        final item = (data['conversations'] as List).firstWhere(
          (e) => e['id'] == id,
        );
        if (message['role'] == 'assistant' && item['active_turn'] != null) {
          item['active_turn'] = {
            'draft': '',
            'time': DateTime.now().toUtc().toIso8601String(),
          };
        }
        (item['messages'] as List).add({
          ...message,
          'time': DateTime.now().toUtc().toIso8601String(),
        });
      });
}
