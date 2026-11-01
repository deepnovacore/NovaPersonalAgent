// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: layout and flow of ModelSetupScreen.kt /
// ModelsScreen.kt re-implemented in Flutter on Nova's backend, credentials and components.
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../agent_core/model_catalog.dart';
import '../agent_core/model_client.dart' show AgentFailure, ModelProtocol;
import '../agent_core/model_presets.dart';
import '../agent_core/model_probe.dart';
import '../agent_core/provider_credentials.dart';
import '../settings/model_settings_backend.dart';
import 'components.dart';
import 'local_dialog.dart';
import 'provider_setup_copy.dart';
import 'theme.dart';

/// Opens the provider setup page and completes when it is closed.
Future<void> showProviderSetupPage(
  BuildContext context,
  ModelSettingsBackend backend,
  ModelSettingsView view, {
  String language = 'zh',
  String? title,
  Future<void> Function(BuildContext)? onManageCredentials,
  Future<bool> Function(BuildContext)? onChatGpt,
}) => Navigator.of(context).push<void>(
  MaterialPageRoute(
    builder: (_) => ProviderSetupPage(
      backend: backend,
      view: view,
      language: language,
      title: title,
      onManageCredentials: onManageCredentials,
      onChatGpt: onChatGpt,
    ),
  ),
);

const customProviderId = 'custom';

/// Connect a model provider: sign in with an account, or pick a provider, paste
/// a key and let Nova list its models and ask one to call a tool before saving.
/// Keys go only to the backend's secure storage; nothing key-like is kept here
/// beyond the text field.
class ProviderSetupPage extends StatefulWidget {
  const ProviderSetupPage({
    super.key,
    required this.backend,
    required this.view,
    this.language = 'zh',
    this.title,
    this.onManageCredentials,
    this.onChatGpt,
  });
  final ModelSettingsBackend backend;
  final ModelSettingsView view;
  final String language;
  final String? title;
  final Future<void> Function(BuildContext)? onManageCredentials;
  final Future<bool> Function(BuildContext)? onChatGpt;

  @override
  State<ProviderSetupPage> createState() => _ProviderSetupPageState();
}

enum _Test { idle, running, failed }

class _StaleTest implements Exception {
  const _StaleTest();
}

class _ProviderSetupPageState extends State<ProviderSetupPage> {
  late ModelSettingsView _view = widget.view;
  late final _endpoint = TextEditingController(text: widget.view.endpoint);
  final _key = TextEditingController();
  final _model = TextEditingController();
  late String _presetId =
      widget.view.providerId ??
      (ModelPreset.forEndpoint(widget.view.endpoint) == null
          ? customProviderId
          : ModelPreset.forEndpoint(widget.view.endpoint)!.id);
  late ModelProtocol _protocol = widget.view.protocol;
  late String _customEndpoint =
      ModelPreset.forEndpoint(widget.view.endpoint) == null
      ? widget.view.endpoint
      : '';
  var _showKey = false, _manual = false, _noList = false;
  var _formOpen = true;
  var _test = _Test.idle;
  var _revision = 0;
  String? _failure, _note;
  var _saved = <SavedProvider>[];
  var _hasSavedKey = false;

  ProviderSetupCopy get _copy => ProviderSetupCopy(widget.language);
  ModelPreset? get _preset => ModelPreset.byId(_presetId);
  bool get _isCustom => _preset == null;
  bool get _selfHosted => _preset?.selfHosted ?? false;
  bool get _urlEditable => _isCustom || _selfHosted;
  bool get _showModel => _noList || _manual;

  @override
  void initState() {
    super.initState();
    _refreshSaved(initial: true);
    _refreshKeyStatus();
  }

  @override
  void dispose() {
    _endpoint.dispose();
    _key.dispose();
    _model.dispose();
    super.dispose();
  }

  Future<void> _refreshSaved({bool initial = false}) async {
    try {
      final saved = await widget.backend.savedProviders();
      final next = await widget.backend.load();
      if (!mounted) return;
      setState(() {
        _saved = saved;
        _view = next;
        if (initial) _formOpen = saved.isEmpty;
      });
    } catch (_) {
      // The list is a convenience; the form still works without it.
    }
  }

