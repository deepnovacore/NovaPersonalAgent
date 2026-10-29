import 'package:flutter/material.dart';

/// Tool payloads stay in storage; the conversation shows only safe metadata.
class ToolStep extends StatelessWidget {
  const ToolStep({
    super.key,
    required this.name,
    required this.status,
    this.language = 'zh',
  });
  final String name, status, language;
  @override
  Widget build(BuildContext context) {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    final label = switch (name) {
      'file_read' => t('读取文件', 'Read file'),
      'file_write' => t('写入文件', 'Write file'),
      'file_edit' => t('修改文件', 'Edit file'),
      'shell_execute' => t('执行命令', 'Run command'),
      'web_fetch' => t('读取网页', 'Read webpage'),
      'browser' || 'browser_open' => t('检查网页', 'Check webpage'),
      _ => t('使用工具', 'Use tool'),
    };
    final done = status == 'completed';
    final state = done
        ? t('已完成', 'Completed')
        : switch (status) {
            'outcome_unknown' => t('结果待核实', 'Outcome unknown'),
            'cancelled' => t('已取消', 'Cancelled'),
            'rejected' || 'denied' => t('未执行', 'Not executed'),
            _ => t('未完成', 'Failed'),
          };
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 8),
        leading: Icon(
          done ? Icons.check_circle_outline : Icons.info_outline,
          size: 18,
        ),
        title: Text(
          '$label · $state',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Text(
              '${t('工具', 'Tool')}: $name\n${t('状态', 'Status')}: $state',
            ),
          ),
        ],
      ),
    );
  }
}
