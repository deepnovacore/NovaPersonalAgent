import 'package:flutter/material.dart';

/// Tool payloads stay in storage; the conversation shows only safe metadata.
class ToolStep extends StatelessWidget {
  const ToolStep({
    super.key,
    required this.name,
    required this.status,
    this.completedReadPath,
    this.language = 'zh',
  });
  final String name, status, language;
  final String? completedReadPath;
  bool get completed => status == 'completed';
  String get label {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    return switch (name) {
      'file_read' => t('读取文件', 'Read file'),
      'file_write' => t('写入文件', 'Write file'),
      'file_edit' => t('修改文件', 'Edit file'),
      'shell_execute' => t('执行命令', 'Run command'),
      'web_fetch' => t('读取网页', 'Read webpage'),
      'browser' || 'browser_open' => t('检查网页', 'Check webpage'),
      _ => t('使用工具', 'Use tool'),
    };
  }

  String get state {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    return switch (status) {
      'completed' => t('已完成', 'Completed'),
      'cancelled' => t('已取消', 'Cancelled'),
      'rejected' || 'denied' => t('未执行', 'Not executed'),
      'failed' || 'error' => t('未完成', 'Failed'),
      _ => t('结果待核实', 'Outcome unknown'),
    };
  }

  @override
  Widget build(BuildContext context) => ToolStepGroup(steps: [this]);
}

class ToolStepGroup extends StatelessWidget {
  const ToolStepGroup({super.key, required this.steps});
  final List<ToolStep> steps;

  @override
  Widget build(BuildContext context) {
    String t(String zh, String en) => steps.first.language == 'zh' ? zh : en;
    final files = {
      for (final step in steps)
        if (step.name == 'file_read' &&
            step.completed &&
            step.completedReadPath != null)
          step.completedReadPath!,
    };
    final done = steps.every((step) => step.completed);
    final summary = steps.length == 1
        ? '${steps.first.label} · ${steps.first.state}'
        : [
            if (files.isNotEmpty)
              t('查看了 ${files.length} 个文件', 'Read ${files.length} files'),
            t('${steps.length} 次工具调用', '${steps.length} tool calls'),
            if (!done) t('有未完成或待核实', 'Some incomplete or unverified'),
          ].join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 4),
        childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
        minTileHeight: 36,
        dense: true,
        visualDensity: VisualDensity.compact,
        shape: const Border(),
        collapsedShape: const Border(),
        leading: Icon(
          done ? Icons.check_circle_outline : Icons.info_outline,
          size: 15,
        ),
        title: Text(summary, style: Theme.of(context).textTheme.bodySmall),
        children: [
          for (final step in steps)
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Text(
                  steps.length == 1
                      ? '${t('工具', 'Tool')}: ${step.name}\n${t('状态', 'Status')}: ${step.state}'
                      : '${step.label} · ${step.state}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
