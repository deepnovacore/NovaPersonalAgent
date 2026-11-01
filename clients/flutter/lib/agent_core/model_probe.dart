// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: ProviderStore.probe, ModelOptions
// and the ModelSetupViewModel probe loop ported to Dart on Nova's ModelClient.
import 'dart:async';
import 'dart:convert';

import 'model_catalog.dart';
import 'model_client.dart';
import 'model_presets.dart';

/// How long one probe may wait for the model before it counts as failed.
const probeTimeout = Duration(seconds: 20);

/// At most this many models are tried when saving a provider.
const probeCandidateLimit = 3;

const _probeSystem =
    'This is a connection test. Call the get_time tool now. Do not answer with text.';
const _probeUser = 'What time is it? Use the get_time tool.';
const _probeTool = {
  'type': 'function',
  'function': {
    'name': 'get_time',
    'description': 'Returns the current time.',
    'parameters': {'type': 'object', 'properties': <String, Object>{}},
  },
};

/// Text a model may produce without calling the tool before the probe gives up.
const _probeTextLimit = 2000;

sealed class ProbeResult {
  const ProbeResult();
}

/// The model called the test tool: the endpoint works and the model can use tools.
class ProbeToolCalled extends ProbeResult {
  const ProbeToolCalled();
}

/// The endpoint works but the model only answered with text.
class ProbeNoToolCall extends ProbeResult {
  const ProbeNoToolCall();
}

class ProbeFailed extends ProbeResult {
  const ProbeFailed(this.error);
  final AgentFailure error;
}

/// Asks [config]'s model to call one tool, through the same client that real
/// turns use. The stream is abandoned at the first tool call. Thinking is off
/// and the wait is bounded by [timeout].
Future<ProbeResult> probeModelTool(
  ModelConfiguration config, {
  Duration timeout = probeTimeout,
  ModelClient Function()? clientFactory,
}) async {
  final client =
      clientFactory?.call() ??
      ModelClient(
        timeout: timeout,
        maxDuration: timeout,
        disableThinking: true,
      );
  Future<ProbeResult> run() async {
    var text = 0;
    try {
      await for (final delta in client.stream(
        config,
        const [
          {'role': 'system', 'content': _probeSystem},
          {'role': 'user', 'content': _probeUser},
        ],
        tools: const [_probeTool],
      )) {
        if ((delta['tool_calls'] as List?)?.isNotEmpty == true) {
          return const ProbeToolCalled();
        }
        text += (delta['content'] as String? ?? '').length;
        if (text > _probeTextLimit) return const ProbeNoToolCall();
      }
      return const ProbeNoToolCall();
    } on AgentFailure catch (failure) {
      return ProbeFailed(failure);
    }
  }

  try {
    return await run().timeout(timeout);
  } on TimeoutException {
    return const ProbeFailed(AgentFailure('probe_timeout'));
  } finally {
    client.cancel();
  }
}

// ---------------------------------------------------------------------------
// Models offered for a provider, and the order they are tried in.

/// A listed model with the provider's capabilities merged over the preset's
/// defaults. The `*Known` flags record what the listing actually said, so the UI
/// can mark the rest "unconfirmed".
class ModelOption {
  const ModelOption({
    required this.id,
    required this.capabilities,
    required this.toolCallsKnown,
    required this.visionKnown,
    required this.contextKnown,
    this.displayName = '',
    this.chat,
    this.typed = false,
  });
  final String id, displayName;
  final ProviderCapabilities capabilities;
  final bool toolCallsKnown, visionKnown, contextKnown;
  final bool? chat;

  /// Not in the provider's list: typed by the user.
  final bool typed;
  bool get canBeMain => capabilities.toolCalls;
}

/// Merges listed capabilities over [base]; models the caller cannot call are
/// dropped. Models that can use tools come first, the rest keep the list order.
List<ModelOption> mergeModelOptions(
  List<ListedModel> listed,
  ProviderCapabilities base,
) {
  final options = [
    for (final m in listed)
      if (m.usable)
        ModelOption(
          id: m.id,
          capabilities: ProviderCapabilities(
            toolCalls: m.toolCalls ?? base.toolCalls,
            vision: m.vision ?? base.vision,
            contextTokens: m.contextTokens ?? base.contextTokens,
            reasoning: m.reasoning ?? base.reasoning,
            promptCaching: base.promptCaching,
          ),
          toolCallsKnown: m.toolCalls != null,
          visionKnown: m.vision != null,
          contextKnown: m.contextTokens != null,
          displayName: m.displayName,
          chat: m.chat,
        ),
  ];
  return _stableSorted(
    options,
    (a, b) => _rank(a.canBeMain).compareTo(_rank(b.canBeMain)),
  );
}

