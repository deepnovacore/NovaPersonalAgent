import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  for (final outcome in ['empty', 'partial', 'complete']) {
    test(
      'single round pauses durably after $outcome output without cancelling',
      () async {
        final disk = MemoryLifePersistence();
        var time = DateTime.utc(2026), calls = 0, cancels = 0;
        var returned = false;
        ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
          persistence: disk,
          autoSchedule: false,
          pauseAfterRound: true,
          now: () => time,
          inspect: () async => ProfileGenerationSnapshot(
            scope: 'unchanged',
            complete: returned && outcome == 'complete',
            hasResult: returned && outcome != 'empty',
            covered: returned && outcome != 'empty' ? 5 : 0,
            total: 10,
            pendingOutput: returned && outcome == 'partial',
            outputBatches: returned && outcome != 'empty' ? 1 : 0,
          ),
          generate:
              ({required savedObservationsOnly, required maxNewBatches}) async {
                calls++;
                expect(savedObservationsOnly, true);
                returned = true;
              },
          cancel: () {
            cancels++;
          },
          failureCode: (e) => '$e',
        );
        final first = create();
        await first.start();
        await first.poll();
        expect(calls, 1);
        expect(cancels, 0);
        expect(first.phase, ProfileGenerationPhase.paused);
        expect(first.manuallyPaused, true);
        final durable = jsonDecode(disk.value!);
        expect(durable['manual_pause'], true);
        expect(durable['stage'], 'saved');
        expect(durable['status'], 'paused');
        for (var i = 0; i < 4; i++) {
          time = time.add(const Duration(days: 1));
          first.wake();
          await first.poll();
        }
        expect(calls, 1);
        expect(cancels, 0);
        first.dispose();
        final next = create();
        await next.start();
        for (var i = 0; i < 4; i++) {
          next.wake();
          await next.poll();
        }
        expect(calls, 1);
        expect(next.phase, ProfileGenerationPhase.paused);
        expect(next.manuallyPaused, true);
        next.dispose();
      },
    );
  }

  for (final code in [
    'profile_no_saved_observations',
    'model_timeout',
    'profile_budget_exhausted',
    'profile_timeline_deferred',
  ]) {
    test(
      'single round failure $code cannot fall through into another paid round',
      () async {
        final disk = MemoryLifePersistence();
        var calls = 0, cancels = 0;
        var time = DateTime.utc(2026);
        ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
          persistence: disk,
          autoSchedule: false,
          pauseAfterRound: true,
          now: () => time,
          inspect: () async => const ProfileGenerationSnapshot(
            scope: 'unchanged',
            complete: false,
            hasResult: false,
            covered: 0,
            total: 10,
          ),
          generate:
              ({required savedObservationsOnly, required maxNewBatches}) async {
                calls++;
                throw code;
              },
          cancel: () {
            cancels++;
          },
          failureCode: (e) => '$e',
        );
        final first = create();
        await first.start();
        await first.poll();
        expect(calls, 1);
        expect(cancels, 0);
        expect(first.phase, ProfileGenerationPhase.paused);
        final durable = jsonDecode(disk.value!);
        expect(durable['manual_pause'], true);
        expect(durable['stage'], 'saved');
        if (code == 'profile_budget_exhausted' ||
            code == 'profile_timeline_deferred') {
          expect(durable['terminal_code'], code);
        }
        time = time.add(const Duration(days: 1));
        first.wake();
        await first.poll();
        expect(calls, 1);
        first.dispose();
        final next = create();
        await next.start();
        next.wake();
        await next.poll();
        expect(calls, 1);
        expect(next.phase, ProfileGenerationPhase.paused);
        if (code == 'profile_budget_exhausted' ||
            code == 'profile_timeline_deferred') {
          expect(jsonDecode(disk.value!)['terminal_code'], code);
        }
        next.dispose();
      },
    );
  }

  test(
    'single round lets the entire in-flight generation finish before pausing',
    () async {
      final disk = MemoryLifePersistence();
      final entered = Completer<void>(), release = Completer<void>();
      var calls = 0, cancels = 0, streamCompleted = false;
      final c = ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
        pauseAfterRound: true,
        inspect: () async => ProfileGenerationSnapshot(
          scope: 's',
          complete: false,
          hasResult: streamCompleted,
          covered: streamCompleted ? 1 : 0,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              calls++;
              entered.complete();
              await release.future;
              streamCompleted = true;
            },
        cancel: () {
          cancels++;
        },
        failureCode: (e) => '$e',
      );
      await c.start();
      final running = c.poll();
      await entered.future;
      expect(c.phase, ProfileGenerationPhase.working);
      expect(c.manuallyPaused, false);
      expect(jsonDecode(disk.value!)['status'], 'running');
      c.wake();
      await c.poll();
      c.setForeground(false);
      c.setForeground(true);
      expect(calls, 1);
      expect(cancels, 0);
      expect(streamCompleted, false);
      release.complete();
      await running;
      expect(streamCompleted, true);
      expect(cancels, 0);
      expect(c.phase, ProfileGenerationPhase.paused);
      expect(c.manuallyPaused, true);
      await c.poll();
      expect(calls, 1);
      c.dispose();
    },
  );

  test('ordinary constructor keeps automatic multi-round behavior', () async {
    final disk = MemoryLifePersistence();
    var time = DateTime.utc(2026), covered = 0, calls = 0;
    final c = ProfileGenerationCoordinator(
      persistence: disk,
      autoSchedule: false,
      now: () => time,
      inspect: () async => ProfileGenerationSnapshot(
        scope: 's',
        complete: false,
        hasResult: covered > 0,
        covered: covered,
        total: 10,
      ),
      generate:
          ({required savedObservationsOnly, required maxNewBatches}) async {
            calls++;
            covered++;
          },
      processedRecords: () => covered,
      cancel: () {},
      failureCode: (e) => '$e',
    );
    await c.start();
    await c.poll();
    expect(c.manuallyPaused, false);
    time = time.add(const Duration(minutes: 1));
    await c.poll();
    expect(calls, 2);
    expect(c.manuallyPaused, false);
    c.dispose();
  });
}
