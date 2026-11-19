import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/ingest.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'feishu_recent_test.dart' show recentAuth, recentMessage, recentPage;
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final clock = DateTime.utc(2026, 10, 30);
  test(
    'normalizes authors, structured mentions and bounded reply metadata',
    () async {
      final store = SourceStore(MemoryLifePersistence(), now: () => clock);
      await store.bind('feishu:fixture:ou_self', 1);
      await store.select('chat', DateTime.utc(1970));
      Map<String, dynamic> row(
        String id,
        String sender,
        String type,
        dynamic mentions,
      ) => {
        ...recentMessage(id, clock),
        'sender': {'id': sender, 'id_type': 'open_id', 'sender_type': type},
        'mentions': ?mentions,
      };
      await store.ingestPage(
        store.fence('chat'),
        [
          {
            ...row('bot', 'ou_bot', 'app', []),
            'parent_id': 'parent',
            'root_id': 'root',
            'thread_id': 'thread',
            'upper_message_id': 'container',
          },
          row('direct', 'ou_other', 'user', [
            {'id': 'ou_self'},
            {'id': 'all'},
          ]),
          row('all', 'ou_other', 'user', [
            {'id': 'all'},
          ]),
          row('self', 'ou_self', 'user', [
            {'id': 'ou_self'},
          ]),
          row('wrong-type', 'ou_other', 'user', [
            {'id': 'ou_self', 'id_type': 'user_id'},
          ]),
          {
            ...recentMessage('legacy', clock),
            'parent_id': '',
            'root_id': 'x' * 257,
          },
          row(
            'many',
            'ou_other',
            'user',
            List.generate(60, (i) => {'id': 'ou_$i'}),
          ),
        ],
        nextPage: null,
        windowEnd: clock,
      );
      final rows = {
        for (final row in store.messages('chat')) row['message_id']: row,
      };
      expect(rows['bot']!['sender_type'], 'app');
      expect(rows['bot']!['relation'], 'app');
      expect(rows['bot']!['upper_message_id'], 'container');
      expect(rows['direct']!['relation'], 'addressed');
      expect(rows['direct']!['mention'], 'direct');
      expect(rows['direct']!['mention_ids'], ['ou_self']);
      expect(rows['all']!['mention'], 'all');
      expect(rows['all']!['relation'], 'participant');
      expect(rows['self']!['mention'], 'none');
      expect(rows['self']!['relation'], 'self');
      expect(rows['wrong-type']!['mention'], 'none');
      expect(rows['legacy']!['sender_type'], 'unknown');
      expect(rows['legacy']!['mention'], 'unknown');
      expect(rows['legacy']!.containsKey('parent_id'), false);
      expect(rows['legacy']!.containsKey('root_id'), false);
      expect(rows['many']!['mention_ids'], hasLength(50));
      store.dispose();
    },
  );

  test(
    'old cache rereads fourteen days once with resumable isolated cursor',
    () async {
      final queries = <Map<String, String>>[];
      final auth = recentAuth(() => clock, (m, u, h, b) async {
        queries.add(u.queryParameters);
        return recentPage([
          {
            ...recentMessage('cached', clock.subtract(const Duration(days: 2))),
            'sender': {
              'id': 'ou_bot',
              'id_type': 'open_id',
              'sender_type': 'app',
            },
            'mentions': [],
          },
        ], next: queries.length == 1 ? 'metadata-next' : null);
      });
      await auth.open();
      final disk = MemoryLifePersistence();
      var store = SourceStore(disk, now: () => clock);
      await store.bind(auth.identityKey, auth.generation);
      await store.select('chat', DateTime.utc(1970));
      await store.ingestPage(
        store.fence('chat'),
        [
          recentMessage('cached', clock.subtract(const Duration(days: 2))),
          recentMessage('outside', clock.subtract(const Duration(days: 20))),
        ],
        nextPage: 'history-next',
        windowEnd: clock.subtract(const Duration(days: 1)),
      );
      store.dispose();
      final legacy = jsonDecode(disk.value!) as Map<String, dynamic>;
      (legacy['sources']['chat'] as Map).remove('metadata_revision');
      for (final row in (legacy['messages'] as Map).values) {
        (row as Map).remove('sender_type');
      }
      disk.value = jsonEncode(legacy);
      store = SourceStore(disk, now: () => clock);
      await store.open();
      var ingest = FeishuIngest(auth, store, now: () => clock);
      expect(await ingest.page('chat'), true);
      expect(
        queries.first['start_time'],
        '${clock.subtract(const Duration(days: 14)).millisecondsSinceEpoch ~/ 1000}',
      );
      expect(store.checkpoint('chat')['page_token'], 'history-next');
      store.dispose();
      store = SourceStore(disk, now: () => clock);
      await store.open();
      ingest = FeishuIngest(auth, store, now: () => clock);
      expect(await ingest.page('chat'), true);
      expect(queries[1]['page_token'], 'metadata-next');
      expect(store.checkpoint('chat')['metadata_revision'], 1);
      expect(
        store
            .messages('chat')
            .singleWhere((r) => r['message_id'] == 'cached')['sender_type'],
        'app',
      );
      expect(
        store
            .messages('chat')
            .singleWhere((r) => r['message_id'] == 'outside')['sender_type'],
        isNull,
      );
      await ingest.page('chat');
      expect(queries[2]['page_token'], 'history-next');
      expect(queries[2]['start_time'], '0');
      store.dispose();
      auth.dispose();
    },
  );
}
