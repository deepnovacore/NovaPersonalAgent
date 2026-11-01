import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'support/fake_phone_channel.dart';

ToolStep _step({int index = 1, String? reasoning, bool frame = true}) =>
    ToolStep(
      name: 'tap',
      status: 'completed',
      narration: '点搜索',
      reasoning: reasoning,
      stepIndex: index,
      refLabel: '@e3',
      frame: frame ? () async => Uint8List.fromList(tinyFrame) : null,
    );

Future<void> _pump(WidgetTester tester, List<ToolStep> steps) async {
  tester.view.physicalSize = const Size(360, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: ToolStepGroup(steps: steps, running: true),
        ),
      ),
    ),
  );
}

void main() {
  for (final withDetail in [false, true]) {
    testWidgets('the frame button is its own accessible 44dp button '
        '(row ${withDetail ? 'has' : 'has no'} expandable text)', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await _pump(tester, [
        _step(reasoning: withDetail ? '先点搜索框，再输入关键词' : null),
        _step(index: 2, frame: false),
      ]);
      final button = find.byKey(const ValueKey('tool-step-frame:1'));
      expect(button, findsOneWidget);
      expect(tester.getSize(button).height, greaterThanOrEqualTo(44));
      expect(tester.getSize(button).width, greaterThanOrEqualTo(44));

      final node = tester.getSemantics(button);
      // ignore: deprecated_member_use
      expect(node.hasFlag(SemanticsFlag.isButton), isTrue);
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      expect(node.label, '查看当时的画面');

      // The row's own text does not swallow it.
      if (withDetail) {
        final row = tester.getSemantics(find.bySemanticsLabel('点搜索').first);
        expect(row.label, contains('点搜索'));
        expect(row.label, isNot(contains('查看当时的画面')));
      }

      // Activating it through accessibility toggles the picture.
      tester.semantics.tap(find.semantics.byLabel('查看当时的画面'));
      await tester.runAsync(pumpEventQueue);
      await tester.pump();
      await tester.pump();
      expect(find.text('收起当时的画面'), findsOneWidget);
      expect(find.byType(Image), findsOneWidget);
      semantics.dispose();
    });
  }

  testWidgets('a step without a frame has no button', (tester) async {
    await _pump(tester, [_step(frame: false), _step(index: 2, frame: false)]);
    expect(find.text('查看当时的画面'), findsNothing);
  });

  testWidgets('tapping the button with a finger toggles it too', (
    tester,
  ) async {
    await _pump(tester, [_step(), _step(index: 2, frame: false)]);
    await tester.tap(find.text('查看当时的画面'));
    await tester.runAsync(pumpEventQueue);
    await tester.pump();
    expect(find.text('收起当时的画面'), findsOneWidget);
    await tester.tap(find.text('收起当时的画面'));
    await tester.pump();
    expect(find.text('查看当时的画面'), findsOneWidget);
  });
}
