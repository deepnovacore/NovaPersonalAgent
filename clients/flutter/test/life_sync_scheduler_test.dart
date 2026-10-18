import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/life_sync_scheduler.dart';

void main() {
  testWidgets(
    'foreground sync pauses in background and never overlaps a write',
    (tester) async {
      var calls = 0;
      var active = 0;
      final scheduler = LifeSyncScheduler(
        sync: () async {
          active++;
          expectSync(active, 1);
          calls++;
          await Future<void>.delayed(const Duration(seconds: 2));
          active--;
        },
        onError: (error) => throw error,
      );
      scheduler.setForeground(true);
      await tester.pump(const Duration(milliseconds: 1));
      scheduler.changed();
      scheduler.changed();
      await tester.pump(const Duration(seconds: 2));
      expect(calls, 1);
      scheduler.setForeground(false);
      await tester.pump(const Duration(minutes: 2));
      expect(calls, 1);
      scheduler.setForeground(true);
      await tester.pump(const Duration(milliseconds: 1));
      expect(calls, 2);
      await tester.pump(const Duration(seconds: 2));
      scheduler.dispose();
    },
  );
  testWidgets('network failures have bounded backoff and stop when disposed', (
    tester,
  ) async {
    var calls = 0, errors = 0;
    final scheduler = LifeSyncScheduler(
      sync: () async {
        calls++;
        throw StateError('offline');
      },
      onError: (_) {
        errors++;
      },
    );
    scheduler.setForeground(true);
    await tester.pump(const Duration(milliseconds: 1));
    expect(calls, 1);
    await tester.pump(const Duration(seconds: 1));
    expect(calls, 2);
    await tester.pump(const Duration(seconds: 1));
    expect(calls, 2);
    await tester.pump(const Duration(seconds: 1));
    expect(calls, 3);
    scheduler.dispose();
    await tester.pump(const Duration(minutes: 5));
    expect(calls, 3);
    expect(errors, 3);
  });
}