int _rank(bool first) => first ? 0 : 1;

List<T> _stableSorted<T>(List<T> items, int Function(T, T) compare) {
  final indexed = [for (var i = 0; i < items.length; i++) (i, items[i])];
  indexed.sort((a, b) {
    final c = compare(a.$2, b.$2);
    return c != 0 ? c : a.$1.compareTo(b.$1);
  });
  return [for (final e in indexed) e.$2];
}

const _nonChatWords = [
  'embed',
  'rerank',
  'tts',
  'whisper',
  'transcribe',
  'speech',
  'audio',
  'realtime',
  'image',
  'dall',
  'moderation',
  'ocr',
  'asr',
];

/// Looks like embeddings, rerank, speech, image or moderation: what the listing
/// states wins, otherwise the name's words are checked.
bool looksNonChat(ModelOption option) {
  final chat = option.chat;
  if (chat != null) return !chat;
  return option.id
      .toLowerCase()
      .split(RegExp(r'[^a-z0-9]+'))
      .any((part) => _nonChatWords.any(part.startsWith));
}

bool _inFamily(ModelOption option, List<String> tokens) => tokens.any(
  (t) =>
      option.id.toLowerCase().contains(t) ||
      option.displayName.toLowerCase().contains(t),
);

/// Order in which models are tried: tool-capable chat models only; the
/// provider's own family first, then those the listing says can call tools;
/// within the family, newer versions first.
List<String> probeCandidates(
  List<ModelOption> options, [
  List<String> familyTokens = const [],
]) {
  final rows = [
    for (final o in options)
      if (o.canBeMain && !looksNonChat(o))
        (o, _inFamily(o, familyTokens), ModelVersion.of(o.id)),
  ];
  final sorted = _stableSorted(rows, (a, b) {
    final byFamily = _rank(a.$2).compareTo(_rank(b.$2));
    if (byFamily != 0) return byFamily;
    final byKnown = _rank(
      a.$1.toolCallsKnown,
    ).compareTo(_rank(b.$1.toolCallsKnown));
    if (byKnown != 0) return byKnown;
    return a.$2 ? ModelVersion.newestFirst(a.$3, b.$3) : 0;
  });
  return [for (final row in sorted) row.$1.id];
}

/// A model name's version, read from digits in its name.
class ModelVersion {
  const ModelVersion(this.numbers, this.stage, this.date);
  final List<int> numbers;

  /// 0 release, 1 `latest` alias, 2 preview/beta.
  final int stage;
  final int? date;
  bool get parsed => numbers.isNotEmpty || date != null;

  /// Readable versions first; larger first; at equal version release, alias,
  /// preview; undated (usually the newest snapshot) before dated, then newer.
  static int newestFirst(ModelVersion a, ModelVersion b) {
    if (a.parsed != b.parsed) return a.parsed ? -1 : 1;
    if (!a.parsed) return 0;
    final byNumber = _compareNumbers(b.numbers, a.numbers);
    if (byNumber != 0) return byNumber;
    final byStage = a.stage.compareTo(b.stage);
    if (byStage != 0) return byStage;
    return (b.date ?? _maxDate).compareTo(a.date ?? _maxDate);
  }

  static const _maxDate = 1 << 62;
  static final _version = RegExp(
    r'^([a-z]*)((?:0|[1-9]\d?)(?:\.\d{1,3})*)([a-z]?)$',
  );
  static final _minor = RegExp(r'^[1-9]?\d$');
  static const _sizeSuffixes = {'b', 'k', 'm'};
  static const _preRelease = [
    'preview',
    'exp',
    'beta',
    'alpha',
    'rc',
    'dev',
    'test',
  ];

  static int _compareNumbers(List<int> a, List<int> b) {
    final n = a.length > b.length ? a.length : b.length;
    for (var i = 0; i < n; i++) {
      final c = (i < a.length ? a[i] : 0).compareTo(i < b.length ? b[i] : 0);
      if (c != 0) return c;
    }
    return 0;
  }

  static ModelVersion of(String id) {
    final parts = id
        .toLowerCase()
        .split(RegExp(r'[^a-z0-9.]+'))
        .where((p) => p.isNotEmpty)
        .toList();
    var numbers = <int>[];
    var at = -1;
    for (var i = 0; i < parts.length; i++) {
      final m = _version.firstMatch(parts[i]);
      if (m == null) continue;
      if (_sizeSuffixes.contains(m.group(3))) continue;
      numbers = m.group(2)!.split('.').map(int.parse).toList();
      at = i;
      break;
    }
    var end = at + 1;
    if (at >= 0 && numbers.length == 1) {
      // Minor versions separated by dashes: claude-3-5, seed-1-6.
      while (end < parts.length &&
          numbers.length < 3 &&
          _minor.hasMatch(parts[end])) {
        numbers = [...numbers, int.parse(parts[end++])];
      }
    }
    final rest = [
      for (var i = 0; i < parts.length; i++)
        if (i < at || i >= end) parts[i],
    ];
    final stage = rest.any((p) => _preRelease.any(p.startsWith))
        ? 2
        : rest.contains('latest')
        ? 1
        : 0;
    return ModelVersion(
      numbers,
      stage,
      _dateOf([
        for (final p in rest)
          if (RegExp(r'^\d+$').hasMatch(p)) p,
      ]),
    );
  }

