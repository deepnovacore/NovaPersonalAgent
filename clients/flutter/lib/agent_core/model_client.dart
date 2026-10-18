import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'chatgpt_accounts.dart';

class AgentFailure implements Exception {
  const AgentFailure(this.code);
  final String code;
  @override
  String toString() => code;
}

class ModelRequestFailure extends AgentFailure {
  const ModelRequestFailure(
    super.code, {
    this.status,
    this.body,
    this.requestId,
    this.parameter,
  });
  final int? status;
  final String? body, requestId, parameter;
}

ModelRequestFailure responseFailure(Map<String, dynamic> event) {
  final response = event['response'];
  final error = response is Map ? response['error'] : event['error'];
  return ModelRequestFailure(
    error is Map && error['code'] is String
        ? error['code'] as String
        : 'model_response_failed',
    body: jsonEncode(event),
    parameter: error is Map ? error['param'] as String? : null,
  );
}

enum ModelProtocol { chatCompletions, responses, chatgptResponses }

class ModelConfiguration {
  ModelConfiguration({
    required this.endpoint,
    required this.model,
    required this.key,
    this.protocol = ModelProtocol.chatCompletions,
  }) {
    if (protocol == ModelProtocol.chatgptResponses &&
        endpoint != chatGptResource) {
      throw const AgentFailure('invalid_chatgpt_endpoint');
    }
    final uri = Uri.tryParse(endpoint);
    final host = uri?.host.replaceAll('[', '').replaceAll(']', '');
    final loopback =
        host == 'localhost' ||
        (host != null && InternetAddress.tryParse(host)?.isLoopback == true);
    if (uri == null ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        !(uri.scheme == 'https' || (uri.scheme == 'http' && loopback)) ||
        model.trim().isEmpty ||
        model.length > 200 ||
        key.isEmpty ||
        key.length > 8192 ||
        key.contains('\n') ||
        key.contains('\r')) {
      throw const AgentFailure('invalid_model_settings');
    }
  }
  final String endpoint, model, key;
  final ModelProtocol protocol;
  Uri get requestUri => compatibleEndpoint(
    endpoint,
    protocol != ModelProtocol.chatCompletions
        ? 'responses'
        : 'chat/completions',
  );
  Map<String, dynamic> toJson() => {
    'endpoint': endpoint,
    'model': model,
    'key': key,
    'protocol': protocol.name,
  };
}

/// One client per turn: cancellation closes connections, including a pending open.
class ModelClient {
  ModelClient({
    this.timeout = const Duration(seconds: 60),
    this.maxDuration = const Duration(minutes: 10),
    this.maxBytes = 16 * 1024 * 1024,
    this.maxOutputBytes = 512 * 1024,
  });
  final Duration timeout, maxDuration;
  final int maxBytes, maxOutputBytes;
  HttpClient? _http;
  bool _cancelled = false;
  void cancel() {
    _cancelled = true;
    _http?.close(force: true);
  }

