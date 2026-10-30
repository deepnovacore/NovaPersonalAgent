import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'async worker evidence rejects access that expires while it is preparing',
    () async {
      var clock = DateTime.utc(2026, 10, 29);
      final disk = MemoryLifePersistence();
      final initial = SourceStore(disk, now: () => clock);
      await initial.bind('fixture:person', 1);
      await initial.select('a', DateTime.utc(1970));
      await initial.ingestPage(
        initial.fence('a'),
        [
          {
            'message_id': 'one',
            'create_time': '${clock.millisecondsSinceEpoch}',
            'msg_type': 'text',
            'body': {'content': '{"text":"valid before worker"}'},
          },
        ],
        nextPage: null,
        windowEnd: clock,
      );
      await initial.grantProcessing('fixture', 'profile', true);
      final raw = jsonDecode(disk.value!) as Map<String, dynamic>;
      final row = Map<String, dynamic>.from(
        (raw['messages'] as Map).values.single as Map,
      );
      raw['messages'] = {
        for (var i = 0; i < 256; i++) 'e$i': {...row, 'evidence_id': 'e$i'},
      };
      disk.value = jsonEncode(raw);
      initial.dispose();
      final source = SourceStore(disk, now: () => clock);
      await source.open();
      final before = source.revision;
      final previousCheckpoint = source.checkpoint('a'),
          previousDisk = disk.value;
      var authorized = true;
      final saving = source.prepareWindow(
        'a',
        clock,
        authorize: () {
          if (!authorized) throw StateError('authorization_changed');
        },
      );
      scheduleMicrotask(() {
        authorized = false;
      });
      await expectLater(saving, throwsStateError);
      expect(source.checkpoint('a'), previousCheckpoint);
      expect(disk.value, previousDisk);
      final preparing = source.readAuthorizedEvidenceAsync(
        'fixture',
        'profile',
      );
      scheduleMicrotask(() {
        clock = clock.add(const Duration(days: 31));
      });
      expect(await preparing, isEmpty);
      expect(source.revision, before);
      source.dispose();
    },
  );
  test(
    'one count snapshot matches visible rows and evidence copies stay independent',
    () async {
      var clock = DateTime.utc(2026, 10, 29), clockReads = 0;
      final disk = MemoryLifePersistence();
      final source = SourceStore(
        disk,
        now: () {
          clockReads++;
          return clock;
        },
      );
      await source.bind('fixture:person', 1);
      for (final chat in ['a', 'b']) {
        await source.select(chat, DateTime.utc(1970));
        await source.ingestPage(
          source.fence(chat),
          [
            {
              'message_id': chat,
              'create_time': '${clock.millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {
                'content': jsonEncode({'text': 'message-$chat'}),
              },
            },
          ],
          nextPage: null,
          windowEnd: clock,
        );
      }
      await source.grantProcessing('fixture', 'profile', true);
      final raw = jsonDecode(disk.value!) as Map<String, dynamic>;
      final stored = raw['messages'] as Map;
      final first = stored.values.first as Map;
      first['legacy_nested'] = {
        'values': [1],
      };
      stored['unsupported'] = {
        ...first,
        'evidence_id': 'unsupported',
        'status': 'unsupported_type',
        'text': null,
      };
      stored['unselected'] = {
        ...first,
        'evidence_id': 'unselected',
        'chat_id': 'outside',
      };
      raw['sources']['a']['invalid_records'] = 2;
      disk.value = jsonEncode(raw);
      source.dispose();
      final reopened = SourceStore(
        disk,
        now: () {
          clockReads++;
          return clock;
        },
      );
      await reopened.open();
      clockReads = 0;
      final counts = reopened.messageCounts;
      expect(clockReads, 1);
      expect(counts.byStatus, {
        'available': 2,
        'unsupported_type': 1,
        'invalid_record': 2,
      });
      expect(counts.byChat, {'a': 2, 'b': 1});
      expect(
        reopened.skippedSummaryFor(counts.byStatus),
        contains('2 条消息记录格式异常'),
      );
      final expected =
          reopened.sources
              .expand(reopened.messages)
              .where((m) => m['status'] == 'available')
              .toList()
            ..sort(
              (a, b) =>
                  (a['created_at'] as int).compareTo(b['created_at'] as int),
            );
      final evidence = reopened.readAuthorizedEvidence('fixture', 'profile');
      expect(evidence, expected);
      expect(
        await reopened.readAuthorizedEvidenceAsync('fixture', 'profile'),
        expected,
      );
      evidence.first['text'] = 'edited caller copy';
      ((evidence.first['legacy_nested'] as Map)['values'] as List).add(2);
      final fresh = reopened.readAuthorizedEvidence('fixture', 'profile');
      expect(fresh.first['text'], 'message-a');
      expect(fresh.first['legacy_nested'], {
        'values': [1],
      });
      clock = clock.add(const Duration(days: 31));
      expect(reopened.messageCounts.byChat, isEmpty);
      expect(reopened.messageCounts.byStatus, {'invalid_record': 2});
      expect(reopened.readAuthorizedEvidence('fixture', 'profile'), isEmpty);
      reopened.dispose();
    },
  );
}
