import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_evidence.dart';

void main() {
  Map<String, dynamic> source(
    String id, {
    String? sender = 'ou_other',
    String? kind,
    String relation = 'participant',
    String? mention,
    Map<String, dynamic> extra = const {},
  }) => {
    'evidence_id': 'original-$id',
    'message_id': id,
    'chat_id': 'chat',
    'sender_id': sender,
    'sender_type': ?kind,
    'relation': relation,
    'mention': ?mention,
    'created_at': DateTime.utc(2026, 10, 29, 20).millisecondsSinceEpoch,
    'text': 'Message $id',
    ...extra,
  };
  test(
    'authors distinguish self, people, apps, addressed and legacy unknown',
    () {
      final evidence = ProfileEvidence([
        source('self', sender: 'ou_self', kind: 'user', relation: 'self'),
        source('direct', kind: 'user', mention: 'direct'),
        source('all', kind: 'user', mention: 'all'),
        source('bot', sender: 'app_bot', kind: 'app', relation: 'self'),
        source('legacy', sender: 'ou_legacy', relation: 'self'),
        source('missing', sender: null, relation: 'unknown'),
      ]);
      final records = evidence.records;
      expect(records.map((r) => r['relation']), [
        'self',
        'addressed',
        'participant',
        'app',
        'self',
        'unknown',
      ]);
      expect(records.map((r) => r['author']), [
        {'key': 'self', 'kind': 'person', 'is_user': true},
        {'key': 'p1', 'kind': 'person', 'is_user': false},
        {'key': 'p1', 'kind': 'person', 'is_user': false},
        {'key': 'self', 'kind': 'app', 'is_user': false},
        {'key': 'self', 'kind': 'unknown', 'is_user': true},
        {'key': 'unknown', 'kind': 'unknown', 'is_user': false},
      ]);
      expect(records[1]['mentions_user'], true);
      expect(records[2].containsKey('mentions_user'), false);
      expect(
        records.every(
          (r) => !r.containsKey('speaker') && !r.containsKey('body_authorship'),
        ),
        true,
      );
    },
  );
  test(
    'links resolve both directions and filtered parents stay outside window',
    () {
      final records = ProfileEvidence([
        source(
          'reply',
          extra: {
            'parent_id': 'parent',
            'root_id': 'missing',
            'upper_message_id': 'container',
          },
        ),
        source('parent'),
        source('container'),
        source('filtered', extra: {'text': ''}),
        source('last', extra: {'parent_id': 'filtered'}),
      ]).records;
      expect(records.first['links'], {
        'parent': 'e2',
        'root': 'outside_window',
        'forwarded_in': 'e3',
      });
      expect(records.last['links'], {'parent': 'outside_window'});
      expect(records[1]['links'], isEmpty);
    },
  );
  test(
    'new addressed and app classifications retain copied-text exclusion',
    () {
      for (final relation in ['addressed', 'app']) {
        final text = 'Shared synthetic report ' * 8;
        final evidence = ProfileEvidence([
          source('original', relation: relation, extra: {'text': text}),
          source(
            'copy',
            sender: 'ou_self',
            relation: 'self',
            extra: {'text': text},
          ),
        ]);
        expect(evidence.copiedCount, 1);
        expect(evidence.records, hasLength(1));
        expect(evidence.records.single['author']['is_user'], false);
      }
    },
  );
  test(
    'local date uses injected timezone offset across UTC midnight',
    () async {
      final originals = [source('late')];
      final east = ProfileEvidence(
        originals,
        timezoneOffset: const Duration(hours: 8),
      );
      final west = await ProfileEvidence.build(
        originals,
        timezoneOffset: const Duration(hours: -8),
      );
      expect(east.records.single['local_date'], '2026-10-30');
      expect(west.records.single['local_date'], '2026-10-29');
      expect(
        east.records.single['created_at'],
        west.records.single['created_at'],
      );
    },
  );
  test(
    'checkpoint identities survive aliases but metadata changes invalidate',
    () {
      final original = source('a', kind: 'user', extra: {'parent_id': 'b'});
      final first = ProfileEvidence([original, source('b')]);
      final next = ProfileEvidence([
        source('c', sender: 'ou_new'),
        original,
        source('b'),
      ]);
      expect(
        first.checkpointRecords([first.records.first]),
        next.checkpointRecords([next.records[1]]),
      );
      for (final metadata in [
        {'sender_type': 'app'},
        {'mention': 'all'},
        {
          'mention_ids': ['ou_mentioned'],
        },
        {'thread_id': 'thread'},
        {'parent_id': 'outside'},
        {'root_id': 'root'},
        {'upper_message_id': 'container'},
      ]) {
        final changed = ProfileEvidence([
          {...original, ...metadata},
          source('b'),
        ]);
        expect(
          changed.checkpointRecords([changed.records.first]),
          isNot(first.checkpointRecords([first.records.first])),
        );
      }
    },
  );
  test('restores fact and temporal citations; resolved time passes through', () {
    final evidence = ProfileEvidence([source('a'), source('b')]);
    final date = {
      'role': 'scheduled',
      'date': '2026-10-30',
      'ref': 'e2',
      'quote': 'Scheduled for 2026-10-30',
    };
    final restored =
        jsonDecode(
              evidence.restoreCitations(
                jsonEncode([
                  {
                    'evidence_ids': ['e1', 'e2'],
                    'brief': {
                      'facts': [
                        {'ref': 'e1', 'text': 'Message a'},
                      ],
                      'temporal': {
                        'kind': 'scheduled',
                        'dates': [date],
                      },
                    },
                    'time': {
                      'kind': 'scheduled',
                      'anchor_date': '2026-10-30',
                      'anchor_basis': 'scheduled',
                    },
                  },
                ]),
              ),
            )
            as List;
    expect(restored.single['evidence_ids'], ['original-a', 'original-b']);
    expect(restored.single['brief']['facts'].single['ref'], 'original-a');
    expect(restored.single['brief']['temporal']['dates'].single, {
      ...date,
      'ref': 'original-b',
    });
    expect(restored.single['time'], {
      'kind': 'scheduled',
      'anchor_date': '2026-10-30',
      'anchor_basis': 'scheduled',
    });
  });
  test('temporal citations must be known and belong to the card', () {
    final evidence = ProfileEvidence([source('a'), source('b')]);
    for (final location in ['temporal']) {
      for (final ref in ['e2', 'invented', null]) {
        final dates = {
          'dates': [
            {
              'ref': ref,
              'date': '2026-10-30',
              'role': 'scheduled',
              'quote': 'Tomorrow',
            },
          ],
        };
        expect(
          () => evidence.restoreCitations(
            jsonEncode([
              {
                'evidence_ids': ['e1'],
                'brief': {
                  'facts': [
                    {'ref': 'e1'},
                  ],
                  if (location == 'temporal') 'temporal': dates,
                },
              },
            ]),
          ),
          throwsStateError,
          reason: '$location ref=$ref',
        );
      }
    }
  });
  test('rejects malformed temporal date containers', () {
    final evidence = ProfileEvidence([source('a')]);
    for (final location in ['temporal']) {
      for (final value in [
        'invalid',
        <String, dynamic>{},
        {'dates': 'invalid'},
        {
          'dates': ['invalid'],
        },
      ]) {
        expect(
          () => evidence.restoreCitations(
            jsonEncode([
              {
                'evidence_ids': ['e1'],
                'brief': {
                  'facts': [
                    {'ref': 'e1'},
                  ],
                  if (location == 'temporal') 'temporal': value,
                },
              },
            ]),
          ),
          throwsStateError,
          reason: '$location value=$value',
        );
      }
    }
  });
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
    expect(received[0]['author'], received[2]['author']);
    expect(received[0]['author'], isNot(received[1]['author']));
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
