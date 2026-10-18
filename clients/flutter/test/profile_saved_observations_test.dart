import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_writer.dart';

List<Map<String, dynamic>> records() => List.generate(
  3,
  (i) => {
    'evidence_id': 'e$i',
    'chat': 'c',
    'relation': 'self',
    'created_at': '2026-10-17T00:0$i:00Z',
    'text': '原文${'甲' * 13000}',
  },
);
Map<String, dynamic> result() => {
  'timeline': [
    {
      'text': '提出项目计划。',
      'evidence_ids': ['e2'],
      'time_ref': 'e2',
    },
  ],
  'profile': {},
  'todos': [],
};
void main() {
  test(
    'saved-only scans all batches and never observes missing batches',
    () async {
      final stages = <String>[];
      final looked = <String>[];
      final writer = ProfileWriter(
        loadValidatedBatch: (messages) async {
          final id = messages.single['evidence_id'] as String;
          looked.add(id);
          if (id == 'e0') return <Map<String, dynamic>>[];
          if (id == 'e2') {
            return [
              {
                'text': '【事】提出项目计划',
                'refs': ['e2'],
              },
            ];
          }
          return null;
        },
        complete: (stage, instructions, input) async {
          stages.add(stage);
          expect(stage, isNot('observations'));
          expect((input['messages'] as List).single, records()[2]);
          expect(input['coverage']['eligible_records'], 3);
          expect(input['coverage']['validated_observation_records'], 2);
          expect(instructions, contains('部分资料'));
          return stage == 'review' ? {'review_notes': []} : result();
        },
      );
      final output = jsonDecode(
        await writer.generate(records(), savedObservationsOnly: true),
      );
      expect(looked, containsAll(['e0', 'e1', 'e2']));
      expect(stages, ['draft', 'review', 'edit']);
      expect(output.single['evidence_ids'], ['e2']);
      expect(writer.coverage['deferred_batches'], 1);
      expect(writer.coverage['unobserved_records'], 1);
      expect(writer.observedRecordCount, 0);
      expect(writer.reusedObservationRecordCount, 2);
      expect(writer.isPartial, true);
    },
  );
  test(
    'saved-only without valid checkpoint does not send any model request',
    () async {
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          fail('unexpected model request');
        },
      );
      await expectLater(
        writer.generate(records(), savedObservationsOnly: true),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'code',
            'profile_no_saved_observations',
          ),
        ),
      );
    },
  );
  test('partial evidence cannot publish current todo claims', () async {
    final stages = <String>[];
    final writer = ProfileWriter(
      loadValidatedBatch: (messages) async =>
          messages.single['evidence_id'] == 'e2'
          ? [
              {
                'text': '【事】提出项目计划',
                'refs': ['e2'],
              },
            ]
          : null,
      complete: (stage, _, input) async {
        stages.add(stage);
        if (stage == 'review') return {'review_notes': []};
        return {
          ...result(),
          'todos': [
            {
              'text': '当前应完成项目',
              'evidence_ids': ['e2'],
              'time_ref': 'e2',
            },
          ],
        };
      },
    );
    await expectLater(
      writer.generate(records(), savedObservationsOnly: true),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'code',
          'partial_profile_todo_unsupported',
        ),
      ),
    );
    expect(stages, ['draft', 'review', 'edit', 'repair', 'repair']);
  });
}