  Future<void> _refreshKeyStatus() async {
    final endpoint = _endpoint.text;
    bool saved;
    try {
      saved = await widget.backend.hasCredential(_preset?.id, endpoint);
    } catch (_) {
      saved = false;
    }
    if (mounted && endpoint == _endpoint.text) {
      setState(() => _hasSavedKey = saved);
    }
  }

  /// Anything the user changes makes an in-flight test obsolete.
  void _invalidate() {
    _revision++;
    _test = _Test.idle;
    _failure = null;
    _note = null;
  }

  void _choose(String id, {bool keepKey = false}) {
    setState(() {
      if (_presetId == customProviderId) _customEndpoint = _endpoint.text;
      _presetId = id;
      final preset = _preset;
      if (preset != null) {
        _endpoint.text = ModelPreset.forEndpoint(widget.view.endpoint)?.id == id
            ? widget.view.endpoint
            : preset.endpoint;
        _protocol = preset.protocol;
      } else {
        _endpoint.text = _customEndpoint;
        _protocol = widget.view.protocol;
      }
      if (!keepKey) _key.clear();
      _model.clear();
      _manual = false;
      _noList = false;
      _hasSavedKey = false;
      _invalidate();
    });
    _refreshKeyStatus();
  }

  String? get _urlProblem {
    if (!_urlEditable) return null;
    final text = _endpoint.text.trim();
    if (text.isEmpty) return _copy.urlNeed;
    if (!text.startsWith('http://') && !text.startsWith('https://')) {
      return _copy.urlScheme;
    }
    return null;
  }

  bool get _unencrypted {
    final uri = Uri.tryParse(_endpoint.text.trim());
    if (uri == null || uri.scheme != 'http' || uri.host.isEmpty) return false;
    return !_loopback(uri.host);
  }

  static bool _loopback(String host) {
    final h = host.replaceAll('[', '').replaceAll(']', '');
    return h == 'localhost' || InternetAddress.tryParse(h)?.isLoopback == true;
  }

  /// Local services run without a key; every other provider needs one.
  bool get _keyRequired {
    if (_selfHosted) return false;
    final uri = Uri.tryParse(_endpoint.text.trim());
    return !(_isCustom && uri != null && _loopback(uri.host));
  }

  ModelPreset? get _suggestion => _isCustom && _urlProblem == null
      ? ModelPreset.forHost(_endpoint.text)
      : null;

  bool get _canTest =>
      _urlProblem == null &&
      !_unencrypted &&
      _test != _Test.running &&
      (!_keyRequired || _key.text.trim().isNotEmpty || _hasSavedKey) &&
      (!_noList || _model.text.trim().isNotEmpty);

  ProviderKind get _exampleKind =>
      _suggestion?.providerKind ??
      _preset?.providerKind ??
      (_protocol == ModelProtocol.responses
          ? ProviderKind.openAiResponses
          : ProviderKind.openAiCompat);

  ModelSettingsInput _input(String model, String key) => ModelSettingsInput(
    providerId: _preset?.id,
    endpoint: _endpoint.text.trim(),
    model: model,
    protocol: _protocol,
    newKey: key,
  );