  static int? _dateOf(List<String> digits) {
    if (digits.isEmpty) return null;
    final year = digits.where((d) {
      if (d.length != 4) return false;
      final y = int.parse(d);
      return y >= 1990 && y <= 2099;
    }).firstOrNull;
    if (year != null) {
      final others = [...digits]..remove(year);
      final md = others
          .take(2)
          .map((d) => int.parse(d.length > 2 ? d.substring(0, 2) : d))
          .toList();
      return int.parse(year) * 10000 +
          (md.isNotEmpty ? md[0] : 0) * 100 +
          (md.length > 1 ? md[1] : 0);
    }
    final joined = digits.join();
    final capped = joined.length > 14 ? joined.substring(0, 14) : joined;
    return digits.length == 1 && capped.length == 6
        ? 20000000 + int.parse(capped)
        : int.parse(capped);
  }
}

// ---------------------------------------------------------------------------
// What went wrong with a probe, and the save-time loop over candidates.

/// Why one model did not pass. The first four are about that model only, so
/// another model may work; the rest are about the provider or the network.
enum ProbeProblem {
  noTools,
  notAvailable,
  notFound,
  server,
  wrongProtocol,
  timeout,
  auth,
  quota,
  rateLimited,
  network,
  other,
}

class ProbeFailure {
  const ProbeFailure(this.problem, this.model, {this.detail = '', this.status});
  final ProbeProblem problem;
  final String model;

  /// The provider's own words, or an error code for [ProbeProblem.other].
  final String detail;
  final int? status;

  /// Another model may still work with this provider.
  bool get modelSpecific => switch (problem) {
    ProbeProblem.noTools ||
    ProbeProblem.notAvailable ||
    ProbeProblem.notFound ||
    ProbeProblem.server ||
    ProbeProblem.wrongProtocol => true,
    _ => false,
  };
}

/// Reads a failed model call: HTTP status, then the provider's error code and
/// words. Heuristics only choose which hint the user sees, never whether to save.
ProbeFailure classifyProbeFailure(AgentFailure failure, String model) {
  if (failure.code == 'probe_timeout' || failure.code == 'model_timeout') {
    return ProbeFailure(ProbeProblem.timeout, model);
  }
  final status = failure is ModelRequestFailure ? failure.status : null;
  final body = (failure is ModelRequestFailure ? failure.body : null) ?? '';
  final words = body.toLowerCase();
  final codes = '${failure.code} $words';
  final detail = _providerMessage(body);
  ProbeFailure make(ProbeProblem problem, [String? words]) =>
      ProbeFailure(problem, model, detail: words ?? detail, status: status);
  if (status == null) {
    if (failure.code == 'model_not_found') return make(ProbeProblem.notFound);
    if (failure.code == 'insufficient_quota') return make(ProbeProblem.quota);
    if (failure.code == 'invalid_api_key') return make(ProbeProblem.auth);
    return failure.code == 'model_request_failed'
        ? make(ProbeProblem.network)
        : make(ProbeProblem.other, failure.code);
  }
  if (status == 401) return make(ProbeProblem.auth);
  if (status == 402 || codes.contains('insufficient_quota')) {
    return make(ProbeProblem.quota);
  }
  if (status == 429) return make(ProbeProblem.rateLimited);
  if (status >= 500) return make(ProbeProblem.server);
  final aboutModel = words.contains('model');
  if (status == 403) {
    return make(aboutModel ? ProbeProblem.notAvailable : ProbeProblem.auth);
  }
  if (status == 404 ||
      codes.contains('model_not_found') ||
      (aboutModel &&
          RegExp(
            r'not found|does not exist|not exist|unknown model|invalid model',
          ).hasMatch(words))) {
    return make(ProbeProblem.notFound);
  }
  if (RegExp(r'tool|function').hasMatch(words) &&
      RegExp(r'not support|unsupported|does not support').hasMatch(words)) {
    return make(ProbeProblem.noTools);
  }
  return make(ProbeProblem.other, detail.isEmpty ? failure.code : detail);
}

