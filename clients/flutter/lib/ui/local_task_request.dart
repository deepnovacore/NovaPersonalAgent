import 'package:flutter/material.dart';
import '../agent/local_agent.dart';
import '../personal/local_life.dart';
import '../protocol/request_id.dart';
import 'local_dialog.dart';

/// Collect explicit user scope and consent before asking the native task host to
/// run. This deliberately only returns a native `run` payload: dispatch and
/// every subsequent action approval remain owned by the native host.
Future<Map<String, dynamic>?> requestLocalTask(
  BuildContext context, {
  required LocalAgent agent,
  LocalLife? life,
  Map<String, dynamic>? lifeSnapshot,
  String? goal,
  String? taskId,
}) async {
  final replies = await Future.wait<dynamic>([
    agent.call('apps'),
    agent.call('modelSettings'),
    agent.call('capabilities'),
  ]);
  if (!context.mounted) return null;
  final apps = replies[0] as List;
  final settings = replies[1] as Map;
  final capabilities = replies[2] as Map;
  final todos =
      (life?.life['todos'] ?? lifeSnapshot?['todos'] ?? const []) as List;
  final goalController = TextEditingController(text: goal ?? '');
  final acceptanceController = TextEditingController();
  String? package;
  Map? todo;
  var consent = false;
  try {
    return await showLocalDialog<Map<String, dynamic>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialog) => AlertDialog(
          title: const Text('在这台手机执行'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '允许操作的范围'),
                  items: apps
                      .map(
                        (app) => DropdownMenuItem<String>(
                          value: app['package'] as String,
                          child: Text(
                            app['label'] as String,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (value) => setDialog(() => package = value),
                ),
                TextField(
                  controller: goalController,
                  maxLength: 4000,
                  decoration: const InputDecoration(labelText: '希望完成什么'),
                  maxLines: 2,
                ),
                if (todos.isNotEmpty)
                  DropdownButtonFormField<String>(
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: '关联待办（可选）'),
                    items: [
                      const DropdownMenuItem(value: '', child: Text('不关联')),
                      for (final row in todos)
                        if (!['done', 'cancelled'].contains(row['status']))
                          DropdownMenuItem(
                            value: row['id'] as String,
                            child: Text(
                              row['title'] as String,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                    ],
                    onChanged: (id) => setDialog(
                      () => todo =
                          todos.where((row) => row['id'] == id).firstOrNull
                              as Map?,
                    ),
                  ),
                TextField(
                  controller: acceptanceController,
                  maxLength: 2000,
                  decoration: const InputDecoration(labelText: '怎样确认完成'),
                  maxLines: 2,
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: consent,
                  onChanged: (value) =>
                      setDialog(() => consent = value ?? false),
                  title: Text(
                    '允许将本次目标、${capabilities['platform'] == 'ios' ? '所选范围的待办／目标或日历／提醒事项内容' : '所选 App 界面和截图'}发送给 ${Uri.tryParse(settings['endpoint'] as String? ?? '')?.host ?? '模型服务'}，模型 ${settings['model']}。',
                  ),
                ),
                Text(
                  capabilities['platform'] == 'ios'
                      ? '请保持 Nova 在前台，每一步修改由你确认。进入后台会停止执行，任务最多运行 5 分钟。系统可能请求日历或提醒事项权限。'
                      : '开始后打开所选 App。每一步操作由你确认，可随时点屏幕上的“停止 Nova”。任务最多运行 5 分钟。',
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: !consent || package == null
                  ? null
                  : () {
                      if (goalController.text.trim().isEmpty ||
                          acceptanceController.text.trim().isEmpty) {
                        return;
                      }
                      Navigator.pop(context, {
                        'id': taskId ?? requestId(),
                        'goal': goalController.text.trim(),
                        'acceptance': acceptanceController.text.trim(),
                        'target_package': package,
                        if (todo != null)
                          'todo_ref': {
                            'id': todo!['id'],
                            'version': todo!['version'],
                          },
                      });
                    },
              child: const Text('开始任务'),
            ),
          ],
        ),
      ),
    );
  } finally {
    goalController.dispose();
    acceptanceController.dispose();
  }
}
