import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'package:nova_mobile/ui/tool_timeline.dart';

void main() {
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
    expect(find.text('做了 4 步 · 有未完成或待核实'), findsOneWidget);
    expect(
      tester.getSize(find.byType(ToolTimeline)).height,
      lessThanOrEqualTo(40),
    );
    expect(find.textContaining('shell_execute'), findsNothing);
    await tester.tap(find.byType(ToolTimeline));
    await tester.pumpAndSettle();
    expect(find.text('执行命令'), findsOneWidget);
    expect(find.text('结果待核实'), findsOneWidget);
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
    expect(find.text('做了 2 步 · 有未完成或待核实'), findsOneWidget);
    await tester.tap(find.byType(ToolTimeline));
    await tester.pumpAndSettle();
    expect(find.text('读取文件'), findsNWidgets(2));
    expect(find.text('结果待核实'), findsOneWidget);
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
}
