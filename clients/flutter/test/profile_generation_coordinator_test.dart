import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'backgrounding lets the bounded in-flight round save and blocks new rounds',
    () async {
      final disk = MemoryLifePersistence();
      final entered = Completer<void>(), release = Completer<void>();
      var calls = 0, cancels = 0, covered = 0;
      final c = ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
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
              entered.complete();
              await release.future;
              covered = 4;
            },
        processedRecords: () => covered,
        cancel: () {
          cancels++;
        },
        failureCode: (e) => '$e',
      );
      await c.start();
      final run = c.poll();
      await entered.future;
      c.setForeground(false);
      expect(cancels, 0);
      release.complete();
      await run;
      expect(disk.value, contains('"last_covered":4'));
      await c.poll();
      expect(calls, 1);
      await c.pause();
      expect(cancels, 1);
      c.dispose();
    },
  );

  test(
    'cache misses cannot reset the retry limit for persistent paid request failures',
    () async {
      var time = DateTime.utc(2026), paid = 0;
      final c = ProfileGenerationCoordinator(
        persistence: MemoryLifePersistence(),
        autoSchedule: false,
        now: () => time,
        inspect: () async => const ProfileGenerationSnapshot(
          scope: 's',
          complete: false,
          hasResult: false,
          covered: 0,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              if (savedObservationsOnly) throw 'profile_no_saved_observations';
              paid++;
              throw 'model_timeout';
            },
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await c.start();
      for (var i = 0; i < 10; i++) {
        await c.poll();
        time = time.add(const Duration(minutes: 5));
      }
      expect(paid, 3);
      expect(c.phase, ProfileGenerationPhase.blocked);
      c.dispose();
    },
  );
  test(
    'three unknown process interruptions stop instead of replaying after every restart',
    () async {
      final disk = MemoryLifePersistence()
        ..value =
            '{"version":1,"scope":"s","status":"running","stage":"collect","retry_count":2,"next_at":0}';
      final c = ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
        inspect: () async => const ProfileGenerationSnapshot(
          scope: 's',
          complete: false,
          hasResult: false,
          covered: 0,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async =>
                fail('replayed'),
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await c.start();
      await c.poll();
      expect(c.code, 'profile_interrupted');
      expect(c.phase, ProfileGenerationPhase.blocked);
      c.dispose();
    },
  );

  test(
    'budget integrity failure stays stopped across scope changes and restart',
    () async {
      final disk = MemoryLifePersistence();
      var scope = 'a';
      var calls = 0;
      var time = DateTime.utc(2026);
      ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
        now: () => time,
        inspect: () async => ProfileGenerationSnapshot(
          scope: scope,
          complete: false,
          hasResult: false,
          covered: 0,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              calls++;
              throw 'profile_budget_usage_invalid';
            },
        cancel: () {},
        failureCode: (e) => '$e',
      );
      final first = create();
      await first.start();
      await first.poll();
      first.dispose();
      scope = 'changed-account';
      time = time.add(const Duration(days: 1));
      final next = create();
      await next.start();
      await next.poll();
      expect(calls, 1);
      expect(next.phase, ProfileGenerationPhase.blocked);
      next.dispose();
    },
  );
  for (final budgetFailure in [
    'profile_budget_exhausted',
    'profile_budget_unavailable',
    'profile_budget_usage_invalid',
    'profile_budget_usage_exceeds_reservation',
    'profile_budget_model_unsupported',
    'profile_budget_request_unsupported',
  ]) {
    test(
      'pre-existing $budgetFailure receipt stops before any generation and persists',
      () async {
        final disk = MemoryLifePersistence();
        var inspections = 0;
        final c = ProfileGenerationCoordinator(
          persistence: disk,
          autoSchedule: false,
          inspect: () async {
            inspections++;
            throw budgetFailure;
          },
          generate:
              ({
                required savedObservationsOnly,
                required maxNewBatches,
              }) async => fail('paid work'),
          cancel: () {},
          failureCode: (e) => '$e',
        );
        await c.start();
        await c.poll();
        await c.poll();
        expect(inspections, 1);
        expect(disk.value, contains(budgetFailure));
        c.dispose();
      },
    );
  }
  test(
    'successful but unchanged partial results have a bounded no-progress stop',
    () async {
      var time = DateTime.utc(2026), calls = 0;
      final c = ProfileGenerationCoordinator(
        persistence: MemoryLifePersistence(),
        autoSchedule: false,
        now: () => time,
        inspect: () async => const ProfileGenerationSnapshot(
          scope: 's',
          complete: false,
          hasResult: true,
          covered: 5,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              calls++;
            },
        processedRecords: () => 5,
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await c.start();
      for (var i = 0; i < 4; i++) {
        await c.poll();
        time = time.add(const Duration(minutes: 5));
      }
      expect(calls, 3);
      expect(c.phase, ProfileGenerationPhase.blocked);
      expect(c.code, 'profile_no_progress');
      c.dispose();
    },
  );
  test(
    'an interrupted collect round first publishes saved progress before new observations',
    () async {
      var time = DateTime.utc(2026), observed = 5, published = 5;
      final calls = <bool>[];
      final c = ProfileGenerationCoordinator(
        persistence: MemoryLifePersistence(),
        autoSchedule: false,
        now: () => time,
        inspect: () async => ProfileGenerationSnapshot(
          scope: 's',
          complete: false,
          hasResult: true,
          covered: published,
          total: 20,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              calls.add(savedObservationsOnly);
              if (savedObservationsOnly) {
                if (observed == published) throw 'profile_no_progress';
                published = observed;
              } else {
                observed = 9;
                throw 'model_timeout';
              }
            },
        processedRecords: () => observed,
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await c.start();
      await c.poll();
      expect(calls, [true]);
      time = time.add(const Duration(minutes: 1));
      await c.poll();
      expect(c.phase, ProfileGenerationPhase.failed);
      time = time.add(const Duration(minutes: 1));
      await c.poll();
      expect(calls, [true, false, true]);
      expect(published, 9);
      expect(c.phase, ProfileGenerationPhase.continuing);
      expect(c.code, isNull);
      c.dispose();
    },
  );

  test(
    'starts automatically from saved work then bounded rounds; complete scope never repeats',
    () async {
      final disk = MemoryLifePersistence();
      var time = DateTime.utc(2026);
      var complete = false, covered = 0;
      final calls = <String>[];
      final coordinator = ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
        now: () => time,
        inspect: () async => ProfileGenerationSnapshot(
          scope: 'scope',
          complete: complete,
          hasResult: covered > 0,
          covered: covered,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              calls.add(
                savedObservationsOnly ? 'saved' : 'round:$maxNewBatches',
              );
              covered += 5;
              complete = covered >= 10;
            },
        cancel: () {},
        failureCode: (e) => '$e',
        processedRecords: () => covered,
      );
      await coordinator.start();
      await coordinator.poll();
      expect(calls, ['saved']);
      await coordinator.poll();
      expect(calls, ['saved']);
      time = time.add(const Duration(seconds: 5));
      await coordinator.poll();
      expect(calls, ['saved', 'round:4']);
      await coordinator.poll();
      expect(calls, hasLength(2));
      expect(coordinator.phase, ProfileGenerationPhase.ready);
      coordinator.dispose();
      final restarted = ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
        now: () => time,
        inspect: () async => const ProfileGenerationSnapshot(
          scope: 'scope',
          complete: true,
          hasResult: true,
          covered: 10,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async =>
                fail('repeat spend'),
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await restarted.start();
      await restarted.poll();
      expect(restarted.phase, ProfileGenerationPhase.ready);
      restarted.dispose();
    },
  );
  test(
    'no cache falls through once to bounded observations without waiting for a user',
    () async {
      var time = DateTime.utc(2026);
      final calls = <bool>[];
      final coordinator = ProfileGenerationCoordinator(
        persistence: MemoryLifePersistence(),
        autoSchedule: false,
        now: () => time,
        inspect: () async => const ProfileGenerationSnapshot(
          scope: 'scope',
          complete: false,
          hasResult: false,
          covered: 0,
          total: 10,
        ),
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              calls.add(savedObservationsOnly);
              if (savedObservationsOnly) throw 'profile_no_saved_observations';
            },
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await coordinator.start();
      await coordinator.poll();
      time = time.add(const Duration(seconds: 5));
      await coordinator.poll();
      expect(calls, [true, false]);
      coordinator.dispose();
    },
  );
  test(
    'ineligible sources and repeated wakes cannot start or overlap requests',
    () async {
      ProfileGenerationSnapshot? snapshot;
      final started = Completer<void>(), release = Completer<void>();
      var calls = 0;
      final c = ProfileGenerationCoordinator(
        persistence: MemoryLifePersistence(),
        autoSchedule: false,
        inspect: () async => snapshot,
        generate:
            ({required savedObservationsOnly, required maxNewBatches}) async {
              calls++;
              started.complete();
              await release.future;
            },
        cancel: () {},
        failureCode: (e) => '$e',
      );
      await c.start();
      await c.poll();
      expect(calls, 0);
      snapshot = const ProfileGenerationSnapshot(
        scope: 'scope',
        complete: false,
        hasResult: false,
        covered: 0,
        total: 10,
      );
      final run = c.poll();
      await started.future;
      await c.poll();
      c.wake();
      expect(calls, 1);
      release.complete();
      await run;
      c.dispose();
    },
  );
  test('manual pause survives restart and explicit retry resumes', () async {
    final disk = MemoryLifePersistence();
    var calls = 0;
    ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
      persistence: disk,
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
          },
      cancel: () {},
      failureCode: (e) => '$e',
    );
    final first = create();
    await first.start();
    await first.pause();
    first.dispose();
    final next = create();
    await next.start();
    await next.poll();
    expect(calls, 0);
    expect(next.phase, ProfileGenerationPhase.paused);
    await next.retry();
    await next.poll();
    expect(calls, 1);
    next.dispose();
  });
  test(
    'failed requests back off across restart and budget exhaustion is terminal',
    () async {
      final disk = MemoryLifePersistence();
      var time = DateTime.utc(2026), calls = 0;
      var failure = 'model_timeout';
      ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
        now: () => time,
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
              throw failure;
            },
        cancel: () {},
        failureCode: (e) => '$e',
      );
      final first = create();
      await first.start();
      await first.poll();
      expect(calls, 1);
      first.dispose();
      final next = create();
      await next.start();
      await next.poll();
      expect(calls, 1);
      time = time.add(const Duration(minutes: 1));
      failure = 'profile_budget_exhausted';
      await next.poll();
      expect(calls, 2);
      time = time.add(const Duration(days: 1));
      await next.poll();
      expect(calls, 2);
      expect(next.phase, ProfileGenerationPhase.blocked);
      next.dispose();
    },
  );
  test(
    'persist running lease before generating, restart waits and background stops new rounds',
    () async {
      final disk = MemoryLifePersistence();
      var time = DateTime.utc(2026);
      var cancels = 0, calls = 0;
      ProfileGenerationCoordinator create() => ProfileGenerationCoordinator(
        persistence: disk,
        autoSchedule: false,
        now: () => time,
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
              expect(disk.value, contains('running'));
              throw 'model_timeout';
            },
        cancel: () {
          cancels++;
        },
        failureCode: (e) => '$e',
      );
      final c = create();
      await c.start();
      c.setForeground(false);
      await c.poll();
      expect(calls, 0);
      c.setForeground(true);
      await c.poll();
      expect(calls, 1);
      expect(cancels, 0);
      c.dispose();
    },
  );
}
