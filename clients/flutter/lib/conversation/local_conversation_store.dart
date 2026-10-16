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

  Future<String> create({required bool computerConnected}) => _write((data) {
    final id = requestId();
    (data['conversations'] as List).add({
      'id': id,
      'backend': computerConnected ? 'computer' : 'local',
      'messages': <dynamic>[],
    });
    return id;
  });

  Map<String, dynamic> conversation(String id) =>
      conversations.firstWhere((e) => e['id'] == id);

  Future<void> selectBackend(String id, String backend) => _write((data) {
    if (!['computer', 'local'].contains(backend)) {
      throw ArgumentError('invalid_backend');
    }
    (data['conversations'] as List).firstWhere(
      (e) => e['id'] == id,
    )['backend'] = backend;
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
        (item['messages'] as List).add({
          ...message,
          'time': DateTime.now().toUtc().toIso8601String(),
        });
      });
}
