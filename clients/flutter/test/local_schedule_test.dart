import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/schedule_repository.dart';
import 'package:nova_mobile/agent_core/schedule_time.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'duplicate wakes and epoch changes keep one occurrence; unknown runs never replay',
    () async {
      var now = DateTime.utc(2026, 10, 17, 8);
      final disk = MemoryLifePersistence();
      var repo = ScheduleRepository(
        disk,
        deviceId: 'phone',
        clock: ScheduleClock(),
        now: () => now,
      );
      await repo.open();
      await repo.create({
        'title': 'Fixture',
        'goal': 'Summarize my tasks',
        'acceptance': 'Return a summary',
        'rule': {'kind': 'daily', 'timezone': 'UTC', 'time': '09:00'},
        'provider': 'fixture',
        'context': {'life': true, 'web': false},
      });
      now = DateTime.utc(2026, 10, 17, 9, 30);
      final runs = await repo.claimDue();
      expect(runs.length, 1);
      expect(await repo.claimDue(), isEmpty);
      final id = runs.single['run_id'] as String;
      await repo.bindTask(id, 'task');
      await repo.checkpoint(id, 0, 'running');
      repo = ScheduleRepository(
        disk,
        deviceId: 'phone',
        clock: ScheduleClock(),
        now: () => now,
      );
      await repo.open();
      expect(repo.run(id)['status'], 'outcome_unknown');
      expect(await repo.claimDue(), isEmpty);
      await repo.cancel(id, 0);
      await expectLater(repo.checkpoint(id, 0, 'completed'), throwsStateError);
      expect(repo.run(id)['status'], 'cancelled');
    },
  );
  test(
    'catchup only takes latest within two hours; clock rollback cannot reopen slots',
    () async {
      var now = DateTime.utc(2026, 10, 14, 8);
      final repo = ScheduleRepository(
        MemoryLifePersistence(),
        deviceId: 'phone',
        clock: ScheduleClock(),
        now: () => now,
      );
      await repo.open();
      final definition = await repo.create({
        'title': 'Fixture',
        'goal': 'Read',
        'acceptance': 'Summary',
        'rule': {'kind': 'daily', 'timezone': 'UTC', 'time': '09:00'},
        'provider': 'fixture',
        'context': {'life': true, 'web': false},
      });
      now = DateTime.utc(2026, 10, 17, 10);
      expect((await repo.claimDue()).length, 1);
      expect(repo.items.single['missed_count'], 3);
      now = DateTime.utc(2026, 10, 16, 10);
      expect(await repo.claimDue(), isEmpty);
      expect(repo.items.single['id'], definition['id']);
    },
  );
  test('failed claim persistence cannot dispatch a run', () async {
    var now = DateTime.utc(2026, 10, 17, 8);
    final disk = MemoryLifePersistence();
    final repo = ScheduleRepository(
      disk,
      deviceId: 'phone',
      clock: ScheduleClock(),
      now: () => now,
    );
    await repo.open();
    await repo.create({
      'title': 'Fixture',
      'goal': 'Read',
      'acceptance': 'Summary',
      'rule': {
        'kind': 'once',
        'timezone': 'UTC',
        'date': '2026-10-17',
        'time': '09:00',
      },
      'provider': 'fixture',
      'context': {'life': false, 'web': false},
    });
    now = DateTime.utc(2026, 10, 17, 9);
    disk.fail = true;
    await expectLater(repo.claimDue(), throwsStateError);
    expect(repo.runs, isEmpty);
    disk.fail = false;
    expect((await repo.claimDue()).length, 1);
  });
}
