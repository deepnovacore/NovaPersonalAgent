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
  bool get isOfficialDeepSeekFlash =>
      protocol == ModelProtocol.chatCompletions &&
      model == 'deepseek-flash' &&
      const [
        'https://api.deepseek.com/chat/completions',
        'https://api.deepseek.com/v1/chat/completions',
      ].contains(requestUri.toString());
  bool get supportsJsonObject =>
      isOfficialDeepSeekFlash ||
      protocol == ModelProtocol.chatCompletions &&
          requestUri.toString() ==
              'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' &&
          ['qwen-flash', 'qwen3-vl-plus'].contains(model);
}

/// One client per turn: cancellation closes connections, including a pending open.
class ModelClient {
  ModelClient({
    this.timeout = const Duration(seconds: 60),
    this.maxDuration = const Duration(minutes: 10),
    this.maxBytes = 16 * 1024 * 1024,
    this.maxOutputBytes = 512 * 1024,
    this.collectUsage = false,
    this.disableThinking = false,
    this.jsonObject = false,
  });
  final bool collectUsage;
  final bool jsonObject;

  /// Background profile/voice turns skip thinking; chat explicitly enables it
  /// on supported providers so visible reasoning can stream to the UI.
  final bool disableThinking;
  CompletedModelUsage? completedUsage;
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
    completedUsage = null;
    final usage =
        collectUsage && configuration.protocol == ModelProtocol.chatCompletions
        ? ChatCompletionUsage(
            configuration.model,
            allowTerminalChoiceUsage: configuration.isOfficialDeepSeekFlash,
          )
        : null;
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
        jsonEncode({
          ...modelRequestBody(
            configuration,
            messages,
            tools,
            disableThinking: disableThinking,
            jsonObject: jsonObject,
            includeUsage: usage != null,
          ),
        }),
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
            completedUsage = usage?.finish();
            return;
          }
          final root = jsonDecode(event) as Map<String, dynamic>;
          if (root['error'] != null) {
            throw responseFailure(root);
          }
          usage?.add(root);
          final Map<String, dynamic> delta;
          var reasoningBytes = 0;
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
            final reasoning = delta['reasoning_content'] is String
                ? delta['reasoning_content'] as String
                : delta['reasoning'] is String
                ? delta['reasoning'] as String
                : null;
            if (reasoning != null) {
              delta['reasoning'] = reasoning;
              reasoningBytes = utf8.encode(reasoning).length;
            }
          }
          outputSize +=
              utf8.encode(delta['content'] as String? ?? '').length +
              reasoningBytes;
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

/// Model ids from `{base}/models`. Public catalogues may accept invalid keys,
/// so a successful response does not establish access to inference.
/// Input validation is shared with [ModelConfiguration].
Future<List<String>> listModels({
  required String endpoint,
  required String key,
  Duration timeout = const Duration(seconds: 15),
}) async {
  ModelConfiguration(endpoint: endpoint, model: '-', key: key);
  final http = HttpClient()..connectionTimeout = timeout;
  try {
    final request = await http
        .getUrl(compatibleEndpoint(endpoint, 'models'))
        .timeout(timeout);
    request.followRedirects = false;
    request.headers.set('Authorization', 'Bearer $key');
    request.headers.set('Accept', 'application/json');
    final response = await request.close().timeout(timeout);
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
        .join()
        .timeout(timeout);
    if (response.statusCode != 200) {
      throw ModelRequestFailure(
        'model_http_${response.statusCode}',
        status: response.statusCode,
      );
    }
    final data = (jsonDecode(body) as Map)['data'] as List;
    final ids = {
      for (final item in data)
        if (item is Map && item['id'] is String)
          (item['id'] as String).replaceFirst(RegExp(r'^models/'), ''),
    }.where((id) => id.isNotEmpty && id.length <= 200).toList()..sort();
    return ids.take(500).toList();
  } on AgentFailure {
    rethrow;
  } on FormatException {
    throw const AgentFailure('invalid_model_response');
  } on TypeError {
    throw const AgentFailure('invalid_model_response');
  } catch (_) {
    throw const AgentFailure('model_request_failed');
  } finally {
    http.close(force: true);
  }
}

/// Chat Completions history: provider-private thinking is replayed only to the
/// host that requires it back, and internal bookkeeping never reaches the wire.
Map<String, dynamic> _chatMessage(
  ModelConfiguration config,
  Map<String, dynamic> message,
) {
  final deepseek = config.requestUri.host == 'api.deepseek.com';
  final value = Map<String, dynamic>.from(message)
    ..remove('_nova_response_items')
    ..remove('reasoning');
  if (!deepseek) {
    value.remove('reasoning_content');
  } else if (value['role'] == 'assistant' &&
      value['reasoning_content'] is! String) {
    // Legacy turns predate visible thinking; DeepSeek still expects the field.
    value['reasoning_content'] = '';
  }
  return value;
}

