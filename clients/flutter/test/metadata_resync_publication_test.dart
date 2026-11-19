import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'package:nova_mobile/personal/life_reducer.dart' show lifeFingerprint;
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'metadata-only re-read keeps published evidence available and card keys reusable',
    () async {
      final now = DateTime.utc(2026, 10, 19);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:self', 1);
      await source.select('chat', DateTime.utc(1970));
      Map<String, dynamic> message(
        String id,
        String sender,
        String text, {
        bool withMetadata = false,
      }) => {
        'message_id': id,
        'sender': {
          'id_type': 'open_id',
          'id': sender,
          if (withMetadata) 'sender_type': 'user',
        },
        if (withMetadata)
          'mentions': [
            if (sender != 'self') {'id': 'self', 'id_type': 'open_id'},
          ],
        if (withMetadata) 'parent_id': 'root_message',
        'create_time': '${now.millisecondsSinceEpoch}',
        'msg_type': 'text',
        'body': {
          'content': jsonEncode({'text': text}),
        },
      };
      await source.ingestPage(
        source.fence('chat'),
        [
          message('m1', 'peer', '请看一下接口验收'),
          message('m2', 'self', '接口验收已完成'),
        ],
        nextPage: null,
        windowEnd: now,
      );
      await source.grantProcessing('p', 'profile', true);
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final disk = MemoryLifePersistence();
      final repo = ProfileRepository(disk, publication, source);
      final refs = [
        for (final m in source.readAuthorizedEvidence('p', 'profile'))
          m['evidence_id'] as String,
      ];
      expect(refs, hasLength(2));
      await repo.publish(
        jsonEncode([
          {
            'key': 'timeline_card',
            'kind': 'timeline',
            'policy_revision': 2,
            'text': '接口验收已完成',
            'evidence_ids': refs,
            'observed_at': now.toIso8601String(),
          },
        ]),
        sourceRevision: source.revision,
        consentRevision: source.processingRevision,
        provider: 'p',
        mergeTimelineHistory: true,
      );
      expect(repo.value!['available_evidence_ids'], unorderedEquals(refs));

      // One-time metadata re-read: same messages, same text, new metadata.
      await source.ingestPage(
        source.fence('chat'),
        [
          message('m1', 'peer', '请看一下接口验收', withMetadata: true),
          message('m2', 'self', '接口验收已完成', withMetadata: true),
        ],
        nextPage: null,
        windowEnd: now,
      );
      final relations = {
        for (final m in source.messages('chat')) m['message_id']: m['relation'],
      };
      expect(relations['m1'], 'addressed');

      final reopened = ProfileRepository(disk, publication, source);
      await reopened.open();
      expect(
        reopened.value!['available_evidence_ids'],
        unorderedEquals(refs),
        reason: 'metadata enrichment is not a content change',
      );
      expect(reopened.value!['entries'].single['key'], 'timeline_card');

      // A real content change still makes the evidence unavailable.
      await source.ingestPage(
        source.fence('chat'),
        [message('m2', 'self', '接口验收未完成', withMetadata: true)],
        nextPage: null,
        windowEnd: now,
      );
      final edited = ProfileRepository(disk, publication, source);
      await edited.open();
      expect(edited.value!['available_evidence_ids'], hasLength(1));
      publication.dispose();
    },
  );

  test(
    'schema-1 history survives the upgrade: verified refs convert, deleted ones stay historical',
    () async {
      final now = DateTime.utc(2026, 10, 19);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:self', 1);
      await source.select('chat', DateTime.utc(1970));
      Map<String, dynamic> message(
        String id,
        String text, {
        bool deleted = false,
        bool withMetadata = false,
      }) => {
        'message_id': id,
        'sender': {
          'id_type': 'open_id',
          'id': 'self',
          if (withMetadata) 'sender_type': 'user',
        },
        if (withMetadata) 'mentions': <Map>[],
        if (deleted) 'deleted': true,
        'create_time': '${now.millisecondsSinceEpoch}',
        'msg_type': 'text',
        'body': {
          'content': jsonEncode({'text': text}),
        },
      };
      await source.ingestPage(
        source.fence('chat'),
        [message('kept', '旧计划已确认'), message('gone', '旧安排已取消')],
        nextPage: null,
        windowEnd: now,
      );
      await source.grantProcessing('p', 'profile', true);
      final publication = LocalPublicationContext(MemoryLifePersistence());
      await publication.open();
      final disk = MemoryLifePersistence();
      final repo = ProfileRepository(disk, publication, source);
      final ids = {
        for (final m in source.messages('chat'))
          m['message_id']: m['evidence_id'] as String,
      };
      Map<String, dynamic> card(String key, String id, String text) => {
        'key': key,
        'kind': 'timeline',
        'policy_revision': 2,
        'text': text,
        'evidence_ids': [id],
        'observed_at': now.toIso8601String(),
      };
      await repo.publish(
        jsonEncode([
          card('old_kept', ids['kept']!, '旧计划已确认'),
          card('old_gone', ids['gone']!, '旧安排已取消'),
        ]),
        sourceRevision: source.revision,
        consentRevision: source.processingRevision,
        provider: 'p',
        mergeTimelineHistory: true,
      );
      // Rewrite as the pre-upgrade format: schema 1 with full-record digests.
      final stored = jsonDecode(disk.value!) as Map<String, dynamic>;
      stored['history_schema'] = 1;
      // 'kept' mimics a record ingested by an older build, which had no
      // metadata keys at all; 'gone' keeps the current default keys.
      const metadataKeys = {'sender_type', 'mention', 'mention_ids'};
      stored['evidence_fingerprints'] = {
        for (final m in source.messages('chat'))
          m['evidence_id']: lifeFingerprint({
            for (final entry in (m as Map).entries)
              if (entry.key != 'fetched_at' &&
                  !(m['message_id'] == 'kept' &&
                      metadataKeys.contains(entry.key)))
                entry.key: entry.value,
          }),
      };
      disk.value = jsonEncode(stored);

      // Metadata re-read of one message, deletion of the other.
      await source.ingestPage(
        source.fence('chat'),
        [
          message('kept', '旧计划已确认', withMetadata: true),
          message('gone', '', deleted: true),
        ],
        nextPage: null,
        windowEnd: now,
      );

      final upgraded = ProfileRepository(disk, publication, source);
      await upgraded.open();
      expect(upgraded.value, isNotNull);
      expect(
        (upgraded.value!['entries'] as List).map((e) => e['key']),
        unorderedEquals(['old_kept', 'old_gone']),
      );
      expect(upgraded.value!['available_evidence_ids'], [ids['kept']]);

      await source.ingestPage(
        source.fence('chat'),
        [message('fresh', '新事项已完成', withMetadata: true)],
        nextPage: null,
        windowEnd: now,
      );
      final fresh = source
          .messages('chat')
          .firstWhere((m) => m['message_id'] == 'fresh')['evidence_id']
          as String;
      await upgraded.publish(
        jsonEncode([card('new_card', fresh, '新事项已完成')]),
        sourceRevision: source.revision,
        consentRevision: source.processingRevision,
        provider: 'p',
        mergeTimelineHistory: true,
      );
      final after = ProfileRepository(disk, publication, source);
      await after.open();
      expect(
        (after.value!['entries'] as List).map((e) => e['key']),
        unorderedEquals(['new_card', 'old_kept', 'old_gone']),
      );
      expect(
        after.value!['available_evidence_ids'],
        unorderedEquals([ids['kept'], fresh]),
      );
      expect((jsonDecode(disk.value!) as Map)['history_schema'], 2);
      publication.dispose();
    },
  );
}
