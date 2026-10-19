import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/profile_writer.dart';

void main() {
  final records = <Map<String, dynamic>>[
    {
      'evidence_id': 'e1',
      'chat': 'c',
      'relation': 'self',
      'created_at': '2026-10-19T00:00:00Z',
      'text': '本人提出核对项目计划',
    },
    {
      'evidence_id': 'e2',
      'chat': 'c',
      'relation': 'participant',
      'created_at': '2026-10-19T00:01:00Z',
      'text': '同事声称已经完成实现',
    },
  ];
  final timeline = [
    {
      'text': '同事汇报实现完成',
      'evidence_ids': ['e2'],
      'time_ref': 'e2',
    },
  ];
  for (final remove in [false, true]) {
    test(
      'self-evidence repair locates profile field and can ${remove ? 'omit unsupported claim' : 'rewrite from self evidence'}',
      () async {
        var repairs = 0;
        final bad = {
          'timeline': timeline,
          'profile': {
            'about': {
              'text': '本人完成实现',
              'evidence_ids': ['e1', 'e2'],
            },
          },
        };
        final writer = ProfileWriter(
          complete: (stage, instructions, input) async {
            if (stage == 'observations') {
              return {
                'facts': [
                  {
                    'text': '【事】本人提出计划，同事汇报进展',
                    'refs': ['e1', 'e2'],
                  },
                ],
              };
            }
            expect(input['self_evidence_ids'], ['e1']);
            if (stage == 'review') return {'review_notes': []};
            if (stage == 'repair') {
              repairs++;
              expect(
                input['validation_error'],
                'profile_requires_self_evidence',
              );
              final detail = input['validation_detail'] as Map;
              expect(detail['path'], 'profile.about.evidence_ids');
              expect(detail['invalid_references'], [
                {'evidence_id': 'e2', 'relation': 'participant'},
              ]);
              expect(detail['allowed_values'], ['e1']);
              expect(jsonEncode(detail), isNot(contains('本人完成实现')));
              expect(instructions, contains('不能机械替换引用'));
              return {
                'timeline': timeline,
                'profile': {
                  'about': remove
                      ? null
                      : {
                          'text': '本人提出核对项目计划',
                          'evidence_ids': ['e1'],
                        },
                },
              };
            }
            return bad;
          },
        );
        final entries = jsonDecode(await writer.generate(records)) as List;
        expect(repairs, 1);
        expect(
          entries.where((e) => e['kind'] == 'timeline').single['evidence_ids'],
          ['e2'],
        );
        expect(
          entries.where((e) => e['kind'] == 'profile'),
          remove ? isEmpty : hasLength(1),
        );
      },
    );
  }
  test(
    'no self evidence can retain grounded timeline and omit unsupported profile',
    () async {
      var repairs = 0;
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】同事汇报完成',
                  'refs': ['e2'],
                },
              ],
            };
          }
          expect(input['self_evidence_ids'], isEmpty);
          if (stage == 'review') return {'review_notes': []};
          if (stage == 'repair') {
            repairs++;
            expect(input['validation_detail']['allowed_values'], isEmpty);
            return {
              'timeline': timeline,
              'profile': {'about': null, 'work': null, 'interests': null},
            };
          }
          return {
            'timeline': timeline,
            'profile': {
              'about': {
                'text': '错误归因本人',
                'evidence_ids': ['e2'],
              },
            },
          };
        },
      );
      final output = jsonDecode(await writer.generate([records[1]])) as List;
      expect(output, hasLength(1));
      expect(output.single['kind'], 'timeline');
      expect(repairs, 1);
    },
  );
  test(
    'persistent mixed references still fail after exactly two repair requests',
    () async {
      var repairs = 0;
      final bad = {
        'timeline': timeline,
        'profile': {
          'work': {
            'text': '未核实的本人行动',
            'evidence_ids': ['e1', 'e2'],
          },
        },
      };
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】协作讨论',
                  'refs': ['e1', 'e2'],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          if (stage == 'repair') {
            repairs++;
            expect(
              input['validation_detail']['path'],
              'profile.work.evidence_ids',
            );
          }
          return bad;
        },
      );
      await expectLater(
        writer.generate(records),
        throwsA(
          isA<ProfileValidationFailure>().having(
            (e) => e.message,
            'code',
            'profile_requires_self_evidence',
          ),
        ),
      );
      expect(repairs, 2);
    },
  );
  test(
    'todo and legacy entry errors identify exact unsupported references without changing rules',
    () {
      for (final legacy in [false, true]) {
        final output = <String, dynamic>{
          if (legacy)
            'entries': [
              {
                'key': 'candidate',
                'kind': 'todo_candidate',
                'text': '未核实承诺',
                'evidence_ids': ['e2'],
                'time_ref': 'e2',
              },
            ]
          else
            'todos': [
              {
                'text': '未核实承诺',
                'evidence_ids': ['e2'],
                'time_ref': 'e2',
              },
            ],
        };
        expect(
          () => ProfileWriter.encodeEntries(output, records),
          throwsA(
            isA<ProfileValidationFailure>().having(
              (e) => e.detail['path'],
              'path',
              legacy ? 'entries[0].evidence_ids' : 'todos[0].evidence_ids',
            ),
          ),
        );
      }
    },
  );
}
