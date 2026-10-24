import 'push_invitation_dialog.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'client_controller.dart';
import 'client_state.dart';
import 'relay_transport.dart';
import 'space_storage.dart';
import 'native_scope.dart';
import 'push_client.dart';
import 'notification_router.dart';
import 'source_panel.dart';
import 'space_dialog.dart';
import 'chat_message.dart';

class SpaceRoot extends StatefulWidget {
  const SpaceRoot({
    super.key,
    required this.standaloneBuilder,
    this.catalog,
    this.clientBuilder,
  });
  final Widget Function(SpaceRecord) standaloneBuilder;
  final SpaceCatalog? catalog;
  final Widget Function(SpaceRecord)? clientBuilder;
  @override
  State<SpaceRoot> createState() => _SpaceRootState();
}

class _SpaceRootState extends State<SpaceRoot> {
  late final catalog = widget.catalog ?? SpaceCatalog();
  String? error;
  Future<void> nativeScope = Future.value();
  StreamSubscription<dynamic>? pushEvents;
  Future<void> tokenRefresh = Future.value();
  @override
  void initState() {
    super.initState();
    catalog.addListener(_changed);
    unawaited(
      catalog.open().catchError((Object e) {
        if (mounted) setState(() => error = '$e');
      }),
    );
  }

  void _changed() {
    nativeScope = SpaceNativeScope.activate(catalog.selected);
    if (catalog.ready && pushEvents == null) {
      pushEvents = SpacePushClient.eventStream.listen((raw) {
        final event = Map<String, dynamic>.from(raw as Map);
        if (event['type'] == 'token') {
          tokenRefresh = tokenRefresh
              .then(
                (_) =>
                    SpacePushClient.refreshSavedTokens(event, catalog.spaces),
              )
              .catchError((Object _) {});
        }
        if (event['type'] == 'open' && event['handle'] is String) {
          unawaited(_openNotification(event['handle'] as String));
        }
      }, onError: (Object _) {});
    }
    if (mounted) setState(() {});
  }

  Future<void> _openNotification(String handle) async {
    final id = await SpaceNotificationRouter.resolve(handle, catalog.spaces);
    if (!mounted) return;
    if (id != null && catalog.selectedId != id) await catalog.select(id);
  }

  @override
  void dispose() {
    catalog.removeListener(_changed);
    unawaited(pushEvents?.cancel() ?? Future.value());
    if (widget.catalog == null) catalog.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (error != null) {
      return Scaffold(body: Center(child: Text('无法打开 Space：$error')));
    }
    if (!catalog.ready) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final selected = catalog.selected;
    if (selected == null) return _SpaceChooser(catalog: catalog);
    return Column(
      children: [
        Material(
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Row(
                children: [
                  Icon(
                    selected.mode == SpaceMode.client
                        ? Icons.devices
                        : Icons.phone_android,
                    size: 20,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${selected.name} · ${selected.mode == SpaceMode.client ? 'Host 连接' : '独立运行'}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () => catalog.select(null),
                    icon: const Icon(Icons.swap_horiz),
                    label: const Text('Space'),
                  ),
                ],
              ),
            ),
          ),
        ),
        Expanded(
          child: FutureBuilder<void>(
            future: nativeScope,
            builder: (context, result) {
              if (result.hasError) {
                return Center(child: Text('无法切换设备空间：${result.error}'));
              }
              if (result.connectionState != ConnectionState.done) {
                return const Center(child: CircularProgressIndicator());
              }
              return KeyedSubtree(
                key: ValueKey(selected.id),
                child: selected.mode == SpaceMode.standalone
                    ? widget.standaloneBuilder(selected)
                    : widget.clientBuilder?.call(selected) ??
                          _ClientSpace(space: selected),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _SpaceChooser extends StatelessWidget {
  const _SpaceChooser({required this.catalog});
  final SpaceCatalog catalog;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Space')),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const Text(
          '每个 Space 的数据与密钥相互独立。',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 12),
        const Text('创建时选择独立运行，或连接电脑上的 Host。更换模式需要新建 Space。'),
        const SizedBox(height: 24),
        for (final space in catalog.spaces)
          ListTile(
            leading: Icon(
              space.mode == SpaceMode.client
                  ? Icons.devices
                  : Icons.phone_android,
            ),
            title: Text(space.name),
            subtitle: Text(
              space.mode == SpaceMode.client ? '由 Host 处理聊天与后台任务' : '在此设备独立运行',
            ),
            onTap: () => catalog.select(space.id),
          ),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => _CreateSpace(catalog: catalog),
            ),
          ),
          icon: const Icon(Icons.add),
          label: const Text('新建 Space'),
        ),
      ],
    ),
  );
}

