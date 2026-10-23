import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'package:nova_mobile/ui/profile_generation_status.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'package:nova_mobile/personal/models.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'package:nova_mobile/ui/workbench_page.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class ReadyHost extends FeishuHost {
  ReadyHost(SourceStore sources) : super(sources: sources) {
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

class _RetainedProfile extends ProfileRepository {
  _RetainedProfile(super.persistence, super.publication, super.sources);
  @override
  Future<void> open() async {}
  @override
  Map<String, dynamic> get value => {
    'generated_at': '2026-10-19T05:17:00Z',
    'historical': true,
    'partial': true,
    'incomplete_batches': 1,
    'available_evidence_ids': <String>[],
    'coverage': {
      'eligible_records': 10,
      'validated_observation_records': 2,
      'final_original_records': 1,
      'unobserved_records': 8,
    },
    'entries': [
      {
        'key': 'event',
        'kind': 'timeline',
        'text': 'Retained timeline content.',
        'observed_at': '2026-10-18T05:17:00Z',
        'evidence_ids': <String>[],
      },
      {
        'key': 'about',
        'kind': 'profile',
        'text': 'Retained profile content.',
        'evidence_ids': <String>[],
      },
    ],
  };
}

void main() {
  for (final expire in [false, true]) {
    testWidgets(
      'local history survives ${expire ? 'expiry' : 'processing withdrawal'} and unavailable evidence stays hidden',
      (tester) async {
        var now = DateTime.utc(2026, 10, 18);
        final sourceTime = now
            .subtract(const Duration(days: 30))
            .add(const Duration(seconds: 2));
        final sources = SourceStore(MemoryLifePersistence(), now: () => now);
        await sources.bind('self', 1);
        await sources.select('c', sourceTime);
        await sources.ingestPage(
          sources.fence('c'),
          [
            {
              'message_id': 'm',
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time': '${sourceTime.millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {'content': '{"text":"synthetic original plan"}'},
            },
          ],
          nextPage: null,
          windowEnd: now,
        );
        await sources.grantProcessing('p', 'profile', true);
        final host = ReadyHost(sources);
        final publication = LocalPublicationContext(MemoryLifePersistence());
        await publication.open();
        final disk = MemoryLifePersistence();
        final profile = ProfileRepository(disk, publication, sources);
        final ref = sources.messages('c').single['evidence_id'];
        await profile.publish(
          jsonEncode([
            {
              'key': 'about',
              'kind': 'profile',
              'text': 'Grounded profile',
              'evidence_ids': [ref],
            },
            {
              'key': 'event',
              'kind': 'timeline',
              'text': 'Grounded plan',
              'observed_at': sourceTime.toIso8601String(),
              'evidence_ids': [ref],
            },
          ]),

          sourceRevision: sources.revision,
          consentRevision: sources.processingRevision,
          provider: 'p',
          incompleteBatches: 1,
          partial: true,
          coverage: {
            'eligible_records': 10,
            'validated_observation_records': 2,
            'final_original_records': 1,
            'unobserved_records': 8,
          },
        );
        final saved = disk.value;
        final priorRevision = profile.value!['revision'];
        await expectLater(
          profile.publish(
            jsonEncode(profile.value!['entries']),

            sourceRevision: sources.revision,
            consentRevision: sources.processingRevision,
            provider: 'p',
            partial: true,
            coverage: {
              'eligible_records': 10,
              'validated_observation_records': 1,
              'final_original_records': 1,
              'unobserved_records': 9,
            },
          ),
          throwsA(
            isA<StateError>().having(
              (e) => e.message,
              'code',
              'profile_result_more_complete',
            ),
          ),
        );
        expect(disk.value, saved);
        expect(profile.value!['revision'], priorRevision);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: LocalProfileResults(
                  host: host,
                  publication: publication,
                  repository: profile,
                  kind: 'all',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Grounded profile'), findsOneWidget);
        expect(find.text('部分内容'), findsOneWidget);
        expect(find.textContaining('近况可能不完整'), findsNothing);
        expect(find.textContaining('已整理 2 / 10 条消息'), findsNothing);
        await tester.ensureVisible(find.text('整理范围'));
        await tester.tap(find.text('整理范围'));
        await tester.pumpAndSettle();
        expect(find.textContaining('已整理 2 / 10 条消息'), findsOneWidget);
        expect(find.textContaining('还有 8 条待整理'), findsOneWidget);
        expect(find.textContaining('近况可能不完整'), findsOneWidget);
        final reopened = ProfileRepository(disk, publication, sources);
        await reopened.open();
        expect(reopened.value?['partial'], true);
        expect(reopened.value?['coverage']['final_original_records'], 1);
        expect(disk.value, saved);
        await tester.ensureVisible(find.text('Grounded plan'));
        await tester.tap(find.text('Grounded plan'));
        await tester.pumpAndSettle();
        expect(find.text('synthetic original plan'), findsOneWidget);
        if (expire) {
          now = now.add(const Duration(days: 30, seconds: 3));
          await tester.pump(const Duration(days: 30, seconds: 3));
        } else {
          await sources.grantProcessing('p', 'profile', false);
        }
        await tester.pumpAndSettle();
        expect(find.text('synthetic original plan'), findsNothing);
        expect(find.text('原始来源已不可用，仍保留此前整理的内容。'), findsOneWidget);
        await tester.tap(find.text('关闭'));
        await tester.pumpAndSettle();
        expect(find.text('Grounded profile'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
        host.dispose();
        publication.dispose();
      },
    );
  }
  for (final language in ['zh', 'en']) {
    for (final kind in ['timeline', 'profile']) {
      for (final phase in [
        ProfileGenerationPhase.working,
        ProfileGenerationPhase.paused,
        ProfileGenerationPhase.ready,
        ProfileGenerationPhase.waiting,
      ]) {
        testWidgets(
          'retained $kind is prominent with one $phase status in $language',
          (tester) async {
            final width = language == 'zh' ? 320.0 : 360.0;
            tester.view.physicalSize = Size(width, 820);
            tester.view.devicePixelRatio = 1;
            addTearDown(tester.view.resetPhysicalSize);
            addTearDown(tester.view.resetDevicePixelRatio);
            final sources = SourceStore(MemoryLifePersistence());
            final host = ReadyHost(sources);
            final publication = LocalPublicationContext(MemoryLifePersistence());
            await publication.open();
            final repository = _RetainedProfile(
              MemoryLifePersistence(),
              publication,
              sources,
            );
            final generation = ProfileGenerationCoordinator(
              persistence: MemoryLifePersistence(),
              autoSchedule: false,
              inspect: () async => null,
              generate:
                  ({
                    required savedObservationsOnly,
                    required maxNewBatches,
                  }) async => fail('UI test must not generate'),
              cancel: () {},
              failureCode: (e) => '$e',
            )..phase = phase;
            if (phase == ProfileGenerationPhase.paused) {
              generation.code = 'profile_budget_exhausted';
            }
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
                  body: SingleChildScrollView(
                    padding: const EdgeInsets.all(20),
                    child: LocalProfileResults(
                      host: host,
                      publication: publication,
                      repository: repository,
                      generation: generation,
                      kind: kind,
                      language: language,
                    ),
                  ),
                ),
              ),
            );
            await tester.pump();
            final text = kind == 'timeline'
                ? 'Retained timeline content.'
                : 'Retained profile content.';
            expect(find.text(text), findsOneWidget);
            expect(
              find.textContaining(language == 'zh' ? '最近成功整理' : 'Updated ·'),
              findsOneWidget,
            );
            expect(
              find.text(language == 'zh' ? '历史结果' : 'Saved'),
              findsOneWidget,
            );
            expect(
              find.text(language == 'zh' ? '部分内容' : 'Partial'),
              findsOneWidget,
            );
            expect(find.byType(ProfileGenerationStatus), findsOneWidget);
            expect(
              find.textContaining(
                language == 'zh' ? '这是上次整理的结果' : 'These saved results',
              ),
              findsNothing,
            );
            expect(
              find.textContaining(
                language == 'zh' ? '还有部分内容待整理' : 'Some content remains',
              ),
              findsNothing,
            );
            expect(
              find.textContaining(
                language == 'zh' ? '无法与原文核对' : 'could not be checked',
              ),
              findsNothing,
            );
            expect(tester.getTopLeft(find.text(text)).dy, lessThan(820 * .8));
            if (phase == ProfileGenerationPhase.paused) {
              expect(
                find.text(
                  language == 'zh'
                      ? '已达到本次费用上限，现有内容会保留。'
                      : 'Cost limit reached. Results kept.',
                ),
                findsOneWidget,
              );
              final resume = find.widgetWithText(
                TextButton,
                language == 'zh' ? '继续' : 'Continue',
              );
              expect(resume, findsOneWidget);
              expect(tester.widget<TextButton>(resume).onPressed, isNotNull);
            }
            final details = find.text(
              language == 'zh' ? '整理范围' : 'Review coverage',
            );
            expect(
              tester.getTopLeft(details).dy,
              greaterThan(tester.getTopLeft(find.text(text)).dy),
            );
            await tester.ensureVisible(details);
            await tester.tap(details);
            await tester.pump(const Duration(milliseconds: 300));
            expect(
              find.textContaining(
                language == 'zh' ? '这是上次整理的结果' : 'These saved results',
              ),
              findsOneWidget,
            );
            expect(
              find.textContaining(
                language == 'zh' ? '还有部分内容待整理' : 'Some content remains',
              ),
              findsOneWidget,
            );
            expect(
              find.textContaining(
                language == 'zh' ? '无法与原文核对' : 'could not be checked',
              ),
              findsOneWidget,
            );
            expect(
              find.textContaining(
                language == 'zh'
                    ? '已整理 2 / 10 条消息'
                    : '2 / 10 messages reviewed',
              ),
              findsOneWidget,
            );
            expect(find.text(text), findsOneWidget);
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
            generation.dispose();
            host.dispose();
            publication.dispose();
          },
        );
      }
    }
  }

  testWidgets('an explicitly cleared introduction suppresses inferred about', (
    tester,
  ) async {
    final store = PersonalStore(send: (_) => false)
      ..restore(
        PersonalSnapshot({
          'revision': 1,
          'life': {
            'profile': {'version': 1, 'about': ''},
          },
        }),
      );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkbenchPage(
            store: store,
            page: 5,
            onSettings: () {},
            localProfile: (excludeAbout) =>
                Text(excludeAbout ? 'explicit wins' : 'inferred about'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('explicit wins'), findsOneWidget);
    expect(find.text('inferred about'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    store.dispose();
  });
}
