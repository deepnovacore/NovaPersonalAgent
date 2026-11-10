import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'tool_timeline.dart';
import 'reason_copy.dart';

/// Tool payloads stay in storage; the conversation shows only safe metadata.
///
/// The optional fields feed the trajectory timeline (`tool_timeline.dart`).
/// They carry display-safe text only (file name, host, app name; never raw
/// payloads). Phone steps map in directly: `step` -> [stepIndex], `tool` ->
/// [name], `label` -> [narration], `ref` -> [refLabel], and the status of the
/// step event -> [status] using this class's vocabulary ('completed', 'failed',
/// ...). A step screenshot arrives lazily through [frame].
class ToolStep extends StatelessWidget {
  const ToolStep({
    super.key,
    required this.name,
    required this.status,
    this.completedReadPath,
    this.language = 'zh',
    this.target,
    this.targetKey,
    this.narration,
    this.reasoning,
    this.stepIndex,
    this.refLabel,
    this.frame,
    this.data,
  });
  final String name, status, language;
  final String? completedReadPath;

  /// The tool message's result data, used only for its human explanation.
  final Map? data;
  String get explanation => toolResultCopy(data, language: language);

  /// Where the tool acted (file name, host, app name). Equal consecutive
  /// targets of observe-like tools merge into one timeline row.
  final String? target;

  /// Undisplayed raw identity of [target] (full path, host); merging compares
  /// it so equal names in different places stay separate rows.
  final String? targetKey;

  /// What equal consecutive observe steps are compared by.
  String? get mergeKey => targetKey ?? target;

  /// The model's own one-line description of this step; wins over the tool
  /// label as the row title.
  final String? narration;

  /// Longer model text behind [narration]; shown when the row is tapped.
  final String? reasoning;

  /// The agent's own step number (phone loops); defaults to list position.
  final int? stepIndex;

  /// Element reference the step acted on, e.g. `@e12`.
  final String? refLabel;

  /// Loads the screen as it was at this step (JPEG/PNG bytes), or null.
  final Future<Uint8List?> Function()? frame;

  /// Whether the step carries nothing the timeline would add to the legacy
  /// single-line rendering.
  bool get isPlain =>
      narration == null &&
      reasoning == null &&
      stepIndex == null &&
      refLabel == null &&
      frame == null;

  ToolStep withNarration({String? narration, String? reasoning}) => ToolStep(
    key: key,
    name: name,
    status: status,
    completedReadPath: completedReadPath,
    language: language,
    target: target,
    targetKey: targetKey,
    narration: narration ?? this.narration,
    reasoning: reasoning ?? this.reasoning,
    stepIndex: stepIndex,
    refLabel: refLabel,
    frame: frame,
    data: data,
  );
  bool get completed => status == 'completed';

  /// The earlier phone task this step was refused for, until the user checks it.
  String? get priorTaskId {
    final d = data;
    if (d == null || d['reason'] != 'prior_task_unverified') return null;
    final id = (d['prior_task'] as Map?)?['task_id'];
    return id is String && id.isNotEmpty ? id : null;
  }

  String get label {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    return switch (name) {
      'memory_remember' => t('保存记忆', 'Save memory'),
      'memory_recall' => t('召回记忆', 'Recall memory'),
      'memory_forget' => t('忘记记忆', 'Forget memory'),
      'file_read' => t('读取文件', 'Read file'),
      'file_write' => t('写入文件', 'Write file'),
      'file_edit' => t('修改文件', 'Edit file'),
      'shell_execute' => t('执行命令', 'Run command'),
      'web_fetch' => t('读取网页', 'Read webpage'),
      'browser' || 'browser_open' => t('检查网页', 'Check webpage'),
      'web_search' => t('搜索网页', 'Search the web'),
      'computer_screenshot' => t('查看屏幕', 'View screen'),
      'computer_click' => t('点击屏幕', 'Tap screen'),
      'computer_type' => t('输入文字', 'Type text'),
      'computer_scroll' => t('滚动屏幕', 'Scroll screen'),
      'computer_key' => t('按键', 'Press keys'),
      // Phone-control steps (`nova/phone/events`).
      'observe' => t('查看屏幕', 'View screen'),
      'tap' => t('点击', 'Tap'),
      'type' => t('输入文字', 'Type text'),
      'scroll' => t('滚动', 'Scroll'),
      'swipe' => t('滑动', 'Swipe'),
      'open_app' => t('打开 App', 'Open app'),
      'back' => t('返回', 'Go back'),
      'submit' => t('提交', 'Submit'),
      'hand_to_user' => t('请你接手', 'Hand over to you'),
      _ => t('使用工具', 'Use tool'),
    };
  }

