import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_evidence.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

Map<String, dynamic> brief(String ref) => {
  'title': '接口验收已完成',
  'status_label': '已完成',
  'facts': [
    {'text': '接口验收已完成。', 'ref': ref, 'quote': '接口验收已完成'},
  ],
  'why_now': '这轮验收已具备原先要求的接口结果。',
  'next_steps': [],
  'uncertainty': '',
};
void main() {
  test(
    'host accumulated 101 cards publish but model batches stay limited and capacity failure preserves success',
    () async {
      final now = DateTime.utc(2026, 10, 19);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:self', 1);
      await source.select('chat', DateTime.utc(1970));
      final messages = List.generate(
        101,
        (index) => {
          'message_id': 'source_$index',
          'sender': {'id_type': 'open_id', 'id': 'self'},
          'create_time': '${now.millisecondsSinceEpoch}',
          'msg_type': 'text',
          'body': {
            'content': jsonEncode({'text': '验收事项$index已完成'}),
          },
        },
      );
      for (var offset = 0; offset < messages.length; offset += 50) {
        await source.ingestPage(
          source.fence('chat'),
          messages.skip(offset).take(50).toList(),
          nextPage: null,
          windowEnd: now,
        );
      }
      await source.grantProcessing('p', 'profile', true);
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final disk = MemoryLifePersistence();
      final repo = ProfileRepository(disk, publication, source);
      final originals = {
        for (final message in source.readAuthorizedEvidence('p', 'profile'))
          message['evidence_id']: message,
      };
      final refs = originals.keys.toList();
      final entries = List.generate(
        101,
        (index) => <String, dynamic>{
          'key': 'event_$index',
          'kind': 'timeline',
          'text': originals[refs[index]]!['text'],
          'evidence_ids': [refs[index]],
          'observed_at': now.toIso8601String(),
        },
      );
      expect(
        () => validateProfileEntries(entries.take(100).toList(), originals),
        returnsNormally,
      );
      expect(
        () => validateProfileEntries(entries, originals),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'code',
            'invalid_projection',
          ),
        ),
      );
      Future<void> publish(List<Map<String, dynamic>> items) async {
        await repo.publish(
          jsonEncode(items),

          sourceRevision: source.revision,
          consentRevision: source.processingRevision,
          provider: 'p',
          mergeTimelineHistory: true,
        );
      }

      await publish(entries);
      expect(repo.value!['entries'], entries);
      final before = disk.value;
      final revision = repo.value!['revision'];
      final generated = repo.value!['generated_at'];
      final tooMany = List.generate(
        10001,
        (index) => <String, dynamic>{
          ...entries[index % entries.length],
          'key': 'overflow_$index',
        },
      );
      await expectLater(
        publish(tooMany),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'code',
            'profile_result_capacity',
          ),
        ),
      );
      expect(disk.value, before);
      expect(repo.value!['entries'], entries);
      expect(repo.value!['revision'], revision);
      expect(repo.value!['generated_at'], generated);
      final reopened = ProfileRepository(disk, publication, source);
      await reopened.open();
      expect(reopened.value!['entries'], entries);
      publication.dispose();
    },
  );

  test(
    'progressive publications preserve cross-day deleted-source history and replay without duplicates',
    () async {
      var now = DateTime.utc(2026, 10, 19);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:self', 1);
      await source.select('chat', DateTime.utc(1970));
      Future<void> ingest(String id, {bool deleted = false}) =>
          source.ingestPage(
            source.fence('chat'),
            [
              {
                'message_id': id,
                'sender': {'id_type': 'open_id', 'id': 'self'},
                'create_time': '${now.millisecondsSinceEpoch}',
                'msg_type': 'text',
                'body': {
                  'content': jsonEncode({'text': '接口验收$id'}),
                },
                if (deleted) 'deleted': true,
              },
            ],
            nextPage: null,
            windowEnd: now,
          );
      await ingest('first');
      await source.grantProcessing('p', 'profile', true);
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final disk = MemoryLifePersistence();
      final repo = ProfileRepository(disk, publication, source);
      Future<void> publish(List<String> refs, String text) async {
        await repo.publish(
          jsonEncode([
            {
              'key': 'event',
              'kind': 'timeline',
              'text': text,
              'evidence_ids': refs,
              'observed_at': now.toIso8601String(),
            },
          ]),

          sourceRevision: source.revision,
          consentRevision: source.processingRevision,
          provider: 'p',
          mergeTimelineHistory: true,
        );
      }

      final oldRef = source.messages('chat').single['evidence_id'] as String;
      await publish([oldRef], '第一天完成第一步');
      final oldDate = now.toIso8601String();
      final oldFingerprint = repo.value!['evidence_fingerprints'][oldRef];
      now = now.add(const Duration(days: 1));
      await ingest('second');
      await ingest('third');
      final newRefs = source
          .messages('chat')
          .map((message) => message['evidence_id'] as String)
          .where((ref) => ref != oldRef)
          .toList();
      await ingest('first', deleted: true);
      await publish(newRefs, '第二天完成后续验收');
      final entries = repo.value!['entries'] as List;
      expect(entries, hasLength(2));
      final history = entries.singleWhere(
        (entry) => entry['text'] == '第一天完成第一步',
      );
      expect(history['observed_at'], oldDate);
      expect(history['evidence_ids'], [oldRef]);
      expect(history['key'], isNot('event'));
      expect(repo.value!['evidence_fingerprints'][oldRef], oldFingerprint);
      expect(repo.value!['available_evidence_ids'], unorderedEquals(newRefs));
      expect(repo.value!['historical'], true);

      await publish(newRefs.reversed.toList(), '第二天结果经复核');
      final replayed = repo.value!['entries'] as List;
      expect(replayed, hasLength(2));
      expect(replayed.where((entry) => entry['text'] == '第二天完成后续验收'), isEmpty);
      expect(
        replayed.singleWhere((entry) => entry['text'] == '第一天完成第一步'),
        history,
      );
      expect(replayed.map((entry) => entry['key']).toSet(), hasLength(2));
      final reopened = ProfileRepository(disk, publication, source);
      await reopened.open();
      expect(reopened.value!['entries'], replayed);
      expect(
        reopened.value!['available_evidence_ids'],
        unorderedEquals(newRefs),
      );
      publication.dispose();
    },
  );

  test(
    'publishing one region retains other successful categories without reviving todo candidates',
    () async {
      var now = DateTime.utc(2026, 10, 19);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:self', 1);
      await source.select('chat', DateTime.utc(1970));
      Future<void> ingest(String id, String text, {bool deleted = false}) =>
          source.ingestPage(
            source.fence('chat'),
            [
              {
                'message_id': id,
                'sender': {'id_type': 'open_id', 'id': 'self'},
                'create_time': '${now.millisecondsSinceEpoch}',
                'msg_type': 'text',
                'body': {
                  'content': jsonEncode({'text': text}),
                },
                if (deleted) 'deleted': true,
              },
            ],
            nextPage: null,
            windowEnd: now,
          );
      await ingest('first', '本人介绍工作与兴趣，并计划验收接口');
      await source.grantProcessing('p', 'profile', true);
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final disk = MemoryLifePersistence();
      final repo = ProfileRepository(disk, publication, source);
      final oldRef = source.messages('chat').single['evidence_id'];
      Future<void> publish(List entries) async {
        await repo.publish(
          jsonEncode(entries),

          sourceRevision: source.revision,
          consentRevision: source.processingRevision,
          provider: 'p',
          generationScope: 'recipe',
        );
      }

      await publish([
        for (final category in ['about', 'work', 'interests'])
          {
            'key': category,
            'kind': 'profile',
            'text': '已有$category画像',
            'evidence_ids': [oldRef],
          },
        {
          'key': 'event',
          'kind': 'timeline',
          'text': '原先计划验收',
          'evidence_ids': [oldRef],
          'observed_at': now.toIso8601String(),
        },
        {
          'key': 'candidate',
          'kind': 'todo_candidate',
          'text': '待本人采纳的旧建议',
          'evidence_ids': [oldRef],
          'observed_at': now.toIso8601String(),
        },
      ]);
      final fingerprint = repo.value!['evidence_fingerprints'][oldRef];
      final currentCandidate = {
        'key': 'event',
        'kind': 'todo_candidate',
        'text': '本轮新候选',
        'evidence_ids': [oldRef],
        'observed_at': now.toIso8601String(),
      };
      await publish([currentCandidate]);
      final historyKey = (repo.value!['entries'] as List)
          .where((e) => e['kind'] == 'timeline')
          .single['key'];
      expect(historyKey, isNot('event'));
      await publish([currentCandidate]);
      expect(
        (repo.value!['entries'] as List)
            .where((e) => e['kind'] == 'timeline')
            .single['key'],
        historyKey,
      );
      expect(
        (repo.value!['entries'] as List)
            .where((e) => e['kind'] == 'todo_candidate')
            .single['key'],
        'event',
      );

      now = now.add(const Duration(days: 1));
      await ingest('second', '接口验收已完成');
      final newRef = source
          .messages('chat')
          .firstWhere((m) => m['evidence_id'] != oldRef)['evidence_id'];
      await ingest('first', '', deleted: true);
      await publish([
        {
          'key': 'new_event',
          'kind': 'timeline',
          'text': '接口验收完成',
          'evidence_ids': [newRef],
          'observed_at': now.toIso8601String(),
        },
      ]);
      final first = repo.value!;
      expect(
        (first['entries'] as List).where((e) => e['kind'] == 'profile'),
        hasLength(3),
      );
      expect(
        (first['entries'] as List).where((e) => e['kind'] == 'todo_candidate'),
        isEmpty,
      );
      expect(first['evidence_fingerprints'][oldRef], fingerprint);
      expect(first['available_evidence_ids'], [newRef]);
      expect(first['historical'], true);
      expect(first['preserved_history'], 3);
      final reopened = ProfileRepository(disk, publication, source);
      await reopened.open();
      expect(reopened.value!['entries'], first['entries']);
      await publish([
        {
          'key': 'about',
          'kind': 'profile',
          'text': '新的个人概况',
          'evidence_ids': [newRef],
        },
      ]);
      final merged = repo.value!['entries'] as List;
      expect(merged.where((e) => e['key'] == 'about').single['text'], '新的个人概况');
      expect(merged.where((e) => e['kind'] == 'profile'), hasLength(3));
      expect(
        merged.where((e) => e['kind'] == 'timeline').single['text'],
        '接口验收完成',
      );
      expect(merged.map((e) => e['key']).toSet(), hasLength(merged.length));
      expect(repo.value!['evidence_fingerprints'][oldRef], fingerprint);
      await source.bind('other:self', 2);
      await source.select('chat', DateTime.utc(1970));
      await ingest('other', '新账号自己的进展');
      await source.grantProcessing('p', 'profile', true);
      final otherRef = source.messages('chat').single['evidence_id'];
      await publish([
        {
          'key': 'other_event',
          'kind': 'timeline',
          'text': '新账号自己的进展',
          'evidence_ids': [otherRef],
          'observed_at': now.toIso8601String(),
        },
      ]);
      expect(repo.value!['entries'], hasLength(1));
      expect(repo.value!['evidence_fingerprints'].containsKey(oldRef), false);
    },
  );

  test(
    'structured citation restoration resolves nested facts without accepting foreign refs',
    () {
      final evidence = ProfileEvidence([
        {
          'evidence_id': 'real-ref',
          'chat_id': 'chat',
          'sender_id': 'self',
          'relation': 'self',
          'text': '接口验收已完成',
          'created_at': DateTime.utc(2026, 10, 19).millisecondsSinceEpoch,
        },
      ]);
      final item = {
        'key': 'event',
        'kind': 'timeline',
        'text': '接口验收已完成',
        'evidence_ids': ['e1'],
        'observed_at': '2026-10-19T00:00:00Z',
        'brief': brief('e1'),
      };
      final decoded =
          jsonDecode(evidence.restoreCitations(jsonEncode([item]))) as List;
      expect(decoded.single['brief']['facts'][0]['ref'], 'real-ref');
      item['brief'] = brief('foreign');
      expect(
        () => evidence.restoreCitations(jsonEncode([item])),
        throwsStateError,
      );
    },
  );
  test(
    'publication revalidates structured quotes and requires host-derived legacy text',
    () {
      final entries = [
        {
          'key': 'event',
          'kind': 'timeline',
          'text': '接口验收已完成\n接口验收已完成。',
          'evidence_ids': ['source'],
          'observed_at': '2026-10-19T00:00:00Z',
          'brief': brief('source'),
        },
      ];
      final originals = {
        'source': {
          'text': '接口验收已完成',
          'relation': 'self',
          'created_at': DateTime.utc(2026, 10, 19).millisecondsSinceEpoch,
        },
      };
      expect(() => validateProfileEntries(entries, originals), returnsNormally);
      entries.single['text'] = '完全不同的未核实说法';
      expect(
        () => validateProfileEntries(entries, originals),
        throwsStateError,
      );
      entries.single['text'] = '接口验收已完成\n接口验收已完成。';
      (entries.single['brief'] as Map)['facts'] = [
        {'text': '验收完成', 'ref': 'source', 'quote': '不存在的引用'},
      ];
      expect(
        () => validateProfileEntries(entries, originals),
        throwsStateError,
      );
    },
  );
  test(
    'zero meaningful updates retains previous success and records checked recipe without clearing history',
    () async {
      var now = DateTime.utc(2026, 10, 19);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:self', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [
          {
            'message_id': 'first',
            'sender': {'id_type': 'open_id', 'id': 'self'},
            'create_time': '${now.millisecondsSinceEpoch}',
            'msg_type': 'text',
            'body': {
              'content': jsonEncode({'text': '接口验收已完成'}),
            },
          },
        ],
        nextPage: null,
        windowEnd: now,
      );
      await source.grantProcessing('p', 'profile', true);
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final disk = MemoryLifePersistence(),
          repo = ProfileRepository(MemoryLifePersistence(), publication, source);
      final actual = ProfileRepository(disk, publication, source);
      final ref = source.messages('chat').single['evidence_id'];
      Future<Map<String, dynamic>> publish(List entries, String scope) =>
          actual.publish(
            jsonEncode(entries),

            sourceRevision: source.revision,
            consentRevision: source.processingRevision,
            provider: 'p',
            generationScope: scope,
          );
      await publish([
        {
          'key': 'event',
          'kind': 'timeline',
          'text': '已有真实结果',
          'evidence_ids': [ref],
          'observed_at': now.toIso8601String(),
        },
      ], 'old');
      final generated = actual.value!['generated_at'];
      now = now.add(const Duration(days: 1));
      await publish([], 'new');
      expect(actual.value!['entries'].single['text'], '已有真实结果');
      expect(actual.value!['generated_at'], generated);
      expect(actual.value!['generation_scope'], 'new');
      final reopened = ProfileRepository(disk, publication, source);
      await reopened.open();
      expect(reopened.value!['entries'].single['text'], '已有真实结果');
      expect(reopened.value!['generated_at'], generated);
      expect(repo.value, isNull);
    },
  );
}