  Future<void> _testAndSave() async {
    if (!_canTest) return;
    final copy = _copy;
    final revision = ++_revision;
    void checkFresh() {
      if (!mounted || revision != _revision) throw const _StaleTest();
    }

    setState(() {
      _test = _Test.running;
      _failure = null;
      _note = null;
    });
    final typedKey = _key.text.trim();
    final key = typedKey.isNotEmpty
        ? typedKey
        : (!_hasSavedKey && !_keyRequired ? keylessServiceKey : '');
    final typed = _showModel ? _model.text.trim() : '';
    final backend = widget.backend;
    final preset = _preset;
    try {
      ModelListResult listed;
      try {
        listed = await backend.listModelsDetailed(_input('', key));
      } catch (_) {
        listed = const ModelListFailed(ListFailure.network);
      }
      checkFresh();
      final models = listed is ModelListOk ? listed.models : <ListedModel>[];
      if (listed is ModelListFailed &&
          listed.reason != ListFailure.notSupported &&
          typed.isEmpty) {
        setState(() {
          _test = _Test.failed;
          _failure = copy.failed(copy.listFailure(listed as ModelListFailed));
          _manual = true;
        });
        return;
      }
      if (models.isEmpty && typed.isEmpty) {
        setState(() {
          _test = _Test.idle;
          _noList = true;
        });
        return;
      }
      String? selected;
      String? note;
      if (typed.isNotEmpty) {
        final result = await backend.probe(_input(typed, key));
        checkFresh();
        switch (result) {
          case ProbeFailed(:final error):
            setState(() {
              _test = _Test.failed;
              _failure = copy.failed(
                copy.probeFailed(
                  classifyProbeFailure(error, typed),
                  example: copy.exampleModel(_exampleKind),
                  listMissing: models.isEmpty && _isCustom,
                ),
              );
            });
            return;
          case ProbeNoToolCall():
            note = copy.noToolsKept(typed);
          case ProbeToolCalled():
            selected = typed;
        }
      } else {
        final done = await probeListedModels(
          models: models,
          base: preset?.capabilities ?? const ProviderCapabilities(),
          familyTokens: preset?.familyTokens ?? const [],
          protocol: _protocol == ModelProtocol.responses
              ? WireProtocol.responses
              : WireProtocol.chatCompletions,
          baseUrl: _endpoint.text.trim(),
          probe: (model) async {
            checkFresh();
            final result = await backend.probe(_input(model, key));
            checkFresh();
            return result;
          },
        );
        checkFresh();
        switch (done) {
          case ProviderTestBlocked(:final failure):
            setState(() {
              _test = _Test.failed;
              _failure = copy.failed(
                copy.probeFailed(
                  failure,
                  example: copy.exampleModel(_exampleKind),
                ),
              );
            });
            return;
          case ProviderTestDone(main: null, rejected: []):
            setState(() {
              _test = _Test.idle;
              _noList = true;
            });
            return;
          case final ProviderTestDone result:
            selected = result.main;
            note = copy.probeNote(result);
        }
      }
      if (selected != null) {
        await backend.save(_input(selected, key));
      } else {
        await backend.saveCredential(_input('', key));
      }
      checkFresh();
      await _refreshSaved();
      if (!mounted) return;
      if (selected != null && note == null) {
        Navigator.of(context).pop();
        return;
      }
      setState(() {
        _test = _Test.idle;
        _note = note;
        _formOpen = false;
        _key.clear();
        _model.clear();
        _manual = false;
        _noList = false;
      });
    } on _StaleTest {
      return;
    } catch (_) {
      if (!mounted || revision != _revision) return;
      setState(() {
        _test = _Test.failed;
        _failure = copy.failed(copy.saveFailed);
      });
    }
  }

