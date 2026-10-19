import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent_core/scheduled_agent_runner.dart';
import 'components.dart';
import 'scheduled_tasks_page.dart' show scheduleRuleText;
import 'theme.dart';

class LocalSchedulesPage extends StatefulWidget {
  const LocalSchedulesPage({super.key, required this.runner});
  final ScheduledAgentRunner runner;
  @override
  State<LocalSchedulesPage> createState() => _LocalSchedulesPageState();
}

class _LocalSchedulesPageState extends State<LocalSchedulesPage> {
  String? error;
  bool busy = false;
  Future<void> _result(Map<String, dynamic> run) async {
    final text = await widget.runner.result(run['run_id']);
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(run['definition']['title']),
        content: SingleChildScrollView(
          child: SelectableText(
            '${run['status']}\n${run['reason'] ?? ''}\n\n$text',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  Future<void> _run(Future<void> Function() action) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await action();
      if (mounted) setState(() => error = null);
    } catch (_) {
      if (mounted) setState(() => error = '操作未完成，请检查模型配置、时间和当前任务状态。');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _create() async {
    final title = TextEditingController(),
        goal = TextEditingController(),
        zone = TextEditingController(text: 'UTC'),
        time = TextEditingController(text: '09:00'),
        date = TextEditingController(
          text: DateTime.now().toIso8601String().substring(0, 10),
        );
    var kind = 'daily', life = false, web = false, workspace = false;
    final weekdays = <int>{1};
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          title: const Text('手机定时任务'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  '由这台手机负责。前台到时执行；后台由系统择机唤醒。错过超过 2 小时会记录为错过。写入或访问新网站仍需你确认。',
                ),
                TextField(
                  controller: title,
                  decoration: const InputDecoration(labelText: '名称'),
                ),
                TextField(
                  controller: goal,
                  maxLines: 3,
                  decoration: const InputDecoration(labelText: '具体要做什么'),
                ),
                DropdownButton<String>(
                  value: kind,
                  items: const [
                    DropdownMenuItem(value: 'once', child: Text('一次')),
                    DropdownMenuItem(value: 'daily', child: Text('每天')),
                    DropdownMenuItem(value: 'weekly', child: Text('每周')),
                  ],
                  onChanged: (v) => setLocal(() => kind = v!),
                ),
                if (kind == 'once')
                  TextField(
                    controller: date,
                    decoration: const InputDecoration(
                      labelText: '日期 YYYY-MM-DD',
                    ),
                  ),
                if (kind == 'weekly')
                  Wrap(
                    children: [
                      for (var n = 1; n <= 7; n++)
                        FilterChip(
                          label: Text('周$n'),
                          selected: weekdays.contains(n),
                          onSelected: (v) => setLocal(() {
                            v ? weekdays.add(n) : weekdays.remove(n);
                          }),
                        ),
                    ],
                  ),
                TextField(
                  controller: time,
                  decoration: const InputDecoration(labelText: '时间 HH:mm'),
                ),
                TextField(
                  controller: zone,
                  decoration: const InputDecoration(
                    labelText: '时区，例如 Asia/Shanghai',
                  ),
                ),
                SwitchListTile(
                  title: const Text('允许读取本机事项'),
                  value: life,
                  onChanged: (v) => setLocal(() => life = v),
                ),
                SwitchListTile(
                  title: const Text('允许读写工作区和运行命令'),
                  subtitle: const Text('可安装软件包、访问网络并修改工作区文件'),
                  value: workspace,
                  onChanged: (v) => setLocal(() => workspace = v),
                ),
                SwitchListTile(
                  title: const Text('允许申请网页访问'),
                  value: web,
                  onChanged: (v) => setLocal(() => web = v),
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
              child: const Text('授权并创建'),
            ),
          ],
        ),
      ),
    );
    try {
      if (accepted == true) {
        final model = await widget.runner.models.read();
        if (model == null) throw StateError('model_required');
        await widget.runner.repository.create({
          'title': title.text.trim(),
          'goal': goal.text.trim(),
          'acceptance': '说明完成的内容、依据和未完成部分，等待用户核对。',
          'provider': '${model.endpoint}|${model.model}',
          'context': {'life': life, 'web': web, 'workspace': workspace},
          'rule': {
            'kind': kind,
            'timezone': zone.text.trim(),
            'time': time.text.trim(),
            if (kind == 'once') 'date': date.text.trim(),
            if (kind == 'weekly') 'weekdays': weekdays.toList()..sort(),
          },
        });
      }
    } finally {
      title.dispose();
      goal.dispose();
      zone.dispose();
      time.dispose();
      date.dispose();
    }
  }

  String _runStatus(Object? status) => switch (status) {
    'completed' => '已返回结果，待核对',
    'claimed' => '等待执行',
    'running' => '执行中',
    'waiting_approval' => '等待你确认',
    'outcome_unknown' => '结果不明，请核对，未自动重试',
    'cancelled' => '已取消',
    'failed' => '未完成',
    _ => '已绑定任务',
  };

  NovaTone _runTone(Object? status) => switch (status) {
    'completed' => NovaTone.success,
    'running' || 'claimed' => NovaTone.active,
    'waiting_approval' || 'outcome_unknown' => NovaTone.warning,
    'failed' => NovaTone.danger,
    _ => NovaTone.neutral,
  };

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.runner,
    builder: (context, _) {
      final items = widget.runner.repository.items;
      final runs = widget.runner.repository.runs.reversed.toList();
      final approval = widget.runner.pendingApproval;
      return NovaPage(
        title: '手机定时任务',
        actions: [
          IconButton(
            tooltip: '新建定时任务',
            onPressed: busy ? null : () => _run(_create),
            icon: const Icon(CupertinoIcons.add),
          ),
        ],
        body: ListView(
          padding: const EdgeInsets.only(top: 8, bottom: 32),
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 12),
              child: Text(
                '任务由这台手机负责执行。完成记录表示 Agent 已返回结果，实际效果仍需你核对。',
                style: TextStyle(
                  color: Nova.secondary,
                  fontSize: 13,
                  height: 1.5,
                ),
              ),
            ),
            if (approval != null)
              NovaCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const NovaStatusChip('等待确认', tone: NovaTone.warning),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            approval.tool,
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    SelectableText(
                      approval.arguments.toString(),
                      style: const TextStyle(
                        color: Nova.secondary,
                        fontSize: 13,
                      ),
                    ),
                    Wrap(
                      children: [
                        TextButton(
                          onPressed: () => widget.runner.approve(false),
                          child: const Text('拒绝'),
                        ),
                        FilledButton(
                          onPressed: () => widget.runner.approve(true),
                          child: const Text('允许这一步'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            if (items.isEmpty)
              const EmptyNote(
                '还没有定时任务。点右上角的 + 新建一个。',
                icon: CupertinoIcons.clock,
              )
            else
              NovaSection(
                header: '规则',
                surface: Nova.sheetCell,
                children: [
                  for (final item in items)
                    NovaSwitchRow(
                      title: item['title'],
                      subtitle: [
                        scheduleRuleText(
                          Map<String, dynamic>.from(item['rule']),
                          'zh-CN',
                        ),
                        if ((item['missed_count'] ?? 0) > 0)
                          '错过 ${item['missed_count']} 次',
                      ].join(' · '),
                      value: item['enabled'] == true,
                      onChanged: busy
                          ? null
                          : (v) => _run(
                              () => widget.runner.repository.setEnabled(
                                item['id'],
                                item['revision'],
                                v,
                              ),
                            ),
                    ),
                ],
              ),
            if (runs.isNotEmpty)
              NovaSection(
                header: '运行记录',
                surface: Nova.sheetCell,
                children: [
                  for (final run in runs)
                    NovaTile(
                      surface: Nova.sheetCell,
                      title: run['definition']['title'],
                      subtitle: Text(
                        relativeTime('${run['slot']['scheduled_at']}', 'zh'),
                      ),
                      onTap: () => _run(() => _result(run)),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          NovaStatusChip(
                            _runStatus(run['status']),
                            tone: _runTone(run['status']),
                          ),
                          if (![
                            'completed',
                            'cancelled',
                          ].contains(run['status']))
                            TextButton(
                              onPressed: busy
                                  ? null
                                  : () => _run(
                                      () => widget.runner.cancel(
                                        run['run_id'],
                                        run['control_revision'],
                                      ),
                                    ),
                              child: const Text('取消'),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            if (error != null) NovaNotice(error!),
            if (widget.runner.wakeError != null)
              NovaNotice(widget.runner.wakeError!, tone: NovaTone.warning),
            if (busy)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16),
                child: LinearProgressIndicator(),
              ),
          ],
        ),
      );
    },
  );
}
