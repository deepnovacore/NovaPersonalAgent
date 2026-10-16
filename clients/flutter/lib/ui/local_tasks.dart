import 'dart:async';
import 'package:flutter/material.dart';
import 'local_dialog.dart';
import 'local_task_request.dart';
import '../agent/local_agent.dart';
import '../agent/hub_tasks.dart';
import '../agent/task_todo_completion.dart';
import '../personal/local_life.dart';

class LocalTasksPage extends StatefulWidget {
  const LocalTasksPage({
    super.key,
    this.agent = const NativeLocalAgent(),
    this.hub,
    this.life,
  });
  final LocalAgent agent;
  final HubTasks? hub;
  final LocalLife? life;
  @override
  State<LocalTasksPage> createState() => _LocalTasksPageState();
}

class _LocalTasksPageState extends State<LocalTasksPage>
    with WidgetsBindingObserver {
  List<dynamic> tasks = [];
  Map<String, dynamic> capabilities = {};
  String? error;
  Timer? timer;
  bool refreshing = false, foreground = true;
  List<dynamic> offers = [], remoteTasks = [];
  DateTime? lastHubPoll;
  final Map<String, String> todoErrors = {};
  final Set<String> completedTodos = {};
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_refresh());
    timer = Timer.periodic(const Duration(seconds: 2), (_) {
      if (foreground) unawaited(_refresh());
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    if (foreground) unawaited(_refresh());
  }

  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _refresh() async {
    if (refreshing) return;
    refreshing = true;
    try {
      final caps = await widget.agent.call('capabilities') as Map;
      final rows = await widget.agent.call('tasks') as List;
      for (final task in rows) {
        if (widget.life == null ||
            task['phase'] != 'completed' ||
            task['todo_ref'] == null ||
            completedTodos.contains(task['id']) ||
            todoErrors.containsKey(task['id'])) {
          continue;
        }
        try {
          await completeTaskTodo(widget.life!, task as Map);
          completedTodos.add(task['id']);
        } catch (_) {
          todoErrors[task['id']] = '任务已完成，但关联待办已修改或正在解决同步冲突。请在待办页核对，未覆盖新版本。';
        }
      }
      if (widget.hub != null &&
          (lastHubPoll == null ||
              DateTime.now().difference(lastHubPoll!).inSeconds >= 10)) {
        lastHubPoll = DateTime.now();
        try {
          await widget.hub!.poll();
          offers = await widget.hub!.offers();
          remoteTasks = await widget.hub!.projections();
        } catch (_) {
          if (mounted) setState(() => error = '暂时无法连接 Hub；本机任务仍可查看和停止。');
        }
      }
      if (mounted) {
        setState(() {
          capabilities = Map<String, dynamic>.from(caps);
          // Native Android overlays own approval. Keep our own target screen
          // stable so displaying a proposal cannot invalidate its observation.
          tasks = rows.map((row) {
            if (caps['platform'] == 'android' &&
                caps['host_package'] != null &&
                row['target_package'] == caps['host_package'] &&
                row['phase'] == 'waiting_approval') {
              return Map<String, dynamic>.from(row as Map)
                ..['phase'] = 'running'
                ..remove('proposal');
            }
            return row;
          }).toList();
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      refreshing = false;
    }
  }

  Future<void> _command(String method, Map<String, dynamic> args) async {
    try {
      final result = await widget.agent.call(method, args);
      if (method == 'approve' && result?['accepted'] != true) {
        throw StateError('这项审批已失效，请查看最新任务状态。');
      }
      if (mounted) setState(() => error = null);
      await _refresh();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _hubAction(Future<void> Function() action) async {
    try {
      await action();
      lastHubPoll = null;
      if (mounted) setState(() => error = null);
      await _refresh();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _acceptOffer(Map<String, dynamic> command) async {
    final settings = await widget.agent.call('modelSettings') as Map;
    if (!mounted) return;
    final accepted = await showLocalDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('在这台手机执行'),
        content: Text(
          '${command['goal']}\n\n完成标准：${command['acceptance']}\n操作范围：${command['target']}\n\n允许将本次目标及所选范围的数据${capabilities['platform'] == 'android' ? '、界面截图' : ''}发送给 ${Uri.tryParse(settings['endpoint'] as String? ?? '')?.host ?? '模型服务'}（${settings['model']}）？每一步修改仍需你批准。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('拒绝任务'),
          ),
          FilledButton(
            onPressed: settings['configured'] == true
                ? () => Navigator.pop(context, true)
                : null,
            child: const Text('允许并开始'),
          ),
        ],
      ),
    );
    if (accepted != null) {
      await _hubAction(() => widget.hub!.accept(command, allow: accepted));
    }
  }

  Future<void> _chooseExecution() async {
    if (widget.hub == null) {
      await _newTask();
      return;
    }
    try {
      final devices = await widget.hub!.devices();
      if (!mounted) return;
      final device = await showLocalDialog<Map<String, dynamic>>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('在哪里执行？'),
          children: [
            SimpleDialogOption(
              onPressed:
                  capabilities['model_configured'] == true &&
                      (capabilities['platform'] == 'ios' ||
                          capabilities['accessibility'] == true)
                  ? () => Navigator.pop(context, <String, dynamic>{})
                  : null,
              child: const Text('这台手机'),
            ),
            for (final device in devices)
              SimpleDialogOption(
                onPressed: device['online'] == true
                    ? () => Navigator.pop(
                        context,
                        Map<String, dynamic>.from(device),
                      )
                    : null,
                child: Text(
                  '${device['name']}${device['online'] == true ? '' : '（离线）'}',
                ),
              ),
          ],
        ),
      );
      if (device == null) return;
      if (device.isEmpty) {
        await _newTask();
        return;
      }
      await _remoteTask(device);
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _remoteTask(Map<String, dynamic> device) async {
    final targets = device['targets'] as List? ?? [];
    final goal = TextEditingController(), acceptance = TextEditingController();
    Map? target;
    try {
      final start = await showLocalDialog<bool>(
        context: context,
        builder: (context) => StatefulBuilder(
          builder: (context, update) => AlertDialog(
            title: Text('交给${device['name']}'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  DropdownButtonFormField<int>(
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: '允许操作的范围'),
                    items: [
                      for (var i = 0; i < targets.length; i++)
                        DropdownMenuItem(
                          value: i,
                          child: Text(
                            targets[i]['label'] as String,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: (i) => update(
                      () => target = i == null ? null : targets[i] as Map,
                    ),
                  ),
                  TextField(
                    controller: goal,
                    maxLength: 4000,
                    decoration: const InputDecoration(labelText: '希望完成什么'),
                  ),
                  TextField(
                    controller: acceptance,
                    maxLength: 2000,
                    decoration: const InputDecoration(labelText: '怎样确认完成'),
                  ),
                  const Text('任务会等待执行设备接收。操作权限和模型数据授权在执行设备上确认；5 分钟未接收则过期。'),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: target == null
                    ? null
                    : () {
                        if (goal.text.trim().isNotEmpty &&
                            acceptance.text.trim().isNotEmpty) {
                          Navigator.pop(context, true);
                        }
                      },
                child: const Text('发送任务'),
              ),
            ],
          ),
        ),
      );
      if (start == true) {
        await _hubAction(
          () => widget.hub!.send(
            device: device['device_id'],
            capability: target!['capability'],
            target: target!['id'],
            goal: goal.text.trim(),
            acceptance: acceptance.text.trim(),
          ),
        );
      }
    } finally {
      goal.dispose();
      acceptance.dispose();
    }
  }

  Future<void> _settings() async {
    try {
      final settings = await widget.agent.call('modelSettings') as Map;
      if (!mounted) return;
      final endpoint = TextEditingController(
        text: settings['endpoint'] as String? ?? '',
      );
      final model = TextEditingController(
        text: settings['model'] as String? ?? '',
      );
      final key = TextEditingController();
      try {
        final accepted = await showLocalDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('本机模型服务'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    '任务目标及你选择的数据会发送到此服务。Android GUI 任务还会发送界面和截图。密钥仅保存在这台设备，不通过 Hub 同步。',
                  ),
                  TextField(
                    controller: endpoint,
                    decoration: const InputDecoration(
                      labelText: 'HTTPS Chat Completions 地址',
                    ),
                    autocorrect: false,
                  ),
                  TextField(
                    controller: model,
                    decoration: const InputDecoration(labelText: '模型'),
                    autocorrect: false,
                  ),
                  TextField(
                    controller: key,
                    obscureText: true,
                    autocorrect: false,
                    enableSuggestions: false,
                    decoration: InputDecoration(
                      labelText: settings['configured'] == true
                          ? '密钥（留空保持现有密钥）'
                          : 'API Key',
                    ),
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
                child: const Text('保存'),
              ),
            ],
          ),
        );
        if (accepted == true) {
          await _command('saveModelSettings', {
            'endpoint': endpoint.text.trim(),
            'model': model.text.trim(),
            'key': key.text,
          });
        }
      } finally {
        endpoint.dispose();
        model.dispose();
        key.dispose();
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _newTask() async {
    try {
      final value = await requestLocalTask(
        context,
        agent: widget.agent,
        life: widget.life,
      );
      if (value != null) await _command('run', value);
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('本机任务'),
      actions: [
        IconButton(
          tooltip: '模型设置',
          onPressed: _settings,
          icon: const Icon(Icons.settings_outlined),
        ),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (capabilities['platform'] == 'android' &&
            capabilities['accessibility'] != true)
          ListTile(
            title: const Text('需要开启 Nova 无障碍服务'),
            trailing: TextButton(
              onPressed: () => _command('accessibilitySettings', {}),
              child: const Text('去设置'),
            ),
          ),
        if (capabilities['model_configured'] != true)
          const Text('请先在模型设置中配置服务。'),
        if (error != null)
          SelectableText(error!, style: const TextStyle(color: Colors.red)),
        for (final offer in offers)
          Card(
            child: ListTile(
              title: Text('其他设备委托：${offer['command']['goal']}'),
              subtitle: Text('完成标准：${offer['command']['acceptance']}'),
              trailing: TextButton(
                onPressed: () => _hubAction(
                  () =>
                      _acceptOffer(Map<String, dynamic>.from(offer['command'])),
                ),
                child: const Text('查看并接收'),
              ),
            ),
          ),
        for (final task in remoteTasks)
          Card(
            child: ListTile(
              title: Text(task['goal'] as String),
              subtitle: Text('跨设备任务 · ${task['phase']}\n${task['summary']}'),
              trailing:
                  [
                    'completed',
                    'cancelled',
                    'interrupted',
                  ].contains(task['phase'])
                  ? null
                  : TextButton(
                      onPressed: () => _hubAction(
                        () =>
                            widget.hub!.cancel(Map<String, dynamic>.from(task)),
                      ),
                      child: const Text('请求停止'),
                    ),
            ),
          ),
        if (tasks.isEmpty)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Text('本机任务不依赖电脑连接。完成结果会在这里等待核验。'),
          ),
        for (final task in tasks)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    task['goal'] as String,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  Text(
                    const {
                          'running': '执行中',
                          'waiting_approval': '等待批准',
                          'verifying': '等待核验',
                          'completed': '已完成',
                          'cancelled': '已停止',
                          'interrupted': '已暂停，需核对',
                        }[task['phase']] ??
                        task['phase'] as String,
                  ),
                  Text('完成标准：${task['acceptance']}'),
                  if (task['todo_ref'] != null)
                    const Text('核验完成后更新关联待办；待办有新修改时会提示你核对。'),
                  if (todoErrors[task['id']] != null)
                    Text(
                      todoErrors[task['id']]!,
                      style: const TextStyle(color: Colors.orange),
                    ),
                  if (task['summary'] != null) Text(task['summary'] as String),
                  if (task['proposal'] != null) ...[
                    Text('拟执行：${task['proposal']['summary']}'),
                    SelectableText('${task['proposal']['action']}'),
                    if (capabilities['platform'] == 'ios')
                      Wrap(
                        children: [
                          TextButton(
                            onPressed: () => _command('approve', {
                              'id': task['id'],
                              'proposal_id': task['proposal']['id'],
                              'allow': false,
                            }),
                            child: const Text('拒绝'),
                          ),
                          FilledButton(
                            onPressed: () => _command('approve', {
                              'id': task['id'],
                              'proposal_id': task['proposal']['id'],
                              'allow': true,
                            }),
                            child: const Text('批准此操作'),
                          ),
                        ],
                      )
                    else
                      const Text('可在目标 App 上的 Nova 提示中批准；回到任务页面会使原界面审批失效。'),
                  ],
                  if (task['phase'] == 'verifying')
                    TextButton(
                      onPressed: () => _command('verify', {'id': task['id']}),
                      child: const Text('确认已完成'),
                    ),
                  if ([
                    'running',
                    'waiting_approval',
                    'verifying',
                  ].contains(task['phase']))
                    TextButton(
                      onPressed: () => _command('stop', {'id': task['id']}),
                      child: const Text('停止任务'),
                    ),
                ],
              ),
            ),
          ),
        const SizedBox(height: 80),
      ],
    ),
    floatingActionButton: FloatingActionButton.extended(
      onPressed:
          widget.hub != null ||
              capabilities['model_configured'] == true &&
                  (capabilities['accessibility'] == true ||
                      capabilities['platform'] == 'ios')
          ? _chooseExecution
          : null,
      label: const Text('委托任务'),
      icon: const Icon(Icons.add),
    ),
  );
}
