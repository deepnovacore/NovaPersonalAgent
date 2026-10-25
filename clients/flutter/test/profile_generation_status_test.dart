import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'package:nova_mobile/ui/profile_generation_status.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  testWidgets('invalid timeline explains validation failure without retrying', (
    tester,
  ) async {
    var calls = 0;
    final c = ProfileGenerationCoordinator(
      persistence: MemoryLifePersistence(),
      autoSchedule: false,
      inspect: () async => const ProfileGenerationSnapshot(
        scope: 's',
        complete: false,
        hasResult: false,
        covered: 0,
        total: 10,
      ),
      generate:
          ({required savedObservationsOnly, required maxNewBatches}) async {
            calls++;
            throw 'profile_timeline_invalid';
          },
      cancel: () {},
      failureCode: (e) => '$e',
    );
    await c.start();
    await c.poll();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ProfileGenerationStatus(generation: c)),
      ),
    );
    expect(find.text('这次近况未通过校验'), findsOneWidget);
    expect(find.text('生成内容的格式或原文引用不符合要求，已停止自动重试。已有内容会保留。'), findsOneWidget);
    await c.poll();
    expect(calls, 1);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets(
    'empty working state is truthful and budget block has no retry action',
    (tester) async {
      final entered = Completer<void>(), release = Completer<void>();
      final c = ProfileGenerationCoordinator(
        persistence: MemoryLifePersistence(),
        autoSchedule: false,
        inspect: () async => const ProfileGenerationSnapshot(
          scope: 's',
          complete: false,
          hasResult: false,
          covered: 0,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              entered.complete();
              await release.future;
              throw 'profile_budget_exhausted';
            },
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await c.start();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProfileGenerationStatus(generation: c, empty: true),
          ),
        ),
      );
      final run = c.poll();
      await tester.pump();
      await entered.future;
      await tester.pump();
      expect(find.text('整理好后会自动显示在这里。'), findsOneWidget);
      expect(find.textContaining('先查看已有内容'), findsNothing);
      release.complete();
      await run;
      await tester.pump();
      expect(find.text('本次整理已暂停'), findsOneWidget);
      expect(find.text('重试'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
  testWidgets('failed retry can be paused before another paid round', (
    tester,
  ) async {
    var attempts = 0;
    var clock = DateTime.utc(2026, 10, 19);
    final c = ProfileGenerationCoordinator(
      persistence: MemoryLifePersistence(),
      autoSchedule: false,
      now: () => clock,
      inspect: () async => const ProfileGenerationSnapshot(
        scope: 's',
        complete: false,
        hasResult: false,
        covered: 0,
        total: 10,
      ),
      generate:
          ({required savedObservationsOnly, required maxNewBatches}) async {
            attempts++;
            throw 'ungrounded_projection';
          },
      cancel: () {},
      failureCode: (e) => '$e',
    );
    await c.start();
    await c.poll();
    expect(c.phase, ProfileGenerationPhase.failed);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ProfileGenerationStatus(generation: c)),
      ),
    );
    expect(find.text('重试'), findsOneWidget);
    expect(find.text('暂停'), findsOneWidget);
    await tester.tap(find.text('暂停'));
    await tester.pump();
    expect(c.phase, ProfileGenerationPhase.paused);
    clock = clock.add(const Duration(minutes: 5));
    await c.poll();
    expect(attempts, 1);
    expect(find.text('继续'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets(
    'completed empty section does not ask a synced user to sync again',
    (tester) async {
      final c = ProfileGenerationCoordinator(
        persistence: MemoryLifePersistence(),
        autoSchedule: false,
        inspect: () async => const ProfileGenerationSnapshot(
          scope: 's',
          complete: true,
          hasResult: true,
          covered: 5,
          total: 5,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async =>
                fail('unexpected'),
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await c.start();
      await c.poll();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ProfileGenerationStatus(
              generation: c,
              empty: true,
              emptyLabel: '暂时没有可确认的个人信息',
            ),
          ),
        ),
      );
      expect(find.text('暂时没有可确认的个人信息'), findsOneWidget);
      expect(find.textContaining('消息同步后'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
}
