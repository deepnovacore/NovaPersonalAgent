import 'push_invitation_dialog.dart';
import '../experience/persona.dart';
import '../generic/shared_ideas.dart';
import '../ui/shared_idea_suggestions.dart';
import '../services/preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../experience/onboarding.dart';
import 'dart:async';
import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:nova_audio/channel_audio.dart';
import 'package:nova_audio/nova_audio.dart';
import '../conversation/phone_dictation.dart';
import '../voice/audio_owner.dart';
import '../voice/voice_settings.dart';
import '../voice/voice_settings_sheet.dart';
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

/// The platform language, reduced to the two the Space UI ships.
String spacePlatformLanguage() =>
    WidgetsBinding.instance.platformDispatcher.locale.languageCode == 'zh'
    ? 'zh'
    : 'en';

/// The App language preference, falling back to the platform language.
Future<String> spaceSavedLanguage() async {
  final system = WidgetsBinding.instance.platformDispatcher.locale.languageCode;
  try {
    final saved = Preferences(await SharedPreferences.getInstance());
    return saved.language(system) == 'zh' ? 'zh' : 'en';
  } catch (_) {
    return system.startsWith('zh') ? 'zh' : 'en';
  }
}

class SpaceRoot extends StatefulWidget {
  const SpaceRoot({
    super.key,
    required this.standaloneBuilder,
    this.audio,
    this.requestMicrophone,
    this.audioOwner,
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

  /// Dictation for the Client Space composer; null opens the native port.
  final AudioPort? audio;
  final Future<bool> Function()? requestMicrophone;
  final AudioOwner? audioOwner;
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
  String language = spacePlatformLanguage();
  String t(String zh, String en) => language == 'zh' ? zh : en;
  @override
  void initState() {
    super.initState();
    unawaited(
      spaceSavedLanguage().then((value) {
        if (mounted) setState(() => language = value);
      }),
    );
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
    final id = await SpaceNotificationRouter.resolve(
      handle,
      catalog.spaces.toList(),
    );
    if (!mounted) return;
    if (id != null && catalog.selectedId != id) {
      await catalog.select(id, ignoreMissing: true);
    }
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
      return Scaffold(
        body: Center(
          child: Text(t('无法打开 Space：$error', 'Could not open Space: $error')),
        ),
      );
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
            language: language,
          ),
        Expanded(
          child: FutureBuilder<void>(
            future: nativeScope,
            builder: (context, result) {
              if (result.hasError) {
                return Center(
                  child: Text(
                    t(
                      '无法切换设备空间：${result.error}',
                      'Could not switch device space: ${result.error}',
                    ),
                  ),
                );
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
                            audio: widget.audio,
                            requestMicrophone: widget.requestMicrophone,
                            audioOwner: widget.audioOwner,
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

enum _SpaceAction { cleanBindings, remove }

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
                Text(
                  t(
                    '选择保留的有效所有者绑定。确认后将断开其他旧设备绑定，仅保留一条连接；原记录保留在私有恢复信息中。',
                    'Choose the owner connection to keep. The other old device connections are disconnected; the original records stay in private recovery data.',
                  ),
                ),
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
                      t('设备 ', 'Device ') +
                          (binding.device?.substring(
                                0,
                                binding.device!.length.clamp(0, 8),
                              ) ??
                              t('未知', 'unknown')),
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
                            problem = t(
                              '未确认清理完成，原绑定已保留。请连接 Host，并选择已获所有者授权的绑定后重试。',
                              'Cleanup was not confirmed; the original connections are kept. Connect to the host, choose a connection with owner authorization, and retry.',
                            );
                          });
                        }
                      }
                    },
              child: Text(t('保留所选并清理其他', 'Keep selected, clean up others')),
            ),
          ],
        ),
      ),
    );
    if (result != null) await catalog.select(result.id);
  }

  Future<void> _removeSpace(SpaceRecord space) async {
    final name = ExperiencePersona.spaceDisplayName(space);
    final confirmed = await showCupertinoDialog<bool>(
      context: context,
      builder: (dialogContext) => CupertinoAlertDialog(
        title: Text(t('删除「$name」？', 'Delete “$name”?')),
        content: Text(
          space.mode == SpaceMode.client
              ? t(
                  '将从这部手机移除连接。电脑上的 Space 和数据会保留。',
                  'This removes the connection from this phone. The Space and its data stay on the computer.',
                )
              : t(
                  '将从 Space 列表移除。本机数据会保留以便恢复。',
                  'This removes it from the Space list. Local data is kept for recovery.',
                ),
        ),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(t('取消', 'Cancel')),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(t('删除', 'Delete')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      final removed = await catalog.removeSpace(space.id);
      for (final record in removed.where((v) => v.mode == SpaceMode.client)) {
        unawaited(
          SpacePushClient(
            record,
            null,
            onWake: () async {},
          ).disable().catchError((Object _) {}),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(t('删除失败，请重试。', 'Could not delete Space. Try again.')),
          ),
        );
      }
    }
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
                builder: (_) =>
                    ExperienceChooser(catalog: catalog, language: language),
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
                  trailing: PopupMenuButton<_SpaceAction>(
                    tooltip: t('管理 Space', 'Manage Space'),
                    icon: const Icon(CupertinoIcons.ellipsis_circle),
                    onSelected: (action) => switch (action) {
                      _SpaceAction.cleanBindings => manageBindings(
                        context,
                        space,
                      ),
                      _SpaceAction.remove => _removeSpace(space),
                    },
                    itemBuilder: (_) => [
                      if (catalog.bindings(space).length > 1)
                        PopupMenuItem(
                          value: _SpaceAction.cleanBindings,
                          child: Text(t('清理旧绑定', 'Clean up old connections')),
                        ),
                      PopupMenuItem(
                        value: _SpaceAction.remove,
                        child: Text(t('删除 Space', 'Delete Space')),
                      ),
                    ],
                  ),
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
  Widget build(BuildContext context) => NovaPage(
    title: t('创建 Space', 'Create a Space'),
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
                subtitle: Text(
                  t(
                    '电脑处理聊天与后台任务；此设备展示缓存并发送操作。',
                    'The computer handles chats and background tasks; this device shows cached data and sends actions.',
                  ),
                ),
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
                ? t('确认连接电脑', 'Connect to computer')
                : t('创建独立 Space', 'Create standalone Space'),
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
    this.language,
    this.audio,
    this.requestMicrophone,
    this.audioOwner,
    this.createDictation,
  });
  final SpaceRecord space;
  final VoidCallback onSwitchSpace;

  /// Replaceable so tests can drive dictation without native audio or ASR.
  final PhoneDictation Function(ValueChanged<String> onText)? createDictation;

  /// Fixed UI language; null follows the App preference and platform locale.
  final String? language;

  /// Dictation inputs. Without them the screen opens the native port on
  /// phones and shows no microphone elsewhere.
  final AudioPort? audio;
  final Future<bool> Function()? requestMicrophone;
  final AudioOwner? audioOwner;

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
  late String language = widget.language ?? spacePlatformLanguage();
  String t(String zh, String en) => language == 'zh' ? zh : en;
  bool sending = false;
  int tab = 0;
  PhoneDictation? dictation;
  String _dictationBase = '';

  /// The composer a dictation run writes into; null once it was sent or left.
  String? _dictationTarget;
  String get _composerTarget =>
      tab == 1 ? taskConversation ?? 'chat:main' : 'chat:main';

  /// Ends any dictation run so a late transcript cannot reach a composer the
  /// user has sent from or left.
  void _leaveDictation() {
    _dictationTarget = null;
    unawaited(dictation?.cancel());
  }

  bool _showDictationHint = false;
  final _voiceSettings = VoiceSettings();

  /// Approval decisions sent from this screen, by op id, until the Host answers.
  final _approvalOps = <String, bool>{};
  static bool get _nativeAudio =>
      !kIsWeb && (Platform.isIOS || Platform.isAndroid);
  Widget _switchSpaceButton() => IconButton(
    tooltip: t('切换 Space', 'Switch Space'),
    onPressed: widget.onSwitchSpace,
    icon: const Icon(CupertinoIcons.arrow_swap, size: 23),
  );
  @override
  void initState() {
    super.initState();
    unawaited(petAvatar.load());
    unawaited(_restoreIdeaLanguage());
    unawaited(_open());
    final audio = widget.audio ?? (_nativeAudio ? ChannelAudio() : null);
    final requestMicrophone =
        widget.requestMicrophone ??
        (audio is ChannelAudio ? audio.requestMicrophone : null);
    final create = widget.createDictation;
    if (create != null) {
      dictation = create(_dictationText)..addListener(_changed);
    } else if (audio != null && requestMicrophone != null) {
      dictation = PhoneDictation(
        audioOwner: widget.audioOwner ?? AudioOwner(),
        audio: audio,
        requestMicrophone: requestMicrophone,
        readConfiguration: _voiceSettings.readForDictation,
        onText: _dictationText,
      )..addListener(_changed);
    }
  }

  void _dictationText(String text) {
    if (_dictationTarget == null || _dictationTarget != _composerTarget) return;
    chat.text = _dictationBase.isEmpty ? text : '$_dictationBase\n$text';
  }

  Future<void> _restoreIdeaLanguage() async {
    final saved = widget.language ?? await spaceSavedLanguage();
    if (mounted) {
      setState(() {
        language = saved;
        _ideaLanguage = saved;
      });
    }
  }

  void _beginDictation() {
    final d = dictation;
    if (d == null || d.busy || sending) return;
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() => _showDictationHint = false);
    _dictationBase = chat.text;
    _dictationTarget = _composerTarget;
    unawaited(d.begin(language));
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
    _settleApprovals();
    if (mounted) setState(() {});
  }

  /// Turns Host answers to this screen's approval decisions into one notice each.
  void _settleApprovals() {
    final state = controller?.state;
    if (state == null || _approvalOps.isEmpty) return;
    for (final entry in _approvalOps.entries.toList()) {
      final op = state.pending
          .where((p) => p['op_id'] == entry.key)
          .firstOrNull;
      if (op == null) {
        if (!state.completedOperations.contains(entry.key)) continue;
        _approvalOps.remove(entry.key);
        message(entry.value ? t('已允许', 'Allowed') : t('已拒绝', 'Denied'));
      } else if (op['status'] == 'rejected' || op['status'] == 'conflict') {
        _approvalOps.remove(entry.key);
        message(_approvalError(op['error'] as String?));
        unawaited(state.discard(entry.key));
      }
    }
  }

  String _approvalError(String? error) => switch (error) {
    'approval_expired' => t(
      '确认已过期，电脑未执行该操作。',
      'This approval expired. The computer did not run the action.',
    ),
    'approval_not_found' => t(
      '该确认已处理或不存在。',
      'This approval was already handled or no longer exists.',
    ),
    'owner_required' || 'owner_unassigned' => t(
      '仅 Space 所有者可以确认电脑上的操作。',
      'Only the Space owner can approve actions on the computer.',
    ),
    _ => t(
      '确认未被电脑接受，请重试。',
      'The computer did not accept the decision. Try again.',
    ),
  };

  Future<void> _resolveApproval(
    Map<String, dynamic> approval,
    bool approved,
  ) async {
    final state = controller?.state;
    if (state == null) return;
    final id = await state.resolveApproval(
      conversationId: approval['conversation_id'] as String,
      approvalId: approval['id'] as String,
      approved: approved,
    );
    _approvalOps[id] = approved;
    if (mounted) setState(() {});
    unawaited(controller!.sync().catchError((Object _) {}));
  }

  String _approvalKind(String? kind) => switch (kind) {
    'file_change' => t('修改文件', 'Change files'),
    'command_execution' => t('运行命令', 'Run a command'),
    'network' => t('访问网络', 'Network access'),
    'permissions' => t('权限请求', 'Permission request'),
    _ => t('电脑上的操作', 'Action on the computer'),
  };

  /// Approval cards for [conversationId], or every pending approval when null.
  List<Widget> _approvals(SpaceClientState state, {String? conversationId}) {
    final now = DateTime.now().millisecondsSinceEpoch;
    return [
      for (final approval in state.pendingApprovals)
        if (conversationId == null ||
            approval['conversation_id'] == conversationId)
          Builder(
            builder: (context) {
              final id = approval['id'];
              final allowed = (approval['allowed_decisions'] as List? ?? [])
                  .cast<Object?>();
              final expires = approval['expires_at'];
              final expired = expires is int && expires <= now;
              final busy = state.pending.any(
                (p) =>
                    p['kind'] == approvalResolveKind &&
                    p['status'] == 'pending' &&
                    (p['input'] as Map)['approval_id'] == id,
              );
              final enabled = !busy && !expired && state.hostOnline;
              return Padding(
                key: ValueKey('space.approval.$id'),
                padding: const EdgeInsets.only(bottom: 12),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Nova.cell,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${t('需要你的确认', 'Approval needed')} · ${_approvalKind(approval['kind'] as String?)}',
                          style: const TextStyle(
                            color: Nova.amber,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          approval['summary'] as String? ?? '',
                          style: const TextStyle(
                            color: Nova.text,
                            fontSize: 15,
                            height: 1.4,
                          ),
                        ),
                        if (expired || !state.hostOnline)
                          Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Text(
                              expired
                                  ? t(
                                      '已过期，电脑不会执行。',
                                      'Expired; the computer will not run it.',
                                    )
                                  : t(
                                      'Host 不在线，暂时无法确认。',
                                      'Host offline; cannot decide now.',
                                    ),
                              style: const TextStyle(
                                color: Nova.secondary,
                                fontSize: 12,
                              ),
                            ),
                          ),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            if (allowed.contains('decline'))
                              TextButton(
                                key: ValueKey('space.approval.$id.decline'),
                                onPressed: enabled
                                    ? () => _resolveApproval(approval, false)
                                    : null,
                                child: Text(t('拒绝', 'Deny')),
                              ),
                            if (allowed.contains('accept'))
                              FilledButton(
                                key: ValueKey('space.approval.$id.accept'),
                                onPressed: enabled
                                    ? () => _resolveApproval(approval, true)
                                    : null,
                                child: Text(t('允许', 'Allow')),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
    ];
  }

  @override
  void dispose() {
    dictation?.removeListener(_changed);
    dictation?.dispose();
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
      message(
        t('此构建尚未配置通知网关', 'This build has no notification gateway configured.'),
      );
      return;
    }
    try {
      await push.enable(
        requestInvitation: () async {
          if (!mounted) return null;
          return showDialog<String>(
            context: context,
            builder: (_) => PushInvitationDialog(language: language),
          );
        },
      );
    } catch (_) {
      message(
        t(
          '通知启用失败，请检查邀请、通知权限或网络后重试',
          'Could not enable notifications. Check the invitation, notification permission or network, then retry.',
        ),
      );
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
      message(
        t(
          '主对话暂时无法发送，请稍后重试。',
          'The main chat cannot send right now. Try again shortly.',
        ),
      );
      return;
    }
    if (pageContext != null) Navigator.of(pageContext).pop();
    setState(() => tab = 0);
    unawaited(send(idea: text));
  }

  Future<void> send({String? idea}) async {
    if (sending || (idea == null && dictation?.busy == true)) return;
    if (idea == null &&
        tab == 1 &&
        _readOnlyTask(
          controller!.state
              .cards('conversations')
              .where((row) => row['id'] == taskConversation)
              .firstOrNull,
        )) {
      message(t('请在电脑上继续处理此任务。', 'Continue this task on the computer.'));
      return;
    }
    final text = idea ?? chat.text;
    if (text.trim().isEmpty) return;
    if (idea == null) _leaveDictation();
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
            ? t(
                '消息过长，请缩短内容后再发送。',
                'The message is too long. Shorten it and send again.',
              )
            : t(
                'Host 不在线或连接中断。请恢复连接以确认发送结果；不会自动重发。',
                'The host is offline or the connection dropped. Reconnect to confirm the result; nothing is resent automatically.',
              ),
      );
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Map<String, String> get _kindNames => {
    'goal': t('目标', 'Goals'),
    'todo': t('待办', 'To-dos'),
    'idea': t('想法', 'Ideas'),
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
      title: card['title'] as String? ?? t('新内容', 'New item'),
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
              tooltip: t('忽略', 'Dismiss'),
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
            header: t('需要处理', 'Needs attention'),
            children: [
              for (final p in problems)
                NovaTile(
                  title: p['status'] == 'conflict'
                      ? t('编辑冲突 · 修改已保留', 'Edit conflict · change kept')
                      : t('修改未能保存', 'Change not saved'),
                  subtitle: Text(
                    '${(p['input'] as Map)['title'] ?? (p['input'] as Map)['about'] ?? {'life.mutate': t('事项修改', 'Item change'), 'settings.patch': t('助手设置', 'Assistant settings')}[p['kind']] ?? t('内容修改', 'Content change')}',
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
                        PopupMenuItem(
                          value: 'retry',
                          child: Text(
                            t('按最新内容重试', 'Retry with latest content'),
                          ),
                        ),
                      PopupMenuItem(
                        value: 'discard',
                        child: Text(t('放弃这次修改', 'Discard this change')),
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
                        ? t(
                            '配对中，等待电脑确认绑定。',
                            'Pairing; waiting for the computer to confirm.',
                          )
                        : t(
                            '已连接，正在同步电脑资料…',
                            'Connected; syncing from the computer…',
                          ),
                    style: const TextStyle(color: Nova.secondary, fontSize: 13),
                  ),
                ),
              ],
            ),
            if (state.waitingForApproval && controller != null) ...[
              const SizedBox(height: 8),
              Text(
                t(
                  '请在电脑核对此手机指纹',
                  'Check this phone’s fingerprint on the computer',
                ),
                style: const TextStyle(color: Nova.secondary, fontSize: 12),
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
                    tooltip: t('复制手机指纹', 'Copy phone fingerprint'),
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
        t('Host 不在线 · 展示上次缓存', 'Host offline · showing last cached data'),
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
          language: language,
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
      language: language,
      sourceTimeline: TimelineBriefs(
        language: language,
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
    if (events.isEmpty) return _empty(t('暂无执行动态', 'No execution activity yet'));
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
      // Bounded and scrollable so many approvals never push the task list
      // or their own buttons off a phone screen.
      if (state.pendingApprovals.isNotEmpty)
        ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * .45,
          ),
          child: ListView(
            key: const ValueKey('space.tasks.approvals'),
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            children: _approvals(state),
          ),
        ),
      if (state.cards('notifications').isNotEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () => _openPersonalPage(
                t('执行动态', 'Execution activity'),
                () => _executionActivity(state),
              ),
              icon: const Icon(CupertinoIcons.bell, size: 17),
              label: Text(t('执行动态', 'Execution activity')),
            ),
          ),
        ),
      Expanded(
        child: ConversationHome(
          changes: state,
          language: language,
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
                  title: Text('${row['title'] ?? t('任务', 'Task')}'),
                  content: Text(
                    '${row['preview'] ?? ''}\n\n${t('请在电脑上继续处理此任务。', 'Continue this task on the computer.')}',
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: Text(t('完成', 'Done')),
                    ),
                  ],
                ),
              );
            } else {
              _leaveDictation();
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
    final canSend = !sending && state.hostOnline && dictation?.busy != true;
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
            children: [
              ..._approvals(
                state,
                conversationId: tab == 1 ? taskConversation : 'chat:main',
              ),
              for (final m in state.messages.where(
                (m) =>
                    (m['conversation_id'] ?? 'chat:main') ==
                    (tab == 1 ? taskConversation : 'chat:main'),
              ))
                SpaceChatMessage(
                  message: m,
                  language: language,
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
                          Expanded(
                            child: Text(
                              t('Host 正在回复…', 'Host is replying…'),
                              style: const TextStyle(
                                color: Nova.secondary,
                                fontSize: 13,
                              ),
                            ),
                          ),
                          IconButton(
                            tooltip: t('停止回复', 'Stop reply'),
                            icon: const Icon(
                              CupertinoIcons.stop_circle,
                              size: 22,
                              color: Nova.secondary,
                            ),
                            onPressed: () async {
                              try {
                                await c.cancelChat(preview['op_id'] as String);
                              } catch (_) {
                                message(
                                  t(
                                    'Host 不在线，无法取消。',
                                    'Host is offline; cannot cancel.',
                                  ),
                                );
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
                    language: language,
                    compact: true,
                    onSend: _sendIdea,
                  )
                : const SizedBox.shrink(),
          ),
        if (dictation != null &&
            (dictation!.busy || dictation!.notice.isNotEmpty))
          Padding(
            key: const ValueKey('space.dictation.status'),
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    dictation!.partial.isNotEmpty
                        ? dictation!.partial
                        : dictation!.notice.isNotEmpty
                        ? switch (dictation!.notice) {
                            'microphone_denied' => t(
                              '请在系统设置中允许麦克风访问',
                              'Allow microphone access in Settings',
                            ),
                            'dictation_settings_required' => t(
                              '请先配置语音识别服务',
                              'Configure a speech recognition service first',
                            ),
                            'dictation_empty' => t(
                              '没有识别到内容，草稿已保留',
                              'No speech recognized. Draft preserved.',
                            ),
                            'audio_in_use' => t(
                              '麦克风正被其他功能使用',
                              'The microphone is in use by another feature',
                            ),
                            _ => t(
                              '暂时无法识别语音，草稿已保留',
                              'Speech recognition unavailable. Draft preserved.',
                            ),
                          }
                        : dictation!.transcribing
                        ? t('正在识别…', 'Transcribing…')
                        : t('松开后转为文字', 'Release to transcribe'),
                    style: const TextStyle(color: Nova.secondary, fontSize: 13),
                  ),
                ),
                if (dictation!.notice == 'dictation_settings_required')
                  TextButton(
                    onPressed: () async {
                      try {
                        await showVoiceSettings(
                          context,
                          _voiceSettings,
                          dictationOnly: true,
                          language: language,
                        );
                      } catch (_) {
                        message(
                          t(
                            '无法读取语音设置，请稍后重试',
                            'Unable to read speech settings. Try again later.',
                          ),
                        );
                      }
                    },
                    child: Text(t('设置', 'Settings')),
                  ),
                if (dictation!.busy)
                  TextButton(
                    onPressed: dictation!.cancel,
                    child: Text(t('取消', 'Cancel')),
                  ),
              ],
            ),
          ),
        if (_showDictationHint && dictation?.busy != true)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 6),
            child: Text(
              t(
                '按住麦克风说话，松开后转成文字',
                'Hold the microphone, then release to transcribe',
              ),
              style: const TextStyle(color: Nova.secondary, fontSize: 13),
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
                        enabled: !sending && dictation?.busy != true,
                        style: const TextStyle(fontSize: 16, color: Nova.text),
                        decoration: InputDecoration(
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          hintText: state.hostOnline
                              ? t('发送给 Host', 'Message Host')
                              : state.waitingForApproval
                              ? t(
                                  '等待电脑确认绑定',
                                  'Waiting for the computer to confirm pairing',
                                )
                              : t(
                                  'Host 离线，聊天不可用',
                                  'Host offline; chat unavailable',
                                ),
                          hintStyle: const TextStyle(color: Nova.tertiary),
                        ),
                        onSubmitted: (_) => send(),
                      ),
                    ),
                    if (dictation != null)
                      Tooltip(
                        message: t('按住说话', 'Hold to speak'),
                        triggerMode: TooltipTriggerMode.manual,
                        child: GestureDetector(
                          key: const ValueKey('space.dictation.mic'),
                          onTap: () =>
                              setState(() => _showDictationHint = true),
                          onLongPressStart: (_) => _beginDictation(),
                          onLongPressEnd: (_) => dictation!.finish(),
                          onLongPressCancel: () => dictation!.cancel(),
                          child: Semantics(
                            button: true,
                            label: t('按住说话', 'Hold to speak'),
                            child: SizedBox(
                              width: 42,
                              height: 48,
                              child: Icon(
                                CupertinoIcons.mic_fill,
                                size: 22,
                                color: dictation!.recording
                                    ? Nova.red
                                    : Nova.secondary,
                              ),
                            ),
                          ),
                        ),
                      ),
                    IconButton.filled(
                      tooltip: t('发送', 'Send'),
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
      title: Text(t('手机工具', 'Phone tools')),
      content: Text(
        t(
          '手机工具由 Host 指定动作，并受系统权限限制。iOS 支持日历读取、提醒事项创建、拍照；Android 支持日历读取、拍照。执行结果不明确时不会自动重试。',
          'The host chooses phone tool actions, limited by system permissions. iOS supports reading calendars, creating reminders and taking photos; Android supports reading calendars and taking photos. Unclear results are never retried automatically.',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(t('知道了', 'Got it')),
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
    if (cards.isEmpty) return _empty(t('暂无资讯', 'No news yet'));
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
    language: language,
    life: c.state.snapshot,
    draft: {
      'about':
          (c.state.snapshot['profile_presentation'] as Map?)?['about'] ?? '',
    },
    onOpen: (page) {
      if (page == 5) {
        _openPersonalPage(t('个人资料', 'Profile'), () => _profileDetails(c.state));
      } else if (page == 1) {
        _openPersonalPage(t('资讯', 'News'), () => _feeds(c.state));
      } else {
        final kind = {2: 'todo', 3: 'idea', 4: 'goal'}[page]!;
        _openPersonalPage(_kindNames[kind]!, () => _workbench(page));
      }
    },
  );

  Future<void> _settings(SpaceClientController c) async {
    final choice = await showSettingsSheet(
      context,
      language: language,
      builder: (context) => ListView(
        padding: const EdgeInsets.fromLTRB(4, 20, 4, 28),
        children: [
          SettingsGroup(
            title: t('对话', 'Conversation'),
            rows: [
              ...conversationSettingsRows(language),
              ('api_keys', t('API 密钥', 'API keys'), CupertinoIcons.lock),
            ],
          ),
          SettingsGroup(
            title: t('更多', 'More'),
            rows: [
              ('connectors', t('连接器', 'Connectors'), CupertinoIcons.link),
              (
                'assistant',
                t('助手设置', 'Assistant settings'),
                CupertinoIcons.person,
              ),
            ],
          ),
        ],
      ),
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'devices':
        await _openPersonalPage(t('设备', 'Devices'), () => _devices(c));
      case 'model_services':
        await _openPersonalPage(
          t('模型服务', 'Model services'),
          () => _modelServices(c),
        );
      case 'api_keys':
        await _openPersonalPage(
          t('API 密钥', 'API keys'),
          () => _hostSection(c, 'credentials'),
        );
      case 'pet_avatar':
        await showPetAvatarSettings(context, petAvatar, language: language);
      case 'assistant':
        await _openPersonalPage(
          t('助手设置', 'Assistant settings'),
          () => _hostSection(c, 'assistant'),
        );
      case 'connectors':
        await Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) => AnimatedBuilder(
              animation: c.state,
              builder: (context, _) {
                final feishu = c.state.snapshot['host_feishu'] as Map? ?? {};
                final connected = feishu['connected'] == true;
                final label = connected
                    ? t('已连接', 'Connected')
                    : feishu['unverified'] == true
                    ? t('暂时无法验证登录', 'Could not verify sign-in')
                    : feishu['login_pending'] == true
                    ? t('等待授权', 'Awaiting authorization')
                    : t('未连接', 'Not connected');
                return ConnectorsPage(
                  language: language,
                  feishuStatus: (
                    label: label,
                    subtitle: connected
                        ? t(
                            '从电脑同步已授权的消息与资料',
                            'Syncs authorized messages and documents from the computer',
                          )
                        : t(
                            '在电脑上完成飞书授权',
                            'Complete Feishu authorization on the computer',
                          ),
                    tone: connected ? NovaTone.success : NovaTone.warning,
                  ),
                  onOpenFeishu: () => _openPersonalPage(
                    t('飞书', 'Feishu'),
                    () => _hostSection(c, 'feishu'),
                  ),
                  systemTitle: t('手机采集与授权', 'Phone input & permissions'),
                  systemSubtitle: t(
                    '手动提交内容，管理上传与处理授权。',
                    'Submit content manually and manage upload and processing permissions.',
                  ),
                  onOpenSystem: () => _openPersonalPage(
                    t('手机采集与授权', 'Phone input & permissions'),
                    () => SingleChildScrollView(
                      child: SpaceSourcePanel(
                        state: c.state,
                        onSync: c.sync,
                        language: language,
                      ),
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
      ? _empty(
          t(
            '仅 Space 所有者可以修改电脑上的设置',
            'Only the Space owner can change settings on the computer',
          ),
        )
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
      return _empty(
        t(
          '暂时无法读取电脑上的模型设置，请连接 Host 后刷新',
          'Cannot read the computer’s model settings. Connect to the host and refresh.',
        ),
      );
    }
    final routes = models['routes'] as Map? ?? {};
    final providers = {
      for (final provider
          in (models['providers'] as List? ?? []).whereType<Map>())
        provider['id']: provider['label'] ?? provider['id'],
    };
    final labels = {
      'conversationText': t('对话模型', 'Conversation model'),
      'support': t('后台分析模型', 'Background analysis model'),
      'fast': t('快速响应模型', 'Fast response model'),
      'compressor': t('上下文压缩模型', 'Context compression model'),
      'watch': t('视觉模型', 'Vision model'),
      'embedding': t('向量模型', 'Embedding model'),
    };
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        SettingsGroup(
          title: t('模型选择', 'Model selection'),
          rows: [
            for (final lane in labels.keys)
              (lane, labels[lane]!, CupertinoIcons.sparkles),
          ],
          subtitles: {
            for (final lane in labels.keys)
              lane: routes[lane] is Map
                  ? "${providers[routes[lane]['provider']] ?? routes[lane]['provider']} · ${routes[lane]['model']}"
                  : t('使用电脑默认模型', 'Uses the computer default'),
          },
          onSelected: (lane) => showModelSettingsEditor(
            context,
            RemoteModelSettingsBackend(c.state, onSync: c.sync, lane: lane),
            title: labels[lane],
            language: language,
            description: t(
              '修改将加密发送到电脑，重启电脑上的助手后生效。',
              'Changes are sent encrypted to the computer and apply after its assistant restarts.',
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 6),
          child: Text(
            models['locked'] == true
                ? t(
                    '模型由电脑的启动配置管理，请在电脑上修改。',
                    'Models are managed by the computer’s startup configuration. Change them on the computer.',
                  )
                : t(
                    '模型选择将加密发送到电脑。请在设置中的 API 密钥管理服务密钥。',
                    'Model choices are sent encrypted to the computer. Manage service keys under API keys in Settings.',
                  ),
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
          footer: t(
            'Host 损坏会丢失此 Space；不提供备份恢复。',
            'If the host is lost, this Space is lost; there is no backup recovery.',
          ),
          children: [
            NovaTile(
              title: widget.space.name,
              subtitle: Text(
                state.waitingForApproval
                    ? t(
                        '等待电脑确认绑定',
                        'Waiting for the computer to confirm pairing',
                      )
                    : state.hostOnline
                    ? t('Host 在线', 'Host online')
                    : t('Host 不在线', 'Host offline'),
              ),
              leading: const NovaIconTile(CupertinoIcons.desktopcomputer),
            ),
            NovaTile(
              title: t('切换或新建 Space', 'Switch or create a Space'),
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
          header: t('Host 连接', 'Host connection'),
          footer: t(
            '请在 Host 上核对指纹并批准连接。通信内容端到端加密；通知网关可见设备令牌、时间与密文大小。',
            'Check the fingerprint and approve the connection on the host. Messages are end-to-end encrypted; the notification gateway can see the device token, timing and ciphertext size.',
          ),
          children: [
            NovaTile(
              title: t('中继地址', 'Relay address'),
              subtitle: Text(widget.space.relay ?? '', maxLines: 1),
            ),
            NovaTile(
              title: t('此设备指纹', 'This device’s fingerprint'),
              // SelectableText would reserve the tile's full three-line height.
              subtitle: SelectionArea(
                child: Text(
                  c.fingerprint,
                  style: const TextStyle(fontSize: 12, color: Nova.secondary),
                ),
              ),
            ),
            NovaTile(
              title: t('启用锁屏通知', 'Enable lock-screen notifications'),
              subtitle: Text(c.push?.status ?? t('推送未就绪', 'Push not ready')),
              onTap: enablePushNotifications,
            ),
            NovaTile(
              title: t('关闭锁屏通知', 'Disable lock-screen notifications'),
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
              title: t('手机工具', 'Phone tools'),
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
              : Text(
                  t(
                    '无法打开 Client：$startupError',
                    'Could not open client: $startupError',
                  ),
                ),
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
                tooltip: t('返回任务', 'Back to tasks'),
                icon: const Icon(CupertinoIcons.back),
                onPressed: () {
                  _leaveDictation();
                  setState(() => taskOpen = false);
                },
              )
            : tab == 3
            ? null
            : IconButton(
                tooltip: t('刷新', 'Refresh'),
                onPressed: () => c.sync(),
                icon: const Icon(CupertinoIcons.arrow_clockwise, size: 23),
              ),
        automaticallyImplyLeading: false,
        centerTitle: true,
        title: tab == 0
            ? PetAvatarTitle(
                store: petAvatar,
                title: 'NovaCore',
                language: language,
              )
            : Text(
                [
                  'NovaCore',
                  t('任务', 'Tasks'),
                  t('时间线', 'Timeline'),
                  t('我的', 'Me'),
                ][tab],
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -.5,
                ),
              ),
        actions: [
          IconButton(
            tooltip: t('设置', 'Settings'),
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
                    language: language,
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
                if (v != tab) _leaveDictation();
                setState(() => tab = v);
              },
              items: [
                (
                  CupertinoIcons.chat_bubble,
                  CupertinoIcons.chat_bubble_fill,
                  'Nova',
                  0,
                ),
                (
                  CupertinoIcons.square_stack,
                  CupertinoIcons.square_stack_fill,
                  t('任务', 'Tasks'),
                  0,
                ),
                (
                  CupertinoIcons.clock,
                  CupertinoIcons.clock_fill,
                  t('时间线', 'Timeline'),
                  0,
                ),
                (
                  CupertinoIcons.person,
                  CupertinoIcons.person_fill,
                  t('我的', 'Me'),
                  0,
                ),
              ],
            ),
    );
  }

  String _connectionText(String error) {
    if (error.contains('incompatible_business_version') ||
        error.contains('unsupported_display_version')) {
      return t(
        'Host 与此设备的协议版本不兼容，请更新应用后重试。',
        'The host and this device use incompatible protocol versions. Update the app and retry.',
      );
    }
    if (error.contains('unknown_device') || error.contains('inactive')) {
      return t(
        '等待 Host 确认配对。请在连接页核对此设备指纹。',
        'Waiting for the host to confirm pairing. Check this device’s fingerprint on the connection page.',
      );
    }
    if (error.contains('waiting_for_host_key') ||
        error.contains('missing_content_key')) {
      return t(
        '等待 Host 发送空间密钥。',
        'Waiting for the host to send the Space key.',
      );
    }
    if (error.contains('needs_repair')) {
      return t(
        '此设备需要重新配对。请在电脑上打开配对码并重新扫描。',
        'This device needs to pair again. Open the pairing code on the computer and scan it again.',
      );
    }
    if (error.contains('revoked')) {
      return t(
        '此设备已被撤销。请创建新 Space 后重新配对。',
        'This device was revoked. Create a new Space and pair again.',
      );
    }
    return t('网络不稳定，正在重试。', 'The network is unstable; retrying.');
  }
}

class StandaloneSpaceBar extends StatelessWidget {
  const StandaloneSpaceBar({
    super.key,
    required this.space,
    required this.onSwitch,
    this.onSettings,
    this.settingsLabel,
    this.language = 'zh',
  });
  final SpaceRecord space;
  final VoidCallback onSwitch;
  final VoidCallback? onSettings;
  final String? settingsLabel;
  final String language;
  String t(String zh, String en) => language == 'zh' ? zh : en;
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
                      TextSpan(
                        text: t('独立运行', 'On this device'),
                        style: const TextStyle(
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
                  tooltip: settingsLabel ?? t('设置', 'Settings'),
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