  String get state {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    if (knownStepsStopped(data) &&
        ['outcome_unknown', 'failed', 'error'].contains(status)) {
      return t('中途停止', 'Stopped partway through');
    }
    return switch (status) {
      'completed' => t('已完成', 'Completed'),
      'running' || 'executing' || 'prepared' => t('进行中', 'In progress'),
      'awaiting_approval' => t('等你允许', 'Waiting for your approval'),
      'cancelled' => t('已取消', 'Cancelled'),
      'timed_out' => t('已超时', 'Timed out'),
      'blocked' ||
      'blocked_by_unresolved_prior_action' ||
      'prior_task_unverified' => t(
        '已跳过：先核对上一步',
        'Skipped: check the previous step first',
      ),
      'cancelled_before_execution' => t('未执行', 'Not executed'),
      'device_busy' => t('手机正忙，未执行', 'Phone busy; not executed'),
      'denied' => t('你未允许，未执行', 'Not executed because you did not allow it'),
      'rejected' => t('Nova 未执行', 'Nova did not execute this'),
      'outcome_unknown' => t('无法确认结果', 'Unable to confirm the result'),
      'failed' || 'error' => t('未完成', 'Failed'),
      _ => t('未完成', 'Incomplete'),
    };
  }

  @override
  Widget build(BuildContext context) => ToolStepGroup(steps: [this]);
}

/// One run's tool steps. A lone plain step keeps the compact legacy line
/// (`label · target · state`);
/// anything longer renders as a [ToolTimeline]: while [running] the last
/// [toolTimelineVisibleSteps] rows, once finished one expandable summary line
/// in the established "查看了 N 个文件 · N 次工具调用" wording.
class ToolStepGroup extends StatelessWidget {
  const ToolStepGroup({
    super.key,
    required this.steps,
    this.running = false,
    this.canConfirmChecked,
    this.onConfirmChecked,
  });
  final List<ToolStep> steps;
  final bool running;

  /// Whether a refused phone task still waits for the user's check, and the
  /// callback that confirms exactly that task.
  final bool Function(String taskId)? canConfirmChecked;
  final void Function(String taskId)? onConfirmChecked;

  @override
  Widget build(BuildContext context) {
    final body = _body(context);
    final confirm = onConfirmChecked;
    if (confirm == null || steps.isEmpty) return body;
    final ids = {
      for (final s in steps)
        if (s.priorTaskId != null &&
            (canConfirmChecked?.call(s.priorTaskId!) ?? true))
          s.priorTaskId!,
    };
    if (ids.isEmpty) return body;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        body,
        for (final id in ids)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: OutlinedButton(
              onPressed: () => confirm(id),
              child: Text(
                steps.first.language == 'zh'
                    ? '我核对过了，可以重新做'
                    : 'I checked it; it can run again',
              ),
            ),
          ),
      ],
    );
  }

  Widget _body(BuildContext context) {
    if (steps.isEmpty) return const SizedBox.shrink();
    if (steps.length > 1 || !steps.first.isPlain) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: ToolTimeline(steps: steps, running: running),
      );
    }
    final step = steps.first;
    String t(String zh, String en) => step.language == 'zh' ? zh : en;
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
          step.completed ? Icons.check_circle_outline : Icons.info_outline,
          size: 15,
        ),
        title: Text(
          [step.label, ?step.target, step.state].join(' · '),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        subtitle: step.explanation.isEmpty ? null : Text(step.explanation),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Text(
                '${t('工具', 'Tool')}: ${step.name}\n${t('状态', 'Status')}: ${step.state}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
