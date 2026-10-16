import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/ui/local_tasks.dart';

class TestAgent implements LocalAgent {
  String phase = 'verifying';
  int verifications = 0, runs = 0;
  Map<String, dynamic>? lastRun;
  String platform = 'android';
  String target = 'com.nova.nova_mobile';
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    switch (method) {
      case 'capabilities':
        return {
          'platform': platform,
          'host_package': 'com.nova.nova_mobile',
          'accessibility': true,
          'model_runtime': true,
          'model_configured': true,
        };
      case 'tasks':
        return [
          {
            'id': 'one',
            'goal': 'Toggle fixture',
            'acceptance': 'Count is 1',
            'phase': phase,
            'target_package': target,
            if (phase == 'waiting_approval')
              'proposal': {
                'id': 'p',
                'summary': 'Return to workspace',
                'action': {'type': 'back'},
              },
            'summary': 'Count shows 1',
            'actions': [],
          },
        ];
      case 'modelSettings':
        return {
          'configured': true,
          'endpoint': 'https://openrouter.ai/api/v1/chat/completions',
          'model': 'vision',
        };
      case 'apps':
        return [
          {'package': 'com.example.fixture', 'label': 'Fixture App'},
        ];
      case 'run':
        runs++;
        lastRun = Map<String, dynamic>.from(input);
        return {'id': input['id'], 'phase': 'running'};
      case 'verify':
        verifications++;
        phase = 'completed';
        return {'id': 'one', 'phase': phase};
    }
    return null;
  }
}

void main() {
  testWidgets('self GUI approval does not change the observed task card', (
    tester,
  ) async {
    final agent = TestAgent()..phase = 'running';
    await tester.pumpWidget(MaterialApp(home: LocalTasksPage(agent: agent)));
    await tester.pumpAndSettle();
    final before = tester.getRect(find.text('停止任务'));
    agent.phase = 'waiting_approval';
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('执行中'), findsOneWidget);
    expect(find.textContaining('拟执行：'), findsNothing);
    expect(tester.getRect(find.text('停止任务')), before);
    agent.phase = 'verifying';
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('确认已完成'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('iOS still exposes native approval controls', (tester) async {
    final agent = TestAgent()
      ..platform = 'ios'
      ..phase = 'waiting_approval'
      ..target = 'nova';
    await tester.pumpWidget(MaterialApp(home: LocalTasksPage(agent: agent)));
    await tester.pumpAndSettle();
    expect(find.text('批准此操作'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('dismissing focused model settings keeps tasks usable', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(home: LocalTasksPage(agent: TestAgent())),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('模型设置'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'test-only-key');
    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.takeException(), isNull);
    await tester.pumpAndSettle();
    expect(find.text('本机任务'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('cancelled local task request does not dispatch run', (
    tester,
  ) async {
    final agent = TestAgent();
    await tester.pumpWidget(MaterialApp(home: LocalTasksPage(agent: agent)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('委托任务'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(agent.runs, 0);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('confirmed local task request dispatches one native run', (
    tester,
  ) async {
    final agent = TestAgent();
    await tester.pumpWidget(MaterialApp(home: LocalTasksPage(agent: agent)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('委托任务'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Fixture App').last);
    await tester.pumpAndSettle();
    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), 'Open the fixture');
    await tester.enterText(fields.at(1), 'Fixture is open');
    await tester.tap(find.byType(Checkbox));
    await tester.pumpAndSettle();
    await tester.tap(find.text('开始任务'));
    await tester.pumpAndSettle();
    expect(agent.runs, 1);
    expect(agent.lastRun!['id'], isNotEmpty);
    expect(agent.lastRun!['goal'], 'Open the fixture');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'model completion remains unverified until explicit user confirmation',
    (tester) async {
      final agent = TestAgent();
      await tester.pumpWidget(MaterialApp(home: LocalTasksPage(agent: agent)));
      await tester.pumpAndSettle();
      expect(find.text('等待核验'), findsOneWidget);
      expect(agent.verifications, 0);
      await tester.tap(find.text('确认已完成'));
      await tester.pumpAndSettle();
      expect(agent.verifications, 1);
      expect(find.text('已完成'), findsOneWidget);
      expect(find.text('确认已完成'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
