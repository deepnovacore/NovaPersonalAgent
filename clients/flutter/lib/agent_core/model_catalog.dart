// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: ported ModelCatalog.kt to Dart on
// dart:io, added a `speaks` filter for the protocols Nova's model client can call.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Which API family a provider's own endpoint belongs to.
/// [wireProtocol] is the protocol used to call it and to pick listing dialect.
enum ProviderKind {
  openAiCompat(WireProtocol.chatCompletions),
  anthropic(WireProtocol.messages),
  gemini(WireProtocol.generateContent),
  openAiResponses(WireProtocol.responses);

  const ProviderKind(this.wireProtocol);
  final WireProtocol wireProtocol;

  /// Kinds a custom provider can choose when it is filled in by hand.
  static const withApiKey = [openAiCompat, anthropic, gemini, openAiResponses];
}

/// Protocol names used by aggregator `api` tables and `supported_endpoints`.
enum WireProtocol {
  chatCompletions('chat-completions'),
  messages('messages'),
  generateContent('generate-content'),
  responses('responses');

  const WireProtocol(this.wire);
  final String wire;

  static WireProtocol? of(String? wire) {
    for (final protocol in values) {
      if (protocol.wire == wire) return protocol;
    }
    return null;
  }

  /// Recognises the protocol from an endpoint path. Only `:generateContent` is
  /// accepted for Gemini: a bare `/models` path lists models but proves nothing
  /// about generation.
  static WireProtocol? ofPath(String? path) {
    final p = path?.trim().replaceFirst(RegExp(r'/+$'), '').toLowerCase();
    if (p == null) return null;
    if (p.endsWith('/chat/completions')) return chatCompletions;
    if (p.endsWith('/messages')) return messages;
    if (p.endsWith('/responses')) return responses;
    if (p.endsWith(':generatecontent')) return generateContent;
    return null;
  }
}

/// An endpoint a listing assigns to one model: its protocol root and the
/// field a compatible endpoint puts reasoning text in.
class ModelEndpoint {
  const ModelEndpoint(this.protocol, this.baseUrl, {this.reasoningField});
  final WireProtocol protocol;
  final String baseUrl;
  final String? reasoningField;

  /// Base URL for an adapter that appends its own version path.
  String get adapterBaseUrl {
    final url = baseUrl.trim().replaceFirst(RegExp(r'/+$'), '');
    return switch (protocol) {
      WireProtocol.chatCompletions || WireProtocol.responses => url,
      WireProtocol.messages => url.replaceFirst(RegExp(r'/v1$'), ''),
      WireProtocol.generateContent => url.replaceFirst(RegExp(r'/v1beta$'), ''),
    };
  }
}

/// One model as a provider lists it. A null capability means "not stated" and is
/// never guessed here; the caller falls back to its own defaults.
class ListedModel {
  const ListedModel({
    required this.id,
    this.displayName = '',
    this.toolCalls,
    this.vision,
    this.contextTokens,
    this.reasoning,
    this.endpoint,
    this.unsupportedApis = const [],
    this.chat,
    this.reasoningEfforts,
    this.thinkingTypes,
    this.protocols,
  });
  final String id, displayName;
  final bool? toolCalls, vision, reasoning, chat;
  final int? contextTokens;

  /// The endpoint among those Nova can speak, if the listing names several.
  final ModelEndpoint? endpoint;

  /// Protocol names the listing states but the caller cannot speak at all.
  final List<String> unsupportedApis;
  final List<String>? reasoningEfforts, thinkingTypes;

  /// Protocols the listing says this model can be called with.
  final List<WireProtocol>? protocols;

  /// False when the listing states only protocols the caller cannot speak.
  bool get usable => endpoint != null || unsupportedApis.isEmpty;
}

/// Why listing failed. [text] is the user-facing reason.
enum ListFailure {
  badUrl('接口地址不对，要以 http:// 或 https:// 开头', 'The API URL is invalid.'),
  auth('API Key 无效或没有权限', 'The API key is invalid or lacks permission.'),
  quota('账户额度已用完', 'The account is out of quota.'),
  rateLimited('请求太频繁，请稍后再试', 'Too many requests. Try again later.'),
  network(
    '连不上这个地址，请检查网络和接口地址',
    'Could not reach the address. Check the network and API URL.',
  ),
  notSupported('这个服务不提供模型列表', 'This provider does not offer a model list.'),
  server('服务暂时出错，请稍后再试', 'The service is having trouble. Try again later.'),
  badResponse(
    '返回的内容看不懂，请检查接口地址和接口类型',
    'The response was not understood. Check the API URL and type.',
  );

