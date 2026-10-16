import 'package:flutter/material.dart';
import '../personal/life_host.dart';
import '../personal/local_life.dart';
import '../agent/hub_tasks.dart';
import 'local_dialog.dart';
import 'local_tasks.dart';

/// Controls for the application-owned dataset; never opens a second repository.
class LifeControls extends StatefulWidget {
  const LifeControls({super.key, required this.host});
  final LifeHost host;
  @override
  State<LifeControls> createState() => _LifeControlsState();
}

class _LifeControlsState extends State<LifeControls> {
  LocalLife? get repo => widget.host.repo;
  bool choosing = false;
  String? lastPromptedConflict;
  String? error;

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
      if (mounted) setState(() => error = null);
    } catch (e) {
      if (mounted) setState(() => error = widget.host.error ?? '操作失败，请检查事项状态。');
    }
  }

  Future<void> _settings() async {
    final url = TextEditingController(
      text: await widget.host.readHubUrl() ?? '',
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
        await widget.host.configureHub(
          url: url.text.trim(),
          token: token.text.trim(),
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
      hub = await widget.host.getTasks();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Hub 暂不可用，本机任务仍可使用。')));
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
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.host,
    builder: (context, _) => Column(
      children: [
        Row(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  repo == null
                      ? '正在打开本机事项'
                      : '${repo!.pendingCount} 项待同步 · ${repo!.accountId ?? "仅本机"}',
                ),
              ),
            ),
            IconButton(
              tooltip: '本机任务',
              onPressed: repo == null ? null : () => _run(_openTasks),
              icon: const Icon(Icons.play_circle_outline),
            ),
            IconButton(
              tooltip: '同步设置',
              onPressed: widget.host.busy || repo == null
                  ? null
                  : () => _run(_settings),
              icon: const Icon(Icons.settings_outlined),
            ),
            IconButton(
              tooltip: '同步',
              onPressed: widget.host.busy || repo == null
                  ? null
                  : () => _run(() async {
                      if (!widget.host.hubConfigured) await _settings();
                      await widget.host.sync();
                    }),
              icon: const Icon(Icons.sync),
            ),
          ],
        ),
        if (widget.host.lastSync != null)
          Text('最近同步：${widget.host.lastSync!.toLocal()}'),
        if (widget.host.busy) const LinearProgressIndicator(),
        if (error != null || widget.host.error != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: SelectableText(
              error ?? widget.host.error!,
              style: const TextStyle(color: Colors.red),
            ),
          ),
        if (repo?.conflict != null)
          ListTile(
            title: const Text('有修改需要选择版本'),
            trailing: const Icon(Icons.chevron_right),
            onTap: widget.host.busy ? null : () => _run(_choose),
          ),
      ],
    ),
  );
}
