import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'local_profile_results_test.dart' show ReadyHost;

class _PublishedProfile extends ProfileRepository {
  _PublishedProfile(
    super.persistence,
    super.authority,
    super.sources,
    this.saved,
  );
  final Map<String, dynamic> saved;
  int reads = 0;
  @override
  Map<String, dynamic> get value {
    reads++;
    return saved;
  }

  @override
  Future<void> open() async {}
}

// A cached source view can still contain records whose access just expired.
class _ExpiredSourceView extends SourceStore {
  _ExpiredSourceView()
    : super(MemoryLifePersistence(), now: () => DateTime.utc(2026, 12, 1));
  @override
  List<String> get sources => ['chat'];
  @override
  List<Map<String, dynamic>> messages(String id) => [
    {
      'evidence_id': 'ref',
      'created_at': DateTime.utc(2026, 10, 19).millisecondsSinceEpoch,
      'status': 'available',
      'text': 'Already expired original',
    },
  ];
}

Map<String, dynamic> _entry({bool steps = true}) => {
  'key': 'brief',
  'kind': 'timeline',
  'text': '兼容旧客户端的完整正文',
  'evidence_ids': ['ref'],
  'observed_at': '2026-10-19T09:00:00',
  'brief': {
    'title': '项目验收还差环境复核',
    'status_label': '待确认',
    'facts': [
      {'text': '同事报告接口检查已完成。', 'ref': 'ref', 'quote': '接口检查已完成'},
      {'text': '测试环境仍待复核。', 'ref': 'ref', 'quote': '环境待复核'},
    ],
    'why_now': '环境结果决定能否安排验收。',
    'next_steps': steps
        ? [
            {'title': '确认测试环境', 'detail': '先核对环境复核结果，再讨论验收时间。'},
          ]
        : [],
    'uncertainty': '尚未看到环境复核结论。',
  },
};

