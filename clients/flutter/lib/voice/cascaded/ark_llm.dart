import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../../agent_core/model_client.dart';
import 'ports.dart';

/// Stateless Responses transport: provider-owned history is sent explicitly,
/// so a cancelled/tool-incomplete response cannot become a continuation anchor.
class ArkResponsesCascadeLlm implements CascadeLlm {
  ArkResponsesCascadeLlm({
    required this.configuration,
    this.timeout = const Duration(seconds: 30),
  }) {
    if (timeout <= Duration.zero) {
      throw const CascadeFailure('invalid_ark_configuration');
    }
  }
  final ModelConfiguration configuration;
  final Duration timeout;
  @override
  Stream<CascadeLlmDelta> generate(
    List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>> tools,
    CascadeCancellation cancel,
  ) async* {
    cancel.check();
    final instructions = <String>[],
        input = <Map<String, dynamic>>[],
        schema = <Map<String, dynamic>>[];
    for (final message in messages) {
      final role = message['role'];
      if (role == 'system') {
        if (message['content'] is! String) {
          throw const CascadeFailure('ark_protocol');
        }
        instructions.add(message['content'] as String);
      } else if (role == 'tool') {
        if (!_id(message['tool_call_id']) || message['content'] is! String) {
          throw const CascadeFailure('ark_protocol');
        }
        input.add({
          'type': 'function_call_output',
          'call_id': message['tool_call_id'],
          'output': message['content'],
        });
      } else if (role == 'user' || role == 'assistant') {
        final content = message['content'];
        if (content != null && content != '') {
          if (content is! String) throw const CascadeFailure('ark_protocol');
          input.add({'role': role, 'content': content});
        }
        for (final call in message['tool_calls'] as List? ?? []) {
          if (role != 'assistant' ||
              call is! Map ||
              !_id(call['id']) ||
              call['function'] is! Map) {
            throw const CascadeFailure('ark_protocol');
          }
          final fn = call['function'] as Map;
          if (!_id(fn['name']) || fn['arguments'] is! String) {
            throw const CascadeFailure('ark_protocol');
          }
          input.add({
            'type': 'function_call',
            'call_id': call['id'],
            'name': fn['name'],
            'arguments': fn['arguments'],
          });
        }
      } else {
        throw const CascadeFailure('ark_protocol');
      }
    }
    for (final tool in tools) {
      final fn = tool['function'];
      if (tool['type'] != 'function' ||
          fn is! Map ||
          !_id(fn['name']) ||
          fn['parameters'] is! Map ||
          (fn['description'] != null && fn['description'] is! String)) {
        throw const CascadeFailure('ark_protocol');
      }
      schema.add({
        'type': 'function',
        'name': fn['name'],
        'parameters': fn['parameters'],
        if (fn['description'] != null) 'description': fn['description'],
      });
    }
    final body = utf8.encode(
      jsonEncode({
        'model': configuration.model,
        'instructions': instructions.join('\n\n'),
        'input': input,
        'tools': schema,
        'parallel_tool_calls': false,
        'store': false,
        'stream': true,
        'thinking': {'type': 'disabled'},
      }),
    );
    if (body.length > 4 * 1024 * 1024) {
      throw const CascadeFailure('ark_overflow');
    }
    final http = HttpClient()..connectionTimeout = timeout;
    var expired = false;
    final stopped = Completer<void>();
    void stop() {
      http.close(force: true);
      if (!stopped.isCompleted) stopped.complete();
    }

    final remove = cancel.onCancel(stop);
    final timer = Timer(const Duration(minutes: 2), () {
      expired = true;
      stop();
    });
    Future<T> wait<T>(Future<T> future) => Future.any<T>([
      future,
      stopped.future.then<T>((_) {
        cancel.check();
        throw const CascadeFailure('ark_timeout');
      }),
    ]).timeout(timeout);
    try {
      final request = await wait(
        http.postUrl(Uri.parse(configuration.endpoint)),
      );
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      request.headers.set('Authorization', 'Bearer ${configuration.key}');
      request.headers.set('Accept', 'text/event-stream');
      request.add(body);
      final response = await wait(request.close());
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw const CascadeFailure('ark_http');
      }
      if (response.headers.contentType?.mimeType != 'text/event-stream') {
        throw const CascadeFailure('ark_protocol');
      }
      String? responseId;
      var textSeen = false, outputLength = 0;
      CascadeLlmDelta? pendingTool;
      await for (final event in _events(response.timeout(timeout), cancel)) {
        cancel.check();
        if (expired) throw const CascadeFailure('ark_timeout');
        final type = event['type'];
        if (type is! String) throw const CascadeFailure('ark_protocol');
        if (type == 'response.created') {
          final r = event['response'];
          if (responseId != null || r is! Map || !_id(r['id'])) {
            throw const CascadeFailure('ark_protocol');
          }
          responseId = r['id'] as String;
        } else if (type == 'response.output_text.delta') {
          final text = event['delta'];
          if (responseId == null || pendingTool != null || text is! String) {
            throw const CascadeFailure('ark_protocol');
          }
          outputLength += text.length;
          if (outputLength > 32000) throw const CascadeFailure('ark_overflow');
          textSeen = true;
          yield CascadeLlmDelta(text: text);
        } else if (type == 'response.output_item.done') {
          final item = event['item'];
          if (item is! Map) throw const CascadeFailure('ark_protocol');
          if (item['type'] != 'function_call') continue;
          if (responseId == null ||
              textSeen ||
              pendingTool != null ||
              !_id(item['id']) ||
              !_id(item['call_id']) ||
              !_id(item['name']) ||
              item['arguments'] is! String ||
              (item['arguments'] as String).length > 16000 ||
              !schema.any((s) => s['name'] == item['name'])) {
            throw const CascadeFailure('ark_protocol');
          }
          final args = jsonDecode(item['arguments'] as String);
          if (args is! Map<String, dynamic>) {
            throw const CascadeFailure('ark_protocol');
          }
          pendingTool = CascadeLlmDelta(
            callId: item['call_id'] as String,
            name: item['name'] as String,
            arguments: args,
          );
        } else if (type == 'response.completed') {
          final r = event['response'];
          if (responseId == null || r is! Map || r['id'] != responseId) {
            throw const CascadeFailure('ark_protocol');
          }
          cancel.check();
          if (pendingTool != null) yield pendingTool;
          return;
        } else if (type == 'error' ||
            type == 'response.failed' ||
            type == 'response.incomplete') {
          throw const CascadeFailure('ark_response_failed');
        }
      }
      throw const CascadeFailure('ark_incomplete');
    } on CascadeFailure {
      rethrow;
    } catch (_) {
      cancel.check();
      throw CascadeFailure(expired ? 'ark_timeout' : 'ark_request_failed');
    } finally {
      timer.cancel();
      remove();
      http.close(force: true);
    }
  }
}