  const ListFailure(this._zh, this._en);
  final String _zh, _en;
  String text(String language) => language == 'zh' ? _zh : _en;
}

sealed class ModelListResult {
  const ModelListResult();
}

class ModelListOk extends ModelListResult {
  const ModelListOk(this.models);
  final List<ListedModel> models;
}

class ModelListFailed extends ModelListResult {
  const ModelListFailed(this.reason, {this.detail = '', this.status});
  final ListFailure reason;
  final String detail;

  /// HTTP status that caused the failure, when there was one.
  final int? status;
  String message(String language) => detail.isEmpty
      ? reason.text(language)
      : '${reason.text(language)}（$detail）';
}

/// Maps an HTTP failure to a reason: 401/403 key, Gemini 400 invalid key, 402 or
/// `insufficient_quota`, 429, 404/405/501 no list, 5xx server.
ModelListFailed failureFor(int status, String body) {
  if (status == 401 || status == 403) {
    return ModelListFailed(ListFailure.auth, status: status);
  }
  if (status == 400 &&
      (body.contains('API_KEY_INVALID') ||
          body.contains('API key not valid'))) {
    return ModelListFailed(ListFailure.auth, status: status);
  }
  if (status == 402 || body.contains('insufficient_quota')) {
    return ModelListFailed(ListFailure.quota, status: status);
  }
  if (status == 429) {
    return ModelListFailed(ListFailure.rateLimited, status: status);
  }
  if (status == 404 || status == 405 || status == 501) {
    return ModelListFailed(ListFailure.notSupported, status: status);
  }
  if (status >= 500 && status <= 599) {
    return ModelListFailed(
      ListFailure.server,
      detail: 'HTTP $status',
      status: status,
    );
  }
  return ModelListFailed(
    ListFailure.badResponse,
    detail: 'HTTP $status',
    status: status,
  );
}

/// Base URL of a saved endpoint, without a chat/responses route.
String catalogBase(String endpoint) => endpoint
    .trim()
    .replaceFirst(RegExp(r'/+$'), '')
    .replaceFirst(RegExp(r'/(chat/completions|responses)$'), '');

/// Lists models with each provider's public listing interface:
/// - OpenAI compatible: `GET {base}/models` (Bearer). Capabilities are read only
///   from fields a listing actually gives, in several dialects (OpenRouter-style
///   `architecture`, `capabilities`, `limit`, `modalities`, the `api` table, and
///   the ChatGPT `models` table with `slug` / `visibility`).
/// - Anthropic: `GET {base}/v1/models`, paged by `after_id`.
/// - Gemini: `GET {base}/v1beta/models`, paged by `pageToken`, generateContent only.
class ModelCatalog {
  ModelCatalog({
    this.timeout = const Duration(seconds: 15),
    this.maxBytes = 4 * 1024 * 1024,
    this.speaks = const {
      WireProtocol.chatCompletions,
      WireProtocol.messages,
      WireProtocol.generateContent,
      WireProtocol.responses,
    },
  });
  final Duration timeout;
  final int maxBytes;

  /// Protocols the caller can actually call. A model that lists only others is
  /// not [ListedModel.usable].
  final Set<WireProtocol> speaks;

  static const maxPages = 10;
  static const _effortOrder = ['low', 'medium', 'high', 'xhigh', 'max'];
  static const _chatTypes = {'chat', 'llm', 'language', 'text', 'vlm', 'code'};
  static const _nonChatTypes = {
    'embedding',
    'embeddings',
    'rerank',
    'reranker',
    'image',
    'images',
    'video',
    'audio',
    'tts',
    'stt',
    'asr',
    'speech',
    'transcription',
    'moderation',
  };

  Future<ModelListResult> list(
    ProviderKind kind,
    String baseUrl,
    String apiKey, {
    Map<String, String> headers = const {},
  }) => switch (kind) {
    ProviderKind.anthropic => anthropic(baseUrl, apiKey, headers: headers),
    ProviderKind.gemini => gemini(baseUrl, apiKey, headers: headers),
    _ => openAiCompat(baseUrl, apiKey, headers: headers),
  };

