import 'push_invitation_dialog.dart';
import '../experience/persona.dart';
import '../generic/shared_ideas.dart';
import '../ui/shared_idea_suggestions.dart';
import '../services/preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../experience/onboarding.dart';
import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:mobile_scanner/mobile_scanner.dart';
import '../ui/app.dart' show BottomAppBarTabs;
import '../ui/components.dart';
import '../ui/theme.dart';
import '../ui/my_overview.dart';
import '../ui/settings_sheet.dart';
import '../ui/pet_avatar.dart';
import '../ui/connectors_page.dart';
import '../ui/model_settings_editor.dart';
import 'model_settings_backend.dart';
import 'client_controller.dart';
import 'client_state.dart';
import 'relay_transport.dart';
import 'space_storage.dart';
import 'native_scope.dart';
import 'push_client.dart';
import 'notification_router.dart';
import 'host_panel.dart';
import 'source_panel.dart';
import 'space_dialog.dart';
import 'chat_message.dart';
import 'reconnect_page.dart';
import 'binding_cleanup.dart';
import 'personal_adapter.dart';
import '../ui/workbench_page.dart';
import '../ui/timeline_page.dart';
import '../ui/timeline_briefs.dart';
import '../ui/conversation_home.dart';
import 'connection_status.dart';

class SpaceRoot extends StatefulWidget {
  const SpaceRoot({
    super.key,
    required this.standaloneBuilder,
    this.catalog,
    this.clientBuilder,
    this.standalonePageBuilder,
    this.connectionProbe = probeSpaceConnection,
  });
  final Widget Function(SpaceRecord) standaloneBuilder;
  final SpaceCatalog? catalog;
  final SpaceConnectionProbe connectionProbe;
  final Widget Function(SpaceRecord)? clientBuilder;
  final Widget Function(SpaceRecord, VoidCallback)? standalonePageBuilder;
  @override
  State<SpaceRoot> createState() => _SpaceRootState();
}