  Future<void> _openDetail(SavedProvider provider) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => ProviderDetailPage(
          backend: widget.backend,
          provider: provider,
          view: _view,
          language: widget.language,
        ),
      ),
    );
    if (mounted) await _refreshSaved();
  }

  Future<void> _signInChatGpt() async {
    final close = await widget.onChatGpt!(context);
    if (mounted && close) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final copy = _copy;
    final preset = _preset;
    final suggestion = _suggestion;
    final note = preset == null
        ? null
        : (widget.language == 'zh' ? preset.noteZh : preset.noteEn);
    final urlProblem = _urlProblem;
    return NovaPage(
      title: widget.title ?? copy.setupTitle,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.only(top: 8, bottom: 32),
          children: [
            _text(
              _view.securityText ??
                  copy.t(
                    '对话和任务所需内容会发送给所选模型服务。API 密钥仅保存在这台设备，保存在当前 Space 的安全存储中。',
                    'Content needed for conversations and tasks is sent to the selected model provider. Your API key stays on this device and is stored in the current Space secure storage.',
                  ),
              pad: const EdgeInsets.fromLTRB(20, 4, 20, 14),
            ),
            if (_saved.isNotEmpty)
              NovaSection(
                header: copy.providers,
                children: [
                  for (final p in _saved)
                    NovaTile(
                      key: ValueKey('provider.saved.${p.id}'),
                      leading: const NovaIconTile(CupertinoIcons.cloud),
                      title: p.label,
                      subtitle: Text(
                        _shortUrl(p.endpoint) +
                            (_isCurrent(p.endpoint)
                                ? ' · ${copy.inUse} ${_view.model}'
                                : ''),
                      ),
                      trailing: const CupertinoListTileChevron(),
                      onTap: () => _openDetail(p),
                    ),
                  if (!_formOpen)
                    NovaTile(
                      key: const ValueKey('provider.add'),
                      leading: const NovaIconTile(CupertinoIcons.add),
                      title: copy.addProvider,
                      onTap: () => setState(() => _formOpen = true),
                    ),
                ],
              ),
            if (_note != null) NovaNotice(_note!, tone: NovaTone.warning),
            if (_formOpen) ...[
              if (widget.onChatGpt != null)
                NovaSection(
                  header: copy.accountGroup,
                  children: [
                    NovaTile(
                      key: const ValueKey('provider.chatgpt'),
                      leading: const NovaIconTile(CupertinoIcons.person_fill),
                      title: 'ChatGPT',
                      subtitle: Text(copy.chatGptRowSubtitle),
                      trailing: const CupertinoListTileChevron(),
                      onTap: _signInChatGpt,
                    ),
                  ],
                ),
              _header(copy.keyGroup),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final p in _view.providers)
                      ChoiceChip(
                        key: ValueKey('provider.chip.${p.id}'),
                        label: Text(p.name),
                        selected: _presetId == p.id,
                        onSelected: (_) => _choose(p.id),
                      ),
                    if (_view.customEndpoint)
                      ChoiceChip(
                        key: const ValueKey('provider.chip.custom'),
                        label: Text(copy.custom),
                        selected: _isCustom,
                        onSelected: (_) => _choose(customProviderId),
                      ),
                  ],
                ),
              ),
              if (_isCustom) _protocolRow(copy),
              if (_urlEditable)
                _field(
                  key: const ValueKey('provider.baseUrl'),
                  controller: _endpoint,
                  label: copy.baseUrl,
                  helper: copy.baseUrlHelp,
                  keyboardType: TextInputType.url,
                  onChanged: () {
                    _key.clear();
                    _invalidate();
                    _hasSavedKey = false;
                    _refreshKeyStatus();
                  },
                ),
              _field(
                key: const ValueKey('provider.key'),
                controller: _key,
                label: copy.apiKey,
                hint: _keyRequired ? copy.keyHint : copy.keyOptional,
                helper: _hasSavedKey ? copy.keySavedHint : null,
                obscure: !_showKey,
                onChanged: _invalidate,
                suffix: TextButton(
                  key: const ValueKey('provider.key.toggle'),
                  onPressed: () => setState(() => _showKey = !_showKey),
                  child: Text(_showKey ? copy.hide : copy.show),
                ),
              ),
              if (_showModel)
                _field(
                  key: const ValueKey('provider.model'),
                  controller: _model,
                  label: copy.modelName,
                  hint: preset?.recommendedModels.isNotEmpty == true
                      ? preset!.recommendedModels.first
                      : copy.exampleModel(_exampleKind),
                  keyboardType: TextInputType.url,
                  onChanged: _invalidate,
                ),
              if (preset != null && preset.keyUrl.isNotEmpty)
                Align(
                  alignment: Alignment.centerLeft,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: TextButton(
                      key: const ValueKey('provider.keyLink'),
                      onPressed: () => launchUrl(
                        Uri.parse(preset.keyUrl),
                        mode: LaunchMode.externalApplication,
                      ),
                      child: Text(copy.getKey),
                    ),
                  ),
                ),
              if (!_noList)
                Align(
                  alignment: Alignment.centerLeft,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: TextButton(
                      key: const ValueKey('provider.manual'),
                      onPressed: () => setState(() {
                        _manual = !_manual;
                        _invalidate();
                      }),
                      child: Text(_manual ? copy.manualOff : copy.manualOn),
                    ),
                  ),
                ),
              if (_manual && !_noList)
                _text(
                  copy.manualNote,
                  key: const ValueKey('provider.manualNote'),
                ),
              if (note != null) _text(note),
              if (urlProblem != null && _endpoint.text.trim().isNotEmpty)
                _text(urlProblem, color: Nova.red),
              if (suggestion != null) ...[
                _text(
                  copy.presetMatch(suggestion.name),
                  key: const ValueKey('provider.suggestion'),
                  color: Nova.amber,
                ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: TextButton(
                      key: const ValueKey('provider.usePreset'),
                      onPressed: () => _choose(suggestion.id, keepKey: true),
                      child: Text(copy.usePreset(suggestion.name)),
                    ),
                  ),
                ),
              ],
              if (_noList)
                _text(
                  _isCustom ? copy.noListCustom : copy.noListPreset,
                  key: const ValueKey('provider.noList'),
                ),
              if (_selfHosted)
                _text(
                  copy.selfHostedNote,
                  key: const ValueKey('provider.selfHosted'),
                ),
              if (_unencrypted)
                _text(
                  copy.urlUnencrypted,
                  key: const ValueKey('provider.unencrypted'),
                  color: Nova.amber,
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: FilledButton(
                  key: const ValueKey('provider.test'),
                  onPressed: _canTest ? _testAndSave : null,
                  child: Text(
                    _test == _Test.running ? copy.testing : copy.testAndSave,
                  ),
                ),
              ),
              if (_test == _Test.failed && _failure != null)
                _text(
                  _failure!,
                  key: const ValueKey('provider.failed'),
                  color: Nova.red,
                  pad: const EdgeInsets.fromLTRB(20, 10, 20, 0),
                ),
              _text(copy.testNote),
            ],
            if (widget.onManageCredentials != null)
              Align(
                alignment: Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: TextButton(
                    key: const ValueKey('model.credentials'),
                    onPressed: () async {
                      await widget.onManageCredentials!(context);
                      if (mounted) {
                        await _refreshSaved();
                        await _refreshKeyStatus();
                      }
                    },
                    child: Text(copy.manageCredentials),
                  ),
                ),
              ),
            _text(copy.keyNote),
          ],
        ),
      ),
    );
  }

  bool _isCurrent(String endpoint) {
    try {
      return ProviderCredentials.scopeForEndpoint(endpoint) ==
          ProviderCredentials.scopeForEndpoint(_view.endpoint);
    } on AgentFailure {
      return false;
    }
  }

  Widget _protocolRow(ProviderSetupCopy copy) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
    child: Row(
      children: [
        Text(copy.protocol, style: const TextStyle(fontSize: 15)),
        const SizedBox(width: 12),
        Wrap(
          spacing: 6,
          children: [
            for (final (protocol, label) in const [
              (ModelProtocol.chatCompletions, 'Chat Completions'),
              (ModelProtocol.responses, 'Responses'),
            ])
              ChoiceChip(
                label: Text(label),
                selected: _protocol == protocol,
                onSelected: (_) => setState(() {
                  _protocol = protocol;
                  _invalidate();
                }),
              ),
          ],
        ),
      ],
    ),
  );

  Widget _header(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(32, 6, 20, 8),
    child: Text(
      text,
      style: const TextStyle(
        color: Nova.secondary,
        fontSize: 13,
        fontWeight: FontWeight.w500,
      ),
    ),
  );

  Widget _text(
    String text, {
    Key? key,
    Color color = Nova.secondary,
    EdgeInsets pad = const EdgeInsets.fromLTRB(20, 2, 20, 8),
  }) => Padding(
    key: key,
    padding: pad,
    child: Text(
      text,
      style: TextStyle(color: color, fontSize: 13, height: 1.45),
    ),
  );

  Widget _field({
    required Key key,
    required TextEditingController controller,
    required String label,
    required VoidCallback onChanged,
    String? hint,
    String? helper,
    bool obscure = false,
    Widget? suffix,
    TextInputType? keyboardType,
  }) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
    child: TextField(
      key: key,
      controller: controller,
      obscureText: obscure,
      autocorrect: false,
      enableSuggestions: false,
      enableIMEPersonalizedLearning: false,
      keyboardType: keyboardType,
      onChanged: (_) => setState(onChanged),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        helperText: helper,
        helperMaxLines: 3,
        suffixIcon: suffix,
        filled: true,
        fillColor: Nova.sheetCell,
      ),
    ),
  );
}