  Stream<Map<String, dynamic>> stream(
    ModelConfiguration configuration,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    if (_cancelled) throw const AgentFailure('cancelled');
    final accountChanges =
        configuration.protocol == ModelProtocol.chatgptResponses
        ? ChatGptAccounts.changes.stream.listen((_) => cancel())
        : null;
    final http = _http = HttpClient()..connectionTimeout = timeout;
    var expired = false;
    Timer? idleTimer;
    void expire() {
      expired = true;
      http.close(force: true);
    }

    void receivedOutput() {
      idleTimer?.cancel();
      idleTimer = Timer(timeout, expire);
    }

    receivedOutput();
    final timer = Timer(maxDuration, expire);
    try {
      final request = await http.postUrl(configuration.requestUri);
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      request.headers.set('Authorization', 'Bearer ${configuration.key}');
      request.headers.set('Accept', 'text/event-stream');
      request.write(
        jsonEncode(modelRequestBody(configuration, messages, tools)),
      );
      final response = await request.close();
      if (response.statusCode != 200) {
        var count = 0;
        final body = await utf8.decoder
            .bind(
              response.map((bytes) {
                count += bytes.length;
                if (count > 1024 * 1024) {
                  throw const AgentFailure('model_response_too_large');
                }
                return bytes;
              }),
            )
            .join();
        Map<String, dynamic> detail = {};
        try {
          detail = Map<String, dynamic>.from(jsonDecode(body) as Map);
        } catch (_) {}
        final failure = responseFailure(detail);
        throw ModelRequestFailure(
          failure.code == 'model_response_failed'
              ? 'model_http_${response.statusCode}'
              : failure.code,
          status: response.statusCode,
          body: body,
          parameter: failure.parameter,
          requestId:
              response.headers.value('openai-request-id') ??
              response.headers.value('x-request-id'),
        );
      }
      if (response.headers.contentType?.mimeType != 'text/event-stream') {
        throw const AgentFailure('model_stream_required');
      }
      final responses = ResponsesStream(maxBytes: maxOutputBytes);
      var size = 0;
      var outputSize = 0;
      final bytes = response.map((chunk) {
        size += chunk.length;
        if (size > maxBytes) {
          throw const AgentFailure('model_response_too_large');
        }
        return chunk;
      });
      var data = <String>[];
      await for (final line
          in utf8.decoder.bind(bytes).transform(const LineSplitter())) {
        if (_cancelled) throw const AgentFailure('cancelled');
        if (expired) throw const AgentFailure('model_timeout');
        if (line.isEmpty) {
          if (data.isEmpty) continue;
          final event = data.join('\n');
          data = [];
          if (event == '[DONE]') {
            if (configuration.protocol != ModelProtocol.chatCompletions &&
                !responses.finished) {
              throw const AgentFailure('model_stream_interrupted');
            }
            return;
          }
          final root = jsonDecode(event) as Map<String, dynamic>;
          if (root['error'] != null) {
            throw responseFailure(root);
          }
          final Map<String, dynamic> delta;
          if (configuration.protocol != ModelProtocol.chatCompletions) {
            delta = responses.add(root);
          } else {
            final choices = root['choices'] as List;
            if (choices.isEmpty) continue;
            if (choices.length != 1) {
              throw const AgentFailure('invalid_model_response');
            }
            if ((choices.single as Map)['finish_reason'] == 'length') {
              throw const AgentFailure('model_output_limit');
            }
            delta = Map<String, dynamic>.from(
              (choices.single as Map)['delta'] as Map,
            );
          }
          outputSize += utf8.encode(delta['content'] as String? ?? '').length;
          for (final call in delta['tool_calls'] as List? ?? []) {
            final function = call['function'] as Map?;
            outputSize += utf8
                .encode(function?['arguments'] as String? ?? '')
                .length;
          }
          if (outputSize > maxOutputBytes) {
            throw const AgentFailure('model_response_too_large');
          }
          if (delta.isNotEmpty) receivedOutput();
          yield delta;
          if (responses.finished) return;
        } else if (line.startsWith('data:')) {
          data.add(line.substring(5).replaceFirst(RegExp(r'^ '), ''));
        }
      }
      throw const AgentFailure('model_stream_interrupted');
    } on AgentFailure {
      rethrow;
    } catch (_) {
      throw AgentFailure(
        _cancelled
            ? 'cancelled'
            : expired
            ? 'model_timeout'
            : 'model_request_failed',
      );
    } finally {
      await accountChanges?.cancel();
      timer.cancel();
      idleTimer?.cancel();
      http.close(force: true);
      _http = null;
    }
  }
}

/// Accept a Base URL or an existing complete compatible endpoint.
Uri compatibleEndpoint(String endpoint, String route) {
  final uri = Uri.parse(endpoint);
  var path = uri.path.replaceFirst(RegExp(r'/$'), '');
  for (final suffix in [
    '/chat/completions',
    '/responses',
    '/audio/transcriptions',
    '/audio/speech',
  ]) {
    if (path.endsWith(suffix)) {
      path = path.substring(0, path.length - suffix.length);
      break;
    }
  }
  return uri.replace(path: '$path/$route');
}