void main() {
  testWidgets('expired history settles without repeatedly scheduling expiry', (
    tester,
  ) async {
    final sources = _ExpiredSourceView();
    final host = ReadyHost(sources);
    final authority = SpaceAuthorityRepository(MemoryLifePersistence());
    final profile = _PublishedProfile(
      MemoryLifePersistence(),
      authority,
      sources,
      {
        'entries': [_entry(steps: false)],
        'available_evidence_ids': <String>[],
        'historical': true,
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: LocalProfileResults(
              host: host,
              authority: authority,
              repository: profile,
              kind: 'timeline',
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle(
      const Duration(milliseconds: 100),
      EnginePhase.sendSemanticsUpdate,
      const Duration(seconds: 1),
    );
    expect(find.text('项目验收还差环境复核'), findsOneWidget);
    expect(find.text('原始来源已不可用 · 保留此前整理内容'), findsOneWidget);
    final settledReads = profile.reads;
    await tester.pump(const Duration(minutes: 1));
    await tester.pumpAndSettle(
      const Duration(milliseconds: 100),
      EnginePhase.sendSemanticsUpdate,
      const Duration(seconds: 1),
    );
    expect(
      profile.reads,
      settledReads,
      reason: 'Expired sources must not schedule repeated rebuilds.',
    );
    expect(tester.binding.hasScheduledFrame, false);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    host.dispose();
    authority.dispose();
  });
  for (final width in [320.0, 360.0]) {
    testWidgets(
      'brief cards and legacy history fit $width at 2x without duplicated prose',
      (tester) async {
        tester.view.physicalSize = Size(width, 740);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final sources = SourceStore(MemoryLifePersistence());
        final host = ReadyHost(sources);
        final authority = SpaceAuthorityRepository(MemoryLifePersistence());
        final saved = <String, dynamic>{
          'entries': [
            _entry(),
            {
              'key': 'same-day',
              'kind': 'timeline',
              'text': '同一天的补充记录',
              'evidence_ids': ['old'],
              'observed_at': '2026-10-19T08:00:00',
            },
            {
              'key': 'legacy',
              'kind': 'timeline',
              'text': '此前保留的项目讨论',
              'evidence_ids': ['old'],
              'observed_at': '2026-10-18T10:00:00',
            },
          ],
          'available_evidence_ids': <String>[],
          'partial': true,
          'coverage': {
            'eligible_records': 20,
            'validated_observation_records': 8,
            'final_original_records': 3,
            'unobserved_records': 12,
          },
        };
        final profile = _PublishedProfile(
          MemoryLifePersistence(),
          authority,
          sources,
          saved,
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: novaTheme(),
            home: Scaffold(
              body: MediaQuery(
                data: const MediaQueryData(textScaler: TextScaler.linear(2)),
                child: SingleChildScrollView(
                  child: LocalProfileResults(
                    host: host,
                    authority: authority,
                    repository: profile,
                    kind: 'timeline',
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('项目验收还差环境复核'), findsOneWidget);
        expect(find.text('待确认'), findsOneWidget);
        expect(find.text('同事报告接口检查已完成。'), findsOneWidget);
        expect(find.text('环境结果决定能否安排验收。'), findsOneWidget);
        expect(find.text('确认测试环境'), findsOneWidget);
        expect(find.text('兼容旧客户端的完整正文'), findsNothing);
        expect(find.text('此前保留的项目讨论'), findsOneWidget);
        expect(find.textContaining('更新依据 ·'), findsNWidgets(3));
        final line = find.byKey(const ValueKey('brief-timeline-line'));
        final date = find.byKey(
          const ValueKey('brief-timeline-date-2026-10-19T00:00:00.000'),
        );
        final marker = find.byKey(
          const ValueKey('brief-timeline-marker-2026-10-19T00:00:00.000'),
        );
        expect(date, findsOneWidget);
        expect(find.text('2026年10月19日'), findsOneWidget);
        expect(find.text('2026年10月18日'), findsOneWidget);
        expect(tester.getSize(line).width, 1);
        expect(tester.getSize(line).height, greaterThan(150));
        expect(
          tester.getTopLeft(marker).dx,
          lessThan(tester.getTopLeft(date).dx),
        );
        final first = find.byKey(const ValueKey('timeline-card-brief'));
        final sameDay = find.byKey(const ValueKey('timeline-card-same-day'));
        final older = find.byKey(const ValueKey('timeline-card-legacy'));
        expect(
          tester.getTopLeft(marker).dx,
          lessThan(tester.getTopLeft(first).dx),
        );
        expect(
          tester.getTopLeft(first).dy,
          lessThan(tester.getTopLeft(sameDay).dy),
        );
        expect(
          tester.getTopLeft(sameDay).dy,
          lessThan(tester.getTopLeft(older).dy),
        );
        expect(find.textContaining('消息日期 ·'), findsNothing);
        expect(find.text('部分内容'), findsOneWidget);
        expect(find.text('还有部分内容待整理，后续进展可能尚未包含。'), findsNothing);
        expect(find.textContaining('已整理 8 / 20'), findsNothing);
        await tester.ensureVisible(find.text('整理范围'));
        await tester.tap(find.text('整理范围'));
        await tester.pumpAndSettle();
        expect(find.text('还有部分内容待整理，后续进展可能尚未包含。'), findsOneWidget);
        expect(find.textContaining('已整理 8 / 20 条消息'), findsOneWidget);
        expect(find.textContaining('还有 12 条待整理'), findsOneWidget);
        expect(find.text('加入待办'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        host.dispose();
        authority.dispose();
      },
    );
  }

  testWidgets(
    'no next step produces no empty section and missing originals stay unavailable',
    (tester) async {
      final sources = SourceStore(MemoryLifePersistence());
      final host = ReadyHost(sources);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      final profile = _PublishedProfile(
        MemoryLifePersistence(),
        authority,
        sources,
        {
          'entries': [_entry(steps: false)],
          'available_evidence_ids': <String>[],
        },
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: LocalProfileResults(
                host: host,
                authority: authority,
                repository: profile,
                kind: 'timeline',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('下一步'), findsNothing);
      expect(find.text('原始来源已不可用 · 保留此前整理内容'), findsOneWidget);
      await tester.ensureVisible(find.text('查看 1 条原文 ›'));
      await tester.tap(find.text('查看 1 条原文 ›'));
      await tester.pumpAndSettle();
      expect(find.text('原始来源已不可用，仍保留此前整理的内容。'), findsOneWidget);
      expect(find.byType(SelectableText), findsNothing);
      await tester.tap(find.text('关闭'));
      await tester.pumpAndSettle();
      expect(find.text('项目验收还差环境复核'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      authority.dispose();
    },
  );
}