String _providerMessage(String body) {
  try {
    final root = jsonDecode(body);
    final error = root is Map ? root['error'] : null;
    final message = error is Map
        ? error['message']
        : error is String
        ? error
        : root is Map
        ? root['message']
        : null;
    if (message is String && message.trim().isNotEmpty) {
      final one = message.trim().replaceAll(RegExp(r'\s+'), ' ');
      return one.length > 160 ? '${one.substring(0, 160)}…' : one;
    }
  } catch (_) {}
  return '';
}

/// A model that was tried (or skipped) and did not pass.
class ProbeRejection {
  const ProbeRejection(this.model, this.failure, {this.skipped = false});
  final String model;
  final ProbeFailure failure;

  /// Never tried: the listing says it does not use the configured protocol.
  final bool skipped;
  bool get notAvailable => failure.problem == ProbeProblem.notAvailable;
  bool get serverSide => failure.problem == ProbeProblem.server;
}

sealed class ProviderTestResult {
  const ProviderTestResult();
}

/// [main] is the first model that called the tool; [rejected] were tried before
/// it. Both empty means there was nothing to try; [main] null with rejections
/// means none passed.
class ProviderTestDone extends ProviderTestResult {
  const ProviderTestDone(this.main, this.rejected);
  final String? main;
  final List<ProbeRejection> rejected;
}

/// The first model failed for a reason that is not about that model (key,
/// network, address, timeout, or only server errors): the provider is not saved.
class ProviderTestBlocked extends ProviderTestResult {
  const ProviderTestBlocked(this.failure);
  final ProbeFailure failure;
}

/// Tries up to [limit] listed models in [probeCandidates] order, one tool call
/// each. A pass stops the loop; a model-specific failure moves to the next
/// model; other failures block when they come first. A server error is not
/// held against the provider yet: aggregators list many upstreams, so one dead
/// upstream must not hide a working model. Only if every tried model failed
/// that way is the whole provider treated as down.
///
/// A model whose listing names another endpoint or protocol than
/// [protocol]/[baseUrl] is skipped, because the client would call it wrongly.
/// A [preferred] model (the one already in use) is tried first when it is usable.
Future<ProviderTestResult> probeListedModels({
  required List<ListedModel> models,
  required ProviderCapabilities base,
  required List<String> familyTokens,
  required WireProtocol protocol,
  required String baseUrl,
  required Future<ProbeResult> Function(String model) probe,
  String? preferred,
  int limit = probeCandidateLimit,
}) async {
  final options = mergeModelOptions(models, base);
  final byId = {for (final m in models) m.id: m};
  final mismatched = <String>[];
  final usable = <String>[];
  for (final id in probeCandidates(options, familyTokens)) {
    final listed = byId[id];
    final endpoint = listed?.endpoint;
    final protocols = listed?.protocols;
    final sameRoute =
        endpoint == null ||
        (endpoint.protocol == protocol &&
            catalogBase(endpoint.baseUrl) == catalogBase(baseUrl));
    final speaks = protocols == null || protocols.contains(protocol);
    if (sameRoute && speaks) {
      usable.add(id);
    } else {
      mismatched.add(id);
    }
  }
  if (usable.isEmpty && mismatched.isNotEmpty) {
    return ProviderTestDone(null, [
      for (final id in mismatched.take(limit))
        ProbeRejection(
          id,
          ProbeFailure(ProbeProblem.wrongProtocol, id),
          skipped: true,
        ),
    ]);
  }
  if (preferred != null && usable.remove(preferred)) {
    usable.insert(0, preferred);
  }
  final order = usable.isNotEmpty
      ? usable
      : [if (options.isNotEmpty) options.first.id];
  final rejected = <ProbeRejection>[];
  ProbeFailure? firstServerError;
  for (final (i, model) in order.take(limit).indexed) {
    final result = await probe(model);
    switch (result) {
      case ProbeToolCalled():
        return ProviderTestDone(model, rejected);
      case ProbeNoToolCall():
        rejected.add(
          ProbeRejection(model, ProbeFailure(ProbeProblem.noTools, model)),
        );
      case ProbeFailed(:final error):
        final failure = classifyProbeFailure(error, model);
        if (failure.modelSpecific) {
          rejected.add(ProbeRejection(model, failure));
          if (failure.problem == ProbeProblem.server) {
            firstServerError ??= failure;
          }
        } else if (firstServerError != null || i == 0) {
          // The key is not proven yet, so this is about the provider.
          return ProviderTestBlocked(failure);
        } else {
          rejected.add(ProbeRejection(model, failure));
          return ProviderTestDone(null, rejected);
        }
    }
  }
  if (rejected.isNotEmpty && rejected.every((r) => r.serverSide)) {
    return ProviderTestBlocked(firstServerError ?? rejected.first.failure);
  }
  return ProviderTestDone(null, rejected);
}