  Future<ModelListResult> openAiCompat(
    String baseUrl,
    String? apiKey, {
    Map<String, String> headers = const {},
  }) async {
    final url = _url(baseUrl, '/models');
    if (url == null) return const ModelListFailed(ListFailure.badUrl);
    final root = await _fetch(url, {
      ...headers,
      if (apiKey != null && apiKey.isNotEmpty)
        'Authorization': 'Bearer $apiKey',
    });
    if (root is ModelListFailed) return root;
    final map = root as Map<String, dynamic>;
    final data = map['data'] ?? map['models'];
    if (data is! List) return const ModelListFailed(ListFailure.badResponse);
    return ModelListOk(
      _distinct([
        for (final item in data)
          if (item is Map) ?_openAiModel(item),
      ]),
    );
  }

  Future<ModelListResult> anthropic(
    String baseUrl,
    String apiKey, {
    Map<String, String> headers = const {},
  }) async {
    final base = _url(baseUrl, '/v1/models');
    if (base == null) return const ModelListFailed(ListFailure.badUrl);
    final all = <ListedModel>[];
    String? after;
    for (var page = 0; page < maxPages; page++) {
      final url = base.replace(
        queryParameters: {'limit': '1000', 'after_id': ?after},
      );
      final root = await _fetch(url, {
        ...headers,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      });
      if (root is ModelListFailed) return root;
      final map = root as Map<String, dynamic>;
      final data = map['data'];
      if (data is! List) return const ModelListFailed(ListFailure.badResponse);
      all.addAll([
        for (final item in data)
          if (item is Map) ?_anthropicModel(item),
      ]);
      after = _str(map, 'last_id');
      if (map['has_more'] != true || after == null) break;
    }
    return ModelListOk(_distinct(all));
  }

  Future<ModelListResult> gemini(
    String baseUrl,
    String apiKey, {
    Map<String, String> headers = const {},
  }) async {
    final base = _url(baseUrl, '/v1beta/models');
    if (base == null) return const ModelListFailed(ListFailure.badUrl);
    final all = <ListedModel>[];
    String? token;
    for (var page = 0; page < maxPages; page++) {
      final url = base.replace(
        queryParameters: {'pageSize': '1000', 'pageToken': ?token},
      );
      final root = await _fetch(url, {...headers, 'x-goog-api-key': apiKey});
      if (root is ModelListFailed) return root;
      final map = root as Map<String, dynamic>;
      final data = map['models'];
      if (data is List) {
        all.addAll([
          for (final item in data)
            if (item is Map) ?_geminiModel(item),
        ]);
      }
      final next = _str(map, 'nextPageToken');
      token = next == null || next.isEmpty ? null : next;
      if (token == null) break;
    }
    return ModelListOk(_distinct(all));
  }

  List<ListedModel> _distinct(List<ListedModel> models) {
    final seen = <String>{};
    return [
      for (final model in models)
        if (seen.add(model.id)) model,
    ];
  }

