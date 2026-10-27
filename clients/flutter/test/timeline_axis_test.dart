import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/ui/timeline_page.dart';

PersonalStore timelineStore(List<Map<String, dynamic>> rows) {
  final store = PersonalStore(send: (_) => false);
  store.receive({
    'type': 'personal.state',
    'revision': 1,
    'life': {'todos': rows},
  });
  return store;
}

/// Stand-in generated brief list so the Today header can be tested without
/// building the whole profile pipeline.
class _FakeBriefSummary extends StatelessWidget
    implements TimelineBriefSummary {
  const _FakeBriefSummary(this.count);
  final int count;
  @override
  int todayBriefCount(DateTime now) => count;
  @override
  Widget build(BuildContext context) => const Text('FAKE BRIEF BODY');
}

/// Scrolls to [text] and settles the layout afterwards.
///
/// `scrollUntilVisible` calls `ensureVisible` without pumping one more frame,
/// which can leave a taller P3 list one frame behind the scroll offset.
Future<void> scrollToText(WidgetTester tester, String text) async {
  final scrollable = find.byType(Scrollable).first;
  for (var i = 0; i < 40 && find.text(text).evaluate().isEmpty; i++) {
    await tester.drag(scrollable, const Offset(0, -200));
    await tester.pump();
  }
  expect(find.text(text), findsOneWidget);
  await tester.ensureVisible(find.text(text));
  await tester.pump();
}

