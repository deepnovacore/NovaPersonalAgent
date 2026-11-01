import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'package:nova_mobile/ui/tool_timeline.dart';

ToolStep _read(String target, {String status = 'completed', String? say}) =>
    ToolStep(name: 'file_read', status: status, target: target, narration: say);

Future<void> _pumpGroup(
  WidgetTester tester,
  List<ToolStep> steps, {
  bool running = false,
  Duration? elapsed,
  bool reduceMotion = false,
}) => tester.pumpWidget(
  MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
      child: child!,
    ),
    home: Scaffold(
      body: SingleChildScrollView(
        child: ToolStepGroup(steps: steps, running: running, elapsed: elapsed),
      ),
    ),
  ),
);

List<ToolStep> _shells(int count) => [
  for (var i = 0; i < count; i++)
    ToolStep(name: 'shell_execute', status: 'completed', target: 'step$i'),
];

void main() {
  group('buildToolSteps', () {
    test('merges consecutive observe calls on one target with a count', () {
      final rows = buildToolSteps([
        _read('a.txt'),
        _read('a.txt'),
        _read('a.txt'),
        _read('b.txt'),
        _read('a.txt'),
      ]);
      expect(rows.map((row) => row.text), [
        '读取文件 · a.txt · 3 次',
        '读取文件 · b.txt',
        '读取文件 · a.txt',
      ]);
      expect(rows.map((row) => row.count), [3, 1, 1]);
      expect(rows.map((row) => row.step), [1, 4, 5]);
    });

    test('english copy', () {
      final rows = buildToolSteps([
        ToolStep(
          name: 'web_fetch',
          status: 'completed',
          target: 'example.com',
          language: 'en',
        ),
        ToolStep(
          name: 'web_fetch',
          status: 'completed',
          target: 'example.com',
          language: 'en',
        ),
      ]);
      expect(rows.single.text, 'Read webpage · example.com · ×2');
    });

    test('never merges across tools, unknown targets, status or narration', () {
      final rows = buildToolSteps([
        const ToolStep(name: 'file_read', status: 'completed'),
        const ToolStep(name: 'file_read', status: 'completed'),
        _read('a.txt'),
        _read('a.txt', status: 'failed'),
        _read('a.txt', status: 'failed', say: 'Looking again'),
        const ToolStep(name: 'file_edit', status: 'completed', target: 'a.txt'),
        const ToolStep(name: 'file_edit', status: 'completed', target: 'a.txt'),
      ]);
      expect(rows, hasLength(7));
    });

    test('non-observe tools read tool and target', () {
      final rows = buildToolSteps([
        const ToolStep(
          name: 'file_edit',
          status: 'completed',
          target: 'index.html',
        ),
        const ToolStep(name: 'shell_execute', status: 'completed'),
      ]);
      expect(rows.map((row) => row.text), ['修改文件 · index.html', '执行命令']);
    });

    test('the model narration wins over the tool label, clipped', () {
      final long = 'x' * 200;
      final rows = buildToolSteps([
        _read('a.txt', say: '先看看配置'),
        _read('a.txt', say: '  \n '),
        _read('b.txt', say: long),
      ]);
      expect(rows[0].text, '先看看配置');
      expect(rows[0].title, '读取文件 · a.txt');
      expect(rows[1].text, '读取文件 · a.txt');
      expect(rows[2].text.length, toolNarrationMaxChars);
      expect(rows[2].text, endsWith('…'));
    });

    test('only the last row carries the live state', () {
      List<ToolStepState> states(
        List<ToolStep> steps, {
        bool running = false,
      }) => buildToolSteps(
        steps,
        running: running,
      ).map((row) => row.state).toList();
      ToolStep step(String status) => ToolStep(name: 'x', status: status);
      expect(states([step('failed'), step('completed')]), [
        ToolStepState.ok,
        ToolStepState.ok,
      ]);
      expect(states([step('completed'), step('completed')], running: true), [
        ToolStepState.ok,
        ToolStepState.run,
      ]);
      expect(states([step('completed'), step('failed')], running: true), [
        ToolStepState.ok,
        ToolStepState.dim,
      ]);
      expect(states([step('completed'), step('cancelled')]), [
        ToolStepState.ok,
        ToolStepState.dim,
      ]);
      expect(states([step('completed'), step('outcome_unknown')]), [
        ToolStepState.ok,
        ToolStepState.wait,
      ]);
    });

    test('earlier failures stay visible as the subtitle, not a dot', () {
      final rows = buildToolSteps([
        const ToolStep(name: 'shell_execute', status: 'failed'),
        const ToolStep(name: 'shell_execute', status: 'completed'),
      ]);
      expect(rows.first.state, ToolStepState.ok);
      expect(rows.first.subtitle, '未完成');
      expect(rows.last.subtitle, '');
    });

    test('phone step fields map straight onto the row', () {
      Future<Uint8List?> shot() async => Uint8List.fromList([1]);
      final rows = buildToolSteps([
        ToolStep(
          name: 'tap',
          status: 'completed',
          stepIndex: 7,
          narration: '点搜索框',
          refLabel: '@e12',
          frame: shot,
        ),
      ]);
      expect(rows.single.step, 7);
      expect(rows.single.text, '点搜索框');
      expect(rows.single.refLabel, '@e12');
      expect(rows.single.frame, same(shot));
    });
  });

  group('safe target labels', () {
    test('files keep their name only, urls their host only', () {
      expect(
        toolTargetLabel('file_read', '{"path":"/workspace/a/b/c.txt"}'),
        'c.txt',
      );
      expect(
        toolTargetLabel('web_fetch', {'url': 'https://a.example.com/x?y=1'}),
        'a.example.com',
      );
      expect(
        toolTargetLabel('shell_execute', '{"command":"rm -rf /"}'),
        isNull,
      );
      expect(toolTargetLabel('file_read', 'not json'), isNull);
      expect(toolTargetLabel('file_read', '{"path":"/"}'), isNull);
      expect(toolTargetLabel('web_fetch', '{"url":"nonsense"}'), isNull);
    });
  });

  group('copy and thresholds', () {
    test('finished summary keeps the established wording', () {
      expect(
        toolTimelineSummary(
          language: 'zh',
          steps: const [
            ToolStep(
              name: 'file_read',
              status: 'completed',
              completedReadPath: '/workspace/a.txt',
            ),
            ToolStep(
              name: 'file_read',
              status: 'completed',
              completedReadPath: '/workspace/a.txt',
            ),
            ToolStep(name: 'web_fetch', status: 'completed'),
          ],
        ),
        '查看了 1 个文件 · 3 次工具调用',
      );
      expect(
        toolTimelineSummary(
          language: 'en',
          steps: const [
            ToolStep(name: 'shell_execute', status: 'failed'),
            ToolStep(name: 'web_fetch', status: 'completed'),
          ],
          incomplete: true,
        ),
        '2 tool calls · Some incomplete or unverified',
      );
    });

    test('elapsed is never shorter than one second', () {
      expect(formatToolElapsed(Duration.zero, 'zh'), '1 秒');
      expect(formatToolElapsed(const Duration(milliseconds: 400), 'en'), '1s');
    });

    test('running shows the last five rows', () {
      expect(hiddenEarlierSteps(5, running: true), 0);
      expect(hiddenEarlierSteps(6, running: true), 1);
      expect(hiddenEarlierSteps(12, running: true), 7);
      expect(hiddenEarlierSteps(12, running: true, showAll: true), 0);
      expect(hiddenEarlierSteps(12, running: false), 0);
      expect(earlierStepsLabel('zh', 7), '更早的 7 步');
      expect(earlierStepsLabel('en', 1), '1 earlier step');
      expect(earlierStepsLabel('en', 7), '7 earlier steps');
    });
  });

  group('ToolStepGroup', () {
    testWidgets('running: last five rows, then the earlier-steps link', (
      tester,
    ) async {
      await _pumpGroup(tester, _shells(8), running: true);
      expect(find.text('更早的 3 步'), findsOneWidget);
      expect(find.textContaining('次工具调用'), findsNothing);
      expect(find.text('执行命令 · step2'), findsNothing);
      for (var i = 3; i < 8; i++) {
        expect(find.text('执行命令 · step$i'), findsOneWidget);
      }
      await tester.tap(find.text('更早的 3 步'));
      await tester.pump();
      expect(find.text('更早的 3 步'), findsNothing);
      for (var i = 0; i < 8; i++) {
        expect(find.text('执行命令 · step$i'), findsOneWidget);
      }
    });

    testWidgets('running with five rows or fewer has no link', (tester) async {
      await _pumpGroup(tester, _shells(5), running: true);
      expect(find.textContaining('更早'), findsNothing);
      expect(find.text('执行命令 · step0'), findsOneWidget);
    });

    testWidgets('finished: the established summary line expands', (tester) async {
      await _pumpGroup(
        tester,
        _shells(8),
        elapsed: const Duration(minutes: 1, seconds: 20),
      );
      expect(find.text('8 次工具调用'), findsOneWidget);
      expect(find.byIcon(Icons.check_circle_outline), findsOneWidget);
      expect(find.text('执行命令 · step0'), findsNothing);
      await tester.tap(find.text('8 次工具调用'));
      await tester.pumpAndSettle();
      for (var i = 0; i < 8; i++) {
        expect(find.text('执行命令 · step$i'), findsOneWidget);
      }
      expect(find.textContaining('更早'), findsNothing);
      await tester.tap(find.text('8 次工具调用'));
      await tester.pumpAndSettle();
      expect(find.text('执行命令 · step0'), findsNothing);
    });

    testWidgets('finished with an incomplete step says so', (tester) async {
      await _pumpGroup(tester, [
        ..._shells(2),
        const ToolStep(name: 'shell_execute', status: 'outcome_unknown'),
      ]);
      expect(find.text('3 次工具调用 · 有未完成或待核实'), findsOneWidget);
      expect(find.byIcon(Icons.info_outline), findsOneWidget);
    });

    testWidgets('animations follow the reduced-motion setting', (tester) async {
      final size = find.descendant(
        of: find.byType(ToolTimeline),
        matching: find.byType(AnimatedSize),
      );
      await _pumpGroup(tester, _shells(3));
      expect(
        tester.widget<AnimatedSize>(size).duration,
        const Duration(milliseconds: 200),
      );
      await tester.tap(find.textContaining('3 次工具调用'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      // Mid-animation the body is still growing.
      expect(find.text('执行命令 · step0'), findsOneWidget);
      await tester.pumpAndSettle();

      await tester.pumpWidget(const SizedBox());
      await _pumpGroup(tester, _shells(3), reduceMotion: true);
      expect(size, findsNothing);
      await tester.tap(find.textContaining('3 次工具调用'));
      await tester.pump();
      expect(find.text('执行命令 · step0'), findsOneWidget);
      expect(tester.hasRunningAnimations, isFalse);
      await tester.tap(find.textContaining('3 次工具调用'));
      await tester.pump();
      expect(find.text('执行命令 · step0'), findsNothing);
    });

    testWidgets('rows with model text reveal it when tapped', (tester) async {
      await _pumpGroup(tester, [
        ToolStep(
          name: 'shell_execute',
          status: 'completed',
          narration: '检查依赖',
          reasoning: '先检查依赖是否已安装\n再决定是否安装',
        ),
        const ToolStep(name: 'shell_execute', status: 'completed'),
      ], running: true);
      expect(find.text('检查依赖'), findsOneWidget);
      expect(find.textContaining('再决定'), findsNothing);
      await tester.tap(find.text('检查依赖'));
      await tester.pump();
      expect(find.textContaining('再决定'), findsOneWidget);
    });

    testWidgets('a phone step shows its reference and loads its screen lazily', (
      tester,
    ) async {
      var loads = 0;
      final png = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      );
      await _pumpGroup(tester, [
        ToolStep(
          name: 'tap',
          status: 'completed',
          stepIndex: 3,
          narration: '点搜索框',
          refLabel: '@e12',
          frame: () async {
            loads++;
            return png;
          },
        ),
        const ToolStep(name: 'observe', status: 'completed', target: '微信'),
      ], running: true);
      expect(find.text('@e12'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
      expect(loads, 0);
      await tester.tap(find.text('查看当时的画面'));
      await tester.pumpAndSettle();
      expect(loads, 1);
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('收起当时的画面'), findsOneWidget);
      await tester.tap(find.text('收起当时的画面'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNothing);
      await tester.tap(find.text('查看当时的画面'));
      await tester.pumpAndSettle();
      expect(loads, 1, reason: 'the screen is loaded once per row');
    });
  });

  group('StepRail', () {
    test('dots use Nova colors per state', () {
      expect(StepRailPainter.dotColor(ToolStepState.run), Nova.mint);
      expect(StepRailPainter.dotColor(ToolStepState.wait), Nova.amber);
      expect(StepRailPainter.dotColor(ToolStepState.ok), Nova.secondary);
      expect(
        StepRailPainter.dotColor(ToolStepState.dim).a,
        lessThan(StepRailPainter.dotColor(ToolStepState.ok).a),
      );
    });

    testWidgets('paints one rail slice per row', (tester) async {
      await _pumpGroup(tester, _shells(3), running: true);
      final painters = tester
          .widgetList<CustomPaint>(
            find.descendant(
              of: find.byType(StepRail),
              matching: find.byType(CustomPaint),
            ),
          )
          .map((paint) => paint.painter)
          .whereType<StepRailPainter>()
          .toList();
      expect(painters.map((painter) => painter.state), [
        ToolStepState.ok,
        ToolStepState.ok,
        ToolStepState.run,
      ]);
      expect(painters.map((painter) => painter.first), [true, false, false]);
      expect(painters.map((painter) => painter.last), [false, false, true]);
    });
  });
}