class _CreateSpace extends StatefulWidget {
  const _CreateSpace({required this.catalog});
  final SpaceCatalog catalog;
  @override
  State<_CreateSpace> createState() => _CreateSpaceState();
}

class _CreateSpaceState extends State<_CreateSpace> {
  final name = TextEditingController(), code = TextEditingController();
  SpaceMode mode = SpaceMode.standalone;
  bool scanning = false, busy = false;
  String? error;
  SpaceInvitation? invitation;
  @override
  void dispose() {
    name.dispose();
    code.dispose();
    super.dispose();
  }

  void parse(String value) {
    try {
      final parsed = SpaceInvitation.parse(
        value,
        allowLoopback: const bool.fromEnvironment('NOVA_ALLOW_LOOPBACK_RELAY'),
      );
      setState(() {
        invitation = parsed;
        error = null;
        scanning = false;
      });
    } catch (e) {
      setState(() => error = '$e');
    }
  }

  Future<void> create() async {
    if (name.text.trim().isEmpty) {
      setState(() => error = '请为 Space 命名');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      if (mode == SpaceMode.standalone) {
        await widget.catalog.add(
          SpaceRecord(
            id: newSpaceId(),
            name: name.text.trim(),
            mode: mode,
            device: newSpaceId(),
          ),
        );
      } else {
        if (invitation == null) throw StateError('请先扫描 Host 邀请码');
        await invitation!.pair(
          name.text.trim(),
          widget.catalog,
          allowLoopback: const bool.fromEnvironment(
            'NOVA_ALLOW_LOOPBACK_RELAY',
          ),
        );
      }
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('创建 Space')),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        TextField(
          controller: name,
          decoration: const InputDecoration(labelText: '名称'),
        ),
        const SizedBox(height: 24),
        RadioGroup<SpaceMode>(
          groupValue: mode,
          onChanged: (v) {
            if (v != null) setState(() => mode = v);
          },
          child: Column(
            children: [
              const RadioListTile(
                value: SpaceMode.standalone,
                title: Text('独立运行'),
                subtitle: Text('此设备运行聊天、资料处理与定时任务。'),
              ),
              const RadioListTile(
                value: SpaceMode.client,
                title: Text('连接 Host'),
                subtitle: Text('电脑处理聊天与后台任务；此设备展示缓存并发送操作。'),
              ),
            ],
          ),
        ),
        if (mode == SpaceMode.client) ...[
          const SizedBox(height: 16),
          const Text('Host 不在线时聊天不可用。Host 损坏会丢失这个 Space，不提供备份恢复。'),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => setState(() => scanning = !scanning),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('扫描 Host 邀请码'),
          ),
          if (scanning)
            SizedBox(
              height: 260,
              child: MobileScanner(
                onDetect: (capture) {
                  final value = capture.barcodes.firstOrNull?.rawValue;
                  if (value != null) parse(value);
                },
              ),
            ),
          TextField(
            controller: code,
            autocorrect: false,
            smartQuotesType: SmartQuotesType.disabled,
            smartDashesType: SmartDashesType.disabled,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(labelText: '或粘贴邀请码'),
          ),
          TextButton(
            onPressed: () => parse(code.text),
            child: const Text('读取邀请码'),
          ),
          if (invitation != null)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '请核对电脑上的 Host 指纹',
                      style: TextStyle(fontWeight: FontWeight.bold),
                    ),
                    SelectableText(invitation!.hostFingerprint),
                    const SizedBox(height: 12),
                    Text('连接：${invitation!.relay}'),
                    const Text('确认后请在电脑上核对此设备指纹，并批准连接。'),
                  ],
                ),
              ),
            ),
        ],
        if (error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: busy ? null : create,
          child: Text(
            busy
                ? '正在创建…'
                : mode == SpaceMode.client
                ? '确认指纹并绑定 Host'
                : '创建独立 Space',
          ),
        ),
      ],
    ),
  );
}

class _ClientSpace extends StatefulWidget {
  const _ClientSpace({required this.space});
  final SpaceRecord space;
  @override
  State<_ClientSpace> createState() => _ClientSpaceState();
}

