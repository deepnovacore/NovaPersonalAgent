import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/timeline_brief.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'timeline_brief_writer_test.dart' show brief;

final records = <Map<String, dynamic>>[
  {
    'evidence_id': 'e0',
    'chat': 'c1',
    'speaker': 'p1',
    'relation': 'self',
    'created_at': '2026-10-19T00:00:00Z',
    'text': '本人完成核验',
  },
];
final observations = <Map<String, dynamic>>[
  {
    'text': '【事】本人完成核验',
    'refs': ['e0'],
  },
];
void main() {
  test(
    'first and last failure diagnostics do not mix stale integer values',
    () async {
      var calls = 0;
      final writer = ProfileWriter(
        loadValidatedBatch: (_) async => observations,
        complete: (stage, _, input) async {
          calls++;
          return {
            'topics': [
              {
                'observation_indices': [calls == 1 ? 3 : 'private text'],
              },
            ],
          };
        },
      );
      await expectLater(
        writer.generate(records, savedObservationsOnly: true),
        throwsA(isA<TimelineSelectionFailure>()),
      );
      expect(calls, 2);
      expect(writer.coverage['selection_first_failure_reason_code'], 7);
      expect(writer.coverage['selection_first_failure_invalid_index'], 3);
      expect(writer.coverage['selection_failure_reason_code'], 6);
      expect(
        writer.coverage.containsKey('selection_failure_invalid_index'),
        false,
      );
      expect(jsonEncode(writer.coverage), isNot(contains('private text')));
    },
  );

  test('invalid scalar detail contains no model prose', () {
    try {
      timelineSelectedGroups({
        'topics': [
          {
            'observation_indices': ['private text'],
          },
        ],
      }, observations);
      fail('accepted invalid scalar');
    } on TimelineSelectionFailure catch (error) {
      expect(error.message, 'profile_selection_invalid');
      expect(error.detail['reason'], 'index_not_integer');
      expect(error.detail['path'], 'topics[0].observation_indices[0]');
      expect(error.detail.containsKey('invalid_index'), false);
      expect(jsonEncode(error.detail), isNot(contains('private text')));
    }
  });
  test('malformed selection twice fails terminal without draft', () async {
    var calls = 0;
    final writer = ProfileWriter(
      loadValidatedBatch: (_) async => observations,
      complete: (stage, _, input) async {
        calls++;
        expect(stage, 'timeline_select');
        return {'topics': 'bad'};
      },
    );
    await expectLater(
      writer.generate(records, savedObservationsOnly: true),
      throwsA(
        isA<TimelineSelectionFailure>().having(
          (e) => e.message,
          'code',
          'profile_selection_invalid',
        ),
      ),
    );
    expect(calls, 2);
    expect(writer.coverage['selection_repair_attempts'], 1);
  });
  test(
    'repair context over limit fails before a second request without truncation',
    () async {
      var calls = 0;
      final writer = ProfileWriter(
        loadValidatedBatch: (_) async => observations,
        complete: (stage, _, input) async {
          calls++;
          return {'topics': 'x' * 130000};
        },
      );
      await expectLater(
        writer.generate(records, savedObservationsOnly: true),
        throwsA(
          isA<ProfileContextFailure>().having(
            (e) => e.stage,
            'stage',
            'timeline_select',
          ),
        ),
      );
      expect(calls, 1);
    },
  );

  test(
    'selection repair reuses complete index and revalidates before drafting',
    () async {
      var selections = 0, drafts = 0;
      Map<String, dynamic>? originalInput;
      final invalid = {
        'topics': [
          {
            'observation_indices': [1],
          },
        ],
      };
      final writer = ProfileWriter(
        loadValidatedBatch: (_) async => observations,
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_select') {
            selections++;
            expect(input['observation_count'], 1);
            expect(input['allowed_index_min'], 0);
            expect(input['allowed_index_max'], 0);
            if (selections == 1) {
              originalInput = Map.of(input);
              return invalid;
            }
            for (final key in originalInput!.keys) {
              expect(input[key], originalInput![key]);
            }
            expect(input['previous_selection'], invalid);
            expect(input['selection_error'], {
              'reason': 'index_out_of_range',
              'path': 'topics[0].observation_indices[0]',
              'invalid_index': 1,
              'observation_count': 1,
              'allowed_index_min': 0,
              'allowed_index_max': 0,
            });
            expect(instructions, contains('不是字典下标'));
            return {
              'topics': [
                {
                  'observation_indices': [0],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          drafts++;
          return {
            'timeline': [
              {
                'brief': brief('e0', '本人完成核验'),
                'evidence_ids': ['e0'],
                'time_ref': 'e0',
              },
            ],
            'profile': {},
          };
        },
      );
      await writer.generate(records, savedObservationsOnly: true);
      expect(selections, 2);
      expect(drafts, 2);
      expect(writer.coverage['selection_repair_attempts'], 1);
      expect(writer.coverage['selection_failure_reason_code'], 7);
      expect(writer.coverage['selection_failure_invalid_index'], 1);
      expect(writer.coverage['selection_failure_topic_position'], 0);
      expect(writer.coverage['selection_failure_index_position'], 0);
    },
  );
  for (final failure in [
    'model_timeout',
    'profile_budget_exhausted',
    'authorization_changed',
  ]) {
    test('$failure is not a selection contract repair', () async {
      var calls = 0;
      final writer = ProfileWriter(
        loadValidatedBatch: (_) async => observations,
        complete: (stage, _, input) async {
          calls++;
          throw StateError(failure);
        },
      );
      await expectLater(
        writer.generate(records, savedObservationsOnly: true),
        throwsA(isA<StateError>().having((e) => e.message, 'code', failure)),
      );
      expect(calls, 1);
      expect(writer.coverage['selection_repair_attempts'], 0);
    });
  }
  test('fixed selection failure remains a trusted agent code', () {
    expect(
      profileRunErrorCode(StateError('profile_selection_invalid')),
      'profile_selection_invalid',
    );
  });
}
