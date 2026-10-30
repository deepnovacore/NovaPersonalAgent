import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/timeline_time.dart';

void main() {
  const today = '2026-10-30';
  Map<String, dynamic> record(String text, {String? day = today}) => {
    'evidence_id': 'e1',
    'text': text,
    'local_date': ?day,
  };
  Map<String, dynamic> claim(String role, String date, String quote) => {
    'role': role,
    'date': date,
    'ref': 'e1',
    'quote': quote,
  };
  Map<String, dynamic>? resolve(
    String kind,
    List<Map<String, dynamic>> dates,
    Map<String, dynamic> source,
  ) => resolveTimelineTime(
    {'kind': kind, 'dates': dates},
    [source],
    localDate: today,
  );

  for (final item in [
    ('大后天', '2026-11-02', '2026-11-01'),
    ('大前天', '2026-10-27', '2026-10-28'),
    ('后天', '2026-11-01', '2026-11-02'),
    ('前天', '2026-10-28', '2026-10-27'),
  ]) {
    test('relative expression ${item.$1} is not a shorter embedded token', () {
      expect(
        resolve('scheduled', [
          claim('scheduled', item.$2, item.$1),
        ], record(item.$1))?['scheduled_on'],
        item.$2,
      );
      expect(
        resolve('scheduled', [
          claim('scheduled', item.$3, item.$1),
        ], record(item.$1)),
        isNull,
      );
    });
  }

  test('relative dates use source local day across month/year boundaries', () {
    final time = resolve('event', [
      claim('occurred', '2025-12-31', '昨天完成'),
    ], record('昨天完成', day: '2026-01-01'))!;
    expect(time['anchor_date'], '2025-12-31');
    expect(time['anchor_basis'], 'occurred');
    expect(time['last_reported_on'], '2026-01-01');
  });
  test(
    'date formats and source-year shorthand are grounded in exact quote',
    () {
      for (final quote in [
        '2026-10-29完成',
        '2026/10/29完成',
        '2026年10月29日完成',
        '10月29日完成',
      ]) {
        expect(
          resolve('event', [
            claim('occurred', '2026-10-29', quote),
          ], record(quote))?['occurred_on'],
          '2026-10-29',
        );
      }
      expect(
        resolve('event', [
          claim('occurred', '2026-10-29', '完成'),
        ], record('10月29日完成')),
        isNull,
      );
      expect(
        resolve('event', [
          claim('occurred', '2026-10-29', '昨天完成'),
        ], record('昨天完成', day: null)),
        isNull,
      );
    },
  );
  test('message metadata does not prove occurrence', () {
    final time = resolve('event', [
      claim('occurred', today, '完成'),
    ], record('完成'))!;
    expect(time['occurred_on'], isNull);
    expect(time['anchor_basis'], 'reported');
    expect(time['anchor_date'], today);
  });
  test(
    'reject invalid calendar days, future occurrence, duplicates and ordering',
    () {
      expect(
        resolve('event', [
          claim('occurred', '2026-02-30', '2026-02-30完成'),
        ], record('2026-02-30完成')),
        isNull,
      );
      expect(
        resolve('event', [
          claim('occurred', '2026-10-31', '明天完成'),
        ], record('明天完成')),
        isNull,
      );
      expect(
        resolve('event', [
          claim('occurred', today, '今天'),
          claim('occurred', today, '今天'),
        ], record('今天')),
        isNull,
      );
      expect(
        resolve('event', [
          claim('started', today, '今天开始'),
          claim('occurred', '2026-10-29', '昨天完成'),
        ], record('今天开始，昨天完成')),
        isNull,
      );
    },
  );
  test('deadline and scheduled require their own grounded date role', () {
    for (final kind in ['deadline', 'scheduled']) {
      expect(resolve(kind, [], record('计划')), isNull);
      expect(
        resolve(kind, [claim('occurred', today, '今天')], record('今天')),
        isNull,
      );
      final time = resolve(kind, [
        claim(kind, '2026-10-31', '明天'),
      ], record('明天'))!;
      expect(time['anchor_basis'], kind);
      expect(time['anchor_date'], '2026-10-31');
    }
  });
  test(
    'strict trust boundary rejects wrong schema, refs, quote and lengths',
    () {
      for (final temporal in [
        null,
        {},
        {'kind': 'invented', 'dates': []},
        {'kind': 'event', 'dates': [], 'extra': true},
        {
          'kind': 'event',
          'dates': [claim('occurred', today, '今天')..['extra'] = true],
        },
        {
          'kind': 'event',
          'dates': [claim('occurred', today, '今天')..['ref'] = 'e2'],
        },
        {
          'kind': 'event',
          'dates': [claim('occurred', today, '明天')],
        },
        {
          'kind': 'event',
          'dates': [claim('occurred', today, 'x' * 601)],
        },
        {
          'kind': 'event',
          'dates': List.filled(4, claim('occurred', today, '今天')),
        },
      ]) {
        expect(
          resolveTimelineTime(temporal, [record('今天')], localDate: today),
          isNull,
        );
      }
    },
  );
  test('background drops; unknown has no anchor; future reports excluded', () {
    expect(resolve('background', [], record('背景')), isNull);
    expect(resolve('unknown', [], record('状态'))?['anchor_date'], isNull);
    expect(
      resolve(
        'ongoing',
        [],
        record('状态', day: '2026-10-31'),
      )?['last_reported_on'],
      isNull,
    );
  });
  test('old event drops unless a later deadline or schedule exists', () {
    final time = resolve('event', [
      claim('occurred', '2026-10-01', '2026-10-01'),
    ], record('2026-10-01'))!;
    expect(timelineTimeOutsideWindow(time, '2026-10-16'), isTrue);
    for (final key in ['due_on', 'scheduled_on']) {
      expect(
        timelineTimeOutsideWindow({...time, key: '2026-10-16'}, '2026-10-16'),
        isFalse,
      );
    }
    expect(
      timelineTimeOutsideWindow({...time, 'anchor_date': null}, '2026-10-16'),
      isFalse,
    );
  });
}
