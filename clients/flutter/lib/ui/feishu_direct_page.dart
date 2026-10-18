import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import '../connectors/feishu/browser.dart';
import '../connectors/feishu/host.dart';
import '../connectors/feishu/auth.dart';
import '../connectors/feishu/api.dart';
import '../agent_core/model_settings.dart';
import '../agent_core/model_client.dart';
import '../device/space_authority.dart';
import '../context/profile_agent.dart';
import '../context/context_sync.dart';
import '../context/profile_corrections.dart';
import 'local_profile_results.dart';
import '../personal/life_reducer.dart';

class FeishuDirectPage extends StatefulWidget {
  const FeishuDirectPage({
    super.key,
    required this.host,
    required this.models,
    required this.authority,
    required this.contextSync,
  });
  final FeishuHost host;
  final ModelSettings models;
  final SpaceAuthorityRepository authority;
  final Future<ContextSync> Function() contextSync;
  @override
  State<FeishuDirectPage> createState() => _FeishuDirectPageState();
}

class _FeishuDirectPageState extends State<FeishuDirectPage>
    with WidgetsBindingObserver {
  final app = TextEditingController(), secret = TextEditingController();
  String brand = 'feishu';
  String? error, processingError, chatPage;
  String? provider;
  FeishuAuthorizationSession? session;
  bool _busy = false, polling = false, hasMoreChats = false;
  bool get busy => _busy || host.collection.running;
  bool registering = false;
  List<Map<String, dynamic>> get chats => host.collection.chats;
  Timer? timer;
  late final profile = ProfileAgent(
    host,
    widget.authority,
    widget.models,
    onProgress: _changed,
  );
  FeishuHost get host => widget.host;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    host.addListener(_changed);
    _loadProvider();
    unawaited(profile.repository.open().then((_) => _changed()));
  }

  Future<void> _loadProvider() async {
    try {
      final model = await widget.models.read();
      if (mounted) {
        setState(
          () => provider = model == null
              ? null
              : '${model.endpoint}|${model.model}',
        );
      }
    } catch (_) {}
  }

  Future<void> _correctProfile(String category) async {
    if (provider == null) throw StateError('model_required');
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
          title: Text('纠正${ProfileCorrections.categories[category]}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('这段表述将替代本类推断，保存在手机，并允许当前模型 $provider 用于后续画像和对话。'),
              TextField(controller: value, maxLines: 4, maxLength: 2600),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('保存并允许使用'),
            ),
          ],
        ),
      );
      if (accepted == true) {
        await profile.corrections.correct(
          profile.repository.correctionScope,
          category,
          value.text,
          provider!,
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
            appBar: AppBar(title: const Text('近况与个人记忆')),
            body: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                LocalProfileResults(
                  host: host,
                  authority: widget.authority,
                  repository: profile.repository,
                  kind: 'all',
                  revision: profile.repository.value?['revision'] as int? ?? 0,
                ),
                const ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('补充或纠正个人信息'),
                  subtitle: Text('你填写的信息会替代对应的模型推断。'),
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
                          '尚无明确纠正',
                    ),
                    trailing: const Icon(Icons.edit_outlined),
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
    AgentFailure(code: 'cancelled') => '已取消本次整理，消息仍保存在手机。',
    AgentFailure(code: 'model_required') ||
    StateError(message: 'model_required') => '请先在设置中配置模型，再开始整理。',
    AgentFailure(code: 'source_expired') => '部分消息已超出最近 30 天，本次整理已停止。请重新整理当前范围。',
    AgentFailure(code: 'model_request_failed') =>
      '模型请求失败，请检查当前模型服务与网络。消息仍保存在手机。',
    AgentFailure(code: 'tool_round_limit') => '本次内容超过模型整理轮次，尚未生成完整结果。消息仍保存在手机。',
    AgentFailure(code: 'profile_not_published') => '模型尚未生成有效的近况与个人记忆，消息仍保存在手机。',
    FeishuFailure(code: 'registration_expired') => '网页绑定已过期，请重新开始。',
    FeishuFailure(code: 'registration_denied') => '已取消网页绑定，没有保存应用凭据。',
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
      initialDate: now.subtract(const Duration(days: 7)),
      firstDate: now.subtract(const Duration(days: 30)),
      lastDate: now,
    );
    if (date != null) await host.sources.select(id, date, updateRange: true);
  }

  Future<void> _read(String id) => host.collection.start(chat: id);

  Future<void> _readScope() => host.collection.start();

  Future<void> _processing() async {
    await _loadProvider();
    if (!mounted || provider == null) throw StateError('model_required');
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('允许处理选定内容'),
        content: Text(
          '将所选聊天的已读取文本发送给以下模型，用于整理个人画像和长期记忆：\n\n$provider\n\n来源新增后需要重新同意。此操作不允许发送飞书消息，也不启用 Hub 上传。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('暂不允许'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('允许此模型处理'),
          ),
        ],
      ),
    );
    if (accepted == true) {
      await host.sources.grantProcessing(provider!, 'profile', true);
    }
  }

  Future<void> _organize() async {
    if (busy) return;
    setState(() {
      _busy = true;
      error = null;
      processingError = null;
    });
    try {
      if (!processingAllowed) await _processing();
      if (processingAllowed) await profile.run();
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
        title: const Text('撤销同意并删除整理结果？'),
        content: const Text('撤销后将删除本机已整理的近况与个人记忆，已同步的消息仍保留。以后重新整理需要再次同意。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('保留同意'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('撤销并删除结果'),
          ),
        ],
      ),
    );
    if (accepted != true) return;
    await host.sources.grantProcessing(provider!, 'profile', false);
    await profile.repository.clear();
  }

  String _remoteSource(String chat) => lifeFingerprint({
    'hub': widget.authority.hubId,
    'identity': host.auth.identityKey,
    'chat': chat,
  });
  Future<void> _upload(String chat) async {
    final model = await widget.models.read();
    if (model == null) throw StateError('model_required');
    final recipient = '${model.endpoint}|${model.model}';
    if (!mounted) return;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('上传选定来源'),
        content: Text(
          '将此聊天当前已读取的文本上传到你配置的 Hub，同一空间的设备可读取；Hub 可以看到这些内容。允许主电脑使用以下模型整理画像：\n\n$recipient\n\n后续新消息需再次点击上传。飞书应用凭据不会上传。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('允许上传和处理'),
          ),
        ],
      ),
    );
    if (accepted != true) return;
    final sync = await widget.contextSync();
    await sync.exportSource(
      _remoteSource(chat),
      recipient,
      host.sources.messages(chat),
    );
    await sync.sync();
  }

  Future<void> _forgetRemote(String chat) async {
    final sync = await widget.contextSync();
    await sync.forget(_remoteSource(chat));
    await sync.sync();
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

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('飞书')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('从对话中整理近况，逐步了解你。'),
        const SizedBox(height: 16),
        if (!host.auth.configured) ...[
          DropdownButtonFormField<String>(
            initialValue: brand,
            items: const [
              DropdownMenuItem(value: 'feishu', child: Text('飞书')),
              DropdownMenuItem(value: 'lark', child: Text('Lark')),
            ],
            onChanged: busy ? null : (value) => setState(() => brand = value!),
          ),
          const SizedBox(height: 16),
          const Text('前往飞书官方网页创建并绑定你的应用，凭据会自动保存到手机，无需复制密钥。已有应用可使用下方高级设置。'),
          FilledButton(
            onPressed: busy || session != null ? null : () => _run(_register),
            child: const Text('前往飞书网页绑定'),
          ),
          ExpansionTile(
            title: const Text('高级设置：手动绑定已有应用'),
            children: [
              TextField(
                controller: app,
                autocorrect: false,
                decoration: const InputDecoration(labelText: 'App ID'),
              ),
              TextField(
                controller: secret,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                decoration: const InputDecoration(labelText: 'App Secret'),
              ),
              TextButton(
                onPressed: busy || session != null
                    ? null
                    : () => _run(() async {
                        await host.auth.bindApp(
                          brand: brand,
                          appId: app.text.trim(),
                          secret: secret.text.trim(),
                        );
                        secret.clear();
                        await host.synchronizeIdentity();
                      }),
                child: const Text('绑定已有应用'),
              ),
            ],
          ),
        ] else ...[
          ListTile(
            leading: const Icon(Icons.forum_outlined),
            title: Text(host.auth.authorized ? '已连接飞书' : '应用已绑定'),
            subtitle: Text(
              host.auth.authorized
                  ? '${host.auth.identity?['name'] ?? ''} · 由这台手机读取'
                  : '尚未取得用户授权',
            ),
          ),
          if (!host.auth.authorized && !host.auth.revocationPending)
            FilledButton(
              onPressed: busy ? null : () => _run(_authorize),
              child: const Text('前往飞书授权'),
            ),
          if (host.auth.revocationPending)
            FilledButton(
              onPressed: busy ? null : () => _run(host.auth.retryRevocation),
              child: const Text('重试远端撤销'),
            ),
        ],
        if (session != null) ...[
          Text('请在官方网页完成${registering ? '应用绑定' : '用户授权'}，然后返回 Nova。'),
          TextButton(
            onPressed: () => _run(_openSession),
            child: const Text('重新打开官方网页'),
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
              child: const Text('取消本次绑定'),
            ),
        ],
        if (host.ready) ...[
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '最近 30 天',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '${host.sources.sources.length} 个对话 · ${host.sources.sources.expand(host.sources.messages).length} 条消息已保存在手机',
                  ),
                  const SizedBox(height: 8),
                  Text(host.collection.status),
                  if (host.collection.running) ...[
                    const SizedBox(height: 12),
                    const LinearProgressIndicator(),
                    const SizedBox(height: 8),
                    const Text('可以返回其他页面，读取会继续。'),
                  ],
                  if (host.collection.error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        _message(host.collection.error!),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: host.collection.running
                        ? host.collection.pause
                        : _busy
                        ? null
                        : () => _run(_readScope),
                    icon: Icon(
                      host.collection.running ? Icons.pause : Icons.sync,
                    ),
                    label: Text(host.collection.running ? '暂停读取' : '同步消息'),
                  ),
                ],
              ),
            ),
          ),
          if (host.sources.sources.isNotEmpty) ...[
            const ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('近况与个人记忆'),
              subtitle: Text('从已有消息整理近况，每条结论都可以查看依据。'),
            ),
            if (profile.busy) ...[
              const LinearProgressIndicator(),
              const SizedBox(height: 8),
              const Text('正在整理，可以取消本次操作。'),
              TextButton(
                onPressed: profile.cancel,
                child: const Text('取消本次整理'),
              ),
            ] else if (processingError != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  processingError!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              )
            else if (profile.status.isNotEmpty &&
                !profile.status.startsWith('整理未完成'))
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(profile.status.split('\n').first),
              ),
            if (profile.repository.value != null) ...[
              FilledButton(
                onPressed: _showResults,
                child: const Text('查看整理结果'),
              ),
              if (widget.authority.canPublish)
                OutlinedButton(
                  onPressed: busy ? null : _organize,
                  child: const Text('重新整理'),
                ),
            ] else ...[
              if (widget.authority.canPublish)
                FilledButton(
                  onPressed: busy ? null : _organize,
                  child: const Text('整理近况与个人记忆'),
                ),
              TextButton(onPressed: _showResults, child: const Text('个人信息')),
            ],
            ExpansionTile(
              title: const Text('整理设置'),
              children: [
                ListTile(
                  title: Text(processingAllowed ? '已允许当前模型处理' : '尚未允许模型处理'),
                  subtitle: Text(provider ?? '请先在设置中配置模型'),
                ),
                if (profile.budget != null)
                  ListTile(
                    title: const Text('本次验收费用上限 ¥5'),
                    subtitle: Text(
                      '累计预留 ¥${(profile.budget!.reservedMicroyuan / 1000000).toStringAsFixed(3)}，按保守上限估算，实际费用以模型服务账单为准。',
                    ),
                  ),
                TextButton(
                  onPressed: busy
                      ? null
                      : () => _run(
                          processingAllowed ? _revokeProcessing : _processing,
                        ),
                  child: Text(processingAllowed ? '撤销模型处理同意' : '允许模型处理'),
                ),
              ],
            ),
            if (!widget.authority.canPublish)
              const Text('正式画像由主设备维护；本机保留已读取内容。'),
          ],
          ExpansionTile(
            title: const Text('读取范围'),
            subtitle: Text(
              host.sources.allAccessible ? '所有有权限的对话 · 最近 30 天' : '已选对话',
            ),
            children: [
              SwitchListTile(
                title: const Text('所有有权限的对话'),
                value: host.sources.allAccessible,
                onChanged: busy
                    ? null
                    : (value) =>
                          _run(() => host.sources.setAllAccessible(value)),
              ),
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('仅整理文本消息，原文最多保留 30 天。暂停或移除的对话不会自动恢复。'),
              ),
              OutlinedButton(
                onPressed: busy ? null : () => _run(_listChats),
                child: Text(hasMoreChats ? '加载更多聊天' : '查看可访问聊天'),
              ),
              for (final chat in chats)
                ListTile(
                  title: Text(chat['name'] as String? ?? chat['chat_id']),

                  trailing: host.sources.sources.contains(chat['chat_id'])
                      ? const Icon(Icons.check)
                      : null,
                  onTap: busy
                      ? null
                      : () => _run(() => _select(chat['chat_id'])),
                ),
              for (final id in host.sources.sources)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          chats
                                      .where((c) => c['chat_id'] == id)
                                      .firstOrNull?['name']
                                  as String? ??
                              id,
                        ),
                        Text(
                          '${host.sources.messages(id).length} 条缓存 · ${host.sources.checkpoint(id)['read_through'] == null ? '尚未完成首次读取' : '已读取至 ${host.sources.checkpoint(id)['read_through']}'}',
                        ),
                        if (host.sources.checkpoint(id)['page_token'] != null)
                          const Text('历史读取尚未完成，可继续下一页'),
                        Wrap(
                          spacing: 8,
                          children: [
                            TextButton(
                              onPressed:
                                  busy ||
                                      host.sources.checkpoint(id)['paused'] ==
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
                                        host.sources.checkpoint(id)['paused'] !=
                                            true,
                                      ),
                                    ),
                              child: Text(
                                host.sources.checkpoint(id)['paused'] == true
                                    ? '恢复采集'
                                    : '暂停采集',
                              ),
                            ),
                            TextButton(
                              onPressed: busy
                                  ? null
                                  : () => _run(() async {
                                      await host.sources.remove(id);
                                      await profile.repository.clear();
                                    }),
                              child: const Text('断开并删除本机内容'),
                            ),
                            if (widget.authority.hubId != null)
                              TextButton(
                                onPressed: busy
                                    ? null
                                    : () => _run(() => _upload(id)),
                                child: const Text('上传当前内容给主电脑'),
                              ),
                            if (widget.authority.hubId != null)
                              TextButton(
                                onPressed: busy
                                    ? null
                                    : () => _run(() => _forgetRemote(id)),
                                child: const Text('请求跨端忘记此来源'),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ],
        if (host.auth.configured)
          ExpansionTile(
            title: const Text('连接管理'),
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
                          await profile.repository.clear();
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
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
      ],
    ),
  );
  @override
  void dispose() {
    profile.cancel();
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    host.removeListener(_changed);
    app.dispose();
    secret.dispose();
    super.dispose();
  }
}
