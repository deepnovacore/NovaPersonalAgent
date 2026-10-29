import 'push_invitation_dialog.dart';
import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../ui/app.dart' show BottomAppBarTabs;
import '../ui/components.dart';
import '../ui/theme.dart';
import '../ui/my_overview.dart';
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
        // A Host client has its own title bar and keeps Space switching under
        // 我的; only standalone mode still needs this strip.
        if (selected.mode == SpaceMode.standalone)
          Material(
            color: Nova.ink,
            child: DecoratedBox(
              decoration: const BoxDecoration(
                border: Border(
                  bottom: BorderSide(color: Nova.separator, width: .5),
                ),
              ),
              child: SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 10, 4),
                  child: Row(
                    children: [
                      const Icon(
                        CupertinoIcons.device_phone_portrait,
                        size: 18,
                        color: Nova.secondary,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text.rich(
                          TextSpan(
                            children: [
                              TextSpan(
                                text: selected.name,
                                style: const TextStyle(
                                  color: Nova.text,
                                  fontSize: 15,
                                  fontWeight: FontWeight.w600,
                                  letterSpacing: 0,
                                ),
                              ),
                              const TextSpan(
                                text: '  ·  ',
                                style: TextStyle(
                                  color: Nova.tertiary,
                                  fontSize: 12,
                                  letterSpacing: 0,
                                ),
                              ),
                              const TextSpan(
                                text: '独立运行',
                                style: TextStyle(
                                  color: Nova.secondary,
                                  fontSize: 12,
                                  letterSpacing: 0,
                                ),
                              ),
                            ],
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 8),
                      TextButton.icon(
                        onPressed: () => catalog.select(null),
                        style: TextButton.styleFrom(
                          foregroundColor: Nova.secondary,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 4,
                          ),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          visualDensity: VisualDensity.compact,
                          textStyle: const TextStyle(
                            fontFamily: 'CupertinoSystemText',
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                            letterSpacing: 0,
                          ),
                        ),
                        icon: const Icon(CupertinoIcons.arrow_swap, size: 17),
                        label: const Text('Space'),
                      ),
                    ],
                  ),
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
                    // The strip above already consumed the status-bar inset
                    // through its own SafeArea; the standalone page must not
                    // apply the same top padding a second time.
                    ? MediaQuery.removePadding(
                        context: context,
                        removeTop: true,
                        child: widget.standaloneBuilder(selected),
                      )
                    : widget.clientBuilder?.call(selected) ??
                          SpaceClientScreen(
                            space: selected,
                            onSwitchSpace: () => catalog.select(null),
                          ),
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
  Widget build(BuildContext context) => NovaPage(
    title: 'Space',
    body: ListView(
      padding: const EdgeInsets.fromLTRB(0, 8, 0, 32),
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(20, 4, 20, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '每个 Space 的数据与密钥相互独立。',
                style: TextStyle(
                  color: Nova.text,
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
              ),
              SizedBox(height: 6),
              Text(
                '创建时选择独立运行，或连接电脑上的 Host。更换模式需要新建 Space。',
                style: TextStyle(
                  color: Nova.secondary,
                  fontSize: 14,
                  height: 1.4,
                ),
              ),
              SizedBox(height: 6),
              Text(
                '新建 Space 从空白开始，旧 Space 的历史资料不会迁移到这里。\n'
                'New Spaces start empty; saved data from older Spaces is not migrated.',
                style: TextStyle(
                  color: Nova.secondary,
                  fontSize: 13,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
        if (catalog.spaces.isNotEmpty)
          NovaSection(
            surface: Nova.sheetCell,
            children: [
              for (final space in catalog.spaces)
                NovaTile(
                  surface: Nova.sheetCell,
                  title: space.name,
                  subtitle: Text(
                    space.mode == SpaceMode.client
                        ? '由 Host 处理聊天与后台任务'
                        : '在此设备独立运行',
                  ),
                  leading: NovaIconTile(
                    space.mode == SpaceMode.client
                        ? CupertinoIcons.desktopcomputer
                        : CupertinoIcons.device_phone_portrait,
                  ),
                  trailing: const CupertinoListTileChevron(),
                  onTap: () => catalog.select(space.id),
                ),
            ],
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: FilledButton.icon(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => _CreateSpace(catalog: catalog),
              ),
            ),
            icon: const Icon(CupertinoIcons.add, size: 20),
            label: const Text('新建 Space'),
          ),
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

class SpaceClientScreen extends StatefulWidget {
  const SpaceClientScreen({
    super.key,
    required this.space,
    required this.onSwitchSpace,
    this.open = SpaceClientController.open,
  });
  final SpaceRecord space;
  final VoidCallback onSwitchSpace;

  /// Replaceable so tests can supply a controller without a relay.
  final Future<SpaceClientController> Function(SpaceRecord) open;
  @override
  State<SpaceClientScreen> createState() => _SpaceClientScreenState();
}

class _SpaceClientScreenState extends State<SpaceClientScreen> {
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
      final value = await widget.open(widget.space);
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
        title: Text('${entity == null ? '创建' : '编辑'}${_kindNames[kind]}'),
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

  static const _kindNames = {'goal': '目标', 'todo': '待办', 'idea': '想法'};
  static const _statusNames = {
    'done': '已完成',
    'active': '进行中',
    'archived': '已归档',
  };

  Widget _empty(String text) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: Nova.secondary,
          fontSize: 15,
          height: 1.5,
        ),
      ),
    ),
  );

  Widget _card(Map<String, dynamic> card, {String? collection}) {
    final body = card['body'] as String? ?? card['note'] as String? ?? '';
    return NovaTile(
      title: card['title'] as String? ?? '新内容',
      subtitle: body.isEmpty ? null : Text(body, maxLines: 12),
      trailing: collection == null
          ? null
          : IconButton(
              tooltip: '忽略',
              icon: const Icon(
                CupertinoIcons.xmark,
                size: 18,
                color: Nova.tertiary,
              ),
              onPressed: () async {
                await controller!.state.enqueue('card.dismiss', {
                  'id': card['id'],
                  'kind': collection,
                });
                unawaited(controller!.sync());
              },
            ),
    );
  }

  Widget _pending(SpaceClientState state) => state.pending.isEmpty
      ? const SizedBox.shrink()
      : NovaSection(
          header: '待处理请求',
          children: [
            for (final p in state.pending)
              NovaTile(
                title: p['status'] == 'conflict'
                    ? '编辑冲突 · 修改已保留'
                    : p['status'] == 'rejected'
                    ? 'Host 拒绝了操作'
                    : '等待 Host 确认',
                subtitle: Text(
                  '${(p['input'] as Map)['title'] ?? (p['input'] as Map)['about'] ?? p['kind']}${p['error'] == null ? '' : ' · ${p['error']}'}',
                ),
                trailing: PopupMenuButton<String>(
                  icon: const Icon(
                    CupertinoIcons.ellipsis,
                    size: 20,
                    color: Nova.secondary,
                  ),
                  onSelected: (action) async {
                    if (action == 'discard') {
                      await state.discard(p['op_id'] as String);
                    } else {
                      final input = Map<String, dynamic>.from(
                        p['input'] as Map,
                      );
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
                      const PopupMenuItem(
                        value: 'retry',
                        child: Text('按最新版本重提修改'),
                      ),
                    const PopupMenuItem(value: 'discard', child: Text('撤销此请求')),
                  ],
                ),
              ),
          ],
        );

  /// Quiet one-line status above the page, only when the Host is unreachable
  /// or reported a problem.
  Widget? _notice(SpaceClientState state) {
    final lines = [
      if (!state.hostOnline) 'Host 不在线 · 展示上次缓存',
      if (state.error != null) _connectionText(state.error!),
    ];
    return lines.isEmpty
        ? null
        : NovaNotice(lines.join('\n'), tone: NovaTone.warning);
  }

  Widget _timeline(SpaceClientState state) {
    final cards = <(Map<String, dynamic>, String?)>[
      for (final card in state.cards('notifications')) (card, null),
      for (final card
          in state.cards('feed').where((c) => c['dismissed'] != true))
        (card, 'feed'),
      for (final card
          in state.cards('timeline').where((c) => c['dismissed'] != true))
        (card, 'timeline'),
    ];
    if (cards.isEmpty) {
      return _empty(state.snapshot.isEmpty ? '等待 Host 提供空间快照。' : '暂无动态');
    }
    return ListView(
      padding: const EdgeInsets.only(top: 8, bottom: 24),
      children: [
        NovaSection(
          children: [
            for (final (card, collection) in cards)
              _card(card, collection: collection),
          ],
        ),
      ],
    );
  }

  Widget _entity(String kind, Map<String, dynamic> entity) {
    final done = entity['status'] == 'done';
    final note = (entity['note'] as String? ?? '').trim();
    final status = kind == 'todo' ? null : _statusNames[entity['status']];
    final subtitle = [if (note.isNotEmpty) note, ?status].join(' · ');
    return NovaTile(
      title: entity['title'] as String? ?? '',
      subtitle: subtitle.isEmpty ? null : Text(subtitle),
      onTap: () => editEntity(kind, entity: entity),
      trailing: kind != 'todo'
          ? null
          : done
          ? const Icon(
              CupertinoIcons.checkmark_circle_fill,
              size: 24,
              color: Nova.mint,
            )
          : IconButton(
              tooltip: '标记完成',
              icon: const Icon(
                CupertinoIcons.circle,
                size: 24,
                color: Nova.tertiary,
              ),
              onPressed: () async {
                await controller!.state.enqueue('life.mutate', {
                  'op': 'update',
                  'kind': 'todo',
                  'id': entity['id'],
                  'status': 'done',
                }, baseVersion: entity['version'] as int?);
                unawaited(controller!.sync());
              },
            ),
    );
  }

  Future<void> _create() async {
    final kind = await showCupertinoModalPopup<String>(
      context: context,
      builder: (sheet) => CupertinoActionSheet(
        actions: [
          for (final entry in _kindNames.entries)
            CupertinoActionSheetAction(
              onPressed: () => Navigator.pop(sheet, entry.key),
              child: Text(
                entry.value,
                style: const TextStyle(color: Nova.mint),
              ),
            ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(sheet),
          child: const Text('取消', style: TextStyle(color: Nova.secondary)),
        ),
      ),
    );
    if (kind != null && mounted) await editEntity(kind);
  }

  Widget _tasks(SpaceClientState state) {
    final kinds = [
      for (final kind in _kindNames.keys)
        if (state.cards('${kind}s').isNotEmpty) kind,
    ];
    if (kinds.isEmpty && state.pending.isEmpty) {
      return _empty('还没有目标、待办或想法。\n点右下角 + 创建。');
    }
    return ListView(
      padding: const EdgeInsets.only(top: 8, bottom: 96),
      children: [
        _pending(state),
        for (final kind in kinds)
          NovaSection(
            header: _kindNames[kind],
            children: [
              for (final entity in state.cards('${kind}s'))
                _entity(kind, entity),
            ],
          ),
      ],
    );
  }

  Widget _chat(SpaceClientController c) {
    final state = c.state;
    final canSend = !sending && state.hostOnline;
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
            children: [
              for (final m in state.messages) SpaceChatMessage(message: m),
              for (final preview in state.previews.values)
                Padding(
                  padding: const EdgeInsets.only(bottom: 22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Expanded(
                            child: Text(
                              'Host 正在回复…',
                              style: TextStyle(
                                color: Nova.secondary,
                                fontSize: 13,
                              ),
                            ),
                          ),
                          IconButton(
                            tooltip: '停止回复',
                            icon: const Icon(
                              CupertinoIcons.stop_circle,
                              size: 22,
                              color: Nova.secondary,
                            ),
                            onPressed: () async {
                              try {
                                await c.cancelChat(preview['op_id'] as String);
                              } catch (_) {
                                message('Host 不在线，无法取消。');
                              }
                            },
                          ),
                        ],
                      ),
                      if ((preview['text'] as String? ?? '').isNotEmpty)
                        Text(
                          preview['text'] as String,
                          style: const TextStyle(
                            color: Nova.text,
                            fontSize: 16,
                            height: 1.6,
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 14),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: Nova.cell,
                borderRadius: BorderRadius.circular(26),
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(18, 5, 6, 5),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: chat,
                        enabled: !sending,
                        style: const TextStyle(fontSize: 16, color: Nova.text),
                        decoration: InputDecoration(
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          hintText: state.hostOnline
                              ? '发送给 Host'
                              : 'Host 离线，聊天不可用',
                          hintStyle: const TextStyle(color: Nova.tertiary),
                        ),
                        onSubmitted: (_) => send(),
                      ),
                    ),
                    IconButton.filled(
                      tooltip: '发送',
                      onPressed: canSend ? send : null,
                      icon: const Icon(CupertinoIcons.arrow_up, size: 20),
                      style: IconButton.styleFrom(
                        fixedSize: const Size(40, 40),
                        backgroundColor: Nova.mint,
                        foregroundColor: Nova.ink,
                        disabledBackgroundColor: Nova.separator,
                        disabledForegroundColor: Nova.tertiary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _about() => showSpaceDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('手机工具'),
      content: const Text(
        '手机工具由 Host 指定动作，并受系统权限限制。iOS 支持日历读取、提醒事项创建、拍照；Android 支持日历读取、拍照。执行结果不明确时不会自动重试。',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('知道了'),
        ),
      ],
    ),
  );

  void _openPersonalPage(String title, Widget Function() content) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AnimatedBuilder(
          animation: controller!.state,
          builder: (context, _) => Scaffold(
            backgroundColor: Nova.ink,
            appBar: AppBar(title: Text(title), centerTitle: true),
            body: content(),
          ),
        ),
      ),
    );
  }

  Widget _profileDetails(SpaceClientState state) {
    final value = state.snapshot['profile'] as Map? ?? {};
    final about = value['about'] as String? ?? '';
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        NovaSection(
          header: '个人介绍',
          footer: state.hostOnline ? '来自当前 Space' : 'Host 不在线，显示上次同步的资料',
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Align(
                alignment: Alignment.centerLeft,
                child: SelectableText(about.isEmpty ? '还没有个人介绍' : about),
              ),
            ),
            NovaTile(
              title: '编辑个人资料',
              trailing: const CupertinoListTileChevron(),
              onTap: profile,
            ),
          ],
        ),
        _pending(state),
      ],
    );
  }

  Widget _feeds(SpaceClientState state) {
    final cards = state
        .cards('feed')
        .where((c) => c['dismissed'] != true)
        .toList();
    if (cards.isEmpty) return _empty('暂无资讯');
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        NovaSection(
          children: [for (final card in cards) _card(card, collection: 'feed')],
        ),
      ],
    );
  }

  Widget _me(SpaceClientController c) => MyOverview(
    life: c.state.snapshot,
    draft: const {},
    onOpen: (page) {
      if (page == 5) {
        _openPersonalPage('个人资料', () => _profileDetails(c.state));
      } else if (page == 1) {
        _openPersonalPage('资讯', () => _feeds(c.state));
      } else {
        final kind = {2: 'todo', 3: 'idea', 4: 'goal'}[page]!;
        _openPersonalPage(_kindNames[kind]!, () {
          final rows = c.state.cards('${kind}s');
          if (rows.isEmpty) return _empty('暂无${_kindNames[kind]}');
          return ListView(
            padding: const EdgeInsets.symmetric(vertical: 16),
            children: [
              _pending(c.state),
              NovaSection(
                children: [for (final row in rows) _entity(kind, row)],
              ),
            ],
          );
        });
      }
    },
  );

  Widget _settings(SpaceClientController c) {
    final state = c.state;
    return ListView(
      padding: const EdgeInsets.only(top: 8, bottom: 24),
      children: [
        NovaSection(
          header: 'Space',
          footer: 'Host 损坏会丢失此 Space；不提供备份恢复。',
          children: [
            NovaTile(
              title: widget.space.name,
              subtitle: Text(state.hostOnline ? 'Host 在线' : 'Host 不在线'),
              leading: const NovaIconTile(CupertinoIcons.desktopcomputer),
            ),
            NovaTile(
              title: '切换或新建 Space',
              leading: const NovaIconTile(CupertinoIcons.arrow_swap),
              trailing: const CupertinoListTileChevron(),
              onTap: () {
                Navigator.of(context).pop();
                widget.onSwitchSpace();
              },
            ),
          ],
        ),
        NovaSection(
          header: 'Host 连接',
          footer: '请在 Host 上核对指纹并批准连接。通信内容端到端加密；通知网关可见设备令牌、时间与密文大小。',
          children: [
            NovaTile(
              title: '中继地址',
              subtitle: Text(widget.space.relay ?? '', maxLines: 1),
            ),
            NovaTile(
              title: '此设备指纹',
              // SelectableText would reserve the tile's full three-line height.
              subtitle: SelectionArea(
                child: Text(
                  c.fingerprint,
                  style: const TextStyle(fontSize: 12, color: Nova.secondary),
                ),
              ),
            ),
            NovaTile(
              title: '启用锁屏通知',
              subtitle: Text(c.push?.status ?? '推送未就绪'),
              onTap: enablePushNotifications,
            ),
            NovaTile(
              title: '关闭锁屏通知',
              onTap: () async {
                try {
                  await c.push?.disable();
                } catch (error) {
                  message('$error');
                }
              },
            ),
          ],
        ),
        SpaceSourcePanel(state: state, onSync: c.sync),
        _pending(state),
        NovaSection(
          children: [
            NovaTile(
              title: '手机工具',
              leading: const NovaIconTile(CupertinoIcons.info),
              trailing: const CupertinoListTileChevron(),
              onTap: _about,
            ),
          ],
        ),
      ],
    );
  }

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
    final notice = tab < 2 ? _notice(state) : null;
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        centerTitle: true,
        title: Text(
          ['Nova', '任务', '时间线', '我的'][tab],
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w600,
            letterSpacing: -.5,
          ),
        ),
        actions: [
          if (tab == 3)
            IconButton(
              tooltip: '设置',
              icon: const Icon(CupertinoIcons.gear_alt, size: 23),
              onPressed: () => _openPersonalPage('设置', () => _settings(c)),
            )
          else
            IconButton(
              onPressed: () => c.sync(),
              icon: const Icon(CupertinoIcons.arrow_clockwise, size: 23),
              tooltip: '补拉 Host 状态',
            ),
          const SizedBox(width: 10),
        ],
      ),
      floatingActionButton: tab == 1
          ? FloatingActionButton(
              tooltip: '创建',
              onPressed: _create,
              child: const Icon(CupertinoIcons.add),
            )
          : null,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ?notice,
          Expanded(
            child: switch (tab) {
              0 => _chat(c),
              1 => _tasks(state),
              2 => _timeline(state),
              _ => _me(c),
            },
          ),
        ],
      ),
      bottomNavigationBar: MediaQuery.viewInsetsOf(context).bottom > 0
          ? null
          : BottomAppBarTabs(
              index: tab,
              onTap: (v) {
                FocusManager.instance.primaryFocus?.unfocus();
                setState(() => tab = v);
              },
              items: const [
                (
                  CupertinoIcons.chat_bubble,
                  CupertinoIcons.chat_bubble_fill,
                  'Nova',
                  0,
                ),
                (
                  CupertinoIcons.square_stack,
                  CupertinoIcons.square_stack_fill,
                  '任务',
                  0,
                ),
                (CupertinoIcons.clock, CupertinoIcons.clock_fill, '时间线', 0),
                (CupertinoIcons.person, CupertinoIcons.person_fill, '我的', 0),
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