class _SpaceRootState extends State<SpaceRoot> {
  late final catalog = widget.catalog ?? SpaceCatalog();
  String? error;
  bool experienceUnavailable = false;
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
    unawaited(
      ExperiencePersona.loadManifest()
          .then((_) {
            if (mounted) setState(() {});
          })
          .catchError((Object _) {
            if (mounted) setState(() => experienceUnavailable = true);
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
    final active = catalog.selected;
    final selected =
        active?.personaId != null &&
            !ExperiencePersona.choices.any((p) => p.id == active!.personaId)
        ? null
        : active;
    if (selected == null) {
      return _SpaceChooser(
        catalog: catalog,
        probe: widget.connectionProbe,
        experienceUnavailable: experienceUnavailable,
      );
    }
    return Column(
      children: [
        // Client pages have their own title bar and Space switch.
        if (selected.mode == SpaceMode.standalone &&
            widget.standalonePageBuilder == null)
          StandaloneSpaceBar(
            space: selected,
            onSwitch: () => catalog.select(null),
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
                    ? widget.standalonePageBuilder?.call(
                            selected,
                            () => catalog.select(null),
                          ) ??
                          MediaQuery.removePadding(
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

class _SpaceChooser extends StatefulWidget {
  const _SpaceChooser({
    required this.catalog,
    required this.probe,
    this.experienceUnavailable = false,
  });
  final bool experienceUnavailable;
  final SpaceCatalog catalog;
  final SpaceConnectionProbe probe;
  @override
  State<_SpaceChooser> createState() => _SpaceChooserState();
}

class _SpaceChooserState extends State<_SpaceChooser>
    with WidgetsBindingObserver {
  SpaceCatalog get catalog => widget.catalog;
  String language =
      WidgetsBinding.instance.platformDispatcher.locale.languageCode;
  String t(String zh, String en) => language == 'zh' ? zh : en;
  final statuses = <String, SpaceConnectionStatus>{};
  Timer? timer;
  bool refreshing = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadLanguage());
    WidgetsBinding.instance.addPostFrameCallback((_) => refresh());
    timer = Timer.periodic(const Duration(seconds: 15), (_) => refresh());
  }

  Future<void> _loadLanguage() async {
    final saved = Preferences(await SharedPreferences.getInstance());
    if (mounted) setState(() => language = saved.language(language));
  }

  Future<void> refresh() async {
    if (!mounted ||
        refreshing ||
        WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed ||
        ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    refreshing = true;
    try {
      await Future.wait([
        for (final space in catalog.visibleSpaces)
          if (space.mode == SpaceMode.client)
            (() async {
              SpaceConnectionStatus status;
              try {
                status = await widget.probe(space);
              } catch (_) {
                status = SpaceConnectionStatus.unreachable;
              }
              if (mounted) setState(() => statuses[space.id] = status);
            })(),
      ]);
    } finally {
      refreshing = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(refresh());
  }

  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  (IconData, Color, String) connection(SpaceRecord space) =>
      switch (statuses[space.id] ?? SpaceConnectionStatus.checking) {
        SpaceConnectionStatus.online => (
          CupertinoIcons.checkmark_circle_fill,
          Nova.mint,
          t('电脑在线', 'Computer online'),
        ),
        SpaceConnectionStatus.offline => (
          CupertinoIcons.desktopcomputer,
          Nova.secondary,
          t('电脑离线', 'Computer offline'),
        ),
        SpaceConnectionStatus.unreachable => (
          CupertinoIcons.wifi_exclamationmark,
          Nova.amber,
          t('暂时无法连接', 'Could not connect'),
        ),
        SpaceConnectionStatus.awaitingApproval => (
          CupertinoIcons.lock,
          Nova.amber,
          t('等待电脑批准', 'Waiting for computer approval'),
        ),
        SpaceConnectionStatus.checking => (
          CupertinoIcons.desktopcomputer,
          Nova.secondary,
          t('正在检查连接', 'Checking connection'),
        ),
      };
  Future<void> manageBindings(BuildContext context, SpaceRecord space) async {
    final bindings = catalog.bindings(space);
    var keep = space, busy = false;
    String? problem;
    final result = await showDialog<SpaceRecord>(
      context: context,
      barrierDismissible: false,
      builder: (context) => StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: Text(t('清理旧绑定', 'Clean up old connections')),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('选择保留的有效所有者绑定。确认后将断开其他旧设备绑定，仅保留一条连接；原记录保留在私有恢复信息中。'),
                for (final binding in bindings)
                  ListTile(
                    selected: keep.id == binding.id,
                    trailing: Icon(
                      keep.id == binding.id
                          ? CupertinoIcons.checkmark_circle_fill
                          : CupertinoIcons.circle,
                    ),
                    title: Text(binding.name),
                    subtitle: Text(
                      '设备 ${binding.device?.substring(0, binding.device!.length.clamp(0, 8)) ?? "未知"}',
                    ),
                    onTap: busy ? null : () => update(() => keep = binding),
                  ),
                if (busy) const LinearProgressIndicator(),
                if (problem != null) Text(problem!),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(context),
              child: Text(t('取消', 'Cancel')),
            ),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      update(() {
                        busy = true;
                        problem = null;
                      });
                      try {
                        await consolidateClientBindings(catalog, keep);
                        if (context.mounted) Navigator.pop(context, keep);
                      } catch (_) {
                        if (context.mounted) {
                          update(() {
                            busy = false;
                            problem =
                                '未确认清理完成，原绑定已保留。请连接 Host，并选择已获所有者授权的绑定后重试。';
                          });
                        }
                      }
                    },
              child: const Text('保留所选并清理其他'),
            ),
          ],
        ),
      ),
    );
    if (result != null) await catalog.select(result.id);
  }

  @override
  Widget build(BuildContext context) => NovaPage(
    title: 'Space',
    body: ListView(
      padding: const EdgeInsets.fromLTRB(0, 8, 0, 32),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
          child: Text(
            t(
              '每个 Space 独立保存数据和模型配置。可以在本机运行，也可以连接电脑。',
              'Each Space keeps its own data and model settings. Run it on this device or connect to a computer.',
            ),
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 14,
              height: 1.4,
            ),
          ),
        ),
        if (widget.experienceUnavailable)
          ListTile(
            enabled: false,
            leading: Icon(Icons.auto_awesome_outlined),
            title: Text(t('体验 Space 暂不可用', 'Experience Spaces unavailable')),
            subtitle: Text(
              t(
                '示例资料不完整或已损坏，请更新应用后重试。普通 Space 不受影响。',
                'Sample data is incomplete or damaged. Update the app and retry. Other Spaces are unaffected.',
              ),
            ),
          )
        else if (ExperiencePersona.choices.isNotEmpty)
          ListTile(
            leading: const Icon(Icons.auto_awesome_outlined),
            title: Text(t('体验 Space', 'Experience Spaces')),
            subtitle: Text(t('选择示例人物', 'Choose a sample persona')),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ExperienceChooser(
                  catalog: catalog,
                  language: language,
                  allowInvite: catalog.spaces.isEmpty,
                ),
              ),
            ),
          ),
        if (catalog.spaces.isNotEmpty)
          NovaSection(
            surface: Nova.sheetCell,
            children: [
              for (final space in catalog.visibleSpaces.where(
                (s) =>
                    s.personaId == null ||
                    ExperiencePersona.choices.any((p) => p.id == s.personaId),
              ))
                NovaTile(
                  surface: Nova.sheetCell,
                  title: space.name,
                  subtitle: Text(
                    space.mode == SpaceMode.client
                        ? connection(space).$3
                        : t('在此设备独立运行', 'Runs on this device'),
                  ),
                  leading: NovaIconTile(
                    space.mode == SpaceMode.client
                        ? connection(space).$1
                        : CupertinoIcons.device_phone_portrait,
                    color: space.mode == SpaceMode.client
                        ? connection(space).$2
                        : Nova.mint,
                  ),
                  trailing: catalog.bindings(space).length > 1
                      ? IconButton(
                          tooltip: t('清理旧绑定', 'Clean up old connections'),
                          icon: const Icon(CupertinoIcons.ellipsis_circle),
                          onPressed: () => manageBindings(context, space),
                        )
                      : const CupertinoListTileChevron(),
                  onTap: () => catalog.select(space.id),
                ),
            ],
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: FilledButton.icon(
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) =>
                      _CreateSpace(catalog: catalog, language: language),
                ),
              );
              await refresh();
            },
            icon: const Icon(CupertinoIcons.add, size: 20),
            label: Text(t('新建 Space', 'New Space')),
          ),
        ),
      ],
    ),
  );
}