String _shortUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null || uri.host.isEmpty) return url;
  final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
  return '${uri.host}${uri.hasPort ? ':${uri.port}' : ''}$path';
}

// ---------------------------------------------------------------------------

/// One connected provider: status, address, whether a key is stored, a few of
/// its models with capability tags, and removal.
class ProviderDetailPage extends StatefulWidget {
  const ProviderDetailPage({
    super.key,
    required this.backend,
    required this.provider,
    required this.view,
    this.language = 'zh',
  });
  final ModelSettingsBackend backend;
  final SavedProvider provider;
  final ModelSettingsView view;
  final String language;

  /// Models shown before "view all".
  static const preview = 3;

  @override
  State<ProviderDetailPage> createState() => _ProviderDetailPageState();
}

class _ProviderDetailPageState extends State<ProviderDetailPage> {
  ModelListResult? _listing;
  String? _message;
  var _busy = false;
  late ModelSettingsView _view = widget.view;

  ProviderSetupCopy get _copy => ProviderSetupCopy(widget.language);
  ModelPreset? get _preset => ModelPreset.forEndpoint(widget.provider.endpoint);
  ModelProtocol get _protocol => _isCurrent
      ? _view.protocol
      : _preset?.protocol ?? ModelProtocol.chatCompletions;
  bool get _isCurrent {
    try {
      return ProviderCredentials.scopeForEndpoint(widget.provider.endpoint) ==
          ProviderCredentials.scopeForEndpoint(_view.endpoint);
    } on AgentFailure {
      return false;
    }
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  ModelSettingsInput _input(String model, {String key = ''}) =>
      ModelSettingsInput(
        providerId: _preset?.id,
        endpoint: widget.provider.endpoint,
        model: model,
        protocol: _protocol,
        newKey: key,
      );

  Future<void> _load() async {
    setState(() => _listing = null);
    ModelListResult result;
    try {
      result = await widget.backend.listModelsDetailed(_input(''));
    } catch (_) {
      result = const ModelListFailed(ListFailure.network);
    }
    if (mounted) setState(() => _listing = result);
  }

  List<ModelOption> get _options {
    final listing = _listing;
    if (listing is! ModelListOk) return const [];
    final options = mergeModelOptions(
      listing.models,
      _preset?.capabilities ?? const ProviderCapabilities(),
    );
    if (!_isCurrent || options.any((o) => o.id == _view.model)) return options;
    // The model in use may be typed by hand and absent from the list.
    return [
      ModelOption(
        id: _view.model,
        capabilities: _preset?.capabilities ?? const ProviderCapabilities(),
        toolCallsKnown: false,
        visionKnown: false,
        contextKnown: false,
        typed: true,
      ),
      ...options,
    ];
  }

  Future<void> _use(ModelOption option) async {
    final copy = _copy;
    setState(() {
      _busy = true;
      _message = null;
    });
    String? message;
    try {
      final result = await widget.backend.probe(_input(option.id));
      switch (result) {
        case ProbeToolCalled():
          await widget.backend.save(_input(option.id));
          _view = await widget.backend.load();
        case ProbeNoToolCall():
          message = copy.probeFailed(
            ProbeFailure(ProbeProblem.noTools, option.id),
            example: '',
          );
        case ProbeFailed(:final error):
          message = copy.probeFailed(
            classifyProbeFailure(error, option.id),
            example: copy.exampleModel(
              _preset?.providerKind ?? ProviderKind.openAiCompat,
            ),
          );
      }
    } catch (_) {
      message = copy.actionFailed;
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _message = message;
    });
  }

