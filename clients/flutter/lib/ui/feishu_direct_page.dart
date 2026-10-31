import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../connectors/feishu/browser.dart';
import '../connectors/feishu/host.dart';
import '../connectors/feishu/auth.dart';
import '../connectors/feishu/api.dart';
import '../agent_core/model_settings.dart';
import '../agent_core/model_client.dart';
import '../context/local_publication.dart';
import '../context/profile_agent.dart';
import '../context/profile_corrections.dart';
import 'components.dart';
import 'local_profile_results.dart';
import 'theme.dart';
import 'profile_generation_status.dart';
import '../context/profile_generation_coordinator.dart';

/// Short display copy only; detailed agent diagnostics never become progress UI.
String profileProgressLabel(String status, {String language = 'zh'}) {
  String t(String zh, String en) => language == 'zh' ? zh : en;
  final checked = RegExp(
    r'^已核对 (\d+) / (\d+) 条消息；本轮新处理 (\d+) 条，复用 (\d+) 条',
  ).firstMatch(status);
  if (checked != null) {
    return t(
      '已核对 ${checked[1]} / ${checked[2]} 条消息（复用 ${checked[4]} 条）',
      'Verified ${checked[1]} / ${checked[2]} messages (${checked[4]} reused)',
    );
  }
  final read = RegExp(r'^已整理 (\d+) / (\d+) 条文本').firstMatch(status);
  if (read != null) {
    return t(
      '已处理 ${read[1]} / ${read[2]} 条消息',
      'Processed ${read[1]} / ${read[2]} messages',
    );
  }
  if (status.startsWith('正在读取') || status.startsWith('正在分批归纳')) {
    return t('正在阅读聊天记录…', 'Reading chat history…');
  }
  if (status.startsWith('正在核对第') || status.startsWith('正在修正引用')) {
    return t('正在核对原文…', 'Checking source messages…');
  }
  if (status.startsWith('正在独立核对')) {
    return t('正在核对近况内容…', 'Reviewing updates…');
  }
  if (status.startsWith('正在修订')) {
    return t('正在完善近况…', 'Refining updates…');
  }
  return t('正在生成近况…', 'Generating updates…');
}

class FeishuDirectPage extends StatefulWidget {
  const FeishuDirectPage({
    super.key,
    required this.host,
    required this.models,
    required this.publication,
    this.adoptTodo,
    this.profileAgent,
    this.generation,
    this.language = 'zh',
  });
  final Future<Map<String, dynamic>> Function(Map<String, dynamic>, String)?
  adoptTodo;
  final String language;
  final ProfileAgent? profileAgent;
  final ProfileGenerationCoordinator? generation;
  final FeishuHost host;
  final ModelSettings models;
  final LocalPublicationContext publication;
  @override
  State<FeishuDirectPage> createState() => _FeishuDirectPageState();
}