class _CreateSpace extends StatefulWidget {
  const _CreateSpace({required this.catalog, required this.language});
  final SpaceCatalog catalog;
  final String language;
  @override
  State<_CreateSpace> createState() => _CreateSpaceState();
}

class _CreateSpaceState extends State<_CreateSpace> {
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
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
    if (busy || !mounted || mode != SpaceMode.client) return;
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
      unawaited(create());
    } catch (e) {
      setState(
        () => error = e is FormatException && e.message == 'pairing_expired'
            ? t(
                '邀请码已过期，请在电脑上重新生成。',
                'This pairing code has expired. Generate a new one on the computer.',
              )
            : t(
                '无法读取邀请码，请重新扫描或粘贴完整内容。',
                'Could not read the pairing code. Scan it again or paste the full code.',
              ),
      );
    }
  }

  Future<bool> confirmConnection() async {
    if (name.text.trim().isEmpty) name.text = t('我的电脑', 'My computer');
    return await showSpaceDialog<bool>(
          context: context,
          builder: (context) => StatefulBuilder(
            builder: (context, update) => AlertDialog(
              title: Text(t('连接电脑', 'Connect to computer')),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      t(
                        '请核对电脑上的 Host 指纹',
                        'Check the host fingerprint on your computer.',
                      ),
                    ),
                    const SizedBox(height: 8),
                    SelectableText(invitation!.hostFingerprint),
                    const SizedBox(height: 12),
                    Text(
                      t(
                        '确认后请在电脑上核对此设备指纹，并批准连接。',
                        'Then check this device’s fingerprint and approve the connection on your computer.',
                      ),
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: name,
                      autofocus: true,
                      onChanged: (_) => update(() {}),
                      decoration: InputDecoration(
                        labelText: t('Space 名称', 'Space name'),
                      ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: Text(t('取消', 'Cancel')),
                ),
                TextButton(
                  onPressed: name.text.trim().isEmpty
                      ? null
                      : () => Navigator.pop(context, true),
                  child: Text(t('确认绑定', 'Confirm pairing')),
                ),
              ],
            ),
          ),
        ) ??
        false;
  }

  Future<void> create() async {
    if (busy) return;
    if (mode == SpaceMode.standalone && name.text.trim().isEmpty) {
      setState(() => error = t('请为 Space 命名', 'Enter a Space name.'));
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
        if (invitation == null) {
          setState(
            () => error = t(
              '请先扫描电脑上的邀请码',
              'Scan the pairing code on your computer first.',
            ),
          );
          return;
        }
        if (!await confirmConnection() || !mounted) return;
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
      if (mounted) {
        setState(
          () => error = mode == SpaceMode.client
              ? t(
                  '暂时无法连接电脑，请检查网络后重试。',
                  'Could not connect to the computer. Check your network and retry.',
                )
              : t('无法创建 Space，请重试。', 'Could not create the Space. Try again.'),
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(t('创建 Space', 'Create a Space'))),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(
          t(
            '新建 Space 不会带入旧 Space 的数据。要更换运行方式，请新建 Space。',
            'New Spaces start without data from existing Spaces. Create a new Space to change how it runs.',
          ),
        ),
        const SizedBox(height: 16),
        if (mode == SpaceMode.standalone) ...[
          TextField(
            controller: name,
            decoration: InputDecoration(labelText: t('名称', 'Name')),
          ),
          const SizedBox(height: 24),
        ],
        RadioGroup<SpaceMode>(
          groupValue: mode,
          onChanged: (v) {
            if (v != null) setState(() => mode = v);
          },
          child: Column(
            children: [
              RadioListTile(
                value: SpaceMode.standalone,
                title: Text(t('独立运行', 'Run on this device')),
                subtitle: Text(
                  t(
                    '此设备运行聊天、资料处理与定时任务。',
                    'Chats, data processing, and schedules run here.',
                  ),
                ),
              ),
              RadioListTile(
                value: SpaceMode.client,
                title: Text(t('连接 Host', 'Connect to a computer')),
                subtitle: Text('电脑处理聊天与后台任务；此设备展示缓存并发送操作。'),
              ),
            ],
          ),
        ),
        if (mode == SpaceMode.client) ...[
          const SizedBox(height: 16),
          Text(
            t(
              'Host 不在线时聊天不可用。Host 损坏会丢失这个 Space，不提供备份恢复。',
              'Chats need an online host. If the host is lost, this Space cannot be recovered from a backup.',
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => setState(() => scanning = !scanning),
            icon: const Icon(Icons.qr_code_scanner),
            label: Text(t('扫描 Host 邀请码', 'Scan host pairing code')),
          ),
          if (scanning)
            SizedBox(
              height: 260,
              child: MobileScanner(
                onDetect: (capture) {
                  if (!scanning || busy) return;
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
            decoration: InputDecoration(
              labelText: t('或粘贴邀请码', 'Or paste the pairing code'),
            ),
          ),
          TextButton(
            onPressed: () => parse(code.text),
            child: Text(t('读取邀请码', 'Read pairing code')),
          ),
          if (invitation != null)
            Text(
              t(
                '已读取电脑邀请码，可继续确认连接。',
                'Pairing code read. Confirm the connection to continue.',
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
                ? t('正在创建…', 'Creating…')
                : mode == SpaceMode.client
                ? '确认连接电脑'
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
  RemotePersonalAdapter? personal;
  String? taskConversation;
  bool taskOpen = false;
  String? startupError;
  final chat = TextEditingController();
  final petAvatar = PetAvatarStore();
  String? _ideaLanguage;
  bool sending = false;
  int tab = 0;
  Widget _switchSpaceButton() => IconButton(
    tooltip: '切换 Space',
    onPressed: widget.onSwitchSpace,
    icon: const Icon(CupertinoIcons.arrow_swap, size: 23),
  );
  @override
  void initState() {
    super.initState();
    unawaited(petAvatar.load());
    unawaited(_restoreIdeaLanguage());
    unawaited(_open());
  }

  Future<void> _restoreIdeaLanguage() async {
    final system =
        WidgetsBinding.instance.platformDispatcher.locale.languageCode;
    var language = system == 'zh' ? 'zh' : 'en';
    try {
      final preferences = Preferences(await SharedPreferences.getInstance());
      language = preferences.language(system) == 'zh' ? 'zh' : 'en';
    } catch (_) {
      // Use the system language if App preferences cannot be loaded.
    }
    if (mounted) setState(() => _ideaLanguage = language);
  }

  Future<void> _open() async {
    try {
      final value = await widget.open(widget.space);
      if (!mounted) {
        await value.dispose();
        return;
      }
      controller = value;
      personal = RemotePersonalAdapter(value.state, onSync: value.sync);
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
    personal?.dispose();
    petAvatar.dispose();
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

  bool _readOnlyTask(Map? row) =>
      row == null ||
      !['chat', 'topic'].contains(row['kind']) ||
      row['mode'] == 'plan';

  Map<String, dynamic>? _mainConversation(SpaceClientState state) => state
      .cards('conversations')
      .where((row) => row['id'] == 'chat:main')
      .firstOrNull;

  bool _canSendIdea(SpaceClientState state) {
    final main = _mainConversation(state);
    return !sending &&
        state.hostOnline &&
        main != null &&
        main['mode'] != 'plan' &&
        main['generation_status'] != 'pending' &&
        !state.previews.values.any(
          (row) => (row['conversation_id'] ?? 'chat:main') == 'chat:main',
        );
  }

  bool _emptyIdeaOpening(SpaceClientState state) {
    final main = _mainConversation(state);
    if (main?['opening_empty'] == false) return false;
    final messages = state.messages
        .where((row) => (row['conversation_id'] ?? 'chat:main') == 'chat:main')
        .toList();
    // Older Hosts do not project the complete-history opening flag.
    if (main?['opening_empty'] == null &&
        messages.isEmpty &&
        (main?['preview'] as String? ?? '').isNotEmpty) {
      return false;
    }
    return emptyIdeaOpening(messages);
  }

  void _sendIdea(String text, {BuildContext? pageContext}) {
    if (sending) return;
    final state = controller?.state;
    if (state == null || !_canSendIdea(state)) {
      message('主对话暂时无法发送，请稍后重试。');
      return;
    }
    if (pageContext != null) Navigator.of(pageContext).pop();
    setState(() => tab = 0);
    unawaited(send(idea: text));
  }

  Future<void> send({String? idea}) async {
    if (sending) return;
    if (idea == null &&
        tab == 1 &&
        _readOnlyTask(
          controller!.state
              .cards('conversations')
              .where((row) => row['id'] == taskConversation)
              .firstOrNull,
        )) {
      message('请在电脑上继续处理此任务。');
      return;
    }
    final text = idea ?? chat.text;
    if (text.trim().isEmpty) return;
    setState(() => sending = true);
    try {
      await controller!.sendChat(
        text,
        conversationId: idea == null && tab == 1
            ? taskConversation ?? 'chat:main'
            : 'chat:main',
      );
      if (idea == null) chat.clear();
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

  static const _kindNames = {'goal': '目标', 'todo': '待办', 'idea': '想法'};
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
      subtitle: body.isEmpty && card['date'] == null
          ? null
          : Text(
              [
                if (card['date'] is String) card['date'] as String,
                if (body.isNotEmpty) body,
              ].join('\n'),
              maxLines: 12,
            ),
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

  bool _needsAttention(Map<String, dynamic> value) =>
      ['conflict', 'rejected'].contains(value['status']);
  Widget _pending(SpaceClientState state) {
    final problems = state.pending.where(_needsAttention).toList();
    return problems.isEmpty
        ? const SizedBox.shrink()
        : NovaSection(
            header: '需要处理',
            children: [
              for (final p in problems)
                NovaTile(
                  title: p['status'] == 'conflict' ? '编辑冲突 · 修改已保留' : '修改未能保存',
                  subtitle: Text(
                    '${(p['input'] as Map)['title'] ?? (p['input'] as Map)['about'] ?? const {'life.mutate': '事项修改', 'settings.patch': '助手设置'}[p['kind']] ?? '内容修改'}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
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
                        var input = Map<String, dynamic>.from(
                          p['input'] as Map,
                        );
                        if (p['kind'] == 'settings.patch') {
                          input = refreshSettingsPatch(input, state.snapshot);
                        }
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
                          child: Text('按最新内容重试'),
                        ),
                      const PopupMenuItem(
                        value: 'discard',
                        child: Text('放弃这次修改'),
                      ),
                    ],
                  ),
                ),
            ],
          );
  }

  /// Quiet one-line status above the page, only when the Host is unreachable
  /// or reported a problem.
  Widget? _notice(SpaceClientState state) {
    if (state.waitingForApproval ||
        state.hostOnline && state.snapshot.isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    state.waitingForApproval
                        ? '配对中，等待电脑确认绑定。'
                        : '已连接，正在同步电脑资料…',
                    style: const TextStyle(color: Nova.secondary, fontSize: 13),
                  ),
                ),
              ],
            ),
            if (state.waitingForApproval && controller != null) ...[
              const SizedBox(height: 8),
              const Text(
                '请在电脑核对此手机指纹',
                style: TextStyle(color: Nova.secondary, fontSize: 12),
              ),
              Row(
                children: [
                  Expanded(
                    child: SelectableText(
                      controller!.fingerprint,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                  IconButton(
                    tooltip: '复制手机指纹',
                    icon: const Icon(CupertinoIcons.doc_on_clipboard, size: 18),
                    onPressed: () => Clipboard.setData(
                      ClipboardData(text: controller!.fingerprint),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      );
    }
    final status = state.linkStatus();
    // Only a fatal condition or a real Host absence deserves a banner; a degraded or
    // still-connecting link says nothing rather than contradicting what works.
    final lines = [
      if (!state.hostOnline && status != SpaceLinkStatus.disconnected)
        'Host 不在线 · 展示上次缓存',
      if (status == SpaceLinkStatus.blocked) _connectionText(state.error!),
    ];
    return lines.isEmpty
        ? null
        : NovaNotice(lines.join('\n'), tone: NovaTone.warning);
  }

  Widget _workbench(int page) => Column(
    children: [
      _pending(controller!.state),
      Expanded(
        child: WorkbenchPage(
          store: personal!.store,
          page: page,
          showHeading: false,
          language: page == 3 ? _ideaLanguage ?? 'zh' : 'zh',
          onSettings: () => _settings(controller!),
          onSharedIdea: _ideaLanguage == null
              ? null
              : (text) => _sendIdea(text, pageContext: context),
        ),
      ),
    ],
  );

  Widget _timeline(SpaceClientState state) {
    final entries = (state.snapshot['timeline_entries'] as List? ?? [])
        .whereType<Map>()
        .toList();
    return TimelinePage(
      store: personal!.store,
      language: 'zh',
      sourceTimeline: TimelineBriefs(
        entries: entries,
        availableEvidenceIds:
            state.snapshot['timeline_available_evidence_ids'] as List? ?? [],
        onAction: (draft) => setState(() {
          tab = 0;
          chat.text = draft;
        }),
      ),
      onDiscuss: (text) => setState(() {
        tab = 0;
        chat.text = text;
      }),
    );
  }

  Widget _executionActivity(SpaceClientState state) {
    final events = state.cards('notifications');
    if (events.isEmpty) return _empty('暂无执行动态');
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 16),
      itemCount: events.length,
      itemBuilder: (context, index) =>
          NovaSection(children: [_card(events[index])]),
    );
  }

  Widget _tasks(SpaceClientState state) => Column(
    children: [
      _pending(state),
      if (state.cards('notifications').isNotEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () =>
                  _openPersonalPage('执行动态', () => _executionActivity(state)),
              icon: const Icon(CupertinoIcons.bell, size: 17),
              label: const Text('执行动态'),
            ),
          ),
        ),
      Expanded(
        child: ConversationHome(
          changes: state,
          conversations: () => state
              .cards('conversations')
              .where((row) => row['id'] != 'chat:main' && row['kind'] != 'main')
              .toList(),
          showSchedules: false,
          onNew: null,
          onOpen: (id) {
            final row = state
                .cards('conversations')
                .where((row) => row['id'] == id)
                .first;
            if (_readOnlyTask(row)) {
              showSpaceDialog<void>(
                context: context,
                builder: (context) => AlertDialog(
                  title: Text('${row['title'] ?? '任务'}'),
                  content: Text('${row['preview'] ?? ''}\n\n请在电脑上继续处理此任务。'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('完成'),
                    ),
                  ],
                ),
              );
            } else {
              setState(() {
                taskConversation = id;
                taskOpen = true;
                chat.clear();
              });
            }
          },
        ),
      ),
    ],
  );

  Widget _chat(SpaceClientController c) {
    final state = c.state;
    final canSend = !sending && state.hostOnline;
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
            children: [
              for (final m in state.messages.where(
                (m) =>
                    (m['conversation_id'] ?? 'chat:main') ==
                    (tab == 1 ? taskConversation : 'chat:main'),
              ))
                SpaceChatMessage(
                  message: m,
                  onRetry: () {
                    final original = state.messages
                        .where(
                          (v) =>
                              v['role'] == 'user' &&
                              v['turn_id'] == m['turn_id'],
                        )
                        .firstOrNull;
                    if (original != null) {
                      chat.text = original['text'] as String? ?? '';
                      setState(() {});
                    }
                  },
                ),
              for (final preview in state.previews.values.where(
                (m) =>
                    (m['conversation_id'] ?? 'chat:main') ==
                    (tab == 1 ? taskConversation : 'chat:main'),
              ))
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
        if (tab == 0 &&
            _ideaLanguage != null &&
            _canSendIdea(state) &&
            _emptyIdeaOpening(state))
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: chat,
            builder: (_, value, _) => value.text.isEmpty
                ? SharedIdeaSuggestions(
                    language: _ideaLanguage!,
                    compact: true,
                    onSend: _sendIdea,
                  )
                : const SizedBox.shrink(),
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
                              : state.waitingForApproval
                              ? '等待电脑确认绑定'
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

  Future<void> _openPersonalPage(
    String title,
    Widget Function() content,
  ) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AnimatedBuilder(
          animation: controller!.state,
          builder: (context, _) => Scaffold(
            backgroundColor: Nova.sheet,
            appBar: AppBar(title: Text(title), centerTitle: true),
            body: content(),
          ),
        ),
      ),
    );
  }

  Widget _profileDetails(SpaceClientState state) => _workbench(5);

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
    draft: {
      'about':
          (c.state.snapshot['profile_presentation'] as Map?)?['about'] ?? '',
    },
    onOpen: (page) {
      if (page == 5) {
        _openPersonalPage('个人资料', () => _profileDetails(c.state));
      } else if (page == 1) {
        _openPersonalPage('资讯', () => _feeds(c.state));
      } else {
        final kind = {2: 'todo', 3: 'idea', 4: 'goal'}[page]!;
        _openPersonalPage(_kindNames[kind]!, () => _workbench(page));
      }
    },
  );

  Future<void> _settings(SpaceClientController c) async {
    final choice = await showSettingsSheet(
      context,
      language: 'zh',
      builder: (context) => ListView(
        padding: const EdgeInsets.fromLTRB(4, 20, 4, 28),
        children: [
          SettingsGroup(
            title: '对话',
            rows: [
              ...conversationSettingsRows('zh'),
              ('api_keys', 'API 密钥', CupertinoIcons.lock),
            ],
          ),
          const SettingsGroup(
            title: '更多',
            rows: [
              ('connectors', '连接器', CupertinoIcons.link),
              ('assistant', '助手设置', CupertinoIcons.person),
            ],
          ),
        ],
      ),
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'devices':
        await _openPersonalPage('设备', () => _devices(c));
      case 'model_services':
        await _openPersonalPage('模型服务', () => _modelServices(c));
      case 'api_keys':
        await _openPersonalPage('API 密钥', () => _hostSection(c, 'credentials'));
      case 'pet_avatar':
        await showPetAvatarSettings(context, petAvatar);
      case 'assistant':
        await _openPersonalPage('助手设置', () => _hostSection(c, 'assistant'));
      case 'connectors':
        await Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) => AnimatedBuilder(
              animation: c.state,
              builder: (context, _) {
                final feishu = c.state.snapshot['host_feishu'] as Map? ?? {};
                final connected = feishu['connected'] == true;
                final label = connected
                    ? '已连接'
                    : feishu['unverified'] == true
                    ? '暂时无法验证登录'
                    : feishu['login_pending'] == true
                    ? '等待授权'
                    : '未连接';
                return ConnectorsPage(
                  language: 'zh',
                  feishuStatus: (
                    label: label,
                    subtitle: connected ? '从电脑同步已授权的消息与资料' : '在电脑上完成飞书授权',
                    tone: connected ? NovaTone.success : NovaTone.warning,
                  ),
                  onOpenFeishu: () =>
                      _openPersonalPage('飞书', () => _hostSection(c, 'feishu')),
                  systemTitle: '手机采集与授权',
                  systemSubtitle: '手动提交内容，管理上传与处理授权。',
                  onOpenSystem: () => _openPersonalPage(
                    '手机采集与授权',
                    () => SingleChildScrollView(
                      child: SpaceSourcePanel(state: c.state, onSync: c.sync),
                    ),
                  ),
                );
              },
            ),
          ),
        );
    }
  }

  Widget _hostSection(SpaceClientController c, String section) =>
      c.state.snapshot['owner'] != true
      ? _empty('仅 Space 所有者可以修改电脑上的设置')
      : ListView(
          padding: const EdgeInsets.symmetric(vertical: 16),
          children: [
            SpaceHostPanel(state: c.state, onSync: c.sync, section: section),
            _pending(c.state),
          ],
        );

  Widget _modelServices(SpaceClientController c) {
    final models =
        (c.state.snapshot['host_settings'] as Map?)?['models'] as Map?;
    if (models == null || c.state.snapshot['owner'] != true) {
      return _empty('暂时无法读取电脑上的模型设置，请连接 Host 后刷新');
    }
    final routes = models['routes'] as Map? ?? {};
    final providers = {
      for (final provider
          in (models['providers'] as List? ?? []).whereType<Map>())
        provider['id']: provider['label'] ?? provider['id'],
    };
    const labels = {
      'conversationText': '对话模型',
      'support': '后台分析模型',
      'fast': '快速响应模型',
      'compressor': '上下文压缩模型',
      'watch': '视觉模型',
      'embedding': '向量模型',
    };
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        SettingsGroup(
          title: '模型选择',
          rows: [
            for (final lane in labels.keys)
              (lane, labels[lane]!, CupertinoIcons.sparkles),
          ],
          subtitles: {
            for (final lane in labels.keys)
              lane: routes[lane] is Map
                  ? "${providers[routes[lane]['provider']] ?? routes[lane]['provider']} · ${routes[lane]['model']}"
                  : '使用电脑默认模型',
          },
          onSelected: (lane) => showModelSettingsEditor(
            context,
            RemoteModelSettingsBackend(c.state, onSync: c.sync, lane: lane),
            title: labels[lane],
            description: '修改将加密发送到电脑，重启电脑上的助手后生效。',
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 6),
          child: Text(
            models['locked'] == true
                ? '模型由电脑的启动配置管理，请在电脑上修改。'
                : '模型选择将加密发送到电脑。请在设置中的 API 密钥管理服务密钥。',
            style: const TextStyle(color: Nova.secondary, fontSize: 13),
          ),
        ),
        _pending(c.state),
      ],
    );
  }

  Widget _devices(SpaceClientController c) {
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
              subtitle: Text(
                state.waitingForApproval
                    ? '等待电脑确认绑定'
                    : state.hostOnline
                    ? 'Host 在线'
                    : 'Host 不在线',
              ),
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
        appBar: AppBar(
          title: Text(widget.space.name),
          actions: [_switchSpaceButton()],
        ),
        body: Center(
          child: startupError == null
              ? const CircularProgressIndicator()
              : Text('无法打开 Client：$startupError'),
        ),
      );
    }
    final state = c.state;
    final disconnected = state.linkStatus() == SpaceLinkStatus.disconnected;
    final notice = tab < 2 && !disconnected ? _notice(state) : null;
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        leading: tab == 1 && taskOpen
            ? IconButton(
                tooltip: '返回任务',
                icon: const Icon(CupertinoIcons.back),
                onPressed: () => setState(() => taskOpen = false),
              )
            : tab == 3
            ? null
            : IconButton(
                tooltip: '刷新',
                onPressed: () => c.sync(),
                icon: const Icon(CupertinoIcons.arrow_clockwise, size: 23),
              ),
        automaticallyImplyLeading: false,
        centerTitle: true,
        title: tab == 0
            ? PetAvatarTitle(store: petAvatar, title: 'NovaCore')
            : Text(
                ['NovaCore', '任务', '时间线', '我的'][tab],
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -.5,
                ),
              ),
        actions: [
          IconButton(
            tooltip: '设置',
            icon: const Icon(CupertinoIcons.gear_alt, size: 23),
            onPressed: () => _settings(c),
          ),
          _switchSpaceButton(),
          const SizedBox(width: 10),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ?notice,
          Expanded(
            child: disconnected
                ? SpaceReconnectPage(
                    reconnecting: state.reconnecting,
                    lastOkAt: state.lastOkAt,
                    onRetry: () => unawaited(c.reconnectNow()),
                  )
                : switch (tab) {
                    0 => _chat(c),
                    1 => taskOpen ? _chat(c) : _tasks(state),
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
                  'NovaCore',
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
    return '网络不稳定，正在重试。';
  }
}

class StandaloneSpaceBar extends StatelessWidget {
  const StandaloneSpaceBar({
    super.key,
    required this.space,
    required this.onSwitch,
    this.onSettings,
    this.settingsLabel = '设置',
  });
  final SpaceRecord space;
  final VoidCallback onSwitch;
  final VoidCallback? onSettings;
  final String settingsLabel;
  @override
  Widget build(BuildContext context) => Material(
    color: Nova.ink,
    child: DecoratedBox(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Nova.separator, width: .5)),
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
                        text: space.name,
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
              if (onSettings != null)
                IconButton(
                  key: const ValueKey('global.settings'),
                  tooltip: settingsLabel,
                  onPressed: onSettings,
                  icon: const Icon(CupertinoIcons.gear_alt, size: 23),
                ),
              const SizedBox(width: 8),
              TextButton.icon(
                onPressed: onSwitch,
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
  );
}
