import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/ingest.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'reopened ingest resumes a page and later sync starts at read-through',
    () async {
      var clock = DateTime.utc(2026, 10, 18);
      final credentials = MemoryLifePersistence()
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
            'expires_at': clock
                .add(const Duration(days: 1))
                .millisecondsSinceEpoch,
          },
        });
      final queries = <Map<String, String>>[];
      final auth = FeishuAuth(
        credentials,
        FeishuApi(
          transport: (m, u, h, b) async {
            queries.add(u.queryParameters);
            final first = queries.length == 1;
            return FeishuResponse(200, {
              'code': 0,
              'data': {
                'items': first
                    ? [
                        {
                          'message_id': 'old',
                          'create_time': '${clock.millisecondsSinceEpoch}',
                          'msg_type': 'text',
                          'body': {'content': '{"text":"已保存消息"}'},
                        },
                      ]
                    : [],
                'has_more': first,
                if (first) 'page_token': 'saved-next',
              },
            });
          },
        ),
        now: () => clock,
      );
      await auth.open();
      final disk = MemoryLifePersistence();
      var sources = SourceStore(disk, now: () => clock);
      await sources.bind(auth.identityKey, auth.generation);
      await sources.select('chat', DateTime.utc(1970));
      await FeishuIngest(auth, sources, now: () => clock).page('chat');
      final window = clock;
      sources.dispose();
      clock = clock.add(const Duration(minutes: 10));
      sources = SourceStore(disk, now: () => clock);
      await sources.open();
      final ingest = FeishuIngest(auth, sources, now: () => clock);
      await ingest.page('chat');
      expect(queries[1]['page_token'], 'saved-next');
      expect(
        queries[1]['end_time'],
        '${window.millisecondsSinceEpoch ~/ 1000}',
      );
      await ingest.page('chat');
      expect(queries[2]['page_token'], isNull);
      expect(
        queries[2]['start_time'],
        '${window.millisecondsSinceEpoch ~/ 1000}',
      );
      expect(sources.messages('chat').single['message_id'], 'old');
      sources.dispose();
      auth.dispose();
    },
  );
  test(
    'all accessible is default; discovery paginates past 20 and preserves exclusions',
    () async {
      final clock = DateTime.utc(2026, 10, 18);
      final credentials = MemoryLifePersistence()
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
            'expires_at': clock
                .add(const Duration(days: 1))
                .millisecondsSinceEpoch,
          },
        });
      var calls = 0;
      final auth = FeishuAuth(
        credentials,
        FeishuApi(
          transport: (m, u, h, b) async {
            expect(u.path, '/open-apis/im/v1/chats');
            expect(u.queryParameters['types'], 'p2p,group');
            calls++;
            expect(
              u.queryParameters['page_token'],
              calls == 1 ? null : 'second',
            );
            return FeishuResponse(200, {
              'code': 0,
              'data': {
                'items': List.generate(
                  15,
                  (i) => {'chat_id': 'chat${(calls - 1) * 15 + i}'},
                ),
                'has_more': calls == 1,
                if (calls == 1) 'page_token': 'second',
              },
            });
          },
        ),
        now: () => clock,
      );
      await auth.open();
      final disk = MemoryLifePersistence();
      final store = SourceStore(disk, now: () => clock);
      await store.bind(auth.identityKey, auth.generation);
      expect(store.allAccessible, true);
      await store.select('chat0', clock);
      await store.remove('chat0');
      await store.select('chat1', clock);
      await store.pause('chat1', true);
      final ingest = FeishuIngest(auth, store, now: () => clock);
      final chats = await ingest.discoverAll();
      expect(chats.chats.length, 30);
      await ingest.selectAccessible(chats);
      expect(store.sources.length, 29);
      expect(store.sources, isNot(contains('chat0')));
      expect(store.checkpoint('chat1')['paused'], true);
      expect(
        store.checkpoint('chat29')['from'],
        DateTime.utc(1970).toIso8601String(),
      );
      await store.setAllAccessible(false);
      final restored = SourceStore(disk, now: () => clock);
      await restored.open();
      expect(restored.allAccessible, false);
      await expectLater(
        ingest.selectAccessible(chats),
        throwsA(isA<FeishuFailure>()),
      );
    },
  );
  test(
    'queued account change rejects a discovered source and narrowing invalidates old pages',
    () async {
      final clock = DateTime.utc(2026, 10, 18);
      final store = SourceStore(MemoryLifePersistence(), now: () => clock);
      await store.bind('account-a', 1);
      final switched = store.bind('account-b', 2);
      final stale = store.select(
        'old-chat',
        clock,
        expectedIdentity: 'account-a',
        expectedGeneration: 1,
      );
      await expectLater(stale, throwsStateError);
      await switched;
      expect(store.sources, isEmpty);
      await store.select('chat', clock.subtract(const Duration(days: 30)));
      final oldFence = store.fence('chat');
      await store.ingestPage(
        oldFence,
        [
          {
            'message_id': 'old-message',
            'create_time':
                '${clock.subtract(const Duration(days: 10)).millisecondsSinceEpoch}',
            'msg_type': 'text',
            'body': {'content': '{"text":"fixture"}'},
          },
        ],
        nextPage: 'next',
        windowEnd: clock,
      );
      final inFlight = store.fence('chat');
      final from = clock.subtract(const Duration(days: 7));
      await store.select('chat', from, updateRange: true);
      expect(store.messages('chat'), isEmpty);
      expect(store.checkpoint('chat')['from'], from.toIso8601String());
      expect(store.checkpoint('chat')['page_token'], null);
      await expectLater(
        store.ingestPage(inFlight, [], nextPage: null, windowEnd: clock),
        throwsStateError,
      );
    },
  );
}
