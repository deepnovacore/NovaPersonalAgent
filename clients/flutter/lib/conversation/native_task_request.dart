import 'dart:async';
import 'package:flutter/material.dart';
import '../ui/local_dialog.dart';
import '../agent/local_agent.dart';
import '../agent_core/model_client.dart';
import '../ui/local_tasks.dart';

/// User starts a native task here; all action approvals remain in LocalTasksPage
/// and the native runtime. The model cannot choose a scope or approve actions.
Future<Map<String, dynamic>> requestNativeTask(
  BuildContext context,
  String goal,
  String operationId, {
  LocalAgent agent = const NativeLocalAgent(),
  Widget Function()? taskPanelBuilder,
}) async {
  final apps = await agent.call('apps') as List;
  final settings = await agent.call('modelSettings') as Map;
  if (!context.mounted) return {'status': 'denied'};
  if (settings['configured'] != true) {
    throw const AgentFailure('model_settings_required');
  }
  final acceptance = TextEditingController();
  String? scope;
  var consent = false;
  Map<String, dynamic>? input;
  try {
    input = await showLocalDialog<Map<String, dynamic>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          title: const Text('在这台手机执行'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(goal),
                DropdownButtonFormField<String>(
                  decoration: const InputDecoration(labelText: '允许操作的范围'),
                  items: apps
                      .map(
                        (app) => DropdownMenuItem(
                          value: app['package'] as String,
                          child: Text(app['label'] as String),
                        ),
                      )
                      .toList(),
                  onChanged: (value) => setState(() => scope = value),
                ),
                TextField(
                  controller: acceptance,
                  maxLength: 2000,
                  decoration: const InputDecoration(labelText: '你将如何核验完成'),
                  onChanged: (_) => setState(() {}),
                ),
                CheckboxListTile(
                  value: consent,
                  onChanged: (value) =>
                      setState(() => consent = value ?? false),
                  title: Text(
                    '允许将本次目标及所选范围的数据、屏幕内容发送给 ${Uri.tryParse(settings['endpoint'] as String? ?? '')?.host ?? '所配置服务'}。每一步仍需原生审批。',
                  ),
                ),
                const Text('任务启动不代表完成。请在任务页逐步审批，并自行核验结果。'),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed:
                  !consent || scope == null || acceptance.text.trim().isEmpty
                  ? null
                  : () => Navigator.pop(context, {
                      'id': operationId,
                      'goal': goal,
                      'acceptance': acceptance.text.trim(),
                      'target_package': scope,
                    }),
              child: const Text('开始任务'),
            ),
          ],
        ),
      ),
    );
  } finally {
    acceptance.dispose();
  }
  if (input == null || !context.mounted) return {'status': 'denied'};
  final result = await agent
      .call('run', input)
      .timeout(const Duration(seconds: 15));
  if (context.mounted) {
    unawaited(
      Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) =>
              taskPanelBuilder?.call() ?? LocalTasksPage(agent: agent),
        ),
      ),
    );
  }
  return {
    'status': 'started',
    'task': result,
    'completion_requires_user_verification': true,
  };
}
