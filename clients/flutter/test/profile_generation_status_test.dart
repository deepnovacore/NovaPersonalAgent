import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'package:nova_mobile/ui/profile_generation_status.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
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