  ListedModel? _openAiModel(Map<dynamic, dynamic> raw) {
    final o = Map<String, dynamic>.from(raw);
    // The ChatGPT `models` table keeps only entries shown in the picker.
    final visibility = _str(o, 'visibility');
    if (visibility != null && visibility != 'list') return null;
    final rawId = _str(o, 'id') ?? _str(o, 'slug');
    if (rawId == null || rawId.trim().isEmpty) return null;
    final id = rawId.replaceFirst(RegExp(r'^models/'), '');
    if (id.isEmpty) return null;
    final arch = _obj(o, 'architecture');
    final modalities = _obj(o, 'modalities');
    final inputs = _strList(arch?['input_modalities']);
    final modality = _str(arch ?? const {}, 'modality')?.split('->').first;
    final outputs =
        _strList(arch?['output_modalities'] ?? modalities?['output']) ??
        (() {
          final m = _str(arch ?? const {}, 'modality');
          return m != null && m.contains('->')
              ? m.split('->').skip(1).join('->').split('+')
              : null;
        })();
    final params = _strList(o['supported_parameters']);
    final caps = _obj(o, 'capabilities');
    final modalIn = _strList(modalities?['input'] ?? o['input_modalities']);
    final capsReasoning = _obj(caps ?? const {}, 'reasoning');
    final levelsRaw =
        o['supported_reasoning_levels'] ?? capsReasoning?['effort'];
    final levels = levelsRaw is List ? levelsRaw : null;
    final efforts = levels == null
        ? null
        : <String>{
            for (final level in levels)
              if (((level is Map ? level['effort'] : level)) case final String s
                  when s.trim().isNotEmpty)
                s.trim(),
          }.toList();
    final api = _obj(o, 'api');
    final supported = o['supported_endpoints'];
    final protocols = supported is List
        ? {
            for (final path in supported)
              if (path is String) ?WireProtocol.ofPath(path),
          }.toList()
        : null;
    ModelEndpoint? endpoint;
    if (api != null) {
      for (final protocol in WireProtocol.values) {
        if (!speaks.contains(protocol)) continue;
        final entry = _obj(api, protocol.wire);
        final url = entry == null ? null : _str(entry, 'base_url');
        if (entry == null || url == null || url.trim().isEmpty) continue;
        endpoint = ModelEndpoint(
          protocol,
          url,
          reasoningField: _str(
            _obj(entry, 'compatibility') ?? const {},
            'reasoning_field',
          ),
        );
        break;
      }
    }
    final type = _str(o, 'type')?.toLowerCase();
    bool? chat;
    if (_chatTypes.contains(type)) {
      chat = true;
    } else if (_nonChatTypes.contains(type)) {
      chat = false;
    } else if (outputs != null && !outputs.contains('text')) {
      // Image- or audio-only output is not a chat model.
      chat = false;
    }
    return ListedModel(
      id: id,
      displayName: _str(o, 'name') ?? _str(o, 'display_name') ?? '',
      toolCalls: params != null
          ? params.contains('tools')
          : _bool(_obj(caps ?? const {}, 'tools') ?? const {}, 'supported') ??
                _bool(caps ?? const {}, 'function_calling') ??
                _bool(caps ?? const {}, 'tool_calls'),
      vision: inputs != null
          ? inputs.contains('image')
          : modalIn != null
          ? modalIn.any((m) => m == 'image' || m.startsWith('image/'))
          : modality != null
          ? modality.contains('image')
          : _bool(o, 'supports_image_in') ?? _bool(caps ?? const {}, 'vision'),
      contextTokens:
          _int(o, 'context_length') ??
          _int(o, 'context_window') ??
          _int(o, 'max_context_length') ??
          _int(_obj(o, 'limit') ?? const {}, 'context'),
      reasoning: params != null
          ? params.contains('reasoning') || params.contains('include_reasoning')
          : _bool(capsReasoning ?? const {}, 'supported') ??
                _bool(o, 'supports_reasoning') ??
                levels?.isNotEmpty,
      endpoint: endpoint,
      reasoningEfforts: efforts,
      unsupportedApis: endpoint == null && api != null
          ? api.keys.toList()
          : const [],
      protocols: protocols == null || protocols.isEmpty ? null : protocols,
      chat: chat,
    );
  }

  ListedModel? _anthropicModel(Map<dynamic, dynamic> raw) {
    final o = Map<String, dynamic>.from(raw);
    final id = _str(o, 'id');
    if (id == null || id.trim().isEmpty) return null;
    final caps = _obj(o, 'capabilities');
    final thinking = _obj(caps ?? const {}, 'thinking');
    final typesObject = _obj(thinking ?? const {}, 'types');
    final types = typesObject == null ? null : _supportedKeys(typesObject);
    return ListedModel(
      id: id,
      displayName: _str(o, 'display_name') ?? '',
      vision: _bool(
        _obj(caps ?? const {}, 'image_input') ?? const {},
        'supported',
      ),
      contextTokens: _int(o, 'max_input_tokens'),
      reasoning: thinking == null ? null : _bool(thinking, 'supported'),
      reasoningEfforts: types == null
          ? null
          : _anthropicEfforts(_obj(caps ?? const {}, 'effort'), types),
      thinkingTypes: types,
    );
  }

