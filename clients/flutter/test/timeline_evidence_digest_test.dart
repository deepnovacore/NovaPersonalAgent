import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_evidence.dart';

void main() {
  final at = DateTime.utc(2026, 10, 29, 23, 30).millisecondsSinceEpoch;
  final original = <String, dynamic>{
    'evidence_id': 'original-a',
    'message_id': 'message-a',
    'chat_id': 'chat-a',
    'sender_id': 'sender-a',
    'sender_type': 'user',
    'relation': 'participant',
    'created_at': at,
    'fetched_at': at,
    'status': 'available',
    'text': '合成项目进展',
    'parent_id': 'message-b',
  };
  final parent = {
    ...original,
    'evidence_id': 'original-b',
    'message_id': 'message-b',
    'sender_id': 'sender-b',
    'parent_id': 'outside',
  };
  ProfileEvidence evidence(
    Map<String, dynamic> row, {
    Duration offset = Duration.zero,
  }) => ProfileEvidence([row, parent], timezoneOffset: offset);

  test('each canonical Timeline semantic change invalidates its digest', () {
    final before = evidence(original);
    for (final patch in <Map<String, dynamic>>[
      {'sender_id': 'sender-c'},
      {'relation': 'self'},
      {'sender_type': 'app'},
      {'mention': 'direct'},
      {'parent_id': 'outside'},
      {'root_id': 'message-b'},
      {'upper_message_id': 'message-b'},
      {'created_at': at + 1000},
      {'text': '更新后的合成进展'},
      {'status': 'updated'},
      {'chat_id': 'chat-b'},
    ]) {
      final after = evidence({...original, ...patch});
      expect(
        after.timelineEvidenceDigests['original-a'],
        isNot(before.timelineEvidenceDigests['original-a']),
        reason: '$patch',
      );
    }
  });

  test(
    'Timeline fingerprints the safe text rather than redacted raw secrets',
    () {
      final before = evidence({
        ...original,
        'text': '项目进展 password=synthetic-one',
      });
      final after = evidence({
        ...original,
        'text': '项目进展 password=synthetic-two',
      });
      expect(before.records.first['text'], '项目进展 [redacted]');
      expect(
        after.timelineEvidenceDigests['original-a'],
        before.timelineEvidenceDigests['original-a'],
      );
      expect(
        after.checkpointRecords(after.records).first['source_digest'],
        isNot(before.checkpointRecords(before.records).first['source_digest']),
      );
    },
  );

  test(
    'local date changes Timeline identity without altering source_digest',
    () {
      final before = evidence(original);
      final after = evidence(original, offset: const Duration(hours: 2));
      expect(after.records.first['local_date'], '2026-10-30');
      expect(before.records.first['local_date'], '2026-10-29');
      expect(
        after.timelineEvidenceDigests['original-a'],
        isNot(before.timelineEvidenceDigests['original-a']),
      );
      expect(
        after.checkpointRecords(after.records).first['source_digest'],
        before.checkpointRecords(before.records).first['source_digest'],
      );
    },
  );

  test(
    'run aliases and fetch renewal do not change durable Timeline identity',
    () {
      final before = evidence(original);
      final after = ProfileEvidence([
        {...parent, 'fetched_at': at + 1000},
        {
          ...original,
          'evidence_id': 'new-original',
          'message_id': 'new-message',
          'chat_id': 'other-chat',
          'sender_id': 'new-sender',
        },
        {...original, 'fetched_at': at + 1000},
      ], timezoneOffset: Duration.zero);
      expect(before.records.first['links'], {'parent': 'e2'});
      expect(after.records.last['links'], {'parent': 'e1'});
      expect(before.records.first['evidence_id'], 'e1');
      expect(after.records.last['evidence_id'], 'e3');
      expect(
        after.timelineEvidenceDigests['original-a'],
        before.timelineEvidenceDigests['original-a'],
      );
      expect(
        after.timelineEvidenceDigests['original-b'],
        before.timelineEvidenceDigests['original-b'],
      );
      expect(
        after
            .checkpointRecords(after.records)
            .last
            .containsKey('timeline_digest'),
        false,
      );
    },
  );

  test(
    'outside targets use outside_window until the linked original is present',
    () {
      final before = evidence({...original, 'parent_id': 'outside-one'});
      final after = evidence({...original, 'parent_id': 'outside-two'});
      expect(
        after.timelineEvidenceDigests['original-a'],
        before.timelineEvidenceDigests['original-a'],
      );
      expect(
        evidence(original).timelineEvidenceDigests['original-a'],
        isNot(before.timelineEvidenceDigests['original-a']),
      );
    },
  );

  test(
    'sender and links updates leave the observation source_digest unchanged',
    () {
      final before = evidence(original);
      final after = evidence({
        ...original,
        'sender_id': 'sender-c',
        'upper_message_id': 'message-b',
      });
      expect(
        after.checkpointRecords(after.records).first['source_digest'],
        before.checkpointRecords(before.records).first['source_digest'],
      );
    },
  );
}
