import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/tool_step.dart';

void main() {
  testWidgets('dense group counts only distinct completed file reads', (
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
    expect(find.text('查看了 1 个文件 · 4 次工具调用 · 有未完成或待核实'), findsOneWidget);
    expect(
      tester.getSize(find.byType(ExpansionTile)).height,
      lessThanOrEqualTo(40),
    );
    expect(find.textContaining('shell_execute'), findsNothing);
    await tester.tap(find.byType(ExpansionTile));
    await tester.pumpAndSettle();
    expect(find.text('执行命令 · 结果待核实'), findsOneWidget);
    expect(find.textContaining('/workspace'), findsNothing);
  });

  testWidgets('missing read metadata never invents file counts or completion', (
    tester,
  ) async {
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
    expect(find.text('2 次工具调用 · 有未完成或待核实'), findsOneWidget);
    await tester.tap(find.byType(ExpansionTile));
    await tester.pumpAndSettle();
    expect(find.text('读取文件 · 结果待核实'), findsOneWidget);
  });
}
