import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'large account cache exceeds old cap; quota failure preserves page for resume',
    () async {
      final clock = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final small = SourceStore(disk, now: () => clock, maxBytes: 800000);
      await small.bind('fixture:person', 1);
      await small.select('chat', clock.subtract(const Duration(days: 1)));
      final page = List.generate(
        50,
        (i) => {
          'message_id': 'large$i',
          'create_time': '${clock.millisecondsSinceEpoch}',
          'msg_type': 'text',
          'body': {'content': '{"text":"${List.filled(16000, 'x').join()}"}'},
        },
      );
      await expectLater(
        small.ingestPage(
          small.fence('chat'),
          page,
          nextPage: 'second',
          windowEnd: clock,
        ),
        throwsStateError,
      );
      expect(small.messages('chat'), isEmpty);
      expect(small.checkpoint('chat')['page_token'], isNull);
      final expanded = SourceStore(disk, now: () => clock);
      await expanded.open();
      await expanded.ingestPage(
        expanded.fence('chat'),
        page,
        nextPage: 'second',
        windowEnd: clock,
      );
      expect(expanded.messages('chat'), hasLength(50));
      expect(expanded.checkpoint('chat')['page_token'], 'second');
      small.dispose();
      expanded.dispose();
    },
  );
  test(
    'a failed page write does not advance its checkpoint; replay deduplicates',
    () async {
      final disk = MemoryLifePersistence();
      final store = SourceStore(disk, now: () => DateTime.utc(2026, 10, 17));
      await store.open();
      await store.bind('fixture:person', 1);
      await store.select('chat', DateTime.utc(2026, 10, 1));
      final fence = store.fence('chat');
      final message = {
        'message_id': 'm1',
        'create_time': '1792195200000',
        'msg_type': 'text',
        'body': {'content': '{"text":"fixture"}'},
      };
      disk.fail = true;
      await expectLater(
        store.ingestPage(
          fence,
          [message],
          nextPage: 'p2',
          windowEnd: DateTime.utc(2026, 10, 17),
        ),
        throwsStateError,
      );
      expect(store.checkpoint('chat')['page_token'], null);
      expect(store.messages('chat'), isEmpty);
      disk.fail = false;
      await store.ingestPage(
        fence,
        [message],
        nextPage: 'p2',
        windowEnd: DateTime.utc(2026, 10, 17),
      );
      expect(store.checkpoint('chat')['page_token'], 'p2');
      await expectLater(
        store.ingestPage(
          fence,
          [message],
          nextPage: null,
          windowEnd: DateTime.utc(2026, 10, 17),
        ),
        throwsStateError,
      );
      await store.ingestPage(
        store.fence('chat'),
        [message],
        nextPage: null,
        windowEnd: DateTime.utc(2026, 10, 17),
      );
      expect(store.messages('chat').length, 1);
      expect(store.checkpoint('chat')['page_token'], null);
      final restored = SourceStore(disk, now: () => DateTime.utc(2026, 10, 17));
      await restored.open();
      expect(restored.messages('chat').length, 1);
    },
  );
  test(
    'collection, provider consent, expiry and deletion have independent fences',
    () async {
      var clock = DateTime.utc(2026, 10, 17);
      final store = SourceStore(MemoryLifePersistence(), now: () => clock);
      await store.open();
      await store.bind('fixture:person', 1);
      expect(() => store.fence('unselected'), throwsStateError);
      await store.select('chat', DateTime.utc(2026, 10, 1));
      final stale = store.fence('chat');
      await store.ingestPage(
        stale,
        [
          {
            'message_id': 'm',
            'create_time': '1792195200000',
            'msg_type': 'text',
            'body': {'content': '{"text":"hello"}'},
          },
        ],
        nextPage: null,
        windowEnd: clock,
      );
      expect(
        () => store.readAuthorizedEvidence('provider', 'profile'),
        throwsStateError,
      );
      await store.grantProcessing('provider', 'profile', true);
      expect(store.readAuthorizedEvidence('provider', 'profile').length, 1);
      expect(
        () => store.readAuthorizedEvidence('different', 'profile'),
        throwsStateError,
      );
      final grant = store.processingRevision;
      await store.grantProcessing('provider', 'profile', false);
      expect(
        () => store.validateProcessing('provider', 'profile', grant),
        throwsStateError,
      );
      await store.remove('chat');
      await store.select('chat', DateTime.utc(2026, 10, 1));
      await expectLater(
        store.ingestPage(stale, [], nextPage: null, windowEnd: clock),
        throwsStateError,
      );
      expect(store.messages('chat'), isEmpty);
      await store.bind('fixture:other', 2);
      expect(store.sources, isEmpty);
      await store.select('chat', clock.subtract(const Duration(days: 40)));
      await store.ingestPage(
        store.fence('chat'),
        [
          {
            'message_id': 'old',
            'create_time': '1792195200000',
            'msg_type': 'text',
            'body': {'content': '{"text":"hello"}'},
          },
        ],
        nextPage: null,
        windowEnd: clock,
      );
      clock = clock.add(const Duration(days: 31));
      expect(store.messages('chat'), isEmpty);
      await store.prune();
    },
  );
}
