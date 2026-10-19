import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_evidence.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/device/space_authority.dart';
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
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final disk = MemoryLifePersistence();
      final repo = ProfileRepository(disk, authority, source);
      final oldRef = source.messages('chat').single['evidence_id'];
      Future<void> publish(List entries) async {
        await repo.publish(
          jsonEncode(entries),
          epoch: authority.epoch,
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
      final reopened = ProfileRepository(disk, authority, source);
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
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final disk = MemoryLifePersistence(),
          repo = ProfileRepository(MemoryLifePersistence(), authority, source);
      final actual = ProfileRepository(disk, authority, source);
      final ref = source.messages('chat').single['evidence_id'];
      Future<Map<String, dynamic>> publish(List entries, String scope) =>
          actual.publish(
            jsonEncode(entries),
            epoch: authority.epoch,
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
      final reopened = ProfileRepository(disk, authority, source);
      await reopened.open();
      expect(reopened.value!['entries'].single['text'], '已有真实结果');
      expect(reopened.value!['generated_at'], generated);
      expect(repo.value, isNull);
    },
  );
}
