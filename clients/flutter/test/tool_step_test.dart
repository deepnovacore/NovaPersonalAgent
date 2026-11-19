import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'package:nova_mobile/ui/tool_timeline.dart';
import 'package:nova_mobile/ui/reason_copy.dart';

void main() {
  test('non-execution and unknown outcomes have distinct human copy', () {
    const expected = {
      'timed_out': '已超时',
      'blocked': '已跳过：先核对上一步',
      'blocked_by_unresolved_prior_action': '已跳过：先核对上一步',
      'prior_task_unverified': '已跳过：先核对上一步',
      'cancelled_before_execution': '未执行',
      'device_busy': '手机正忙，未执行',
      'denied': '你未允许，未执行',
      'rejected': 'Nova 未执行',
      'outcome_unknown': '无法确认结果',
      'future_status': '未完成',
      'completed': '已完成',
    };
    for (final entry in expected.entries) {
      expect(ToolStep(name: 'tap', status: entry.key).state, entry.value);
      expect(
        ToolStep(name: 'tap', status: entry.key, language: 'en').state,
        isNot(contains('_')),
      );
    }
    expect(reasonCopy('a11y_reconnected'), '系统的无障碍服务断开了');
    expect(reasonCopy('no_progress'), '页面反复出现，已暂停；请先在 App 里核对');
    expect(
      reasonCopy('no_progress', language: 'en'),
      'Paused after repeated screens; check previous actions in the app first',
    );
    expect(
      reasonCopy('task_runtime_unavailable', language: 'en'),
      'The task service is temporarily unavailable',
    );
    expect(humanReason('schedule_in_past'), contains('执行时间已经过去了'));
    // Prose is never rewritten token by token.
    expect(
      humanReason('Bad state: schedule_in_past'),
      'Bad state: schedule_in_past',
    );
    expect(humanReason('launch_outcome_unknown'), '打开 App 时出了问题');
    expect(humanReason('observation_screen_unavailable'), '没能读取当前屏幕');
    expect(hasReasonCopy('time_limit'), isTrue);
    expect(hasReasonCopy('future_code'), isFalse);
    for (final status in ['executing', 'prepared', 'running']) {
      expect(ToolStep(name: 'tap', status: status).state, '进行中');
    }
    expect(ToolStep(name: 'tap', status: 'awaiting_approval').state, '等你允许');
    expect(toolResultCopy({'summary': 'Saved two notes'}), 'Saved two notes');
  });

  testWidgets('a blocked step offers a confirm button for its own task', (
    tester,
  ) async {
    final confirmed = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: ToolStepGroup(
          steps: [
            ToolStep(
              name: 'device_run_task',
              status: 'outcome_unknown',
              data: {
                'reason': 'prior_task_unverified',
                'prior_task': {'task_id': 'task-7'},
              },
            ),
          ],
          onConfirmChecked: confirmed.add,
        ),
      ),
    );
    await tester.tap(find.text('我核对过了，可以重新做'));
    expect(confirmed, ['task-7']);
  });

  testWidgets(
    'tool data explains non-execution without exposing reason codes',
    (tester) async {
      const step = ToolStep(
        name: 'tap',
        status: 'blocked',
        data: {'reason': 'accessibility_unavailable'},
      );
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: step)));
      expect(find.text('系统的无障碍服务断开了'), findsOneWidget);
      expect(step.withNarration(narration: '点击保存').explanation, '系统的无障碍服务断开了');
      expect(
        buildToolSteps([step]).single.subtitle,
        '已跳过：先核对上一步 · 系统的无障碍服务断开了',
      );
      expect(buildToolSteps([step]).single.state, ToolStepState.dim);
    },
  );
  test(
    'memory tool labels follow the Chinese and English tool string pattern',
    () {
      for (final (name, zh, en) in [
        ('memory_remember', '保存记忆', 'Save memory'),
        ('memory_recall', '召回记忆', 'Recall memory'),
        ('memory_forget', '忘记记忆', 'Forget memory'),
      ]) {
        expect(ToolStep(name: name, status: 'completed').label, zh);
        expect(
          ToolStep(name: name, status: 'completed', language: 'en').label,
          en,
        );
      }
    },
  );
  testWidgets('finished group is one line that expands to its steps', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ToolStepGroup(
            steps: [
              ToolStep(
                name: 'file_read',
                status: 'completed',
                completedReadPath: '/workspace/a',
              ),
              ToolStep(
                name: 'file_read',
                status: 'completed',
                completedReadPath: '/workspace/a',
              ),
              ToolStep(
                name: 'file_read',
                status: 'failed',
                completedReadPath: '/workspace/b',
              ),
              ToolStep(name: 'shell_execute', status: 'outcome_unknown'),
            ],
          ),
        ),
      ),
    );
    // No target metadata, so nothing merges and nothing is invented.
    expect(find.text('查看了 1 个文件 · 4 次工具调用 · 有 2 步没完成或需要你确认'), findsOneWidget);
    expect(
      tester.getSize(find.byType(ToolTimeline)).height,
      lessThanOrEqualTo(48),
    );
    expect(find.textContaining('shell_execute'), findsNothing);
    await tester.tap(find.byType(ToolTimeline));
    await tester.pumpAndSettle();
    expect(find.text('执行命令'), findsOneWidget);
    expect(find.text('无法确认结果'), findsOneWidget);
    expect(find.text('未完成'), findsOneWidget);
    expect(find.textContaining('/workspace'), findsNothing);
  });

  testWidgets('missing read metadata never invents completion', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ToolStepGroup(
            steps: [
              ToolStep(name: 'file_read', status: 'completed'),
              ToolStep(name: 'file_read', status: ''),
            ],
          ),
        ),
      ),
    );
    expect(find.text('2 次工具调用 · 有 1 步没完成或需要你确认'), findsOneWidget);
    await tester.tap(find.byType(ToolTimeline));
    await tester.pumpAndSettle();
    expect(find.text('读取文件'), findsNWidgets(2));
    expect(find.text('未完成'), findsOneWidget);
  });

  testWidgets('a lone plain step keeps the compact single line', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ToolStepGroup(
            steps: [ToolStep(name: 'file_read', status: 'completed')],
          ),
        ),
      ),
    );
    expect(find.byType(ToolTimeline), findsNothing);
    expect(find.text('读取文件 · 已完成'), findsOneWidget);
  });

  testWidgets('a lone step with a target keeps it in the compact line', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: ToolStepGroup(
            steps: [
              ToolStep(
                name: 'file_read',
                status: 'completed',
                target: 'notes.txt',
              ),
            ],
          ),
        ),
      ),
    );
    expect(find.byType(ToolTimeline), findsNothing);
    expect(find.text('读取文件 · notes.txt · 已完成'), findsOneWidget);
  });
}
