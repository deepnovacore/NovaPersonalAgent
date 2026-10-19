import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/ui/timeline_page.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class _ReadyHost extends FeishuHost {
  _ReadyHost(SourceStore sources) : super(sources: sources) {
    sources.addListener(notifyListeners);
  }
  @override
  bool get ready => true;
  @override
  void dispose() {
    sources.removeListener(notifyListeners);
    super.dispose();
  }
}

class _ControlledPersistence extends MemoryLifePersistence {
  Completer<String?>? pending;
  bool failRead = false;
  @override
  Future<String?> read() async {
    if (failRead) throw StateError('locked');
    return pending == null ? value : await pending!.future;
  }
}

class _Fixture {
  final now = DateTime(2026, 10, 18, 18);
  late final sources = SourceStore(MemoryLifePersistence(), now: () => now);
  late final host = _ReadyHost(sources);
  final authority = SpaceAuthorityRepository(MemoryLifePersistence());
  final disk = _ControlledPersistence();
  late final profile = ProfileRepository(disk, authority, sources);
  final life = PersonalStore(send: (_) => false);

  Future<void> open({bool publish = true}) async {
    await authority.open();
    await sources.bind('self', 1);
    final times = [
      DateTime(2026, 10, 16, 10),
      DateTime(2026, 10, 17, 9),
      DateTime(2026, 10, 17, 15),
    ];
    await sources.select('c', times.first);
    // Deliberately insert in reverse order so evidence sorting is observable.
    await sources.ingestPage(
      sources.fence('c'),
      [
        for (final i in [2, 1, 0])
          {
            'message_id': 'm$i',
            'sender': {'id_type': 'open_id', 'id': 'self'},
            'create_time': '${times[i].millisecondsSinceEpoch}',
            'msg_type': 'text',
            'body': {
              'content': jsonEncode({'text': '原始依据 $i'}),
            },
          },
      ],
      nextPage: null,
      windowEnd: now,
    );
    await sources.grantProcessing('p', 'profile', true);
    final refs = {
      for (final m in sources.messages('c')) m['created_at']: m['evidence_id'],
    };
    if (publish) {
      await profile.publish(
        jsonEncode([
          for (final i in [0, 1, 2])
            {
              'key': 'event_$i',
              'kind': 'timeline',
              'text': [
                '较早的项目讨论',
                '当天上午的计划',
                '最新的项目进展：确认已完成的部分，并保留下一步尚待讨论的安排。',
              ][i],
              'observed_at': times[i].toIso8601String(),
              'evidence_ids': i == 2
                  ? [
                      refs[times[2].millisecondsSinceEpoch],
                      refs[times[0].millisecondsSinceEpoch],
                    ]
                  : [refs[times[i].millisecondsSinceEpoch]],
            },
        ]),
        epoch: authority.epoch,
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: 'p',
      );
    }
    life.receive({
      'type': 'personal.state',
      'revision': 1,
      'life': {
        'todos': [
          {'id': 'life', 'title': '独立的待办安排', 'status': 'open'},
        ],
      },
    });
  }

  Widget app({double scale = 1, String language = 'zh'}) => MaterialApp(
    theme: novaTheme(),
    home: Scaffold(
      body: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: TimelinePage(
          store: life,
          language: language,
          sourceTimeline: LocalProfileResults(
            host: host,
            authority: authority,
            repository: profile,
            kind: 'timeline',
            language: language,
          ),
        ),
      ),
    ),
  );

  void dispose() {
    host.dispose();
    authority.dispose();
    life.dispose();
  }
}

void main() {
  for (final width in [320.0, 360.0]) {
    testWidgets(
      'generated source timeline groups newest first and fits $width at large text',
      (tester) async {
        tester.view.physicalSize = Size(width, 740);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final f = _Fixture();
        await f.open();
        await tester.pumpWidget(f.app(scale: 2));
        await tester.pumpAndSettle();
        expect(find.text('消息日期 · 2026年10月17日'), findsOneWidget);
        expect(find.text('消息日期 · 2026年10月16日'), findsOneWidget);
        final cards = tester
            .widgetList<ListTile>(find.byType(ListTile))
            .toList();
        String title(ListTile card) =>
            ((card.title as Column).children.last as Text).data!;
        expect(cards.take(3).map(title).toList(), [
          '最新的项目进展：确认已完成的部分，并保留下一步尚待讨论的安排。',
          '当天上午的计划',
          '较早的项目讨论',
        ]);
        expect(find.text('15:00'), findsOneWidget);
        expect(find.text('查看 2 条原文 ›'), findsOneWidget);
        expect(find.textContaining('事情发生的时间'), findsOneWidget);
        await tester.ensureVisible(find.text('查看 2 条原文 ›'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('查看 2 条原文 ›'));
        await tester.pumpAndSettle();
        final evidence = tester
            .widgetList<SelectableText>(find.byType(SelectableText))
            .map((w) => w.data)
            .toList();
        expect(evidence, ['原始依据 0', '原始依据 2']);
        await tester.tap(find.text('关闭'));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('独立的待办安排'),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('独立的待办安排'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
    );
  }

  testWidgets(
    'local loading, failed read, retry, and no generated results are distinct',
    (tester) async {
      final f = _Fixture();
      await f.open(publish: false);
      f.disk.pending = Completer<String?>();
      await tester.pumpWidget(f.app());
      expect(find.text('正在加载近况…'), findsOneWidget);
      expect(find.text('还没有飞书近况'), findsNothing);
      f.disk.pending!.completeError(StateError('locked'));
      await tester.pumpAndSettle();
      expect(find.text('暂时无法加载近况'), findsOneWidget);
      f.disk.pending = null;
      await tester.tap(find.text('重试'));
      await tester.pumpAndSettle();
      expect(find.text('还没有飞书近况'), findsOneWidget);
      expect(find.text('暂时无法加载近况'), findsNothing);
      expect(find.text('独立的待办安排'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    },
  );
  for (final width in [320.0, 360.0]) {
    testWidgets(
      'English source states and retry stay usable at $width with 2x text',
      (tester) async {
        tester.view.physicalSize = Size(width, 740);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final f = _Fixture();
        await f.open(publish: false);
        f.disk.pending = Completer<String?>();
        await tester.pumpWidget(f.app(scale: 2, language: 'en'));
        expect(find.text('Loading updates…'), findsOneWidget);
        f.disk.pending!.completeError(StateError('unavailable'));
        await tester.pumpAndSettle();
        expect(find.text('Could not load updates'), findsOneWidget);
        expect(find.textContaining('解锁'), findsNothing);
        await tester.ensureVisible(find.text('Retry'));
        f.disk.pending = null;
        await tester.tap(find.text('Retry'));
        await tester.pumpAndSettle();
        expect(find.text('No Feishu updates yet'), findsOneWidget);
        expect(
          find.text('Updates appear automatically after messages sync and access is allowed.'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
    );
  }
  testWidgets(
    'English source timeline retains message-date semantics and source access',
    (tester) async {
      final f = _Fixture();
      await f.open();
      await tester.pumpWidget(f.app(language: 'en'));
      await tester.pumpAndSettle();
      expect(find.text('Message date · 2026-10-17'), findsOneWidget);
      expect(find.text('View 2 source messages ›'), findsOneWidget);
      await tester.tap(find.text('View 2 source messages ›'));
      await tester.pumpAndSettle();
      expect(find.text('Source messages'), findsOneWidget);
      expect(find.text('原始依据 0'), findsOneWidget);
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    },
  );
}