Map<String, dynamic> modelRequestBody(
  ModelConfiguration config,
  List<Map<String, dynamic>> messages,
  List<Map<String, dynamic>> tools,
) {
  if (config.protocol == ModelProtocol.chatCompletions) {
    return {
      'model': config.model,
      'stream': true,
      'max_tokens': 12000,
      if (config.model == 'qwen-flash' &&
          config.requestUri.host == 'dashscope.aliyuncs.com')
        'enable_thinking': false,
      'messages': [
        for (final m in messages)
          Map<String, dynamic>.from(m)..remove('_nova_response_items'),
      ],
      if (tools.isNotEmpty) 'tools': tools,
    };
  }
  final input = <Map<String, dynamic>>[];
  for (final m in messages) {
    if (m['role'] == 'tool') {
      input.add({
        'type': 'function_call_output',
        'call_id': m['tool_call_id'],
        'output': m['content'],
      });
    } else if (m['role'] == 'assistant' &&
        (m['_nova_response_items'] as List? ?? []).isNotEmpty) {
      // Replay exact output items, including encrypted reasoning, once only.
      input.addAll(
        (m['_nova_response_items'] as List).map(
          (e) => Map<String, dynamic>.from(e as Map),
        ),
      );
    } else {
      if (m['content'] != null && m['content'] != '') {
        input.add({
          'role':
              config.protocol == ModelProtocol.chatgptResponses &&
                  m['role'] == 'system'
              ? 'developer'
              : m['role'],
          'content': m['content'],
        });
      }
      for (final c in m['tool_calls'] as List? ?? []) {
        input.add({
          'type': 'function_call',
          'call_id': c['id'],
          'name': c['function']['name'],
          'arguments': c['function']['arguments'],
        });
      }
    }
  }
  return {
    'model': config.model,
    'stream': true,
    'store': false,
    'include': ['reasoning.encrypted_content'],
    'input': input,
    if (tools.isNotEmpty)
      'tools': config.protocol == ModelProtocol.chatgptResponses
          ? [
              {
                'type': 'namespace',
                'name': 'nova',
                'description': 'Tools executed locally under Nova authority.',
                'tools': [
                  for (final t in tools)
                    {
                      'type': 'function',
                      ...Map<String, dynamic>.from(t['function'] as Map),
                    },
                ],
              },
            ]
          : [
              for (final t in tools)
                {
                  'type': 'function',
                  ...Map<String, dynamic>.from(t['function'] as Map),
                },
            ],
  };
}

/// Convert Responses SSE into the existing text/tool delta contract.
class ResponsesStream {
  ResponsesStream({this.maxBytes = 512 * 1024});
  final int maxBytes;
  int _itemBytes = 0;
  bool finished = false;
  final items = <Map<String, dynamic>>[];
  int _calls = 0;
  Map<String, dynamic> add(Map<String, dynamic> event) {
    switch (event['type']) {
      case 'response.output_text.delta':
        if (event['delta'] is! String) {
          throw const AgentFailure('invalid_model_response');
        }
        return {'content': event['delta']};
      case 'response.output_item.done':
        final item = Map<String, dynamic>.from(event['item'] as Map);
        if (!['message', 'function_call', 'reasoning'].contains(item['type'])) {
          throw const AgentFailure('unsupported_model_output');
        }
        _itemBytes += utf8.encode(jsonEncode(item)).length;
        if (_itemBytes > maxBytes) {
          throw const AgentFailure('model_response_too_large');
        }
        items.add(item);
        if (item['type'] == 'function_call') {
          if (item['call_id'] is! String ||
              item['name'] is! String ||
              item['arguments'] is! String ||
              _calls >= 8) {
            throw const AgentFailure('invalid_tool_calls');
          }
          return {
            'tool_calls': [
              {
                'index': _calls++,
                'id': item['call_id'],
                'type': 'function',
                'function': {
                  'name': item['name'],
                  'arguments': item['arguments'],
                },
              },
            ],
          };
        }
        return {};
      case 'response.completed':
        final response = event['response'] as Map;
        if (response['status'] != null && response['status'] != 'completed') {
          throw const AgentFailure('model_stream_interrupted');
        }
        finished = true;
        return {'_nova_response_items': items};
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        throw responseFailure(event);
      default:
        return {};
    }
  }
}
