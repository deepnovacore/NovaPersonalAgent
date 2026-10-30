import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';
import 'timeline_pipeline_test.dart' show fixture, normalComplete;

void main() {
  for (final priorId in ['timeline_existing', 'timeline_foreign']) {
    test(
      'delta identity accepts only current scope prior id: $priorId',
      () async {
        final data = fixture(1);
        final result =
            await TimelinePipeline(
              cacheScope: 'delta',
              authorize: () async {},
              complete: (stage, instructions, input) async {
                final context = input['context'] as Map;
                expect(context['prior_cards'], [
                  {
                    'id': 'timeline_existing',
                    'title': '原核验事项',
                    'why_now': '原有依据',
                    'anchor_date': '2026-10-19',
                  },
                ]);
                expect(context['new_input_ids'], ['e0']);
                final response = await normalComplete(
                  stage,
                  instructions,
                  input,
                );
                response['timeline'][0]['prior_id'] = priorId;
                return response;
              },
            ).generate(
              data.observations,
              data.records,
              historyComplete: true,
              now: DateTime(2026, 10, 30),
              newInputIds: ['e0'],
              priorCards: [
                {
                  'key': 'timeline_existing',
                  'policy_revision': 2,
                  'brief': {'title': '原核验事项', 'why_now': '原有依据'},
                  'time': {'anchor_date': '2026-10-19'},
                  'evidence_ids': ['e0'],
                },
              ],
            );
        final entry = (jsonDecode(result.entries) as List).single as Map;
        expect(
          entry['key'],
          priorId == 'timeline_existing'
              ? 'timeline_existing'
              : isNot('timeline_foreign'),
        );
        expect(entry.containsKey('prior_id'), false);
      },
    );
  }

  for (final mode in ['unique', 'ambiguous', 'prior_wins', 'different']) {
    test(
      'full rerun retains prior summaries and resolves identity: $mode',
      () async {
        final data = fixture(1);
        Map<String, dynamic> prior(String key, List<String> refs) => {
          'key': key,
          'policy_revision': 2,
          'brief': {'title': '旧标题', 'why_now': '有据旧状态'},
          'time': {'anchor_date': '2026-10-19'},
          'evidence_ids': refs,
        };
        final result =
            await TimelinePipeline(
              cacheScope: 'full-rerun',
              evidenceIdentities: {'e0': 'durable_original'},
              authorize: () async {},
              complete: (stage, instructions, input) async {
                final context = input['context'] as Map;
                expect(context['prior_cards'], isNotEmpty);
                expect(context.containsKey('new_input_ids'), false);
                expect(instructions, isNot(contains(timelineDeltaRules)));
                expect(instructions, contains('prior_id'));
                final response = await normalComplete(
                  stage,
                  instructions,
                  input,
                );
                response['timeline'][0]['brief']['title'] = '同一事项新标题';
                if (mode == 'prior_wins') {
                  response['timeline'][0]['prior_id'] = 'timeline_other';
                }
                return response;
              },
            ).generate(
              data.observations,
              data.records,
              historyComplete: true,
              now: DateTime(2026, 10, 30),
              priorCards: [
                {
                  ...prior('timeline_old', ['e0']),
                  'identity_evidence_ids': mode == 'different'
                      ? ['different_original']
                      : ['durable_original'],
                },
                if (mode == 'ambiguous') prior('timeline_duplicate', ['e0']),
                if (mode == 'prior_wins') prior('timeline_other', ['foreign']),
              ],
            );
        final key = (jsonDecode(result.entries) as List).single['key'];
        if (mode == 'unique') {
          expect(key, 'timeline_old');
        } else if (mode == 'prior_wins') {
          expect(key, 'timeline_other');
        } else {
          expect(key, isNot('timeline_old'));
          expect(key, isNot('timeline_duplicate'));
        }
      },
    );
  }

  for (final explicit in [true, false]) {
    test(
      'whole output identity fallback is one-to-one: explicit=$explicit',
      () async {
        final data = fixture(1);
        final result =
            await TimelinePipeline(
              cacheScope: 'fallback-collision',
              authorize: () async {},
              complete: (stage, instructions, input) async {
                final response = await normalComplete(
                  stage,
                  instructions,
                  input,
                );
                final first = response['timeline'][0];
                first['brief']['title'] = '甲事项';
                final second = jsonDecode(jsonEncode(first));
                second['brief']['title'] = '乙事项';
                if (explicit) first['prior_id'] = 'timeline_old';
                response['timeline'] = explicit
                    ? [second, first]
                    : [first, second];
                return response;
              },
            ).generate(
              data.observations,
              data.records,
              now: DateTime(2026, 10, 30),
              priorCards: [
                {
                  'key': 'timeline_old',
                  'policy_revision': 2,
                  'brief': {'title': '旧事项', 'why_now': '原有依据'},
                  'evidence_ids': ['e0'],
                },
              ],
            );
        final entries = jsonDecode(result.entries) as List;
        expect(entries, hasLength(2));
        final keys = entries.map((e) => e['key']).toSet();
        expect(keys, hasLength(2));
        expect(keys.contains('timeline_old'), explicit);
        expect(result.partial, false);
      },
    );
  }

  test(
    'generated key reserved by an explicit prior id keeps both cards',
    () async {
      final data = fixture(1);
      const title = '同名事项';
      final result =
          await TimelinePipeline(
            cacheScope: 'generated-key-collision',
            authorize: () async {},
            complete: (stage, instructions, input) async {
              final response = await normalComplete(stage, instructions, input);
              final first = response['timeline'][0];
              first['brief']['title'] = title;
              final implicit = jsonDecode(jsonEncode(first));
              final explicit = jsonDecode(jsonEncode(first));
              explicit['prior_id'] = _generatedKey(title, ['e0']);
              response['timeline'] = [explicit, implicit];
              return response;
            },
          ).generate(
            data.observations,
            data.records,
            now: DateTime(2026, 10, 30),
            priorCards: [
              {
                // The real hash of title and durable refs, not an arbitrary label.
                'key': _generatedKey(title, ['e0']),
                'policy_revision': 2,
                'brief': {'title': '旧事项', 'why_now': '原有依据'},
                'evidence_ids': ['e0'],
              },
            ],
          );
      expect(result.partial, false);
      final keys = (jsonDecode(result.entries) as List).map((e) => e['key']);
      expect(keys, hasLength(2));
      expect(keys.toSet(), hasLength(2));
    },
  );

  test(
    'edited retained history-only original is reviewed and advances only on success',
    () async {
      final data = fixture(1);
      data.records.single['local_date'] = '2026-09-01';
      data.records.single['created_at'] = '2026-09-01T00:00:00Z';
      var calls = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'history-edit',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          calls++;
          expect(input['context']['new_input_ids'], ['e0']);
          expect((input['messages'] as List).single['history_only'], true);
          return normalComplete(stage, instructions, input);
        },
      );
      final result = await pipeline.generate(
        data.observations,
        data.records,
        now: DateTime(2026, 10, 30),
        newInputIds: ['e0'],
        priorCards: [
          {
            'key': 'timeline_old',
            'policy_revision': 2,
            'brief': {'title': '旧事项', 'why_now': '原有依据'},
            'evidence_ids': ['e0'],
          },
        ],
      );
      expect(calls, 2);
      expect(
        (jsonDecode(result.entries) as List).single['key'],
        'timeline_old',
      );
      expect(pipeline.completedEvidenceIds, {'e0'});
      expect(pipeline.inputEvidenceIds, {'e0'});
    },
  );

  for (final failReview in [false, true]) {
    test(
      'history-only does not create unrelated cards or acknowledge failures: $failReview',
      () async {
        final data = fixture(2);
        for (final record in data.records) {
          record['local_date'] = '2026-09-01';
          record['created_at'] = '2026-09-01T00:00:00Z';
        }
        final pipeline = TimelinePipeline(
          cacheScope: 'history-boundary',
          authorize: () async {},
          complete: (stage, instructions, input) async {
            if (failReview && stage == 'timeline_review') {
              throw StateError('model_timeout');
            }
            return normalComplete(stage, instructions, input);
          },
        );
        final run = pipeline.generate(
          data.observations,
          data.records,
          now: DateTime(2026, 10, 30),
          newInputIds: ['e0'],
          priorCards: [
            {
              'key': 'timeline_old',
              'policy_revision': 2,
              'brief': {'title': '旧合并事项', 'why_now': '原有依据'},
              'evidence_ids': ['e0', 'e1'],
            },
          ],
        );
        if (failReview) {
          await expectLater(run, throwsStateError);
          expect(pipeline.completedEvidenceIds, isEmpty);
        } else {
          final result = await run;
          expect(jsonDecode(result.entries), isEmpty);
          expect(result.coverage['timeline_dropped_history_only_cards'], 2);
        }
      },
    );
  }

  test(
    'prior summaries are bounded and cannot supply factual quotes',
    () async {
      final data = fixture(1);
      final prior = List.generate(
        40,
        (i) => <String, dynamic>{
          'key': 'timeline_old_$i',
          'policy_revision': 2,
          'brief': {'title': '旧事项$i', 'why_now': '旧' * 150},
          'time': {'anchor_date': '2026-10-19'},
          'evidence_ids': ['e0'],
        },
      );
      final pipeline = TimelinePipeline(
        cacheScope: 'summary-not-evidence',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          final cards = input['context']['prior_cards'] as List;
          expect(cards, hasLength(32));
          expect(cards.first.keys.toSet(), {
            'id',
            'title',
            'why_now',
            'anchor_date',
          });
          expect((cards.first['why_now'] as String).length, 120);
          final response = await normalComplete(stage, instructions, input);
          response['timeline'][0]['brief']['facts'][0]['quote'] = '旧事项0';
          return response;
        },
      );
      await expectLater(
        pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
          now: DateTime(2026, 10, 30),
          priorCards: prior,
          newInputIds: ['e0'],
        ),
        throwsA(isA<TimelinePipelineValidationFailure>()),
      );
    },
  );

  test('unchanged Timeline inputs do not call the model', () async {
    final data = fixture(1);
    final result =
        await TimelinePipeline(
          cacheScope: 'unchanged',
          authorize: () async {},
          complete: (_, _, _) async =>
              throw StateError('unexpected model call'),
        ).generate(
          data.observations,
          data.records,
          historyComplete: true,
          now: DateTime(2026, 10, 30),
          newInputIds: [],
        );
    expect(jsonDecode(result.entries), isEmpty);
    expect(result.partial, false);
  });

  test('salvaged incomplete batches do not advance the input basis', () async {
    final data = fixture(2);
    final pipeline = TimelinePipeline(
      cacheScope: 'salvaged-basis',
      authorize: () async {},
      complete: (stage, instructions, input) async {
        final response = await normalComplete(stage, instructions, input);
        response['timeline'][1]['brief']['facts'][0]['quote'] = '没有此原文';
        return response;
      },
    );
    final result = await pipeline.generate(
      data.observations,
      data.records,
      historyComplete: true,
      now: DateTime(2026, 10, 30),
    );
    expect(result.partial, true);
    expect(jsonDecode(result.entries), hasLength(1));
    expect(pipeline.completedEvidenceIds, isEmpty);
  });

  test(
    'shared evidence stays pending until every dependent batch succeeds',
    () async {
      final data = fixture(3);
      final snapshots = <Set<String>>[];
      late TimelinePipeline pipeline;
      pipeline = TimelinePipeline(
        maxWritingRecords: 2,
        cacheScope: 'shared-pending',
        authorize: () async {},
        onPublish: (_) async => snapshots.add(pipeline.completedEvidenceIds),
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_select') {
            return {
              'topics': [
                {
                  'title': '甲事项',
                  'observation_indices': [0, 1],
                },
                {
                  'title': '乙事项',
                  'observation_indices': [0, 2],
                },
              ],
            };
          }
          if (stage == 'timeline_reconcile') return {'groups': []};
          final response = await normalComplete(stage, instructions, input);
          if ((input['messages'] as List).any(
            (r) => r['evidence_id'] == 'e2',
          )) {
            response['timeline'][0]['brief']['facts'][0]['quote'] = '缺少原文';
          }
          return response;
        },
      );
      final result = await pipeline.generate(
        data.observations,
        data.records,
        historyComplete: true,
        now: DateTime(2026, 10, 30),
      );
      expect(result.partial, true);
      expect(pipeline.completedEvidenceIds, {'e1'});
      expect(snapshots.every((ids) => !ids.contains('e0')), true);
    },
  );

  test('fallback identity survives run-local evidence renumbering', () async {
    Future<String> run(String ref) async {
      final data = fixture(1);
      data.records.single['evidence_id'] = ref;
      final result =
          await TimelinePipeline(
            cacheScope: 'renumbered',
            evidenceIdentities: {ref: 'durable_message'},
            authorize: () async {},
            complete: normalComplete,
          ).generate(
            data.observations,
            data.records,
            historyComplete: true,
            now: DateTime(2026, 10, 30),
          );
      return (jsonDecode(result.entries) as List).single['key'] as String;
    }

    expect(await run('e0'), await run('e9'));
  });

  test('fallback identity ignores prose revisions', () async {
    final data = fixture(1);
    Future<String> run(String why) async {
      final result =
          await TimelinePipeline(
            cacheScope: 'identity',
            authorize: () async {},
            complete: (stage, instructions, input) async {
              final response = await normalComplete(stage, instructions, input);
              response['timeline'][0]['brief']['why_now'] = why;
              return response;
            },
          ).generate(
            data.observations,
            data.records,
            historyComplete: true,
            now: DateTime(2026, 10, 30),
          );
      return (jsonDecode(result.entries) as List).single['key'] as String;
    }

    expect(await run('结果已有明确依据。'), await run('核验结果已经明确。'));
  });

  test('compose skips remain counted when review omits those cards', () async {
    final data = fixture(1);
    final result =
        await TimelinePipeline(
          cacheScope: 'compose-drop',
          authorize: () async {},
          complete: (stage, instructions, input) async {
            if (stage == 'timeline_review') return {'timeline': []};
            final response = await normalComplete(stage, instructions, input);
            response['timeline'][0]['brief']['temporal'] = {
              'kind': 'background',
              'dates': [],
            };
            return response;
          },
        ).generate(
          data.observations,
          data.records,
          historyComplete: true,
          now: DateTime(2026, 10, 30),
        );
    expect(jsonDecode(result.entries), isEmpty);
    expect(result.coverage['timeline_dropped_cards'], 1);
    expect(result.coverage['timeline_dropped_background_cards'], 1);
  });

  for (final kind in ['background', 'outside_window']) {
    test('counts reviewed $kind cards once', () async {
      final data = fixture(1);
      if (kind == 'outside_window') {
        data.records.single['text'] = '2026-09-01 完成核验';
      }
      final result =
          await TimelinePipeline(
            cacheScope: 'dropped',
            authorize: () async {},
            complete: (stage, instructions, input) async {
              final response = await normalComplete(stage, instructions, input);
              response['timeline'][0]['brief']['temporal'] =
                  kind == 'background'
                  ? {'kind': 'background', 'dates': []}
                  : {
                      'kind': 'event',
                      'dates': [
                        {
                          'role': 'occurred',
                          'date': '2026-09-01',
                          'ref': 'e0',
                          'quote': '2026-09-01 完成核验',
                        },
                      ],
                    };
              return response;
            },
          ).generate(
            data.observations,
            data.records,
            historyComplete: true,
            now: DateTime(2026, 10, 30),
          );
      expect(jsonDecode(result.entries), isEmpty);
      expect(result.coverage['timeline_dropped_cards'], 1);
      expect(result.coverage['timeline_dropped_${kind}_cards'], 1);
      expect(result.partial, false);
    });
  }
}

String _generatedKey(String title, List<String> refs) =>
    'timeline_${ProfileObservationCheckpoint.digest([title, refs]).substring(0, 24)}';