Map<String, dynamic> modelRequestBody(
  ModelConfiguration config,
  List<Map<String, dynamic>> messages,
  List<Map<String, dynamic>> tools, {
  bool disableThinking = false,
  bool jsonObject = false,
  bool includeUsage = false,
}) {
  if (config.protocol == ModelProtocol.chatCompletions) {
    final deepseek = config.requestUri.host == 'api.deepseek.com';
    return {
      'model': config.model,
      'stream': true,
      if (includeUsage) 'stream_options': {'include_usage': true},
      if (jsonObject &&
          disableThinking &&
          tools.isEmpty &&
          config.supportsJsonObject)
        'response_format': {'type': 'json_object'},
      // DeepSeek shares this budget between thinking and generated tool source.
      'max_tokens': deepseek && !disableThinking ? 65536 : 12000,
      if (deepseek)
        'thinking': {'type': disableThinking ? 'disabled' : 'enabled'},
      if (['qwen-flash', 'qwen3-vl-plus'].contains(config.model) &&
          config.requestUri.host == 'dashscope.aliyuncs.com')
        'enable_thinking': !disableThinking,
      'messages': [for (final m in messages) _chatMessage(config, m)],
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
        if (item['type'] == 'reasoning') {
          // Encrypted reasoning has no human-readable text; never fabricate it.
          final summary = item['summary'];
          final text = summary is List
              ? [
                  for (final part in summary)
                    if (part is Map &&
                        part['text'] is String &&
                        (part['text'] as String).isNotEmpty)
                      part['text'] as String,
                ].join('\n')
              : '';
          if (text.isNotEmpty) return {'reasoning': text};
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

/// Billing evidence is exposed only after a complete, consistent SSE response.
class CompletedModelUsage {
  const CompletedModelUsage({
    required this.responseId,
    required this.model,
    required this.promptTokens,
    required this.completionTokens,
  });
  final String responseId, model;
  final int promptTokens, completionTokens;
}

class ChatCompletionUsage {
  ChatCompletionUsage(this.model, {this.allowTerminalChoiceUsage = false});
  final String model;
  final bool allowTerminalChoiceUsage;
  String? _id;
  bool _invalid = false, _stopped = false;
  CompletedModelUsage? _usage;

  void add(Map<String, dynamic> event) {
    final id = event['id'];
    if (id is! String ||
        id.isEmpty ||
        id.length > 256 ||
        event['model'] != model ||
        (_id != null && _id != id)) {
      _invalid = true;
      return;
    }
    _id = id;
    final choices = event['choices'];
    if (choices is! List || choices.length > 1 || _usage != null) {
      _invalid = true;
      return;
    }
    if (choices.isNotEmpty) {
      final choice = choices.single;
      if (choice is! Map || choice['index'] != 0 || _stopped) {
        _invalid = true;
        return;
      }
      final reason = choice['finish_reason'];
      if (reason != null) {
        if (reason == 'stop') {
          _stopped = true;
        } else {
          _invalid = true;
        }
      }
    }
    final usage = event['usage'];
    if (usage == null) return;
    final terminal = choices.isEmpty ? null : choices.single as Map;
    final delta = terminal?['delta'];
    // DeepSeek reports usage on its empty terminal choice, not a separate chunk.
    final terminalUsage =
        allowTerminalChoiceUsage &&
        model == 'deepseek-flash' &&
        terminal?['finish_reason'] == 'stop' &&
        delta is Map &&
        delta.entries.every(
          (entry) =>
              (entry.key == 'role' && entry.value == null) ||
              (const ['content', 'reasoning_content'].contains(entry.key) &&
                  (entry.value == null || entry.value == '')),
        );
    if (usage is! Map || !_stopped || (choices.isNotEmpty && !terminalUsage)) {
      _invalid = true;
      return;
    }
    final input = usage['prompt_tokens'],
        output = usage['completion_tokens'],
        total = usage['total_tokens'];
    if (input is! int ||
        output is! int ||
        total is! int ||
        input < 1 ||
        output < 1 ||
        input > 1000000 ||
        output > 32768 ||
        total != input + output) {
      _invalid = true;
      return;
    }
    _usage = CompletedModelUsage(
      responseId: id,
      model: model,
      promptTokens: input,
      completionTokens: output,
    );
  }

  CompletedModelUsage? finish() => !_invalid && _stopped ? _usage : null;
}
