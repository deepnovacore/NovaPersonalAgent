import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
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
  bool reduceMotion = false,
}) => tester.pumpWidget(
  MaterialApp(
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
      child: child!,
    ),
    home: Scaffold(
      body: SingleChildScrollView(
        child: ToolStepGroup(steps: steps, running: running),
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

    test('same file name in different directories does not merge', () {
      ToolStep read(String path) => ToolStep(
        name: 'file_read',
        status: 'completed',
        target: 'notes.txt',
        targetKey: path,
      );
      expect(
        buildToolSteps([read('/a/notes.txt'), read('/b/notes.txt')]),
        hasLength(2),
      );
      final merged = buildToolSteps([
        read('/a/notes.txt'),
        read('/a/notes.txt'),
      ]);
      expect(merged.single.count, 2);
    });

    test('runtime tool names have their own labels', () {
      String label(String name, [String language = 'zh']) =>
          ToolStep(name: name, status: 'completed', language: language).label;
      for (final name in [
        'web_search',
        'computer_screenshot',
        'computer_click',
        'computer_type',
        'computer_scroll',
        'computer_key',
      ]) {
        expect(label(name), isNot('使用工具'), reason: name);
        expect(label(name, 'en'), isNot('Use tool'), reason: name);
      }
      expect(isObserveTool('web_search'), isTrue);
      expect(isObserveTool('computer_screenshot'), isTrue);
      expect(isObserveTool('computer_click'), isFalse);
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

    test('windows paths keep only the file name too', () {
      expect(
        toolTargetLabel('file_read', {'path': r'C:\Users\me\.ssh\id_rsa'}),
        'id_rsa',
      );
      expect(toolTargetLabel('file_edit', {'path': r'a/b\c.txt'}), 'c.txt');
      expect(toolTargetLabel('file_read', {'path': r'C:\'}), 'C:');
      expect(pathBaseName(r'\\'), isNull);
    });

    test('the merge identity keeps the raw path out of the label', () {
      final a = toolTarget('file_read', {'path': '/one/notes.txt'})!;
      final b = toolTarget('file_read', {'path': '/two/notes.txt'})!;
      expect(a.label, b.label);
      expect(a.key, isNot(b.key));
    });

    test('computer screenshots are labeled by application only', () {
      expect(
        toolTargetLabel('computer_screenshot', {'application': ' 微信 '}),
        '微信',
      );
      expect(toolTargetLabel('computer_screenshot', {}), isNull);
      expect(toolTargetLabel('computer_click', {'x': 1, 'y': 2}), isNull);
    });

    test('targets by call id survive re-read copies and a full cache', () {
      Map message(int i) => {
        'role': 'assistant',
        'tool_calls': [
          {
            'id': 'c$i',
            'function': {
              'name': 'file_read',
              'arguments': jsonEncode({'path': '/d/f$i.txt'}),
            },
          },
        ],
      };
      for (var round = 0; round < 2; round++) {
        final targets = toolTargetsByCallId([
          for (var i = 0; i < 600; i++) message(i),
        ]);
        expect(targets, hasLength(600));
        expect(targets['c0']!.label, 'f0.txt');
        expect(targets['c599']!.key, '/d/f599.txt');
      }
      final big = toolTargetsByCallId([
        {
          'role': 'assistant',
          'tool_calls': [
            {
              'id': 'big',
              'function': {
                'name': 'file_write',
                'arguments': jsonEncode({
                  'path': '/d/out.txt',
                  'content': 'x' * 10000,
                }),
              },
            },
          ],
        },
      ]);
      expect(big['big']!.label, 'out.txt');
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

    testWidgets('an empty step list renders nothing', (tester) async {
      await _pumpGroup(tester, const []);
      expect(tester.takeException(), isNull);
      expect(find.byType(ToolTimeline), findsNothing);
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(body: ToolTimeline(steps: [])),
        ),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a live run whose last step failed ends on a dim dot', (
      tester,
    ) async {
      await _pumpGroup(tester, [
        ..._shells(2),
        const ToolStep(name: 'shell_execute', status: 'failed'),
      ], running: true);
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
      expect(painters.last.state, ToolStepState.dim);
      expect(find.text('未完成'), findsOneWidget);
      expect(find.textContaining('次工具调用'), findsNothing);
    });

    testWidgets('the summary and tappable rows are single semantics buttons', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await _pumpGroup(tester, _shells(3));
      final summary = tester.getSemantics(find.text('3 次工具调用'));
      expect(summary.label, '3 次工具调用');
      expect(summary.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      expect(
        tester.getSize(find.byType(ToolTimeline)).height,
        greaterThanOrEqualTo(44),
      );

      await tester.pumpWidget(const SizedBox());
      await _pumpGroup(tester, [
        ToolStep(
          name: 'shell_execute',
          status: 'completed',
          narration: '检查依赖',
          reasoning: '先检查依赖',
        ),
        const ToolStep(name: 'shell_execute', status: 'completed'),
      ], running: true);
      final row = tester.getSemantics(find.text('检查依赖'));
      expect(row.label, '检查依赖');
      expect(row.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      expect(
        tester.getSize(find.byKey(const ValueKey('tool-step:1:0'))).height,
        greaterThanOrEqualTo(44),
      );
      handle.dispose();
    });

    testWidgets('running with five rows or fewer has no link', (tester) async {
      await _pumpGroup(tester, _shells(5), running: true);
      expect(find.textContaining('更早'), findsNothing);
      expect(find.text('执行命令 · step0'), findsOneWidget);
    });

    testWidgets('finished: the established summary line expands', (
      tester,
    ) async {
      await _pumpGroup(tester, _shells(8));
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
