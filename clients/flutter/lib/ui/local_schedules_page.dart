import 'package:flutter/material.dart';
import '../agent_core/scheduled_agent_runner.dart';
import 'scheduled_tasks_page.dart' show scheduleRuleText;

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
    var kind = 'daily', life = false, web = false;
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
                    labelText: 'IANA 时区，例如 Asia/Shanghai',
                  ),
                ),
                SwitchListTile(
                  title: const Text('允许读取本机事项'),
                  value: life,
                  onChanged: (v) => setLocal(() => life = v),
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
          'context': {'life': life, 'web': web},
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

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.runner,
    builder: (context, _) => Scaffold(
      appBar: AppBar(
        title: const Text('手机定时任务'),
        actions: [
          IconButton(
            onPressed: busy ? null : () => _run(_create),
            icon: const Icon(Icons.add),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('本机规则保持本机负责人；绑定电脑不会迁走任务。完成记录表示 Agent 已返回结果，实际效果仍需核对。'),
          if (widget.runner.pendingApproval != null)
            Card(
              child: Column(
                children: [
                  Text('等待确认：${widget.runner.pendingApproval!.tool}'),
                  SelectableText(
                    widget.runner.pendingApproval!.arguments.toString(),
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
          for (final item in widget.runner.repository.items)
            SwitchListTile(
              title: Text(item['title']),
              subtitle: Text(
                '${scheduleRuleText(Map<String, dynamic>.from(item['rule']), 'zh-CN')}\n错过 ${item['missed_count']} 次 · 夏令时跳过 ${item['dst_gap_count']} 次',
              ),
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
          const Divider(),
          for (final run in widget.runner.repository.runs.reversed)
            ListTile(
              title: Text(run['definition']['title']),
              onTap: () => _run(() => _result(run)),
              subtitle: Text(
                '${run['slot']['scheduled_at']} · ${switch (run['status']) {
                  'completed' => '已返回结果，待核对',
                  'claimed' => '等待执行',
                  'running' => '执行中',
                  'waiting_approval' => '等待你确认',
                  'outcome_unknown' => '结果不明，请核对，未自动重试',
                  'cancelled' => '已取消',
                  'failed' => '未完成',
                  _ => '已绑定任务',
                }}',
              ),
              trailing: ['completed', 'cancelled'].contains(run['status'])
                  ? null
                  : TextButton(
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
            ),
          if (error != null) Text(error!),
          if (widget.runner.wakeError != null) Text(widget.runner.wakeError!),
          if (busy) const LinearProgressIndicator(),
        ],
      ),
    ),
  );
}
