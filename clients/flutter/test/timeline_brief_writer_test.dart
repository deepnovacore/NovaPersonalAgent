import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/timeline_brief.dart';

Map<String, dynamic> brief(String ref, String quote) => {
  'title': '项目已完成核验',
  'status_label': '已完成',
  'facts': [
    {'text': '原计划已完成，后续验证通过。', 'ref': ref, 'quote': quote},
  ],
  'why_now': '本人等待的验证结果已经明确，可以据此安排后续交付。',
  'next_steps': [],
  'uncertainty': '',
};

void main() {
  test(
    '552 unique Chinese observations and distinct dates survive compact selection',
    () async {
      final records = List.generate(
        552,
        (i) => <String, dynamic>{
          'evidence_id': 'e$i',
          'chat': 'shared-chat',
          'relation': 'self',
          'created_at': DateTime.utc(
            2025,
            1,
            1,
          ).add(Duration(days: i)).toIso8601String(),
          'text': '本人等待的验证通过',
        },
      );
      final facts = List.generate(
        552,
        (i) => <String, dynamic>{
          'text': '${['【事】', '【人】', '【风】'][i % 3]}${'项目进展核对' * 15}，观察$i',
          'refs': ['e$i'],
        },
      );
      var selectionCalls = 0;
      final writer = ProfileWriter(
        loadValidatedBatch: (messages) async => [
          for (final message in messages)
            facts[int.parse((message['evidence_id'] as String).substring(1))],
        ],
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_select') {
            selectionCalls++;
            expect(input.containsKey('observations'), false);
            final compact = input['observation_index'] as Map;
            expect(compact['schema'], 'timeline-index-v1');
            final restored = [
              for (final row in compact['rows'] as List)
                {
                  'index': row[0],
                  'text': compact['texts'][row[1]],
                  'from': compact['times'][compact['contexts'][row[2]][0]],
                  'to': compact['times'][compact['contexts'][row[2]][1]],
                  'relations':
                      compact['relation_sets'][compact['contexts'][row[2]][2]],
                  'groups':
                      compact['group_sets'][compact['contexts'][row[2]][3]],
                },
            ];
            expect(restored, timelineObservationIndex(facts, records));
            expect(compact['rows'], hasLength(552));
            expect(compact['contexts'], hasLength(552));
            expect(compact['texts'], hasLength(552));
            expect(compact['times'], hasLength(552));
            expect(compact['group_sets'], hasLength(1));
            expect(instructions, contains('observation_index'));
            return {
              'topics': [
                {
                  'observation_indices': [551],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          return {
            'timeline': [
              {
                'brief': brief('e551', '验证通过'),
                'evidence_ids': ['e551'],
                'time_ref': 'e551',
              },
            ],
            'profile': {},
          };
        },
      );
      final output =
          jsonDecode(
                await writer.generate(records, savedObservationsOnly: true),
              )
              as List;
      expect(output.single['brief']['facts'].single['ref'], 'e551');
      expect(selectionCalls, 1);
      expect(writer.coverage['timeline_index_compact'], 1);
      expect(
        writer.coverage['timeline_index_full_characters'],
        greaterThan(128000),
      );
      expect(
        writer.coverage['timeline_index_sent_characters'],
        lessThan(128000),
      );
      expect(writer.coverage['timeline_index_sent_bytes'], lessThan(220000));
    },
  );

  test(
    'new generation repairs legacy prose instead of accepting unstructured timeline',
    () async {
      var repairs = 0;
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】本人验证已完成',
                  'refs': ['e1'],
                },
              ],
            };
          }
          if (stage == 'timeline_select') {
            return {
              'topics': [
                {
                  'observation_indices': [0],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          if (stage == 'repair') {
            repairs++;
            expect(input['validation_error'], 'invalid_projection');
            return {
              'timeline': [
                {
                  'brief': brief('e1', '验证通过'),
                  'evidence_ids': ['e1'],
                  'time_ref': 'e1',
                },
              ],
              'profile': {},
            };
          }
          return {
            'timeline': [
              {
                'text': '验证完成',
                'evidence_ids': ['e1'],
                'time_ref': 'e1',
              },
            ],
            'profile': {},
          };
        },
      );
      final result =
          jsonDecode(
                await writer.generate([
                  {
                    'evidence_id': 'e1',
                    'chat': 'c',
                    'relation': 'self',
                    'created_at': '2026-10-17T00:00:00Z',
                    'text': '验证通过',
                  },
                ]),
              )
              as List;
      expect(repairs, 1);
      expect(result.single['brief']['next_steps'], isEmpty);
    },
  );

  test('brief facts require exact original quotes and per-card refs', () {
    final source = <String, dynamic>{
      'e1': {'text': '验证通过，已完成。'},
      'e2': {'text': '其他事项'},
    };
    expect(
      normalizeTimelineBrief(brief('e1', '验证通过'), ['e1'], source)['facts'],
      hasLength(1),
    );
    expect(
      () => normalizeTimelineBrief(brief('e1', '验证已经通过'), ['e1'], source),
      throwsStateError,
    );
    expect(
      () => normalizeTimelineBrief(brief('e2', '其他事项'), ['e1'], source),
      throwsStateError,
    );
    final sanitized = normalizeTimelineBrief(
      {...brief('e1', '验证通过'), 'why_now': '核对结果 password=private-value'},
      ['e1'],
      source,
    );
    expect(sanitized['why_now'], isNot(contains('private-value')));
  });
  test(
    'cross-date observation indices restore all originals and reject invented indices',
    () {
      final observations = [
        {
          'text': '【事】本人计划',
          'refs': ['e1'],
        },
        {
          'text': '【事】后续完成',
          'refs': ['e2'],
        },
      ];
      expect(
        timelineSelectedGroups({
          'topics': [
            {
              'observation_indices': [0, 1],
            },
          ],
        }, observations),
        [
          ['e1', 'e2'],
        ],
      );
      expect(
        () => timelineSelectedGroups({
          'topics': [
            {
              'observation_indices': [2],
            },
          ],
        }, observations),
        throwsStateError,
      );
    },
  );
  test(
    'oversized topic is skipped whole and selected topics precede profile sampling',
    () {
      final records = [
        {'evidence_id': 'e1', 'created_at': '2026-01-01', 'text': 'a' * 48000},
        {'evidence_id': 'e2', 'created_at': '2026-01-02', 'text': 'completed'},
        {'evidence_id': 'e3', 'created_at': '2026-01-03', 'text': 'new topic'},
      ];
      final fitted = fitTimelineGroups([
        ['e1', 'e2'],
        ['e3'],
      ], records);
      expect(fitted.groups, [
        ['e3'],
      ]);
      expect(fitted.skipped, 1);
      final selected = ProfileWriter.selectOriginals(records, [
        {
          'text': '【风】profile',
          'refs': ['e1'],
        },
      ], priorityGroups: fitted.groups);
      expect(selected.map((r) => r['evidence_id']), ['e3']);
    },
  );
  test(
    'timeline-selected source is available even when profile sampling omitted it',
    () async {
      final records = List.generate(
        130,
        (i) => <String, dynamic>{
          'evidence_id': 'e$i',
          'chat': 'c',
          'relation': 'self',
          'created_at': '2026-10-17T00:00:00Z',
          'text': i == 129 ? '本人等待的验证通过' : '背景$i',
        },
      );
      final observations = [
        for (var i = 0; i < 130; i++)
          {
            'text': '【风】习惯$i',
            'refs': ['e$i'],
          },
      ];
      final writer = ProfileWriter(
        loadValidatedBatch: (_) async => observations,
        complete: (stage, _, input) async {
          if (stage == 'timeline_select') {
            expect((input['observations'] as List).length, 130);
            return {
              'topics': [
                {
                  'observation_indices': [129],
                },
              ],
            };
          }
          expect(
            (input['messages'] as List).any((r) => r['evidence_id'] == 'e129'),
            true,
          );
          expect((input['messages'] as List).length, lessThanOrEqualTo(120));
          if (stage == 'review') return {'review_notes': []};
          return {
            'timeline': [
              {
                'brief': brief('e129', '验证通过'),
                'evidence_ids': ['e129'],
                'time_ref': 'e129',
              },
            ],
            'profile': {},
          };
        },
      );
      final result =
          jsonDecode(
                await writer.generate(records, savedObservationsOnly: true),
              )
              as List;
      expect(result.single['brief']['facts'].single['ref'], 'e129');
      expect(writer.coverage['timeline_included_topics'], 1);
    },
  );
  test(
    'oversized selection index fails before network and is never truncated',
    () async {
      var calls = 0;
      final facts = List.generate(
        500,
        (i) => <String, dynamic>{
          'text': '【事】$i${'x' * 390}',
          'refs': ['e1'],
        },
      );
      final writer = ProfileWriter(
        loadValidatedBatch: (_) async => facts,
        complete: (_, _, _) async {
          calls++;
          return {};
        },
      );
      await expectLater(
        writer.generate([
          {
            'evidence_id': 'e1',
            'chat': 'c',
            'relation': 'self',
            'created_at': '2026-10-17T00:00:00Z',
            'text': 'source',
          },
        ], savedObservationsOnly: true),
        throwsA(
          isA<ProfileContextFailure>()
              .having((e) => e.message, 'reason', 'profile_context_too_large')
              .having((e) => e.stage, 'stage', 'timeline_select')
              .having((e) => e.characters, 'characters', greaterThan(128000))
              .having(
                (e) => jsonDecode(e.detail).keys.toSet(),
                'diagnostic keys',
                {'stage', 'characters', 'utf8_bytes'},
              ),
        ),
      );
      expect(
        writer.coverage['timeline_index_sent_characters'],
        greaterThan(128000),
      );
      expect(writer.coverage['timeline_index_sent_bytes'], greaterThan(0));
      expect(calls, 0);
    },
  );
  test(
    'independent screening may omit all events without forcing filler',
    () async {
      final stages = <String>[];
      final writer = ProfileWriter(
        complete: (stage, instructions, input) async {
          stages.add(stage);
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】例行授权成功',
                  'refs': ['e1'],
                },
              ],
            };
          }
          if (stage == 'timeline_select') return {'topics': []};
          if (stage == 'review') return {'review_notes': []};
          return {
            'timeline': [],
            'profile': {
              'about': {
                'text': '重视依据。',
                'evidence_ids': ['e1'],
              },
            },
          };
        },
      );
      final result = jsonDecode(
        await writer.generate([
          {
            'evidence_id': 'e1',
            'chat': 'c',
            'relation': 'self',
            'created_at': '2026-10-17T00:00:00Z',
            'text': '授权成功，我重视依据。',
          },
        ]),
      );
      expect(stages, [
        'observations',
        'timeline_select',
        'draft',
        'review',
        'edit',
      ]);
      expect((result as List).where((r) => r['kind'] == 'timeline'), isEmpty);
    },
  );
}