class _ClientSpaceState extends State<_ClientSpace> {
  SpaceClientController? controller;
  String? startupError;
  final chat = TextEditingController();
  bool sending = false;
  int tab = 0;
  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  Future<void> _open() async {
    try {
      final value = await SpaceClientController.open(widget.space);
      if (!mounted) {
        await value.dispose();
        return;
      }
      controller = value;
      value.state.addListener(_changed);
      setState(() {});
    } catch (e) {
      if (mounted) setState(() => startupError = '$e');
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    chat.dispose();
    controller?.state.removeListener(_changed);
    unawaited(controller?.dispose() ?? Future.value());
    super.dispose();
  }

  Future<void> enablePushNotifications() async {
    final push = controller?.push;
    if (push == null) return;
    if (push.gatewayUrl.isEmpty) {
      message('此构建尚未配置通知网关');
      return;
    }
    try {
      await push.enable(
        requestInvitation: () async {
          if (!mounted) return null;
          return showDialog<String>(
            context: context,
            builder: (_) => const PushInvitationDialog(),
          );
        },
      );
    } catch (_) {
      message('通知启用失败，请检查邀请、通知权限或网络后重试');
    }
  }

  void message(String text) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
    }
  }

  Future<void> send() async {
    final text = chat.text;
    if (text.trim().isEmpty) return;
    setState(() => sending = true);
    try {
      await controller!.sendChat(text);
      chat.clear();
    } catch (error) {
      message(
        error is StateError && error.message == 'chat_message_too_large'
            ? '消息过长，请缩短内容后再发送。'
            : 'Host 不在线或连接中断。请恢复连接以确认发送结果；不会自动重发。',
      );
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Future<void> editEntity(String kind, {Map<String, dynamic>? entity}) async {
    final title = TextEditingController(
      text: entity?['title'] as String? ?? '',
    );
    final note = TextEditingController(text: entity?['note'] as String? ?? '');
    String? goalId = entity?['goal_id'] as String?;
    final pendingGoals = controller!.state.pending
        .where(
          (p) =>
              p['kind'] == 'life.mutate' &&
              (p['input'] as Map)['op'] == 'create' &&
              (p['input'] as Map)['kind'] == 'goal' &&
              p['temp_id'] != null,
        )
        .toList();
    final saved = await showSpaceDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(entity == null ? '创建 $kind' : '编辑 $kind'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: title,
                decoration: const InputDecoration(labelText: '标题'),
              ),
              TextField(
                controller: note,
                decoration: const InputDecoration(labelText: '备注'),
              ),
              if (kind != 'goal')
                DropdownButtonFormField<String>(
                  initialValue: goalId,
                  decoration: const InputDecoration(labelText: '关联目标'),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('无')),
                    for (final p in pendingGoals)
                      DropdownMenuItem(
                        value: p['temp_id'] as String,
                        child: Text(
                          '${(p['input'] as Map)['title']} · 等待 Host',
                        ),
                      ),
                    for (final g in controller!.state.cards('goals'))
                      DropdownMenuItem(
                        value: g['id'] as String,
                        child: Text(g['title'] as String? ?? ''),
                      ),
                  ],
                  onChanged: (v) => goalId = v,
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('发送给 Host'),
          ),
        ],
      ),
    );
    if (saved == true && title.text.trim().isNotEmpty) {
      await controller!.state.enqueue(
        'life.mutate',
        {
          'op': entity == null ? 'create' : 'update',
          'kind': kind,
          if (entity != null) 'id': entity['id'],
          'title': title.text.trim(),
          'note': note.text,
          if (kind != 'goal') 'goal_id': goalId,
        },
        tempId: entity == null ? 'temp_${newSpaceId()}' : null,
        dependsOn: pendingGoals
            .where((p) => p['temp_id'] == goalId)
            .map((p) => p['op_id'] as String)
            .toList(),
        baseVersion: entity?['version'] as int?,
      );
      unawaited(controller!.sync());
    }
    title.dispose();
    note.dispose();
  }

  Future<void> profile() async {
    final value = (controller!.state.snapshot['profile'] as Map? ?? {});
    final text = TextEditingController(text: value['about'] as String? ?? '');
    final save = await showSpaceDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('个人资料'),
        content: TextField(controller: text, maxLines: 8, maxLength: 5000),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('发送给 Host'),
          ),
        ],
      ),
    );
    if (save == true) {
      await controller!.state.enqueue('life.mutate', {
        'op': 'profile',
        'about': text.text,
      }, baseVersion: value['version'] as int? ?? 0);
      unawaited(controller!.sync());
    }
    text.dispose();
  }

  Widget _card(Map<String, dynamic> card, {String? collection}) => Card(
    child: ListTile(
      title: Text(card['title'] as String? ?? '新内容'),
      subtitle: Text(card['body'] as String? ?? card['note'] as String? ?? ''),
      trailing: collection == null
          ? null
          : IconButton(
              tooltip: '忽略',
              icon: const Icon(Icons.close),
              onPressed: () async {
                await controller!.state.enqueue('card.dismiss', {
                  'id': card['id'],
                  'kind': collection,
                });
                unawaited(controller!.sync());
              },
            ),
    ),
  );
  Widget _pending(SpaceClientState state) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final p in state.pending)
        Card(
          child: ListTile(
            title: Text(
              p['status'] == 'conflict'
                  ? '编辑冲突 · 修改已保留'
                  : p['status'] == 'rejected'
                  ? 'Host 拒绝了操作'
                  : '等待 Host 确认',
            ),
            subtitle: Text(
              '${(p['input'] as Map)['title'] ?? (p['input'] as Map)['about'] ?? p['kind']}${p['error'] == null ? '' : ' · ${p['error']}'}',
            ),
            trailing: PopupMenuButton<String>(
              onSelected: (action) async {
                if (action == 'discard') {
                  await state.discard(p['op_id'] as String);
                } else {
                  final input = Map<String, dynamic>.from(p['input'] as Map);
                  final kind = input['kind'] as String?;
                  final current = kind == null
                      ? (state.snapshot['profile'] as Map?)
                      : state
                            .cards('${kind}s')
                            .where((e) => e['id'] == input['id'])
                            .firstOrNull;
                  await state.enqueue(
                    p['kind'] as String,
                    input,
                    baseVersion: current?['version'] as int?,
                  );
                  await state.discard(p['op_id'] as String);
                }
                unawaited(controller!.sync());
              },
              itemBuilder: (_) => [
                if (p['status'] == 'conflict')
                  const PopupMenuItem(value: 'retry', child: Text('按最新版本重提修改')),
                const PopupMenuItem(value: 'discard', child: Text('撤销此请求')),
              ],
            ),
          ),
        ),
    ],
  );
  @override
  Widget build(BuildContext context) {
    final c = controller;
    if (c == null) {
      return Scaffold(
        body: Center(
          child: startupError == null
              ? const CircularProgressIndicator()
              : Text('无法打开 Client：$startupError'),
        ),
      );
    }
    final state = c.state;
    return Scaffold(
      appBar: AppBar(
        title: Text(['动态', '待办与目标', '对话', '连接'][tab]),
        actions: [
          IconButton(
            onPressed: () => c.sync(),
            icon: const Icon(Icons.refresh),
            tooltip: '补拉 Host 状态',
          ),
        ],
      ),
      body: Column(
        children: [
          Material(
            color: state.hostOnline
                ? Colors.green.withValues(alpha: .08)
                : Colors.amber.withValues(alpha: .12),
            child: ListTile(
              dense: true,
              leading: Icon(
                state.hostOnline ? Icons.cloud_done : Icons.cloud_off,
              ),
              title: Text(state.hostOnline ? 'Host 在线' : 'Host 不在线 · 展示上次缓存'),
              subtitle: state.error == null
                  ? null
                  : Text(_connectionText(state.error!), maxLines: 2),
            ),
          ),
          Expanded(
            child: switch (tab) {
              0 => ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  for (final card in state.cards('notifications')) _card(card),
                  for (final card
                      in state
                          .cards('feed')
                          .where((c) => c['dismissed'] != true))
                    _card(card, collection: 'feed'),
                  for (final card
                      in state
                          .cards('timeline')
                          .where((c) => c['dismissed'] != true))
                    _card(card, collection: 'timeline'),
                  if (state.snapshot.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('等待 Host 提供空间快照。'),
                    ),
                ],
              ),
              1 => ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final kind in ['goal', 'todo', 'idea'])
                        OutlinedButton(
                          onPressed: () => editEntity(kind),
                          child: Text('创建 $kind'),
                        ),
                      OutlinedButton(
                        onPressed: profile,
                        child: const Text('个人资料'),
                      ),
                    ],
                  ),
                  _pending(state),
                  for (final kind in ['goal', 'todo', 'idea']) ...[
                    Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: Text(
                        {'goal': '目标', 'todo': '待办', 'idea': '想法'}[kind]!,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                    for (final entity in state.cards('${kind}s'))
                      Card(
                        child: ListTile(
                          title: Text(entity['title'] as String? ?? ''),
                          subtitle: Text(
                            '${entity['note'] ?? ''} · ${entity['status'] ?? ''}',
                          ),
                          onTap: () => editEntity(kind, entity: entity),
                          trailing: kind == 'todo' && entity['status'] != 'done'
                              ? IconButton(
                                  icon: const Icon(Icons.check),
                                  tooltip: '标记完成',
                                  onPressed: () async {
                                    await state.enqueue('life.mutate', {
                                      'op': 'update',
                                      'kind': 'todo',
                                      'id': entity['id'],
                                      'status': 'done',
                                    }, baseVersion: entity['version'] as int?);
                                    unawaited(c.sync());
                                  },
                                )
                              : null,
                        ),
                      ),
                  ],
                ],
              ),
              2 => Column(
                children: [
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        for (final m in state.messages)
                          SpaceChatMessage(message: m),
                        for (final preview in state.previews.values)
                          Card(
                            child: ListTile(
                              title: const Text('Host 正在回复…'),
                              subtitle: Text(preview['text'] as String? ?? ''),
                              trailing: IconButton(
                                icon: const Icon(Icons.stop),
                                onPressed: () async {
                                  try {
                                    await c.cancelChat(
                                      preview['op_id'] as String,
                                    );
                                  } catch (_) {
                                    message('Host 不在线，无法取消。');
                                  }
                                },
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  SafeArea(
                    top: false,
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: chat,
                              enabled: !sending,
                              decoration: InputDecoration(
                                hintText: state.hostOnline
                                    ? '发送给 Host'
                                    : 'Host 离线，聊天不可用',
                              ),
                              onSubmitted: (_) => send(),
                            ),
                          ),
                          IconButton(
                            onPressed: sending || !state.hostOnline
                                ? null
                                : send,
                            icon: const Icon(Icons.send),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              _ => ListView(
                padding: const EdgeInsets.all(24),
                children: [
                  const Text('此设备指纹（签名与加密密钥）'),
                  SelectableText(c.fingerprint),
                  const SizedBox(height: 16),
                  const Text('请在 Host 上核对指纹并批准连接。'),
                  const SizedBox(height: 16),
                  Text('Relay：${widget.space.relay}'),
                  const Text('通信内容端到端加密。通知网关可见设备令牌、时间与密文大小。'),
                  const SizedBox(height: 12),
                  Text(c.push?.status ?? '推送未就绪'),
                  FilledButton(
                    onPressed: enablePushNotifications,
                    child: const Text('启用锁屏通知'),
                  ),
                  TextButton(
                    onPressed: () async {
                      try {
                        await c.push?.disable();
                      } catch (error) {
                        message('$error');
                      }
                    },
                    child: const Text('关闭锁屏通知'),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    '手机工具由 Host 指定动作，并受系统权限限制。iOS 支持日历读取、提醒事项创建、拍照；Android 支持日历读取、拍照。执行结果不明确时不会自动重试。',
                  ),
                  const SizedBox(height: 16),
                  const Text('Host 损坏会丢失此 Space；不提供备份恢复。'),
                  SpaceSourcePanel(state: state, onSync: c.sync),
                  _pending(state),
                ],
              ),
            },
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (v) => setState(() => tab = v),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.dynamic_feed), label: '动态'),
          NavigationDestination(icon: Icon(Icons.checklist), label: '事项'),
          NavigationDestination(
            icon: Icon(Icons.chat_bubble_outline),
            label: '对话',
          ),
          NavigationDestination(icon: Icon(Icons.link), label: '连接'),
        ],
      ),
    );
  }

  String _connectionText(String error) {
    if (error.contains('incompatible_business_version') ||
        error.contains('unsupported_display_version')) {
      return 'Host 与此设备的协议版本不兼容，请更新应用后重试。';
    }
    if (error.contains('unknown_device') || error.contains('inactive')) {
      return '等待 Host 确认配对。请在连接页核对此设备指纹。';
    }
    if (error.contains('waiting_for_host_key') ||
        error.contains('missing_content_key')) {
      return '等待 Host 发送空间密钥。';
    }
    if (error.contains('revoked')) return '此设备已被撤销。请创建新 Space 后重新配对。';
    return '连接暂不可用，将在恢复后补拉。';
  }
}
