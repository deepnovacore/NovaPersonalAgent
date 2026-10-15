import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/ui/local_tasks.dart';

class TestAgent implements LocalAgent {
  String phase = 'verifying';
  int verifications = 0;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    switch (method) {
      case 'capabilities':
        return {
          'platform': 'android',
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
        return <dynamic>[];
      case 'verify':
        verifications++;
        phase = 'completed';
        return {'id': 'one', 'phase': phase};
    }
    return null;
  }
}

void main() {
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