  Future<void> _chooseModel(ModelOption option) async {
    if (_busy) return;
    final copy = _copy;
    final use = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(option.id, style: _modelIdStyle),
              const SizedBox(height: 8),
              _Tags(option: option, copy: copy),
              const SizedBox(height: 16),
              FilledButton(
                key: const ValueKey('provider.model.use'),
                onPressed: () => Navigator.pop(context, true),
                child: Text(copy.useForChat),
              ),
            ],
          ),
        ),
      ),
    );
    if (use == true && mounted) await _use(option);
  }

  Future<void> _changeKey() async {
    final copy = _copy;
    final key = TextEditingController();
    try {
      final value = await showLocalDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(copy.changeKey),
          content: TextField(
            key: const ValueKey('provider.newKey'),
            controller: key,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            enableIMEPersonalizedLearning: false,
            decoration: InputDecoration(hintText: copy.newKeyHint),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(copy.cancel),
            ),
            TextButton(
              key: const ValueKey('provider.newKey.save'),
              onPressed: () => Navigator.pop(context, key.text.trim()),
              child: Text(copy.save),
            ),
          ],
        ),
      );
      if (value == null || value.isEmpty || !mounted) return;
      try {
        await widget.backend.saveCredential(_input('', key: value));
        await _load();
      } catch (_) {
        if (mounted) setState(() => _message = copy.actionFailed);
      }
    } finally {
      key.dispose();
    }
  }

  Future<void> _delete() async {
    final copy = _copy;
    final confirmed = await showLocalDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(copy.deleteTitle(widget.provider.label)),
        content: Text(copy.deleteBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(copy.cancel),
          ),
          TextButton(
            key: const ValueKey('provider.delete.confirm'),
            onPressed: () => Navigator.pop(context, true),
            child: Text(
              copy.deleteConfirm,
              style: const TextStyle(color: Nova.red),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await widget.backend.deleteProvider(widget.provider.id);
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _message = copy.actionFailed);
    }
  }

  @override
  Widget build(BuildContext context) {
    final copy = _copy;
    final listing = _listing;
    final options = _options;
    final preview = options.take(ProviderDetailPage.preview).toList();
    final failed = listing is ModelListFailed ? listing : null;
    final unlisted =
        (listing is ModelListOk && listing.models.isEmpty) ||
        failed?.reason == ListFailure.notSupported;
    final protocolLabel = switch (_protocol) {
      ModelProtocol.responses => 'OpenAI Responses',
      _ => copy.t('OpenAI 兼容', 'OpenAI-compatible'),
    };
    return NovaPage(
      title: widget.provider.label,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.only(top: 8, bottom: 32),
          children: [
            NovaSection(
              header: copy.connection,
              children: [
                NovaTile(
                  title: copy.status,
                  subtitle: listing == null
                      ? Text(copy.listing)
                      : Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: NovaStatusChip(
                            failed != null && !unlisted
                                ? copy.listFailedShort
                                : copy.connected,
                            key: const ValueKey('provider.status'),
                            tone: failed != null && !unlisted
                                ? NovaTone.danger
                                : NovaTone.success,
                          ),
                        ),
                ),
                NovaTile(title: copy.api, subtitle: Text(protocolLabel)),
                NovaTile(
                  title: copy.address,
                  subtitle: Text(_shortUrl(widget.provider.endpoint)),
                ),
                NovaTile(
                  key: const ValueKey('provider.key.row'),
                  title: copy.apiKey,
                  subtitle: Text('${copy.keySaved} · ${copy.change}'),
                  trailing: const CupertinoListTileChevron(),
                  onTap: _changeKey,
                ),
              ],
            ),
            if (failed != null && !unlisted)
              NovaNotice(copy.failed(copy.listFailure(failed))),
            if (_message != null) NovaNotice(_message!),
            NovaSection(
              header: copy.models,
              trailing: CupertinoButton(
                padding: EdgeInsets.zero,
                minimumSize: Size.zero,
                onPressed: listing == null ? null : _load,
                child: Text(
                  copy.refresh,
                  style: const TextStyle(fontSize: 13, color: Nova.mint),
                ),
              ),
              children: [
                for (final option in preview)
                  _ModelTile(
                    option: option,
                    copy: copy,
                    current: _isCurrent && option.id == _view.model,
                    onTap: _busy ? null : () => _chooseModel(option),
                  ),
                if (options.length > preview.length)
                  NovaTile(
                    key: const ValueKey('provider.viewAll'),
                    title: copy.viewAll(options.length),
                    trailing: const CupertinoListTileChevron(),
                    onTap: () => Navigator.of(context).push<void>(
                      MaterialPageRoute(
                        builder: (_) => _AllModelsPage(
                          title: copy.allModelsTitle(widget.provider.label),
                          options: options,
                          copy: copy,
                          currentId: _isCurrent ? _view.model : null,
                          onChoose: (option) {
                            Navigator.of(context).pop();
                            _chooseModel(option);
                          },
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            if (options.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                child: Text(
                  copy.modelsNote,
                  style: const TextStyle(color: Nova.secondary, fontSize: 13),
                ),
              ),
            if (unlisted)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                child: Text(
                  copy.noListNote,
                  key: const ValueKey('provider.noListNote'),
                  style: const TextStyle(color: Nova.secondary, fontSize: 13),
                ),
              ),
            if (_busy) const LinearProgressIndicator(),
            NovaSection(
              footer: _isCurrent ? copy.deleteInUse : null,
              children: [
                NovaTile(
                  key: const ValueKey('provider.delete'),
                  leading: NovaIconTile(
                    CupertinoIcons.delete,
                    color: _isCurrent ? Nova.tertiary : Nova.red,
                  ),
                  title: copy.delete,
                  onTap: _isCurrent || _busy ? null : _delete,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

const _modelIdStyle = TextStyle(
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: FontWeight.w500,
  color: Nova.text,
);

class _ModelTile extends StatelessWidget {
  const _ModelTile({
    required this.option,
    required this.copy,
    required this.current,
    this.onTap,
  });
  final ModelOption option;
  final ProviderSetupCopy copy;
  final bool current;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => NovaTile(
    key: ValueKey('provider.model.${option.id}'),
    title: option.id,
    subtitle: _Tags(option: option, copy: copy),
    trailing: current
        ? NovaStatusChip(copy.inUse, tone: NovaTone.success)
        : null,
    onTap: onTap,
  );
}

class _Tags extends StatelessWidget {
  const _Tags({required this.option, required this.copy});
  final ModelOption option;
  final ProviderSetupCopy copy;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 5,
    runSpacing: 4,
    children: [
      for (final (label, strong) in copy.tags(option))
        NovaStatusChip(
          label,
          tone: strong ? NovaTone.active : NovaTone.neutral,
        ),
    ],
  );
}

class _AllModelsPage extends StatelessWidget {
  const _AllModelsPage({
    required this.title,
    required this.options,
    required this.copy,
    required this.currentId,
    required this.onChoose,
  });
  final String title;
  final List<ModelOption> options;
  final ProviderSetupCopy copy;
  final String? currentId;
  final void Function(ModelOption) onChoose;

  @override
  Widget build(BuildContext context) => NovaPage(
    title: title,
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.only(top: 8, bottom: 32),
        children: [
          NovaSection(
            children: [
              for (final option in options)
                _ModelTile(
                  option: option,
                  copy: copy,
                  current: option.id == currentId,
                  onTap: () => onChoose(option),
                ),
            ],
          ),
        ],
      ),
    ),
  );
}