class _FeishuDirectPageState extends State<FeishuDirectPage>
    with WidgetsBindingObserver {
  final app = TextEditingController(), secret = TextEditingController();
  String brand = 'feishu';
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  String get providerLabel =>
      provider?.split('|').reversed.join('\n') ??
      t('尚未选择模型', 'No model selected');
  String? error, processingError, chatPage;
  String? provider;
  StreamSubscription<void>? _modelChanges;
  int _providerRead = 0;
  FeishuAuthorizationSession? session;
  bool _busy = false, polling = false, hasMoreChats = false;
  bool get busy => _busy || host.collection.running;

  /// Page-owned connection actions (browser registration and manual binding)
  /// must stay usable while a long sync is running; only the page's own
  /// in-flight work and an open browser session block them.
  bool get bindBusy => _busy || session != null;
  bool manualBind = false, _scopeExpanded = false;
  String? bindError;
  bool registering = false;
  List<Map<String, dynamic>> get chats => host.collection.chats;
  Timer? timer;
  late final profile =
      widget.profileAgent ??
      ProfileAgent(
        host,
        widget.publication,
        widget.models,
        onProgress: _changed,
      );
  FeishuHost get host => widget.host;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    host.addListener(_changed);
    profile.addListener(_changed);
    widget.generation?.addListener(_changed);
    _modelChanges = widget.models.changes.listen((_) => _loadProvider());
    _loadProvider();
    unawaited(profile.repository.open().then((_) => _changed()));
  }

  Future<void> _loadProvider() async {
    final read = ++_providerRead;
    try {
      final model = await widget.models.readForPurpose(ModelPurpose.support);
      if (mounted && read == _providerRead) {
        setState(
          () => provider = model == null
              ? null
              : '${model.endpoint}|${model.model}',
        );
      }
    } catch (_) {
      if (mounted && read == _providerRead) setState(() => provider = null);
    }
  }

  Future<void> _requireProvider(String expected) async {
    final model = await widget.models.readForPurpose(ModelPurpose.support);
    if (model == null || '${model.endpoint}|${model.model}' != expected) {
      throw StateError('provider_changed');
    }
  }

  Future<void> _correctProfile(String category) async {
    await _loadProvider();
    if (!mounted || provider == null) throw StateError('model_required');
    final selectedProvider = provider!;
    final value = TextEditingController(
      text:
          profile.corrections.values(
            profile.repository.correctionScope,
          )[category] ??
          '',
    );
    try {
      final accepted = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          scrollable: true,
          title: Text(
            t(
              '修改${ProfileCorrections.categories[category]}',
              'Edit personal info',
            ),
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  t(
                    '你填写的内容会替代对应的推测，保存在手机，并允许以下模型用于后续个人信息和对话：\n\n$providerLabel',
                    'Your text replaces the corresponding inference and is saved on this phone. You allow the following model to use it for future personal info and conversations:\n\n$providerLabel',
                  ),
                ),
                TextField(controller: value, maxLines: 4, maxLength: 2600),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(t('取消', 'Cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(t('保存并允许使用', 'Save and allow use')),
            ),
          ],
        ),
      );
      if (accepted == true) {
        await _requireProvider(selectedProvider);
        await profile.corrections.correct(
          profile.repository.correctionScope,
          category,
          value.text,
          selectedProvider,
        );
      }
    } finally {
      value.dispose();
    }
  }

  Future<void> _showResults() async {
    var editing = false;
    String? correctionError;
    await Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (routeContext) => StatefulBuilder(
          builder: (context, refresh) => Scaffold(
            backgroundColor: Nova.ink,
            appBar: AppBar(
              title: Text(t('近况与个人信息', 'Updates and personal info')),
            ),
            body: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                LocalProfileResults(
                  host: host,
                  publication: widget.publication,
                  repository: profile.repository,
                  generation: widget.generation,
                  kind: 'all',
                  language: widget.language,
                  adoptTodo: widget.adoptTodo,
                  revision: profile.repository.value?['revision'] as int? ?? 0,
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(t('补充或修改个人信息', 'Edit personal info')),
                  subtitle: Text(
                    t(
                      '你填写的内容将替代对应的推测。',
                      'What you enter replaces the corresponding inference.',
                    ),
                  ),
                ),
                if (provider == null) const Text('请先在设置中配置模型，再保存个人信息。'),
                if (correctionError != null)
                  Text(
                    correctionError!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                for (final category in ProfileCorrections.categories.entries)
                  ListTile(
                    title: Text(category.value),
                    subtitle: Text(
                      profile.corrections.values(
                            profile.repository.correctionScope,
                          )[category.key] ??
                          t('未填写', 'Not provided'),
                    ),
                    trailing: const Icon(CupertinoIcons.pencil),
                    onTap: editing || busy || provider == null
                        ? null
                        : () async {
                            refresh(() {
                              editing = true;
                              correctionError = null;
                            });
                            try {
                              await _correctProfile(category.key);
                            } catch (failure) {
                              correctionError = _message(failure);
                            } finally {
                              if (routeContext.mounted) {
                                refresh(() => editing = false);
                              }
                              _changed();
                            }
                          },
                  ),
              ],
            ),
          ),
        ),
      ),
    );
    _changed();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _run(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      _busy = true;
      error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => error = _message(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _message(Object error) => switch (error) {
    ProfileRunFailure(code: 'profile_deadline') => t(
      '本轮整理已到时，已暂停。点击“继续生成”，可在资料和授权不变时接着已保存的进度整理。',
      'This processing session reached its time limit and paused. Choose Resume generation to reuse saved progress while sources and permissions are unchanged.',
    ),
    ProfileRunFailure(code: 'profile_cancelled') ||
    AgentFailure(code: 'cancelled') => t(
      '已暂停生成，消息仍保存在手机。资料和授权未变化时，可继续使用已保存的进度。',
      'Generation paused. Messages remain on this phone. Saved progress can be reused while sources and permissions are unchanged.',
    ),
    AgentFailure(code: 'model_required') ||
    StateError(message: 'model_required') => t(
      '请先在设置中选择模型，再生成近况。',
      'Choose a model in Settings before generating updates.',
    ),
    AgentFailure(code: 'source_expired') => t(
      '部分消息已超过保存期限。请重新同步消息，再生成近况。',
      'Some saved messages have expired. Sync them again before generating updates.',
    ),
    AgentFailure(code: 'model_request_failed') =>
      '模型请求失败，请检查当前模型服务与网络。消息仍保存在手机。',
    AgentFailure(code: 'tool_round_limit') => t(
      '本次未能生成完整近况，消息仍保存在手机。',
      'Could not generate complete updates. Messages remain on this phone.',
    ),
    AgentFailure(code: 'profile_budget_unavailable') => t(
      '暂时无法确认剩余额度，已暂停整理，避免重复扣费。',
      'The remaining allowance could not be checked. Updates are paused to avoid repeated charges.',
    ),
    StateError(message: 'profile_result_more_complete') => t(
      '已保留先前更完整的结果。可继续生成，补充尚未整理的消息。',
      'Your more complete results were kept. Resume generation to process the remaining messages.',
    ),
    StateError(message: 'profile_no_saved_observations') => t(
      '没有可复用的已整理内容。请先生成近况；资料、授权或模型变更后，需要重新整理。',
      'No saved observations are available. Generate updates first; changes to sources, permissions or model require processing again.',
    ),
    AgentFailure(code: 'profile_not_published') => t(
      '本次没有生成可用内容，消息仍保存在手机。',
      'No usable content was generated. Messages remain on this phone.',
    ),
    FeishuFailure(code: 'registration_expired') => '网页绑定已过期，请重新开始。',
    FeishuFailure(code: 'registration_denied') => '已取消网页绑定，没有保存应用凭据。',
    StateError(message: 'profile_context_too_large') =>
      '完整原文、纠正或模型结果超过本轮上下文容量，已停止且未截断内容。请缩小处理范围后重试。',
    StateError(message: 'source_storage_full') =>
      '本机缓存已满，读取尚未完成。已保存进度；可缩小范围或删除不需要的来源后继续。',
    FeishuFailure(code: 'missing_scopes') => '应用缺少所需读取权限，请在飞书开放平台确认权限后重新授权。',
    FeishuFailure(code: 'rate_limited') => '飞书暂时限流，请稍后继续读取。当前进度已保留。',
    FeishuFailure(code: 'reauthorization_required') => '凭据需要重新授权，已有授权不能继续使用。',
    FeishuFailure(code: 'revocation_pending') => '本机已停止访问；远端撤销尚未完成，请重试撤销。',
    FeishuFailure(code: 'unsupported_token_binding') =>
      '该应用返回的令牌绑定方式暂不支持，请保留当前状态并反馈。',
    FeishuFailure(code: 'browser_unavailable') => '系统未能打开官方授权网页，请重试打开。',
    MissingPluginException() => '授权页面组件未初始化，请重启应用后重试。',
    PlatformException(code: 'channel-error') => '授权页面组件连接失败，请重启应用后重试。',
    _ => '操作未完成，请检查应用配置、网络和权限后重试。读取进度不会提前推进。',
  };
  Future<void> _register() async {
    session = await host.auth.beginAppRegistration(brand);
    registering = true;
    await _openSession();
  }

  /// Manual binding for an app the user already created in the Feishu console.
  /// It deliberately ignores [host.collection.running]: a long sync must not
  /// keep credentials from being entered. Identity and collection state are
  /// handed back to the host through [FeishuHost.synchronizeIdentity].
  Future<void> _bindExisting() async {
    if (_busy) return;
    final appId = app.text.trim(), appSecret = secret.text.trim();
    final invalid = !appId.startsWith('cli_')
        ? t('应用 ID 需以 cli_ 开头。', 'App ID must start with cli_.')
        : appSecret.isEmpty
        ? t('请填写 App Secret。', 'Enter the App Secret.')
        : null;
    if (invalid != null) {
      setState(() {
        bindError = invalid;
        error = null;
      });
      return;
    }
    setState(() {
      _busy = true;
      bindError = null;
      error = null;
    });
    try {
      await host.auth.bindApp(brand: brand, appId: appId, secret: appSecret);
      secret.clear();
      await host.synchronizeIdentity();
      if (mounted) {
        setState(() {
          manualBind = false;
          bindError = null;
        });
      }
    } catch (failure) {
      if (mounted) setState(() => bindError = _message(failure));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openSession() async {
    if (!mounted) return;
    timer?.cancel();
    timer = Timer.periodic(const Duration(seconds: 1), (_) => _poll());
    await openFeishuBrowser(session!.verificationUri);
  }

  Future<void> _authorize() async {
    registering = false;
    session = await host.auth.beginAuthorization();
    await host.synchronizeIdentity();
    await _openSession();
  }

  Future<void> _poll() async {
    if (polling ||
        session == null ||
        !mounted ||
        WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
      return;
    }
    polling = true;
    try {
      if (await (registering
          ? host.auth.pollAppRegistration()
          : host.auth.pollAuthorization())) {
        timer?.cancel();
        await host.synchronizeIdentity();
        if (mounted) {
          setState(() {
            session = null;
            registering = false;
            error = null;
          });
        }
      }
    } catch (e) {
      if (e is FeishuFailure &&
          const {
            'network_timeout',
            'network_tls_failed',
            'network_unreachable',
            'http_transport_failed',
            'network_or_response_error',
          }.contains(e.code)) {
        if (mounted) setState(() => error = '连接暂时中断，正在重试核验；授权会话未过期时无需重新开始。');
        return;
      }
      timer?.cancel();
      if (mounted) {
        setState(() {
          session = null;
          error = _message(e);
        });
      }
    } finally {
      polling = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_poll());
  }

  Future<void> _listChats() async {
    final page = await host.ingest.chats(pageToken: chatPage);
    if (page['items'] is! List) throw const FeishuFailure('invalid_page');
    for (final value in page['items'] as List) {
      if (value is Map &&
          value['chat_id'] is String &&
          !chats.any((c) => c['chat_id'] == value['chat_id'])) {
        chats.add(Map<String, dynamic>.from(value));
      }
    }
    hasMoreChats = page['has_more'] == true;
    chatPage = hasMoreChats ? page['page_token'] as String? : null;
  }

  Future<void> _select(String id) async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: DateTime.utc(1970),
      firstDate: DateTime.utc(1970),
      lastDate: now,
    );
    if (date != null) await host.sources.select(id, date, updateRange: true);
  }

  Future<void> _read(String id) => host.collection.start(chat: id);

  Future<void> _readScope() => host.collection.start();

  Future<void> _processing() async {
    await _loadProvider();
    if (!mounted || provider == null) throw StateError('model_required');
    final selectedProvider = provider!;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: Text(
          t('允许模型使用这些消息？', 'Allow this model to use these messages?'),
        ),
        content: Text(
          t(
            '所选聊天中已同步的文字消息会发送给以下模型，用于生成近况和个人信息：\n\n$providerLabel\n\n新增消息会自动继续整理，可随时停止模型使用。此操作不会发送飞书消息。',
            'Synced text from the selected chats will be sent to this model to generate updates and personal info:\n\n$providerLabel\n\nNew messages are processed automatically. You can stop model access at any time. This does not send Feishu messages.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(t('同意并继续', 'Allow and continue')),
          ),
        ],
      ),
    );
    if (accepted == true) {
      await _requireProvider(selectedProvider);
      await host.sources.grantProcessing(selectedProvider, 'profile', true);
    }
  }

  Future<void> _organize({bool savedObservationsOnly = false}) async {
    if (busy) return;
    if (widget.generation != null && !savedObservationsOnly) {
      if (!processingAllowed) await _processing();
      if (processingAllowed) await widget.generation!.retry();
      return;
    }
    setState(() {
      _busy = true;
      error = null;
      processingError = null;
    });
    try {
      if (!processingAllowed) await _processing();
      if (processingAllowed) {
        await profile.run(savedObservationsOnly: savedObservationsOnly);
      }
    } catch (failure) {
      if (mounted) setState(() => processingError = _message(failure));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _revokeProcessing() async {
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: Text(
          t(
            '停止使用消息并删除生成内容？',
            'Stop using messages and delete generated content?',
          ),
        ),
        content: Text(
          t(
            '将删除这台设备上生成的近况与个人信息，已同步的消息仍保留。再次生成时需要重新同意。',
            'Generated updates and personal info will be deleted from this device. Synced messages will remain. Generating again will require your consent.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(t('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(t('停止并删除', 'Stop and delete')),
          ),
        ],
      ),
    );
    if (accepted != true) return;
    await host.sources.grantProcessing(provider!, 'profile', false);
    await profile.repository.clear();
  }

  bool get processingAllowed {
    if (provider == null) return false;
    try {
      host.sources.validateProcessing(
        provider!,
        'profile',
        host.sources.processingRevision,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  Widget _card({
    required IconData icon,
    required String title,
    String? subtitle,
    required List<Widget> children,
  }) => NovaSection(
    margin: const EdgeInsets.only(bottom: 16),
    children: [
      Semantics(
        header: true,
        child: NovaTile(
          leading: NovaIconTile(icon),
          title: title,
          subtitle: subtitle == null ? null : Text(subtitle),
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ),
    ],
  );

  Widget _running(String label, {required String id}) => Semantics(
    liveRegion: true,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 3, right: 10),
          child: ExcludeSemantics(
            child: SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                key: ValueKey('feishu.$id.spinner'),
                strokeWidth: 2,
              ),
            ),
          ),
        ),
        Expanded(
          child: Text(
            label,
            style: const TextStyle(color: Nova.secondary, height: 1.5),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final counts = host.ready
        ? host.sources.messageCounts
        : (byStatus: const <String, int>{}, byChat: const <String, int>{});
    final skipped = host.sources.skippedSummaryFor(counts.byStatus);
    return Scaffold(
      // Opaque background: the page is pushed over the translucent shell, and a
      // transparent Scaffold leaves the previous tab visible mid-transition.
      backgroundColor: Nova.ink,
      appBar: AppBar(title: Text(t('飞书', 'Feishu'))),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (!host.auth.configured) ...[
            Text(
              t(
                '连接飞书，查看聊天中的近况。',
                'Connect Feishu to see updates from your chats.',
              ),
            ),
            const SizedBox(height: 16),
            NovaSection(
              margin: const EdgeInsets.only(bottom: 12),
              header: t('连接应用', 'CONNECT AN APP'),
              children: [
                NovaTile(
                  leading: const NovaIconTile(CupertinoIcons.add),
                  title: t('通过飞书网页绑定', 'Connect in Feishu'),
                  subtitle: Text(
                    t(
                      '在飞书网页创建新应用，或直接选择已有应用；无需复制密钥。',
                      'Create a new app or choose an existing one in Feishu; no keys to copy.',
                    ),
                  ),
                  trailing: const CupertinoListTileChevron(),
                  onTap: busy || session != null ? null : () => _run(_register),
                ),
                NovaTile(
                  leading: const NovaIconTile(CupertinoIcons.link),
                  title: t('手动绑定已有应用', 'Connect an existing app manually'),
                  subtitle: Text(
                    t(
                      '已有 App ID 和 App Secret 时使用。',
                      'Use this when you already have an App ID and App Secret.',
                    ),
                  ),
                  trailing: const CupertinoListTileChevron(),
                  onTap: bindBusy
                      ? null
                      : () => setState(() {
                          manualBind = !manualBind;
                          bindError = null;
                        }),
                ),
              ],
            ),
            if (manualBind) ...[
              Text(
                t(
                  '在飞书开放平台的应用详情中，找到「凭证与基础信息」。',
                  'Find these under Credentials & Basic Info in the Feishu Open Platform app details.',
                ),
                style: const TextStyle(color: Nova.secondary, fontSize: 13),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: brand,
                decoration: InputDecoration(labelText: t('应用品牌', 'App brand')),
                items: const [
                  DropdownMenuItem(value: 'feishu', child: Text('飞书')),
                  DropdownMenuItem(value: 'lark', child: Text('Lark')),
                ],
                onChanged: bindBusy
                    ? null
                    : (value) => setState(() => brand = value!),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: app,
                autocorrect: false,
                enabled: !bindBusy,
                decoration: const InputDecoration(labelText: 'App ID'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: secret,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                enabled: !bindBusy,
                decoration: const InputDecoration(labelText: 'App Secret'),
              ),
              if (bindError != null)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    bindError!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: bindBusy ? null : _bindExisting,
                child: Text(t('绑定应用', 'Connect app')),
              ),
              const SizedBox(height: 4),
            ],
          ] else ...[
            _card(
              icon: CupertinoIcons.link,
              title: host.auth.authorized
                  ? t('已连接飞书', 'Connected to Feishu')
                  : t('应用已绑定', 'App connected'),
              subtitle: host.auth.authorized
                  ? ((host.auth.identity?['name'] as String?)
                                ?.trim()
                                .isNotEmpty ==
                            true
                        ? host.auth.identity!['name'] as String
                        : t('授权已完成', 'Authorization complete'))
                  : t('需要前往飞书授权', 'Authorization required in Feishu'),
              children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: NovaStatusChip(
                    host.auth.revocationPending
                        ? t('待撤销授权', 'Revocation pending')
                        : host.auth.authorized
                        ? t('已授权', 'Authorized')
                        : t('待授权', 'Authorization needed'),
                    tone: host.auth.authorized
                        ? NovaTone.success
                        : NovaTone.warning,
                  ),
                ),
                if (!host.auth.authorized && !host.auth.revocationPending)
                  FilledButton(
                    onPressed: busy ? null : () => _run(_authorize),
                    child: Text(t('前往飞书授权', 'Authorize in Feishu')),
                  ),
                if (host.auth.revocationPending)
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => _run(host.auth.retryRevocation),
                    child: Text(t('重试撤销授权', 'Retry revoking access')),
                  ),
              ],
            ),
          ],
          if (session != null)
            _card(
              icon: CupertinoIcons.clock,
              title: registering
                  ? t('等待应用绑定', 'Waiting for app connection')
                  : t('等待飞书授权', 'Waiting for authorization'),
              subtitle: t(
                '请在飞书网页完成${registering ? '应用绑定' : '授权'}，然后返回 Nova。',
                'Finish ${registering ? 'connecting the app' : 'authorization'} in Feishu, then return to Nova.',
              ),
              children: [
                TextButton(
                  onPressed: () => _run(_openSession),
                  child: Text(t('重新打开飞书网页', 'Reopen Feishu')),
                ),
                if (registering)
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => _run(() async {
                            timer?.cancel();
                            await host.auth.cancelAppRegistration();
                            session = null;
                            registering = false;
                          }),
                    child: Text(t('取消绑定', 'Cancel connection')),
                  ),
              ],
            ),
          if (host.ready) ...[
            _card(
              icon: Icons.sync_rounded,
              title: t('聊天记录', 'Chat history'),
              children: [
                Text(
                  t(
                    '已保存 ${counts.byStatus['available'] ?? 0} 条消息 · ${host.sources.sources.length} 个对话',
                    '${counts.byStatus['available'] ?? 0} messages saved · ${host.sources.sources.length} chats',
                  ),
                ),
                if (host.collection.running) ...[
                  const SizedBox(height: 12),
                  _running(
                    t('正在同步，可继续使用其他页面。', 'Syncing. You can use other pages.'),
                    id: 'sync',
                  ),
                ],
                if (host.collection.error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Semantics(
                      liveRegion: true,
                      child: NovaNotice(_message(host.collection.error!)),
                    ),
                  ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: host.collection.running
                        ? host.collection.pause
                        : _busy
                        ? null
                        : () => _run(_readScope),
                    icon: Icon(
                      host.collection.running
                          ? CupertinoIcons.pause_fill
                          : CupertinoIcons.arrow_2_circlepath,
                    ),
                    label: Text(
                      host.collection.running
                          ? t('暂停同步', 'Pause sync')
                          : t('同步消息', 'Sync messages'),
                    ),
                  ),
                ),
              ],
            ),
            if (host.sources.sources.isNotEmpty) ...[
              _card(
                icon: Icons.auto_awesome_outlined,
                title: t('近况与个人信息', 'Updates and personal info'),
                subtitle: t(
                  '根据已同步的聊天生成，可查看原文。',
                  'Generated from synced chats, with source messages available.',
                ),
                children: [
                  if (widget.generation == null && !profile.busy)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: NovaStatusChip(
                        processingError != null
                            ? t('待重试', 'Retry needed')
                            : profile.repository.value != null
                            ? t('已有近况', 'Updates available')
                            : host.collection.running
                            ? t('等待同步', 'Waiting for sync')
                            : t('待生成', 'Ready to generate'),
                        tone: processingError != null
                            ? NovaTone.warning
                            : profile.repository.value != null
                            ? NovaTone.success
                            : NovaTone.neutral,
                      ),
                    ),
                  if (widget.generation != null)
                    ProfileGenerationStatus(
                      generation: widget.generation!,
                      language: widget.language,
                      empty: profile.repository.value == null,
                      compact: true,
                    )
                  else if (profile.busy) ...[
                    _running(
                      profileProgressLabel(
                        profile.status,
                        language: widget.language,
                      ),
                      id: 'generation',
                    ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(
                        onPressed: profile.cancel,
                        child: Text(t('取消生成', 'Cancel')),
                      ),
                    ),
                  ] else if (processingError != null)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Semantics(
                        liveRegion: true,
                        child: NovaNotice(processingError!),
                      ),
                    ),
                  if (host.collection.running && !profile.busy)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text(
                        t(
                          '消息同步完成后即可生成或更新近况。',
                          'You can generate or refresh updates after messages finish syncing.',
                        ),
                      ),
                    ),
                  if (profile.repository.value != null) ...[
                    FilledButton(
                      onPressed: _showResults,
                      child: Text(t('查看近况', 'View updates')),
                    ),
                    if (widget.generation == null &&
                        widget.publication.canPublish &&
                        !profile.busy)
                      OutlinedButton(
                        onPressed: busy ? null : _organize,
                        child: Text(
                          processingError == null
                              ? t('更新近况', 'Refresh updates')
                              : t('继续生成', 'Resume generation'),
                        ),
                      ),
                  ] else ...[
                    if (widget.generation == null &&
                        widget.publication.canPublish &&
                        !profile.busy)
                      FilledButton(
                        onPressed: busy ? null : _organize,
                        child: Text(
                          processingError == null
                              ? t('生成近况', 'Generate updates')
                              : t('继续生成', 'Resume generation'),
                        ),
                      ),
                    TextButton(
                      onPressed: _showResults,
                      child: Text(t('个人信息', 'Personal info')),
                    ),
                  ],
                  if (widget.generation == null &&
                      widget.publication.canPublish &&
                      !profile.busy) ...[
                    TextButton(
                      onPressed: busy
                          ? null
                          : () => _organize(savedObservationsOnly: true),
                      child: Text(
                        t('先生成已整理部分', 'Generate from saved progress'),
                      ),
                    ),
                    Text(
                      t(
                        '先查看已整理的内容，剩余记录稍后继续。',
                        'See verified results now; process the remaining messages later.',
                      ),
                      style: const TextStyle(
                        color: Nova.secondary,
                        fontSize: 12,
                      ),
                    ),
                  ],
                  if (!widget.publication.canPublish)
                    Text(
                      t(
                        '此 Space 的个人信息由 Host 更新；已同步的消息保留在这台设备。',
                        'This Space uses its Host to update personal info. Synced messages stay on this device.',
                      ),
                    ),
                ],
              ),
              NovaSection(
                margin: const EdgeInsets.only(bottom: 12),
                children: [
                  Material(
                    color: Nova.cell,
                    borderRadius: BorderRadius.circular(12),
                    clipBehavior: Clip.antiAlias,
                    child: ExpansionTile(
                      leading: const Icon(
                        CupertinoIcons.lock_shield,
                        color: Nova.secondary,
                      ),
                      title: Text(t('模型与隐私', 'Model and privacy')),
                      subtitle: Text(
                        processingAllowed
                            ? t('已允许使用消息', 'Model access allowed')
                            : t('使用前需要同意', 'Consent required'),
                      ),
                      children: [
                        ListTile(
                          title: Text(
                            processingAllowed
                                ? t('已允许模型使用消息', 'Model access allowed')
                                : t(
                                    '尚未允许模型使用消息',
                                    'Model access not yet allowed',
                                  ),
                          ),
                          subtitle: Text(providerLabel),
                        ),

                        if (profile.budget != null)
                          ListTile(
                            title: Text(
                              t(
                                '已记账（保守估算）¥${(profile.budget!.reservedMicroyuan / 1000000).toStringAsFixed(3)}',
                                'Recorded (conservative estimate): ¥${(profile.budget!.reservedMicroyuan / 1000000).toStringAsFixed(3)}',
                              ),
                            ),
                            subtitle: Text(
                              t(
                                '非账单；实际费用以模型服务账单为准。',
                                'Not a bill. Actual charges are determined by your model provider.',
                              ),
                            ),
                          ),
                        TextButton(
                          onPressed: busy
                              ? null
                              : () => _run(
                                  processingAllowed
                                      ? _revokeProcessing
                                      : _processing,
                                ),
                          child: Text(
                            processingAllowed
                                ? t('停止模型使用消息', 'Stop model access')
                                : t('允许模型使用消息', 'Allow model access'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ],
            NovaSection(
              margin: const EdgeInsets.only(bottom: 12),
              children: [
                Material(
                  color: Nova.cell,
                  borderRadius: BorderRadius.circular(12),
                  clipBehavior: Clip.antiAlias,
                  child: ExpansionTile(
                    leading: const Icon(
                      CupertinoIcons.info_circle,
                      color: Nova.secondary,
                    ),
                    tilePadding: const EdgeInsets.symmetric(horizontal: 16),
                    title: Text(t('同步详情', 'Sync details')),
                    childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    expandedCrossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(host.collection.status),
                      if (skipped.isNotEmpty)
                        Text(
                          t(
                            '以下消息仅保留基本信息，不会发送给模型：$skipped',
                            'Only metadata is retained for these messages; they are not sent to the model: $skipped',
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
            NovaSection(
              margin: const EdgeInsets.only(bottom: 12),
              children: [
                Material(
                  color: Nova.cell,
                  borderRadius: BorderRadius.circular(12),
                  clipBehavior: Clip.antiAlias,
                  child: ExpansionTile(
                    leading: const Icon(
                      CupertinoIcons.line_horizontal_3_decrease,
                      color: Nova.secondary,
                    ),
                    title: Text(t('同步范围', 'Sync scope')),
                    initiallyExpanded: _scopeExpanded,
                    onExpansionChanged: (value) =>
                        setState(() => _scopeExpanded = value),
                    subtitle: Text(
                      host.sources.allAccessible
                          ? t('全部可访问的聊天记录', 'All accessible chat history')
                          : t('已选聊天', 'Selected chats'),
                    ),
                    children: _scopeExpanded
                        ? [
                            SwitchListTile(
                              title: Text(
                                t('全部可访问的聊天', 'All accessible chats'),
                              ),
                              value: host.sources.allAccessible,
                              onChanged: busy
                                  ? null
                                  : (value) => _run(
                                      () =>
                                          host.sources.setAllAccessible(value),
                                    ),
                            ),
                            const Padding(
                              padding: EdgeInsets.all(16),
                              child: Text(
                                '读取全部可访问的文本历史。原文自本次成功读取起在手机保留 30 天；消息的原始日期不会改变。暂停或移除的对话不会自动恢复。达到本机容量上限会停止并保留续传进度，不代表全量读取完成。',
                              ),
                            ),
                            OutlinedButton(
                              onPressed: busy ? null : () => _run(_listChats),
                              child: Text(hasMoreChats ? '加载更多聊天' : '查看可访问聊天'),
                            ),
                            for (final chat in chats)
                              ListTile(
                                title: Text(
                                  chat['name'] as String? ?? chat['chat_id'],
                                ),

                                trailing:
                                    host.sources.sources.contains(
                                      chat['chat_id'],
                                    )
                                    ? const Icon(CupertinoIcons.checkmark)
                                    : null,
                                onTap: busy
                                    ? null
                                    : () =>
                                          _run(() => _select(chat['chat_id'])),
                              ),
                            for (final id in host.sources.sources)
                              Card(
                                child: Padding(
                                  padding: const EdgeInsets.all(12),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        chats
                                                    .where(
                                                      (c) => c['chat_id'] == id,
                                                    )
                                                    .firstOrNull?['name']
                                                as String? ??
                                            id,
                                      ),
                                      Text(
                                        '${counts.byChat[id] ?? 0} 条缓存 · ${host.sources.checkpoint(id)['read_through'] == null ? '尚未完成首次读取' : '已读取至 ${host.sources.checkpoint(id)['read_through']}'}',
                                      ),
                                      if (host.sources.checkpoint(
                                            id,
                                          )['history_refresh_pending'] ==
                                          true)
                                        const Text('部分缓存已过期，当前分页完成后再次读取可刷新历史。'),
                                      if (host.sources.checkpoint(
                                            id,
                                          )['page_token'] !=
                                          null)
                                        const Text('历史读取尚未完成，可继续下一页'),
                                      Wrap(
                                        spacing: 8,
                                        children: [
                                          TextButton(
                                            onPressed:
                                                busy ||
                                                    host.sources.checkpoint(
                                                          id,
                                                        )['paused'] ==
                                                        true
                                                ? null
                                                : () => _run(() => _read(id)),
                                            child: const Text('继续读取选定范围'),
                                          ),
                                          TextButton(
                                            onPressed: busy
                                                ? null
                                                : () => _run(
                                                    () => host.sources.pause(
                                                      id,
                                                      host.sources.checkpoint(
                                                            id,
                                                          )['paused'] !=
                                                          true,
                                                    ),
                                                  ),
                                            child: Text(
                                              host.sources.checkpoint(
                                                        id,
                                                      )['paused'] ==
                                                      true
                                                  ? t('继续同步', 'Resume sync')
                                                  : t('暂停同步', 'Pause sync'),
                                            ),
                                          ),
                                          TextButton(
                                            onPressed: busy
                                                ? null
                                                : () => _run(() async {
                                                    await host.sources.remove(
                                                      id,
                                                    );
                                                  }),
                                            child: const Text('断开并删除本机消息'),
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                          ]
                        : const [],
                  ),
                ),
              ],
            ),
          ],
          if (host.auth.configured)
            NovaSection(
              margin: const EdgeInsets.only(bottom: 12),
              children: [
                Material(
                  color: Nova.cell,
                  borderRadius: BorderRadius.circular(12),
                  clipBehavior: Clip.antiAlias,
                  child: ExpansionTile(
                    leading: const Icon(
                      CupertinoIcons.gear,
                      color: Nova.secondary,
                    ),
                    title: Text(t('连接管理', 'Connection settings')),
                    children: [
                      if (!host.auth.revocationPending)
                        TextButton(
                          onPressed: busy
                              ? null
                              : () => _run(() async {
                                  timer?.cancel();
                                  session = null;
                                  chats.clear();
                                  chatPage = null;
                                  await host.auth.forgetApp();
                                  await host.synchronizeIdentity();
                                }),
                          child: const Text('移除本机应用凭据，改绑其他应用'),
                        ),
                      const Divider(),
                      TextButton(
                        onPressed: busy
                            ? null
                            : () => _run(() async {
                                timer?.cancel();
                                session = null;
                                chats.clear();
                                chatPage = null;
                                await host.disconnect();
                              }),
                        child: const Text('断开本机连接并清理缓存'),
                      ),
                      TextButton(
                        onPressed: busy
                            ? null
                            : () => _run(() async {
                                timer?.cancel();
                                session = null;
                                chats.clear();
                                chatPage = null;
                                await host.disconnect(revoke: true);
                              }),
                        child: const Text('断开并撤销飞书授权'),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Semantics(liveRegion: true, child: NovaNotice(error!)),
            ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    widget.generation?.removeListener(_changed);
    profile.removeListener(_changed);
    if (widget.profileAgent == null) profile.dispose();
    timer?.cancel();
    unawaited(_modelChanges?.cancel());
    WidgetsBinding.instance.removeObserver(this);
    host.removeListener(_changed);
    app.dispose();
    secret.dispose();
    super.dispose();
  }
}
