import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'local_dialog.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import '../personal/local_life.dart';
import '../personal/personal_store.dart';
import '../personal/hub_transport.dart';
import '../personal/life_sync_scheduler.dart';
import 'workbench_page.dart';
import 'local_tasks.dart';
import '../agent/life_tool_bridge.dart';
import '../agent/hub_tasks.dart';
import '../agent/local_agent.dart';

/// An explicit local dataset: opening this view never imports host snapshots.
class LocalWorkspace extends StatefulWidget {
  const LocalWorkspace({super.key, this.repository});
  final LocalLife? repository;
  @override
  State<LocalWorkspace> createState() => _LocalWorkspaceState();
}

class _LocalWorkspaceState extends State<LocalWorkspace>
    with WidgetsBindingObserver {
  LocalLife? repo;
  PersonalStore? store;
  int tab = 0;
  bool busy = false;
  String? error;
  LifeSyncScheduler? scheduler;
  String? lastPromptedConflict;
  bool choosing = false;
  LifeToolBridge? lifeTools;
  final secrets = const FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
  );
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_open());
  }

  Future<void> _open() async {
    try {
      final local =
          widget.repository ??
          LocalLife(
            FileLifePersistence(
              File(
                '${(await getApplicationSupportDirectory()).path}/local-life-v1.json',
              ),
            ),
          );
      if (!local.ready) await local.open();
      if (!mounted) {
        if (widget.repository == null) local.dispose();
        return;
      }
      repo = local;
      if (Platform.isIOS) lifeTools = LifeToolBridge(local)..attach();
      store = PersonalStore(send: (_) => false, local: local);
      local.addListener(_changed);
      if (widget.repository == null) {
        scheduler = LifeSyncScheduler(
          sync: () => _sync(automatic: true),
          onError: (_) {},
        );
        scheduler!.setForeground(
          WidgetsBinding.instance.lifecycleState == null ||
              WidgetsBinding.instance.lifecycleState ==
                  AppLifecycleState.resumed,
        );
      }
      setState(() {});
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  void _changed() {
    if (mounted) setState(() {});
    if (repo?.pendingCount != 0 && repo?.conflict == null) scheduler?.changed();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    scheduler?.setForeground(state == AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    lifeTools?.detach();
    scheduler?.dispose();
    WidgetsBinding.instance.removeObserver(this);
    repo?.removeListener(_changed);
    store?.dispose();
    if (widget.repository == null) repo?.dispose();
    super.dispose();
  }

  Future<void> _sync({bool automatic = false}) async {
    if (busy || repo == null) return;
    setState(() => busy = true);
    try {
      var endpoint = await secrets.read(key: 'nova.local.hub.url');
      var token = await secrets.read(key: 'nova.local.hub.token');
      if (endpoint == null || token == null) {
        if (automatic) return;
        await _settings();
        endpoint = await secrets.read(key: 'nova.local.hub.url');
        token = await secrets.read(key: 'nova.local.hub.token');
      }
      if (endpoint == null || token == null) return;
      await repo!.sync(HttpLifeSync(endpoint, token));
      if (mounted) setState(() => error = null);
      if (mounted &&
          repo!.conflict != null &&
          !choosing &&
          (!automatic || lastPromptedConflict != repo!.conflictToken)) {
        await _choose();
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
      if (automatic) rethrow;
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _settings() async {
    final url = TextEditingController(
      text: await secrets.read(key: 'nova.local.hub.url') ?? '',
    );
    final token = TextEditingController();
    if (!mounted) {
      url.dispose();
      token.dispose();
      return;
    }
    final accepted = await showLocalDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('连接同步 Hub'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                '同步本机的 Todo、Idea、Goal 及其关联。现有电脑资料不会自动导入；模型密钥和执行权限不会同步。',
              ),
              if (repo?.accountId != null)
                Text('当前数据属于 ${repo!.accountId}，不能切换为其他账号。'),
              TextField(
                controller: url,
                decoration: const InputDecoration(labelText: 'Hub HTTPS 地址'),
                autocorrect: false,
              ),
              TextField(
                controller: token,
                obscureText: true,
                decoration: const InputDecoration(labelText: '设备令牌'),
                autocorrect: false,
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
            child: const Text('允许同步这些资料'),
          ),
        ],
      ),
    );
    try {
      if (accepted == true) {
        final transport = HttpLifeSync(url.text.trim(), token.text.trim());
        final snapshot = await transport.snapshot();
        repo?.validateSnapshot(snapshot);
        if (repo?.accountId != null &&
            snapshot['account_id'] != repo!.accountId) {
          throw StateError('账号不匹配，请使用当前账号的设备令牌。');
        }
        await secrets.write(key: 'nova.local.hub.url', value: url.text.trim());
        await secrets.write(
          key: 'nova.local.hub.token',
          value: token.text.trim(),
        );
      }
    } finally {
      url.dispose();
      token.dispose();
    }
  }

  Future<void> _choose() async {
    if (choosing) return;
    final conflict = repo?.conflict;
    if (conflict == null) return;
    final expectedConflict = repo!.conflictToken!;
    choosing = true;
    lastPromptedConflict = expectedConflict;
    final local = conflict['local'] as Map?,
        synced = conflict['synced'] as Map?;
    final missingGoal = conflict['code'] == 'goal_not_found';
    const fields = {
      'title': '标题',
      'note': '备注',
      'status': '状态',
      'due': '日期',
      'importance': '重要程度',
      'goal_id': '关联目标',
      'success_criteria': '完成标准',
      'about': '个人描述',
    };
    final choice = await showLocalDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('这条记录在另一端有修改'),
        content: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('请选择要采用的版本。未选择的修改会被丢弃。'),
              if (missingGoal)
                const Text('关联目标已不可用。采用本机内容会解除目标关联；尚未同步的新记录会保存为独立记录。'),
              if (synced == null && !missingGoal)
                const Text('已同步版本中，这条记录已不存在。恢复需要重新创建。'),
              for (final field in fields.entries)
                if (local?[field.key] != synced?[field.key])
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: SelectableText(
                      '${field.value}\n本机：${local?[field.key] ?? "—"}\n已同步：${synced?[field.key] ?? "—"}',
                    ),
                  ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('稍后选择'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('采用已同步版本'),
          ),
          FilledButton(
            onPressed:
                local != null &&
                    ((synced != null &&
                            [
                              'update',
                              'profile',
                            ].contains(conflict['input']['op'])) ||
                        (missingGoal && conflict['input']['op'] == 'create'))
                ? () => Navigator.pop(context, true)
                : null,
            child: Text(missingGoal ? '采用本机内容并解除关联' : '采用本机版本'),
          ),
        ],
      ),
    );
    choosing = false;
    if (choice == null) return;
    // The dialog captured a version. A concurrent refresh must not change what
    // "use local" means while the user is deciding.
    try {
      await repo!.resolveConflict(
        useLocal: choice,
        expectedConflict: expectedConflict,
        unlinkGoal: choice && missingGoal,
      );
    } on StateError catch (error) {
      if (error.message != 'conflict_changed') rethrow;
      if (mounted) await _choose();
    }
  }

  Future<void> _openTasks() async {
    HubTasks? hub;
    try {
      final url = await secrets.read(key: 'nova.local.hub.url');
      final token = await secrets.read(key: 'nova.local.hub.token');
      if (url != null && token != null && repo != null) {
        final transport = HttpLifeSync(url, token);
        final snapshot = await transport.snapshot();
        repo!.validateSnapshot(snapshot);
        final candidate = HubTasks(
          request: transport.request,
          persistence: FileLifePersistence(
            File(
              '${(await getApplicationSupportDirectory()).path}/task-delivery-v1.json',
            ),
          ),
          agent: const NativeLocalAgent(),
          hubId: snapshot['hub_id'],
          accountId: snapshot['account_id'],
        );
        await candidate.open();
        hub = candidate;
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Hub 暂不可用，本机任务仍可使用：$e')));
      }
    }
    if (!mounted) return;
    await Navigator.push(
      context,
      MaterialPageRoute<void>(
        builder: (_) => LocalTasksPage(hub: hub, life: repo),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('本机空间'),
      actions: [
        IconButton(
          tooltip: '本机任务',
          onPressed: _openTasks,
          icon: const Icon(Icons.play_circle_outline),
        ),
        IconButton(
          tooltip: '同步设置',
          onPressed: busy
              ? null
              : () => _settings().catchError((Object e) {
                  if (mounted) setState(() => error = e.toString());
                }),
          icon: const Icon(Icons.settings_outlined),
        ),
        IconButton(
          tooltip: '同步',
          onPressed: busy ? null : _sync,
          icon: const Icon(Icons.sync),
        ),
      ],
    ),
    body: Column(
      children: [
        if (repo != null)
          ListTile(
            dense: true,
            title: Text(
              '${repo!.pendingCount} 项待同步 · ${repo!.accountId ?? "仅本机"}',
            ),
            subtitle: const Text('个人资料可离线编辑。执行任务需要另行委托。'),
          ),
        if (busy) const LinearProgressIndicator(),
        if (error != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: SelectableText(
              error!,
              style: const TextStyle(color: Colors.red),
            ),
          ),
        if (repo?.conflict != null)
          ListTile(
            title: const Text('有修改需要选择版本'),
            trailing: const Icon(Icons.chevron_right),
            onTap: busy
                ? null
                : () => _choose().catchError((Object e) {
                    if (mounted) setState(() => error = e.toString());
                  }),
          ),
        Expanded(
          child: store == null
              ? const Center(child: CircularProgressIndicator())
              : WorkbenchPage(
                  store: store!,
                  page: tab + 2,
                  onSettings: _settings,
                ),
        ),
      ],
    ),
    bottomNavigationBar: NavigationBar(
      selectedIndex: tab,
      onDestinationSelected: (value) => setState(() => tab = value),
      destinations: const [
        NavigationDestination(
          icon: Icon(Icons.check_box_outlined),
          label: 'Todos',
        ),
        NavigationDestination(
          icon: Icon(Icons.lightbulb_outline),
          label: 'Ideas',
        ),
        NavigationDestination(icon: Icon(Icons.flag_outlined), label: 'Goals'),
      ],
    ),
  );
}