bool _id(dynamic value) =>
    value is String && value.trim().isNotEmpty && value.length <= 256;

/// Parse SSE on byte boundaries, bounding lines before allocating decoded text.
Stream<Map<String, dynamic>> _events(
  Stream<List<int>> stream,
  CascadeCancellation cancel,
) async* {
  final line = <int>[];
  final data = <String>[];
  var total = 0, eventBytes = 0, count = 0;
  await for (final chunk in stream) {
    cancel.check();
    total += chunk.length;
    if (total > 8 * 1024 * 1024) throw const CascadeFailure('ark_overflow');
    for (final byte in chunk) {
      if (byte != 10) {
        line.add(byte);
        if (line.length > 256 * 1024) {
          throw const CascadeFailure('ark_overflow');
        }
        continue;
      }
      if (line.isNotEmpty && line.last == 13) line.removeLast();
      final text = utf8.decode(line);
      line.clear();
      if (text.isEmpty && data.isNotEmpty) {
        if (++count > 4096) throw const CascadeFailure('ark_overflow');
        final encoded = data.join('\n');
        data.clear();
        eventBytes = 0;
        if (encoded == '[DONE]') return;
        final event = jsonDecode(encoded);
        if (event is! Map<String, dynamic>) {
          throw const CascadeFailure('ark_protocol');
        }
        yield event;
      } else if (text.startsWith('data:')) {
        final value = text.substring(text.startsWith('data: ') ? 6 : 5);
        eventBytes += utf8.encode(value).length + 1;
        if (eventBytes > 512 * 1024) throw const CascadeFailure('ark_overflow');
        data.add(value);
      }
    }
  }
  if (line.isNotEmpty || data.isNotEmpty) {
    throw const CascadeFailure('ark_incomplete');
  }
}
