import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/ingest.dart';
import 'package:nova_mobile/connectors/feishu/collection.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'feishu_collection_test.dart' show Lease;

FeishuAuth recentAuth(DateTime Function() now, FeishuTransport transport) =>
    FeishuAuth(
      MemoryLifePersistence()
        ..value = jsonEncode({
          'version': 1,
          'generation': 1,
          'app': {
            'brand': 'feishu',
            'app_id': 'cli_fixture',
            'secret': 'synthetic',
          },
          'identity': {'open_id': 'person'},
          'credential': {
            'access_token': 'synthetic',
            'expires_at': now()
                .add(const Duration(days: 1))
                .millisecondsSinceEpoch,
          },
        }),
      FeishuApi(transport: transport),
      now: now,
    );
Map<String, dynamic> recentMessage(String id, DateTime time) => {
  'message_id': id,
  'create_time': '${time.millisecondsSinceEpoch}',
  'msg_type': 'text',
  'body': {
    'content': jsonEncode({'text': id}),
  },
};
FeishuResponse recentPage(List<Map<String, dynamic>> items, {String? next}) =>
    FeishuResponse(200, {
      'code': 0,
      'data': {'items': items, 'has_more': next != null, 'page_token': ?next},
    });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'foreground backfill periodically polls completed chats and caps each live context',
    () async {
      var clock = DateTime.utc(2026, 10, 18);
      final firstHeadEnd = clock, oldEnd = DateTime.utc(2026, 10, 17);
      var doneReads = 0, livePages = 0;
      final queries = <Map<String, String>>[];
      final auth = recentAuth(() => clock, (m, u, h, b) async {
        final query = u.queryParameters;
        queries.add(query);
        if (query['container_id'] == 'done') {
          doneReads++;
          return recentPage(
            doneReads == 2
                ? [recentMessage('arrived-in-completed-chat', clock)]
                : [],
          );
        }
        if (query['sort_type'] == 'ByCreateTimeDesc') {
          livePages++;
          return recentPage([], next: livePages < 3 ? 'head-$livePages' : null);
        }
        if (query['page_token'] == 'history-1') {
          clock = clock.add(const Duration(seconds: 62));
          return recentPage([], next: 'history-2');
        }
        return recentPage([]);
      });
      await auth.open();
      final sources = SourceStore(MemoryLifePersistence(), now: () => clock);
      await sources.bind(auth.identityKey, auth.generation);
      await sources.setAllAccessible(false);
      for (final id in ['done', 'filling']) {
        await sources.select(id, DateTime.utc(1970));
        await sources.ingestPage(
          sources.fence(id),
          [],
          nextPage: id == 'done' ? null : 'history-1',
          windowEnd: oldEnd,
        );
      }
      final collection = FeishuCollection(
        FeishuIngest(auth, sources, now: () => clock),
        execution: Lease(),
      );
      await collection.start();
      final firstHistory = queries.indexWhere(
        (q) => q['page_token'] == 'history-1',
      );
      expect(
        queries.take(firstHistory).where((q) => q['container_id'] == 'filling'),
        hasLength(2),
      );
      final resumedHead = queries.singleWhere(
        (q) => q['page_token'] == 'head-2',
      );
      expect(
        resumedHead['end_time'],
        '${firstHeadEnd.millisecondsSinceEpoch ~/ 1000}',
      );
      expect(
        sources.messages('done').single['message_id'],
        'arrived-in-completed-chat',
      );
      expect(collection.completed, 2);
      expect(collection.error, isNull);
      collection.dispose();
      sources.dispose();
      auth.dispose();
    },
  );
  test(
    'fresh history reads newest first and live head never replaces saved backfill',
    () async {
      var clock = DateTime.utc(2026, 10, 18);
      final firstEnd = clock;
      final queries = <Map<String, String>>[];
      final auth = recentAuth(() => clock, (m, u, h, b) async {
        queries.add(u.queryParameters);
        switch (queries.length) {
          case 1:
            return recentPage([
              recentMessage(
                'recent',
                firstEnd.subtract(const Duration(minutes: 1)),
              ),
            ], next: 'history-next');
          case 2:
            return recentPage([
              recentMessage('arrived-during-history', clock),
            ], next: 'head-next');
          case 3:
            return recentPage([]);
          default:
            return recentPage([
              recentMessage('old', firstEnd.subtract(const Duration(days: 2))),
            ]);
        }
      });
      await auth.open();
      final disk = MemoryLifePersistence();
      var sources = SourceStore(disk, now: () => clock);
      await sources.bind(auth.identityKey, auth.generation);
      await sources.select('chat', DateTime.utc(1970));
      await FeishuIngest(auth, sources, now: () => clock).page('chat');
      expect(queries.single['sort_type'], 'ByCreateTimeDesc');
      clock = clock.add(const Duration(minutes: 2));
      final headEnd = clock;
      await FeishuIngest(
        auth,
        sources,
        now: () => clock,
      ).page('chat', head: true);
      expect(sources.checkpoint('chat')['page_token'], 'history-next');
      expect(
        sources.checkpoint('chat')['window_end'],
        firstEnd.toIso8601String(),
      );
      sources.dispose();
      clock = clock.add(const Duration(minutes: 2));
      sources = SourceStore(disk, now: () => clock);
      await sources.open();
      final ingest = FeishuIngest(auth, sources, now: () => clock);
      await ingest.page('chat', head: true);
      expect(queries[2]['page_token'], 'head-next');
      expect(
        queries[2]['end_time'],
        '${headEnd.millisecondsSinceEpoch ~/ 1000}',
      );
      await ingest.page('chat');
      expect(queries[3]['page_token'], 'history-next');
      expect(
        queries[3]['end_time'],
        '${firstEnd.millisecondsSinceEpoch ~/ 1000}',
      );
      expect(queries[3]['sort_type'], 'ByCreateTimeDesc');
      expect(sources.messages('chat').map((m) => m['message_id']).toSet(), {
        'recent',
        'arrived-during-history',
        'old',
      });
      expect(
        sources.checkpoint('chat')['read_through'],
        headEnd.toIso8601String(),
      );
      sources.dispose();
      auth.dispose();
    },
  );
  test(
    'legacy ascending token retains range and order alongside a descending head',
    () async {
      final clock = DateTime.utc(2026, 10, 18),
          oldEnd = DateTime.utc(2026, 10, 17);
      final queries = <Map<String, String>>[];
      final auth = recentAuth(() => clock, (m, u, h, b) async {
        queries.add(u.queryParameters);
        return recentPage([]);
      });
      await auth.open();
      final disk = MemoryLifePersistence();
      var sources = SourceStore(disk, now: () => clock);
      await sources.bind(auth.identityKey, auth.generation);
      await sources.select('chat', DateTime.utc(1970));
      await sources.ingestPage(
        sources.fence('chat'),
        [recentMessage('cached', oldEnd)],
        nextPage: 'legacy-asc',
        windowEnd: oldEnd,
      );
      await sources.grantProcessing('provider', 'profile', true);
      final revision = sources.revision, consent = sources.processingRevision;
      sources.dispose();
      sources = SourceStore(disk, now: () => clock);
      await sources.open();
      final ingest = FeishuIngest(auth, sources, now: () => clock);
      await ingest.page('chat', head: true);
      expect(sources.revision, revision);
      expect(sources.processingRevision, consent);
      expect(
        sources.readAuthorizedEvidence('provider', 'profile'),
        hasLength(1),
      );
      await ingest.page('chat');
      expect(queries[0]['sort_type'], 'ByCreateTimeDesc');
      expect(queries[1]['sort_type'], 'ByCreateTimeAsc');
      expect(queries[1]['page_token'], 'legacy-asc');
      expect(queries[1]['start_time'], '0');
      expect(
        queries[1]['end_time'],
        '${oldEnd.millisecondsSinceEpoch ~/ 1000}',
      );
      expect(sources.messages('chat').single['message_id'], 'cached');
      sources.dispose();
      auth.dispose();
    },
  );
  test('resumed history sweeps live heads of completed chats first', () async {
    final clock = DateTime.utc(2026, 10, 18),
        oldEnd = DateTime.utc(2026, 10, 17);
    final queries = <Map<String, String>>[];
    final auth = recentAuth(() => clock, (m, u, h, b) async {
      queries.add(u.queryParameters);
      return recentPage([]);
    });
    await auth.open();
    final sources = SourceStore(MemoryLifePersistence(), now: () => clock);
    await sources.bind(auth.identityKey, auth.generation);
    await sources.setAllAccessible(false);
    for (final id in ['done', 'filling']) {
      await sources.select(id, DateTime.utc(1970));
      await sources.ingestPage(
        sources.fence(id),
        [],
        nextPage: id == 'done' ? null : 'legacy',
        windowEnd: oldEnd,
      );
    }
    final intent = MemoryLifePersistence()
      ..value = jsonEncode({
        'identity': auth.identityKey,
        'generation': auth.generation,
        'chat': null,
        'all': false,
        'selected': sources.sources,
        'pending': ['filling'],
        'pages': 10,
        'completed': 1,
        'total': 2,
        'failures': 0,
      });
    final collection = FeishuCollection(
      FeishuIngest(auth, sources, now: () => clock),
      execution: Lease(),
      intent: intent,
    );
    await collection.restore();
    await collection.start();
    expect(queries.first['container_id'], 'done');
    expect(queries.first['sort_type'], 'ByCreateTimeDesc');
    expect(queries.last['page_token'], 'legacy');
    expect(collection.completed, 2);
    collection.dispose();
    sources.dispose();
    auth.dispose();
  });
  test(
    'invalid records do not poison valid siblings or the next chat',
    () async {
      final clock = DateTime.utc(2026, 10, 18);
      final visited = <String>[];
      final auth = recentAuth(() => clock, (m, u, h, b) async {
        final id = u.queryParameters['container_id']!;
        visited.add(id);
        return recentPage(
          id == 'first'
              ? [
                  recentMessage('valid-before', clock),
                  {'create_time': '${clock.millisecondsSinceEpoch}'},
                  {
                    ...recentMessage('bad-time', clock),
                    'create_time': 'invalid',
                  },
                  recentMessage('valid-after', clock),
                ]
              : [recentMessage('next-chat', clock)],
        );
      });
      await auth.open();
      final sources = SourceStore(MemoryLifePersistence(), now: () => clock);
      await sources.bind(auth.identityKey, auth.generation);
      await sources.setAllAccessible(false);
      await sources.select('first', DateTime.utc(1970));
      await sources.select('second', DateTime.utc(1970));
      final collection = FeishuCollection(
        FeishuIngest(auth, sources, now: () => clock),
        execution: Lease(),
      );
      await collection.start();
      expect(collection.error, isNull);
      expect(collection.completed, 2);
      expect(visited, ['first', 'second']);
      expect(sources.messages('first').map((m) => m['message_id']), [
        'valid-before',
        'valid-after',
      ]);
      expect(sources.messages('second').single['message_id'], 'next-chat');
      expect(sources.statusCounts['invalid_record'], 2);
      final before = sources.checkpoint('first');
      await expectLater(
        sources.ingestPage(
          sources.fence('first'),
          [
            {...recentMessage('wrong-chat', clock), 'chat_id': 'second'},
          ],
          nextPage: null,
          windowEnd: clock,
        ),
        throwsStateError,
      );
      expect(sources.checkpoint('first'), before);
      expect(sources.messages('first'), hasLength(2));
      collection.dispose();
      sources.dispose();
      auth.dispose();
    },
  );
}