  /// Effort levels are offered only when the model accepts adaptive thinking;
  /// `none` is added when it also accepts thinking disabled.
  List<String> _anthropicEfforts(
    Map<String, dynamic>? effort,
    List<String> types,
  ) {
    final supported = effort != null && effort['supported'] == true
        ? _supportedKeys(effort)
        : <String>[];
    int rank(String level) {
      final i = _effortOrder.indexOf(level);
      return i >= 0 ? i : _effortOrder.length;
    }

    final levels = [...supported]..sort((a, b) => rank(a).compareTo(rank(b)));
    if (!types.contains('adaptive') || levels.isEmpty) return const [];
    return [if (types.contains('disabled')) 'none', ...levels];
  }

  List<String> _supportedKeys(Map<String, dynamic> o) => [
    for (final entry in o.entries)
      if (entry.value is Map && (entry.value as Map)['supported'] == true)
        entry.key,
  ];

  ListedModel? _geminiModel(Map<dynamic, dynamic> raw) {
    final o = Map<String, dynamic>.from(raw);
    final id = _str(o, 'name')?.replaceFirst(RegExp(r'^models/'), '');
    if (id == null || id.trim().isEmpty) return null;
    final methods = _strList(o['supportedGenerationMethods']);
    if (methods != null && !methods.contains('generateContent')) return null;
    return ListedModel(
      id: id,
      displayName: _str(o, 'displayName') ?? '',
      contextTokens: _int(o, 'inputTokenLimit'),
      reasoning: _bool(o, 'thinking'),
    );
  }

  /// Only http(s); plain http is allowed only for loopback hosts, so a key
  /// never travels unencrypted. Credentials, queries and fragments are refused.
  Uri? _url(String baseUrl, String path) {
    final uri = Uri.tryParse(
      baseUrl.trim().replaceFirst(RegExp(r'/+$'), '') + path,
    );
    if (uri == null || uri.host.isEmpty) return null;
    if (uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment) return null;
    final host = uri.host.replaceAll('[', '').replaceAll(']', '');
    final loopback =
        host == 'localhost' ||
        InternetAddress.tryParse(host)?.isLoopback == true;
    if (uri.scheme == 'https' || (uri.scheme == 'http' && loopback)) return uri;
    return null;
  }

  /// Decoded JSON object, or the failure to report.
  Future<Object> _fetch(Uri url, Map<String, String> headers) async {
    final http = HttpClient()..connectionTimeout = timeout;
    try {
      final request = await http.getUrl(url).timeout(timeout);
      request.followRedirects = false;
      for (final entry in headers.entries) {
        request.headers.set(entry.key, entry.value);
      }
      request.headers.set('Accept', 'application/json');
      final response = await request.close().timeout(timeout);
      var count = 0;
      final body = await utf8.decoder
          .bind(
            response.map((bytes) {
              count += bytes.length;
              if (count > maxBytes) throw const _TooLarge();
              return bytes;
            }),
          )
          .join()
          .timeout(timeout);
      if (response.statusCode < 200 || response.statusCode > 299) {
        return failureFor(response.statusCode, body);
      }
      final root = jsonDecode(body);
      if (root is! Map) return const ModelListFailed(ListFailure.badResponse);
      return Map<String, dynamic>.from(root);
    } on _TooLarge {
      return const ModelListFailed(ListFailure.badResponse);
    } on FormatException {
      return const ModelListFailed(ListFailure.badResponse);
    } catch (_) {
      return const ModelListFailed(ListFailure.network);
    } finally {
      http.close(force: true);
    }
  }
}

class _TooLarge implements Exception {
  const _TooLarge();
}

String? _str(Map<dynamic, dynamic> o, String key) {
  final value = o[key];
  return value is String ? value : null;
}

Map<String, dynamic>? _obj(Map<dynamic, dynamic> o, String key) {
  final value = o[key];
  return value is Map ? Map<String, dynamic>.from(value) : null;
}

bool? _bool(Map<dynamic, dynamic> o, String key) {
  final value = o[key];
  return value is bool ? value : null;
}

int? _int(Map<dynamic, dynamic> o, String key) {
  final value = o[key];
  final number = value is int
      ? value
      : value is double && value == value.truncateToDouble()
      ? value.toInt()
      : null;
  return number != null && number > 0 ? number : null;
}

List<String>? _strList(Object? value) => value is List
    ? [
        for (final item in value)
          if (item is String) item,
      ]
    : null;
