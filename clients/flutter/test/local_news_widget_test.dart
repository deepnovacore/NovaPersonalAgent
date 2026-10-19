import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/personal/local_news.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/workbench_page.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'local_news_test.dart' show rss, source, now;

void main() {
  for (final brightness in Brightness.values) {
    testWidgets(
      'news segmented labels have readable contrast in ${brightness.name} theme',
      (tester) async {
        final life = LocalLife(MemoryLifePersistence());
        await life.open();
        final store = PersonalStore(send: (_) => false, local: life);
        addTearDown(() {
          store.dispose();
          life.dispose();
        });
        final theme = brightness == Brightness.light
            ? novaTheme()
            : ThemeData(brightness: brightness);
        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            home: WorkbenchPage(
              store: store,
              page: 1,
              language: 'zh',
              onSettings: () {},
            ),
          ),
        );
        await tester.pumpAndSettle();
        void checkContrast() {
          final control = tester.widget<CupertinoSlidingSegmentedControl<bool>>(
            find.byType(CupertinoSlidingSegmentedControl<bool>),
          );
          for (final entry in {false: '最新', true: '收藏'}.entries) {
            final label = find.text(entry.value);
            final text = tester.widget<Text>(label);
            final foreground =
                text.style?.color ??
                DefaultTextStyle.of(tester.element(label)).style.color!;
            final background = control.groupValue == entry.key
                ? control.thumbColor
                : control.backgroundColor;
            final a = foreground.computeLuminance(),
                b = background.computeLuminance();
            final contrast = a > b
                ? (a + .05) / (b + .05)
                : (b + .05) / (a + .05);
            expect(
              contrast,
              greaterThanOrEqualTo(4.5),
              reason:
                  '${entry.value}, selected=${control.groupValue == entry.key}',
            );
          }
        }

        checkContrast();
        await tester.tap(find.text('收藏'));
        await tester.pumpAndSettle();
        checkContrast();
        expect(find.byTooltip('刷新'), findsOneWidget);
      },
    );
  }

  testWidgets(
    'news refresh waits for fetch; local bookmark and read work without runtime',
    (tester) async {
      final pending = Completer<String>();
      var calls = 0;
      final news = LocalNews(
        MemoryLifePersistence(),
        sources: [source],
        language: 'en',
        now: () => now,
        fetcher: (_) async => ++calls == 1 ? rss : pending.future,
      );
      await news.open();
      // Real IO is injected; widget clock needs an explicit pump for refresh's yield.
      final loading = news.refresh();
      await tester.pump(const Duration(milliseconds: 1));
      await loading;
      final life = LocalLife(MemoryLifePersistence());
      await life.open();
      final store = PersonalStore(
        send: (_) => throw StateError('runtime forbidden'),
        local: life,
        news: news,
      );
      addTearDown(() {
        store.dispose();
        news.dispose();
        life.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: novaTheme(),
          home: WorkbenchPage(store: store, page: 1, onSettings: () {}),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('New & useful'), findsOneWidget);
      await tester.tap(find.byTooltip('Save article').first);
      await tester.pumpAndSettle();
      expect(store.snapshot!.object('news')['saved'], hasLength(1));
      await tester.tap(find.text('New & useful'));
      await tester.pumpAndSettle();
      expect(
        (store.snapshot!.object('news')['items'] as List).first['read'],
        true,
      );
      Navigator.of(tester.element(find.text('Open original'))).pop();
      await tester.pumpAndSettle();
      var finished = false;
      final refresh = tester
          .state<RefreshIndicatorState>(find.byType(RefreshIndicator))
          .show()
          .then((_) => finished = true);
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(milliseconds: 1));
      expect(calls, 2);
      expect(finished, false);
      pending.complete(rss);
      await tester.pumpAndSettle();
      await refresh;
      expect(finished, true);
      expect(find.textContaining('Mac'), findsNothing);
    },
  );
  testWidgets(
    'language synchronization does not notify sibling widgets during build',
    (tester) async {
      final news = LocalNews(MemoryLifePersistence(), language: 'en');
      await news.open();
      final life = LocalLife(MemoryLifePersistence());
      await life.open();
      final store = PersonalStore(send: (_) => false, local: life, news: news);
      addTearDown(() {
        store.dispose();
        news.dispose();
        life.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: novaTheme(),
          home: Column(
            children: [
              ListenableBuilder(
                listenable: store,
                builder: (_, _) => const SizedBox(),
              ),
              Expanded(
                child: WorkbenchPage(
                  store: store,
                  page: 1,
                  language: 'zh',
                  onSettings: () {},
                ),
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect((news.snapshot()['sources'] as List).map((s) => s['id']), [
        'ithome',
        'sspai',
        'solidot',
        '36kr',
      ]);
      expect(find.text('公开资讯 · 按时间排序'), findsOneWidget);
    },
  );
}
