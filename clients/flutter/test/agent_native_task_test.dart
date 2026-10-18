import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/conversation/native_task_request.dart';

class NativeRecorder implements LocalAgent {
  final calls = <String>[];
  Map<String, dynamic>? dispatched;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    calls.add(method);
    switch (method) {
      case 'apps':
        return [
          {'package': 'nova', 'label': 'Nova'},
        ];
      case 'modelSettings':
        return {
          'configured': true,
          'endpoint': 'https://example.com',
          'model': 'm',
        };
      case 'run':
        dispatched = input;
        return {'id': input['id'], 'phase': 'running'};
      default:
        throw StateError('Unexpected action: $method');
    }
  }
}

void main() {
  testWidgets(
    'native task needs user scope, consent and verification criteria; dispatches only run',
    (tester) async {
      final native = NativeRecorder();
      Map<String, dynamic>? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  result = await requestNativeTask(
                    context,
                    'Do the task',
                    'stable-operation',
                    agent: native,
                    taskPanelBuilder: () =>
                        const Scaffold(body: Text('Native approval monitor')),
                  );
                },
                child: const Text('Request'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Request'));
      await tester.pumpAndSettle();
      expect(native.dispatched, isNull);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '开始任务'))
            .onPressed,
        isNull,
      );
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nova').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField),
        'I will inspect the result',
      );
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      await tester.tap(find.text('开始任务'));
      await tester.pumpAndSettle();
      expect(native.calls, ['apps', 'modelSettings', 'run']);
      expect(native.dispatched!['target_package'], 'nova');
      expect(native.dispatched!['id'], 'stable-operation');
      expect(result!['completion_requires_user_verification'], true);
      expect(find.text('Native approval monitor'), findsOneWidget);
    },
  );
  testWidgets('native initiation cancellation never dispatches', (
    tester,
  ) async {
    final native = NativeRecorder();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () =>
                  requestNativeTask(context, 'goal', 'id', agent: native),
              child: const Text('Request'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Request'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(native.dispatched, isNull);
    expect(native.calls, ['apps', 'modelSettings']);
  });
}
