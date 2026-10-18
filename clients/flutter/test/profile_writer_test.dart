import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_writer.dart';

void main() {
  test('structured repair preserves the complete prior result', () async {
    final valid = <String, dynamic>{
      'timeline': [
        {
          'text': '计划核对项目。',
          'evidence_ids': ['e1'],
          'time_ref': 'e1',
        },
      ],
      'profile': {
        'about': {
          'text': '关注依据。',
          'evidence_ids': ['e1'],
        },
      },
    };
    final invalid = {
      ...valid,
      'profile': {
        ...valid['profile'] as Map,
        'work_projects': {
          'text': '持续核对项目。',
          'evidence_ids': ['e1'],
        },
      },
    };
    var repaired = false;
    final writer = ProfileWriter(
      complete: (stage, _, input) async {
        if (stage == 'observations')
          return {
            'facts': [
              {
                'text': '【事】计划核对项目',
                'refs': ['e1'],
              },
            ],
          };
        if (stage == 'draft') return valid;
        if (stage == 'review') return {'review_notes': []};
        if (stage == 'edit') return invalid;
        expect(stage, 'repair');
        expect(input['validation_error'], 'invalid_profile_category');
        expect(input['previous_result'], invalid);
        expect((input['validation_detail'] as Map)['path'], 'profile');
        repaired = true;
        return {
          ...valid,
          'profile': {
            ...valid['profile'] as Map,
            'work': {
              'text': '持续核对项目。',
              'evidence_ids': ['e1'],
            },
          },
        };
      },
    );
    final output =
        jsonDecode(
              await writer.generate([
                {
                  'evidence_id': 'e1',
                  'chat': 'c1',
                  'relation': 'self',
                  'created_at': '2026-10-17T00:00:00Z',
                  'text': '计划核对项目。',
                },
              ]),
            )
            as List;
    expect(repaired, true);
    expect(output.map((e) => e['key']), ['timeline_1', 'about', 'work']);
    expect(output.first['text'], '计划核对项目。');
  });

  test(
    'structured sections get program-owned identifiers and source dates',
    () {
      final value =
          jsonDecode(
                ProfileWriter.encodeEntries(
                  {
                    'timeline': [
                      {
                        'text': '提出核对计划。',
                        'evidence_ids': ['e1'],
                        'time_ref': 'e1',
                      },
                    ],
                    'profile': {
                      'about': {
                        'text': '关注依据。',
                        'evidence_ids': ['e1'],
                      },
                      'work': {
                        'text': '反复核对项目依据。',
                        'evidence_ids': ['e1'],
                      },
                      'interests': null,
                    },
                  },
                  [
                    {
                      'evidence_id': 'e1',
                      'relation': 'self',
                      'created_at': '2026-10-17T00:00:00Z',
                    },
                  ],
                  requireTimeline: true,
                ),
              )
              as List;
      expect(value.map((e) => e['key']), ['timeline_1', 'about', 'work']);
      expect(value.first['kind'], 'timeline');
      expect(value.first['observed_at'], '2026-10-17T00:00:00Z');
      expect(value.last['kind'], 'profile');
      expect(value.last['text'], '反复核对项目依据。');
    },
  );
  test('structured sections retain citation and attribution validation', () {
    for (final relation in ['self', 'participant']) {
      final output = {
        'timeline': <Object>[],
        'profile': {
          'about': {
            'text': '关注依据。',
            'evidence_ids': [relation == 'self' ? 'forged' : 'e1'],
          },
        },
      };
      expect(
        () => ProfileWriter.encodeEntries(output, [
          {
            'evidence_id': 'e1',
            'relation': relation,
            'created_at': '2026-10-17T00:00:00Z',
          },
        ]),
        throwsStateError,
      );
    }
  });
  test('structured sections reject unknown or injected identifiers', () {
    for (final profile in [
      {
        'about': {
          'text': '关注依据。',
          'evidence_ids': ['e1'],
        },
        'work_projects': {
          'text': '项目',
          'evidence_ids': ['e1'],
        },
      },
      {
        'work': {
          'key': 'about',
          'text': '项目',
          'evidence_ids': ['e1'],
        },
      },
    ]) {
      expect(
        () => ProfileWriter.encodeEntries(
          {'timeline': [], 'profile': profile},
          [
            {
              'evidence_id': 'e1',
              'relation': 'self',
              'created_at': '2026-10-17T00:00:00Z',
            },
          ],
        ),
        throwsStateError,
      );
    }
  });

  test(
    'category repair identifies the exact entry and allowed stable keys',
    () async {
      var repairs = 0;
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【风】反复核对项目依据',
                  'refs': ['e1'],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          if (stage == 'repair') {
            repairs++;
            expect(input['validation_error'], 'invalid_profile_category');
            expect(input['validation_detail'], {
              'path': 'entries[0].key',
              'allowed_values': ['about', 'work', 'interests'],
            });
          }
          return {
            'entries': [
              {
                'kind': 'profile',
                'key': stage == 'repair' ? 'work' : 'work_projects',
                'text': '反复核对项目依据。',
                'evidence_ids': ['e1'],
              },
            ],
          };
        },
      );
      final entries =
          jsonDecode(
                await writer.generate([
                  {
                    'evidence_id': 'e1',
                    'chat': 'c1',
                    'relation': 'self',
                    'created_at': '2026-10-17T00:00:00Z',
                    'text': '再次核对项目依据。',
                  },
                ]),
              )
              as List;
      expect(repairs, 1);
      expect(entries.single['key'], 'work');
      expect(entries.single['text'], '反复核对项目依据。');
    },
  );

  test(
    'sampling cannot turn supported events into an optional Timeline',
    () async {
      final records = List.generate(
        121,
        (i) => <String, dynamic>{
          'evidence_id': 'e$i',
          'chat': 'c',
          'created_at': '2026-10-17T00:00:00Z',
          'relation': 'self',
          'text': '计划推进项目',
        },
      );
      final writer = ProfileWriter(
        complete: (stage, _, _) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】计划推进项目',
                  'refs': records.map((r) => r['evidence_id']).toList(),
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          return {
            'entries': [
              {
                'key': 'about',
                'kind': 'profile',
                'text': '持续推进项目',
                'evidence_ids': ['e0'],
              },
            ],
          };
        },
      );
      await expectLater(
        writer.generate(records),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'reason',
            'missing_timeline',
          ),
        ),
      );
    },
  );
  test(
    'retains valid observations when a different observation cannot be repaired',
    () async {
      var attempts = 0;
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            attempts++;
            return {
              'facts': [
                {
                  'text': '【风】反复核对依据',
                  'refs': ['e1'],
                },
                {
                  'text': '【事】unsupported detail',
                  'refs': ['not-in-batch'],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          expect((input['observations'] as List).length, 1);
          expect(jsonEncode(input), isNot(contains('unsupported detail')));
          return {
            'entries': [
              {
                'key': 'about',
                'kind': 'profile',
                'text': '讨论时重视依据。',
                'evidence_ids': ['e1'],
              },
            ],
          };
        },
      );
      expect(
        jsonDecode(
          await writer.generate([
            {
              'evidence_id': 'e1',
              'chat': 'c1',
              'created_at': '2026-10-17T00:00:00Z',
              'relation': 'self',
              'text': '请反复核对依据',
            },
          ]),
        ),
        hasLength(1),
      );
      expect(attempts, 3);
      expect(writer.incompleteBatches, 1);
    },
  );
  test('repeated patterns may cite more than eight valid originals', () async {
    final records = List.generate(
      12,
      (i) => <String, dynamic>{
        'evidence_id': 'e$i',
        'chat': 'c1',
        'created_at': '2026-10-17T00:00:00Z',
        'relation': 'self',
        'text': '反复讨论项目$i',
      },
    );
    var observations = 0;
    final writer = ProfileWriter(
      complete: (stage, _, input) async {
        if (stage == 'observations') {
          observations++;
          return {
            'facts': [
              {
                'text': '【风】反复核对项目依据',
                'refs': [...records.map((r) => r['evidence_id']), 'e0'],
              },
            ],
          };
        }
        if (stage == 'review') return {'review_notes': []};
        expect(
          ((input['observations'] as List).single['refs'] as List).length,
          12,
        );
        return {
          'entries': [
            {
              'key': 'about',
              'kind': 'profile',
              'text': '讨论中反复核对依据。',
              'evidence_ids': records.map((r) => r['evidence_id']).toList(),
            },
          ],
        };
      },
    );
    expect(jsonDecode(await writer.generate(records)), hasLength(1));
    expect(observations, 1);
  });
  test('failed observation diagnostics never expose model prose', () async {
    final writer = ProfileWriter(
      complete: (_, _, _) async => {
        'facts': [
          {
            'text': '【事】计划',
            'refs': ['private-model-output', 'e999'],
          },
        ],
      },
    );
    await expectLater(
      writer.generate([
        {
          'evidence_id': 'e42',
          'chat': 'c1',
          'created_at': '2026-10-17T00:00:00Z',
          'relation': 'self',
          'text': '计划',
        },
      ]),
      throwsA(
        isA<ProfileObservationFailure>()
            .having((e) => e.message, 'code', 'observation_ref_outside_batch')
            .having((e) => e.detail, 'safe IDs', contains('String,e999'))
            .having(
              (e) => e.detail,
              'no prose',
              isNot(contains('private-model-output')),
            ),
      ),
    );
  });
  test(
    'invalid batch references are repaired against the same originals',
    () async {
      var observations = 0;
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            observations++;
            expect((input['messages'] as List).single['evidence_id'], 'e42');
            expect(input['allowed_evidence_ids'], ['e42']);
            if (observations == 2) {
              expect(
                input['validation_error'],
                'observation_ref_outside_batch',
              );
            }
            return {
              'facts': [
                {
                  'text': '【事】本人计划推进项目',
                  'refs': [observations == 1 ? 'e1' : 'e42'],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          return {
            'entries': [
              {
                'key': 'event',
                'kind': 'timeline',
                'text': '计划推进项目',
                'evidence_ids': ['e42'],
                'time_ref': 'e42',
              },
            ],
          };
        },
      );
      final output =
          jsonDecode(
                await writer.generate([
                  {
                    'evidence_id': 'e42',
                    'chat': 'c1',
                    'created_at': '2026-10-17T00:00:00Z',
                    'relation': 'self',
                    'text': '计划推进项目',
                  },
                ]),
              )
              as List;
      expect(observations, 2);
      expect(output.single['evidence_ids'], ['e42']);
    },
  );
  for (final corrected in [true, false]) {
    test('invalid edit has bounded correction attempts: $corrected', () async {
      var repairs = 0;
      final valid = {
        'entries': [
          {
            'key': 'event',
            'kind': 'timeline',
            'text': '计划推进项目',
            'evidence_ids': ['e1'],
            'time_ref': 'e1',
          },
          {
            'key': 'about',
            'kind': 'profile',
            'text': '反复讨论项目。',
            'evidence_ids': ['e1'],
          },
        ],
      };
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】计划推进项目',
                  'refs': ['e1'],
                },
              ],
            };
          }
          if (stage == 'draft') return valid;
          if (stage == 'review') return {'review_notes': []};
          if (stage == 'repair') {
            repairs++;
            expect(input['validation_error'], 'invalid_projection');
            if (corrected) return valid;
          }
          return {'entries': []};
        },
      );
      final run = writer.generate([
        {
          'evidence_id': 'e1',
          'chat': 'c1',
          'created_at': '2026-10-17T00:00:00Z',
          'relation': 'self',
          'text': '计划推进项目',
        },
      ]);
      if (corrected) {
        expect(jsonDecode(await run), hasLength(2));
        expect(repairs, 1);
      } else {
        await expectLater(run, throwsStateError);
        expect(repairs, 2);
      }
    });
  }
  test(
    'empty timeline and other-speaker profile cannot pass final validation',
    () {
      final originals = [
        {
          'evidence_id': 'e1',
          'relation': 'self',
          'created_at': '2026-10-17T00:00:00.123Z',
        },
        {
          'evidence_id': 'e2',
          'relation': 'participant',
          'created_at': '2026-10-18T00:00:00Z',
        },
      ];
      final profile = {
        'key': 'about',
        'kind': 'profile',
        'text': '研究项目',
        'evidence_ids': ['e1'],
      };
      for (final text in ['', '   ', 'password=synthetic-value']) {
        expect(
          () => ProfileWriter.encodeEntries({
            'entries': [
              {...profile, 'text': text},
            ],
          }, originals),
          throwsStateError,
        );
      }
      expect(
        () => ProfileWriter.encodeEntries(
          {
            'entries': [profile],
          },
          originals,
          requireTimeline: true,
        ),
        throwsStateError,
      );
      expect(
        () => ProfileWriter.encodeEntries({
          'entries': [
            {
              ...profile,
              'evidence_ids': ['e2'],
            },
          ],
        }, originals),
        throwsStateError,
      );
      expect(
        () => ProfileWriter.encodeEntries({
          'entries': [
            {...profile, 'kind': 'timeline', 'time_ref': 'e2'},
          ],
        }, originals),
        throwsStateError,
      );
    },
  );

  test(
    'selection spans time and observation kinds within original-message budget',
    () {
      final originals = List.generate(
        1000,
        (i) => <String, dynamic>{
          'evidence_id': 'e$i',
          'created_at': DateTime.utc(
            2026,
          ).add(Duration(hours: i)).toIso8601String(),
        },
      );
      final facts = List.generate(
        1000,
        (i) => <String, dynamic>{
          'text': '${['【事】', '【人】', '【风】'][i % 3]} observation',
          'refs': ['e$i'],
        },
      );
      final selected = ProfileWriter.selectOriginals(originals, facts);
      expect(selected.length, 120);
      final indices = selected
          .map((e) => int.parse((e['evidence_id'] as String).substring(1)))
          .toList();
      expect(indices.where((i) => i < 100), isNotEmpty);
      expect(indices.where((i) => i >= 900), isNotEmpty);
      for (var kind = 0; kind < 3; kind++) {
        expect(indices.where((i) => i % 3 == kind).length, greaterThan(20));
      }
    },
  );
  test(
    'batches all originals, reviews draft, restores timeline time from cited source',
    () async {
      final records = List.generate(
        320,
        (i) => <String, dynamic>{
          'evidence_id': 'e$i',
          'chat': 'c${i % 3}',
          'speaker': 'self',
          'relation': 'self',
          'created_at': '2026-10-17T00:00:00.${i.toString().padLeft(3, '0')}Z',
          'text': 'Project detail $i ${List.filled(200, 'x').join()}',
        },
      );
      final seen = <String>{};
      final stages = <String>[];
      final writer = ProfileWriter(
        complete: (stage, instructions, input) async {
          stages.add(stage);
          if (stage == 'observations') {
            final batch = input['messages'] as List;
            seen.addAll(batch.map((e) => e['evidence_id'] as String));
            return {
              'facts': [
                {
                  'text': '【事】本人计划推进项目',
                  'refs': [batch.first['evidence_id']],
                },
              ],
            };
          }
          if (stage == 'review') {
            expect((input['draft'] as Map)['timeline'], isNotEmpty);
            expect((input['draft'] as Map)['profile'], contains('about'));
            return {
              'review_notes': ['计划不能写成已完成'],
            };
          }
          if (stage == 'edit') expect(input['review_notes'], ['计划不能写成已完成']);
          final ref = (input['messages'] as List).first['evidence_id'];
          return {
            'timeline': [
              {
                'text': '计划推进项目',
                'evidence_ids': [ref],
                'time_ref': ref,
              },
            ],
            'profile': {
              'about': {
                'text': '反复讨论项目方案。',
                'evidence_ids': [ref],
              },
            },
          };
        },
      );
      final output = jsonDecode(await writer.generate(records)) as List;
      expect(seen.length, 320);
      expect(stages.where((s) => s == 'observations').length, greaterThan(1));
      expect(stages.sublist(stages.length - 3), ['draft', 'review', 'edit']);
      final timeline = output.first;
      expect(
        timeline['observed_at'],
        records.firstWhere(
          (e) => e['evidence_id'] == timeline['evidence_ids'].first,
        )['created_at'],
      );
      expect(timeline.containsKey('time_ref'), false);
    },
  );

  test(
    'forged batch citations fail instead of retaining unsupported prose',
    () async {
      var attempts = 0;
      final writer = ProfileWriter(
        complete: (_, _, _) async {
          attempts++;
          return {
            'facts': [
              {
                'text': '【事】unsupported',
                'refs': ['not-in-batch'],
              },
            ],
          };
        },
      );
      await expectLater(
        writer.generate([
          {
            'evidence_id': 'e1',
            'chat': 'c1',
            'created_at': '2026-10-17T00:00:00Z',
            'relation': 'self',
            'text': 'hello',
          },
        ]),
        throwsStateError,
      );
      expect(attempts, 3);
    },
  );
}
