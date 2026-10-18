import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_evidence.dart';

void main() {
  test(
    'near-expiry exclusion cannot turn a copied participant text into self evidence',
    () {
      final deadline = DateTime.utc(2026, 10, 18, 16, 30);
      final text = 'another participant report ' * 8;
      final sourceTime = deadline.subtract(
        const Duration(days: 30, minutes: 5),
      );
      final originals = List.generate(
        2,
        (i) => <String, dynamic>{
          'evidence_id': 'original-$i',
          'chat_id': 'c',
          'sender_id': 'speaker-$i',
          'relation': i == 0 ? 'participant' : 'self',
          'text': text,
          'created_at': sourceTime
              .add(Duration(days: i))
              .millisecondsSinceEpoch,
        },
      );
      expect(
        ProfileEvidence(originals, validThrough: deadline).records,
        isEmpty,
      );
    },
  );
  test('excludes texts expiring before the bounded run can finish', () {
    final deadline = DateTime.utc(2026, 10, 18, 16, 30);
    final originals = List.generate(
      3,
      (i) => <String, dynamic>{
        'evidence_id': 'original-$i',
        'chat_id': 'c',
        'sender_id': 'self',
        'relation': 'self',
        'text': 'Text $i',
        'created_at': deadline
            .subtract(const Duration(days: 30))
            .add(Duration(minutes: i - 1))
            .millisecondsSinceEpoch,
      },
    );
    final evidence = ProfileEvidence(originals, validThrough: deadline);
    expect(evidence.records.map((e) => e['text']), ['Text 2']);
    expect(evidence.expiringCount, 2);
    expect(evidence.expired(deadline), false);
    expect(evidence.expired(deadline.add(const Duration(minutes: 1))), true);
    expect(
      evidence.restoreCitations('[{"evidence_ids":["e1"]}]'),
      contains('original-2'),
    );
  });
  test('compact context keeps every text and restores exact citations', () {
    final originals = List.generate(
      2000,
      (i) => <String, dynamic>{
        'evidence_id': 'original-$i',
        'identity': 'private-account',
        'chat_id': 'chat-${i % 3}',
        'message_id': 'private-message-$i',
        'sender_id': i.isEven ? 'self-id' : 'other-id',
        'relation': i.isEven ? 'self' : 'participant',
        'created_at': 1792195200000 + i,
        'text': 'Text $i',
        'status': 'available',
      },
    );
    final evidence = ProfileEvidence(originals);
    expect(evidence.expired(DateTime.utc(2026, 11, 15, 23, 59, 59)), false);
    expect(evidence.expired(DateTime.utc(2026, 11, 16)), true);
    final received = <Map<String, dynamic>>[];
    var offset = 0;
    while (offset < originals.length) {
      final page = evidence.page(offset);
      expect(page, isNotEmpty);
      expect(jsonEncode(page).length, lessThan(42000));
      received.addAll(page);
      offset += page.length;
    }
    expect(received.map((e) => e['text']), originals.map((e) => e['text']));
    expect(jsonEncode(received), isNot(contains('private-')));
    expect(received[0]['speaker'], received[2]['speaker']);
    expect(received[0]['speaker'], isNot(received[1]['speaker']));
    expect(received[0]['chat'], received[3]['chat']);
    final restored =
        jsonDecode(
              evidence.restoreCitations(
                jsonEncode([
                  {
                    'key': 'work',
                    'evidence_ids': [
                      received[0]['evidence_id'],
                      received.last['evidence_id'],
                    ],
                  },
                ]),
              ),
            )
            as List;
    expect(restored.single['evidence_ids'], ['original-0', 'original-1999']);
    expect(
      () => evidence.restoreCitations('[{"evidence_ids":["invented"]}]'),
      throwsStateError,
    );
    expect(() => evidence.page(-1), throwsStateError);
    expect(received.first['created_at'], '2026-10-17T00:00:00.000Z');
  });
}
