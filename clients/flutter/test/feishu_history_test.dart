import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_evidence.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

Map<String, dynamic> historical(String id, DateTime date, {int length = 20}) =>
    {
      'message_id': id,
      'create_time': '${date.millisecondsSinceEpoch}',
      'msg_type': 'text',
      'sender': {'id_type': 'open_id', 'id': 'person'},
      'body': {
        'content': jsonEncode({'text': 'x' * length}),
      },
    };

void main() {
  test('expiry during a page commit preserves resume and final checkpoint', () async {
    var now = DateTime.utc(2026, 10, 18);
    final disk = MemoryLifePersistence();
    final source = SourceStore(disk, now: () => now);
    await source.bind('fixture:person', 1);
    await source.select('chat', DateTime.utc(1970));
    final window = now;
    await source.ingestPage(source.fence('chat'), [historical('old', DateTime.utc(2020))], nextPage: 'page2', windowEnd: window);
    final scope = source.checkpoint('chat')['scope_revision'];
    now = now.add(const Duration(days: 31));
    await source.ingestPage(source.fence('chat'), [historical('new', DateTime.utc(2021))], nextPage: 'page3', windowEnd: window);
    expect(source.messages('chat').map((m) => m['message_id']), ['new']);
    expect((jsonDecode(disk.value!)['messages'] as Map).length, 1);
    expect(source.checkpoint('chat')['page_token'], 'page3');
    expect(source.checkpoint('chat')['window_end'], window.toIso8601String());
    expect(source.checkpoint('chat')['scope_revision'], scope);
    // Explicit prune must also preserve an active pagination checkpoint.
    await source.prune();
    final reopened = SourceStore(disk, now: () => now);
    await reopened.open();
    expect(reopened.checkpoint('chat')['page_token'], 'page3');
    await reopened.ingestPage(reopened.fence('chat'), [], nextPage: null, windowEnd: window);
    expect(reopened.checkpoint('chat')['read_through'], window.toIso8601String());
    expect(reopened.checkpoint('chat')['from'], window.toIso8601String());
    expect(reopened.checkpoint('chat')['scope_revision'], scope);
    // A later explicit refresh can revisit erased historical content.
    await reopened.prune();
    expect(reopened.checkpoint('chat')['from'], DateTime.utc(1970).toIso8601String());
    expect(reopened.checkpoint('chat')['read_through'], isNull);
    expect(reopened.checkpoint('chat')['scope_revision'], scope + 1);
  });

  test('oversized body records a visible skip and does not stall its page', () async {
    final now = DateTime.utc(2026, 10, 18);
    final source = SourceStore(MemoryLifePersistence(), now: () => now);
    await source.bind('fixture:person', 1);
    await source.select('chat', DateTime.utc(1970));
    await source.ingestPage(source.fence('chat'), [
      historical('oversized', DateTime.utc(2020), length: 16001),
      historical('normal', DateTime.utc(2021)),
    ], nextPage: 'page2', windowEnd: now);
    final large = source.messages('chat').firstWhere((m) => m['message_id'] == 'oversized');
    expect(large['text'], isNull);
    expect(large['status'], 'too_large');
    expect(source.statusCounts, {'too_large': 1, 'available': 1});
    expect(source.skippedSummary, '1 条正文超过16000字');
    expect(source.checkpoint('chat')['page_token'], 'page2');
    await source.grantProcessing('provider', 'profile', true);
    expect(source.readAuthorizedEvidence('provider', 'profile').map((m) => m['message_id']), ['normal']);
  });

  test(
    'old message survives paging restart and is usable with fresh access',
    () async {
      final now = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final source = SourceStore(disk, now: () => now);
      await source.bind('fixture:person', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [historical('old', DateTime.utc(2020))],
        nextPage: 'page2',
        windowEnd: now,
      );
      final reopened = SourceStore(disk, now: () => now);
      await reopened.open();
      expect(reopened.checkpoint('chat')['page_token'], 'page2');
      expect(reopened.messages('chat'), hasLength(1));
      final evidence = ProfileEvidence(
        reopened.messages('chat'),
        validThrough: now.add(const Duration(minutes: 15)),
      );
      expect(
        evidence.records.single['created_at'],
        DateTime.utc(2020).toIso8601String(),
      );
      await reopened.ingestPage(
        reopened.fence('chat'),
        [historical('next', DateTime.utc(2021))],
        nextPage: null,
        windowEnd: now,
      );
      expect(reopened.messages('chat'), hasLength(2));
      expect(
        reopened.checkpoint('chat')['read_through'],
        now.toIso8601String(),
      );
    },
  );

  test(
    'authorization revocation removes old messages and rejects stale pages',
    () async {
      final now = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final source = SourceStore(disk, now: () => now);
      await source.bind('fixture:person', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [historical('old', DateTime.utc(2020))],
        nextPage: 'page2',
        windowEnd: now,
      );
      final stale = source.fence('chat');
      await source.bind(null, 2);
      await expectLater(
        source.ingestPage(
          stale,
          [historical('next', DateTime.utc(2021))],
          nextPage: null,
          windowEnd: now,
        ),
        throwsStateError,
      );
      final reopened = SourceStore(disk, now: () => now);
      await reopened.open();
      expect(reopened.sources, isEmpty);
      expect(jsonDecode(disk.value!)['messages'], isEmpty);
    },
  );

  test(
    'capacity failure preserves all committed history and resumable cursor',
    () async {
      final now = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final source = SourceStore(disk, now: () => now, maxBytes: 4000);
      await source.bind('fixture:person', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [historical('old', DateTime.utc(2020))],
        nextPage: 'page2',
        windowEnd: now,
      );
      final before = disk.value;
      await expectLater(
        source.ingestPage(
          source.fence('chat'),
          [historical('large', DateTime.utc(2021), length: 5000)],
          nextPage: 'page3',
          windowEnd: now,
        ),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'code',
            'source_storage_full',
          ),
        ),
      );
      expect(disk.value, before);
      expect(source.messages('chat'), hasLength(1));
      expect(source.checkpoint('chat')['page_token'], 'page2');
    },
  );

  test(
    'legacy default range migrates once without dropping cached data or resetting resumed pages',
    () async {
      final now = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final source = SourceStore(disk, now: () => now);
      await source.bind('fixture:person', 1);
      await source.select('chat', now.subtract(const Duration(days: 30)));
      await source.ingestPage(
        source.fence('chat'),
        [historical('cached', now)],
        nextPage: 'old-page',
        windowEnd: now,
      );
      await source.grantProcessing('provider', 'profile', true);
      final legacy = jsonDecode(disk.value!) as Map<String, dynamic>;
      legacy.remove('history_policy');
      for (final message in (legacy['messages'] as Map).values) {
        (message as Map).remove('fetched_at');
      }
      disk.value = jsonEncode(legacy);
      final upgraded = SourceStore(disk, now: () => now);
      await upgraded.open();
      expect(upgraded.messages('chat'), hasLength(1));
      expect(
        upgraded.checkpoint('chat')['from'],
        DateTime.utc(1970).toIso8601String(),
      );
      expect(upgraded.checkpoint('chat')['page_token'], isNull);
      expect(
        () => upgraded.readAuthorizedEvidence('provider', 'profile'),
        throwsStateError,
      );
      await upgraded.ingestPage(
        upgraded.fence('chat'),
        [historical('historic', DateTime.utc(2020)), historical('cached', now)],
        nextPage: 'new-page',
        windowEnd: now,
      );
      final reopened = SourceStore(disk, now: () => now);
      await reopened.open();
      expect(reopened.messages('chat'), hasLength(2));
      expect(reopened.checkpoint('chat')['page_token'], 'new-page');
    },
  );

  test(
    'a cursor cycle stops without overwriting the last valid checkpoint',
    () async {
      final now = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final source = SourceStore(disk, now: () => now);
      await source.bind('fixture:person', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [],
        nextPage: 'A',
        windowEnd: now,
      );
      await source.ingestPage(
        source.fence('chat'),
        [],
        nextPage: 'B',
        windowEnd: now,
      );
      final before = disk.value;
      await expectLater(
        source.ingestPage(
          source.fence('chat'),
          [],
          nextPage: 'A',
          windowEnd: now,
        ),
        throwsStateError,
      );
      expect(disk.value, before);
      expect(source.checkpoint('chat')['page_token'], 'B');
    },
  );

  test(
    'cache opens do not extend access; expiry scrubs data and permits explicit refetch',
    () async {
      var now = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final source = SourceStore(disk, now: () => now);
      await source.bind('fixture:person', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [historical('historic', DateTime.utc(2020))],
        nextPage: null,
        windowEnd: now,
      );
      final fetched = source.messages('chat').single['fetched_at'];
      now = now.add(const Duration(days: 29));
      final reopened = SourceStore(disk, now: () => now);
      await reopened.open();
      expect(reopened.messages('chat').single['fetched_at'], fetched);
      now = now.add(const Duration(days: 2));
      expect(reopened.messages('chat'), isEmpty);
      await reopened.prune();
      expect(jsonDecode(disk.value!)['messages'], isEmpty);
      expect(
        reopened.checkpoint('chat')['from'],
        DateTime.utc(1970).toIso8601String(),
      );
      await reopened.ingestPage(
        reopened.fence('chat'),
        [historical('historic', DateTime.utc(2020))],
        nextPage: null,
        windowEnd: now,
      );
      expect(
        reopened.messages('chat').single['fetched_at'],
        now.millisecondsSinceEpoch,
      );
      expect(
        reopened.messages('chat').single['created_at'],
        DateTime.utc(2020).millisecondsSinceEpoch,
      );
    },
  );
}