void main() {
  for (final width in [320.0, 390.0]) {
    testWidgets('date axis groups shared dates and fits $width px', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = timelineStore([
        {'id': 'one', 'title': '整理项目复盘', 'due': '2020-01-01', 'status': 'open'},
        {'id': 'two', 'title': '补充会议记录', 'due': '2020-01-01', 'status': 'open'},
        {
          'id': 'three',
          'title': '确认下一步安排',
          'due': '2020-01-02',
          'status': 'open',
        },
      ]);
      addTearDown(store.dispose);
      final previewPath = width == 390
          ? Platform.environment['NOVA_TIMELINE_PREVIEW']
          : null;
      var theme = novaTheme();
      if (previewPath != null && previewPath.isNotEmpty) {
        await tester.runAsync(() async {
          final fontPath =
              Platform.environment['NOVA_TIMELINE_PREVIEW_FONT'] ??
              '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
          await (FontLoader('TimelinePreview')..addFont(
                File(fontPath).readAsBytes().then(ByteData.sublistView),
              ))
              .load();
          final config = File('.dart_tool/package_config.json');
          final packages =
              jsonDecode(await config.readAsString())['packages'] as List;
          final icons = packages.singleWhere(
            (p) => p['name'] == 'cupertino_icons',
          );
          await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(
                File.fromUri(
                  config.absolute.uri.resolve(
                    "${icons['rootUri']}/assets/CupertinoIcons.ttf",
                  ),
                ).readAsBytes().then(ByteData.sublistView),
              ))
              .load();
        });
        theme = theme.copyWith(
          textTheme: theme.textTheme.apply(fontFamily: 'TimelinePreview'),
        );
      }
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: RepaintBoundary(
            key: const ValueKey('timeline-preview'),
            child: Scaffold(
              backgroundColor: Nova.ink,
              body: MediaQuery(
                data: MediaQueryData(
                  size: Size(width, 700),
                  textScaler: const TextScaler.linear(1.4),
                ),
                child: TimelinePage(
                  store: store,
                  language: 'zh',
                  now: DateTime(2026, 10, 19, 9),
                ),
              ),
            ),
          ),
        ),
      );
      final header = find.byKey(const ValueKey('timeline-today-header'));
      expect(header, findsOneWidget);
      expect(find.text('今天'), findsOneWidget);
      expect(find.text('10月19日 · 星期一'), findsOneWidget);
      expect(find.byKey(const ValueKey('timeline-today-date')), findsOneWidget);
      expect(find.text('今天暂无安排'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('timeline-plans-label')),
        findsOneWidget,
      );
      expect(find.text('我的安排'), findsOneWidget);
      // No generated brief source on this page: no section label and no
      // invented brief count in the summary.
      expect(
        find.byKey(const ValueKey('timeline-morning-brief-label')),
        findsNothing,
      );
      expect(find.text('晨间简报'), findsNothing);
      expect(
        tester.getTopLeft(header).dy,
        lessThan(tester.getTopLeft(find.text('我的安排')).dy),
      );

      final firstDate = find.byKey(
        const ValueKey('timeline-date-overdue-2020-01-01'),
      );
      final marker = find.byKey(
        const ValueKey('timeline-marker-overdue-2020-01-01'),
      );
      final line = find.byKey(const ValueKey('timeline-line-overdue'));
      expect(firstDate, findsOneWidget);
      expect(find.text('2020年1月1日 · 周三'), findsOneWidget);
      expect(find.text('2020年1月2日 · 周四'), findsOneWidget);
      expect(find.byType(ListTile), findsNWidgets(3));
      expect(
        tester.getTopLeft(marker).dx,
        lessThan(tester.getTopLeft(firstDate).dx),
      );
      expect(
        tester.getTopLeft(marker).dx,
        lessThan(tester.getTopLeft(find.byType(ListTile).first).dx),
      );
      expect(tester.getSize(line).width, 1);
      expect(tester.getSize(line).height, greaterThan(150));
      // The white rounded cards must keep the marker/line gutter on 320px.
      expect(
        tester.getSize(find.byType(ListTile).first).width,
        lessThanOrEqualTo(width),
      );
      expect(tester.takeException(), isNull);
      if (previewPath != null && previewPath.isNotEmpty) {
        await tester.pumpAndSettle();
        final boundary = tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const ValueKey('timeline-preview')),
        );
        await tester.runAsync(() async {
          final image = await boundary.toImage(pixelRatio: 2);
          try {
            final png = await image.toByteData(format: ui.ImageByteFormat.png);
            final file = File(previewPath);
            await file.parent.create(recursive: true);
            await file.writeAsBytes(png!.buffer.asUint8List(), flush: true);
          } finally {
            image.dispose();
          }
        });
      }
    });
  }

  for (final language in ['zh', 'en']) {
    testWidgets(
      'today header counts plans and morning briefs without inventing data',
      (tester) async {
        final store = timelineStore([
          {'id': 'a', 'title': '晨会', 'due': '2026-10-19', 'status': 'open'},
          {'id': 'b', 'title': '写周报', 'due': '2026-10-19', 'status': 'waiting'},
          {'id': 'c', 'title': '已完成事项', 'due': '2026-10-19', 'status': 'done'},
          {
            'id': 'd',
            'title': '取消事项',
            'due': '2026-10-19',
            'status': 'cancelled',
          },
          {'id': 'e', 'title': '过期事项', 'due': '2026-10-18', 'status': 'open'},
        ]);
        addTearDown(store.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: novaTheme(),
            home: Scaffold(
              body: TimelinePage(
                store: store,
                language: language,
                now: DateTime(2026, 10, 19, 9),
                sourceTimeline: const _FakeBriefSummary(1),
              ),
            ),
          ),
        );
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('timeline-today-header')),
            matching: find.text(language == 'zh' ? '今天' : 'Today'),
          ),
          findsOneWidget,
        );
        expect(
          find.text(language == 'zh' ? '10月19日 · 星期一' : 'Oct 19 · Monday'),
          findsOneWidget,
        );
        // Two open/waiting plans due today; the done/cancelled ones and the
        // overdue plan stay out of the summary.
        expect(
          find.text(
            language == 'zh' ? '2 个安排 · 1 条晨间简报' : '2 plans · 1 morning brief',
          ),
          findsOneWidget,
        );
        final label = find.byKey(
          const ValueKey('timeline-morning-brief-label'),
        );
        expect(label, findsOneWidget);
        expect(
          find.text(language == 'zh' ? '晨间简报' : 'Morning brief'),
          findsOneWidget,
        );
        expect(find.text('FAKE BRIEF BODY'), findsOneWidget);
        expect(
          tester.getTopLeft(label).dy,
          lessThan(tester.getTopLeft(find.text('FAKE BRIEF BODY')).dy),
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('today header and morning brief fit 320px at 2x text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = timelineStore([
      {
        'id': 'long',
        'title': '整理今天的长安排',
        'note': '需要保留的详细说明。',
        'due': '2026-10-19',
        'status': 'open',
      },
    ]);
    addTearDown(store.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: novaTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: TimelinePage(
            store: store,
            language: 'zh',
            now: DateTime(2026, 10, 19, 9),
            sourceTimeline: const _FakeBriefSummary(1),
          ),
        ),
      ),
    );
    final header = find.byKey(const ValueKey('timeline-today-header'));
    expect(header, findsOneWidget);
    expect(find.byKey(const ValueKey('timeline-today-date')), findsOneWidget);
    expect(find.text('1 个安排 · 1 条晨间简报'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('timeline-morning-brief-label')),
      findsOneWidget,
    );
    expect(find.text('需要保留的详细说明。'), findsOneWidget);
    expect(tester.getSize(header).width, lessThanOrEqualTo(320));
    await tester.ensureVisible(find.text('整理今天的长安排'));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('English dates keep item details and discuss navigation', (
    tester,
  ) async {
    final store = timelineStore([
      {
        'id': 'one',
        'title': 'Plan',
        'note': 'Recorded context',
        'due': '2020-01-01',
        'status': 'open',
      },
    ]);
    addTearDown(store.dispose);
    String? prompt;
    await tester.pumpWidget(
      MaterialApp(
        theme: novaTheme(),
        home: Scaffold(
          body: TimelinePage(
            store: store,
            language: 'en',
            now: DateTime(2026, 10, 19, 9),
            onDiscuss: (value) => prompt = value,
          ),
        ),
      ),
    );
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Oct 19 · Monday'), findsOneWidget);
    expect(find.text('Past due'), findsOneWidget);
    expect(find.text('Jan 1, 2020 · Wed'), findsOneWidget);
    expect(find.text('2020年1月1日 · 周三'), findsNothing);
    // The card carries the note summary, so the sheet makes it a second copy.
    expect(find.text('Recorded context'), findsOneWidget);
    await tester.tap(find.text('Plan'));
    await tester.pumpAndSettle();
    expect(find.text('Recorded context'), findsNWidgets(2));
    await tester.tap(find.text('Discuss in chat'));
    await tester.pumpAndSettle();
    expect(prompt, 'Let’s discuss this plan: Plan');
    expect(find.text('Recorded context'), findsOneWidget);
    expect(find.byKey(const ValueKey('timeline-axis-overdue')), findsOneWidget);
  });

  testWidgets(
    'undated and completed history remain reachable below dated axis',
    (tester) async {
      final store = timelineStore([
        {
          'id': 'past',
          'title': 'Past plan',
          'due': '2020-01-01',
          'status': 'open',
        },
        {
          'id': 'future',
          'title': 'Future plan',
          'due': '2099-01-01',
          'status': 'open',
        },
        {'id': 'wait', 'title': 'Waiting plan', 'status': 'waiting'},
        {'id': 'unset', 'title': 'Unscheduled plan', 'status': 'open'},
        for (var i = 0; i < 12; i++)
          {
            'id': 'done-$i',
            'title': 'Old completed $i',
            'due': '2019-01-01',
            'status': 'done',
          },
      ]);
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: novaTheme(),
          home: Scaffold(
            body: TimelinePage(
              store: store,
              language: 'en',
              now: DateTime(2026, 10, 19, 9),
            ),
          ),
        ),
      );
      for (final title in [
        'Future plan',
        'Waiting plan',
        'Unscheduled plan',
        'Old completed 11',
      ]) {
        await scrollToText(tester, title);
        expect(find.text(title), findsOneWidget);
      }
      expect(
        find.byKey(const ValueKey('timeline-marker-completed-2019-01-01')),
        findsOneWidget,
      );
      expect(
        find
            .byType(ListTile)
            .evaluate()
            .where(
              (element) => ((element.widget as ListTile).title as Text).data!
                  .startsWith('Old completed'),
            ),
        hasLength(12),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('long plan details scroll to discussion at 320dp and 2x text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = timelineStore([
      {
        'id': 'long',
        'title': '长安排',
        'note': List.filled(30, '需要保留的详细说明。').join(),
        'status': 'open',
      },
    ]);
    String? discussed;
    await tester.pumpWidget(
      MaterialApp(
        theme: novaTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: TimelinePage(
            store: store,
            language: 'zh',
            now: DateTime(2026, 10, 19, 9),
            onDiscuss: (value) => discussed = value,
          ),
        ),
      ),
    );
    // The card summarises the note instead of expanding it.
    expect(find.textContaining('需要保留的详细说明。'), findsOneWidget);
    await tester.tap(find.text('长安排'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('在对话中讨论'));
    await tester.tap(find.text('在对话中讨论'));
    await tester.pumpAndSettle();
    expect(discussed, '一起看看这个安排：长安排');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    store.dispose();
  });
}
