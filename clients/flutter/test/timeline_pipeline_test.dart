import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';

void main() {
  pipelineIntegrationTests();
  pipelineScopeTests();
  pipelineTitleRepairTests();
  test(
    'all 624 complete observations retain their global indices across batches',
    () {
      final index = List.generate(
        624,
        (i) => <String, dynamic>{
          'index': i,
          'text': '完整中文观察$i${'甲' * 100}',
          'from': '2026-01-01',
          'to': '2026-10-19',
          'relations': ['self'],
          'groups': ['c1'],
        },
      );
      final batches = timelineSelectionBatches(index);
      expect(batches.expand((b) => b).toList(), index);
      expect(batches.length, greaterThan(1));
      for (final batch in batches) {
        expect(batch.length, lessThanOrEqualTo(80));
        expect(jsonEncode(batch).length, lessThanOrEqualTo(16000));
        expect(utf8.encode(jsonEncode(batch)).length, lessThanOrEqualTo(48000));
      }
    },
  );
  test(
    'writing capacity applies per batch with full refs and deferred giant topics',
    () {
      final records = List.generate(
        260,
        (i) => <String, dynamic>{'evidence_id': 'e$i', 'text': '完整原文$i'},
      );
      final topics = [
        TimelinePipelineTopic('甲', [0], [for (var i = 0; i < 100; i++) 'e$i']),
        TimelinePipelineTopic(
          '乙',
          [1],
          [for (var i = 100; i < 200; i++) 'e$i'],
        ),
        TimelinePipelineTopic(
          '过大事项',
          [2],
          [for (var i = 0; i < 260; i++) 'e$i'],
        ),
      ];
      final plan = timelineWritingPlan(topics, records);
      expect(plan.batches.length, 2);
      expect(plan.batches.expand((b) => b).toList(), topics.take(2).toList());
      expect(plan.deferred.single, topics.last);
      expect(plan.batches.first.single.refs.length, 100);
      expect(plan.batches.last.single.refs.length, 100);
    },
  );
  test('shared background never unions independent writing topics', () {
    final records = [
      for (final id in ['shared', 'a', 'b'])
        <String, dynamic>{'evidence_id': id, 'text': id},
    ];
    final a = TimelinePipelineTopic('甲交付', [0], ['shared', 'a']);
    final b = TimelinePipelineTopic('乙交付', [1], ['shared', 'b']);
    expect(timelineWritingPlan([a, b], records).batches.single, [a, b]);
  });
}

({List<Map<String, dynamic>> records, List<Map<String, dynamic>> observations})
fixture(int count) => (
  records: List.generate(
    count,
    (i) => <String, dynamic>{
      'evidence_id': 'e$i',
      'chat': 'c1',
      'speaker': 'p1',
      'relation': 'self',
      'created_at': '2026-10-19T00:00:00Z',
      'text': '本人完成核验$i',
    },
  ),
  observations: List.generate(
    count,
    (i) => <String, dynamic>{
      'text': '【事】本人完成核验$i',
      'refs': ['e$i'],
    },
  ),
);
Map<String, dynamic> written(Map<String, dynamic> input) {
  final originals = {
    for (final r in input['messages'] as List) r['evidence_id']: r,
  };
  return {
    'timeline': [
      for (final topic in input['timeline_topics'] as List)
        (() {
          final ref = (topic['evidence_ids'] as List).last;
          return {
            'evidence_ids': [ref],
            'time_ref': ref,
            'brief': {
              'title': topic['title'],
              'status_label': '已核验',
              'facts': [
                {
                  'text': originals[ref]['text'],
                  'ref': ref,
                  'quote': originals[ref]['text'],
                },
              ],
              'why_now': '本人关注的核验结果已经明确。',
              'next_steps': [],
              'uncertainty': '',
            },
          };
        })(),
    ],
  };
}

Future<Map<String, dynamic>> normalComplete(
  String stage,
  String _,
  Map<String, dynamic> input,
) async {
  if (stage == 'timeline_select') {
    final rows = input['observations'] as List;
    final middle = (rows.length / 2).ceil();
    return {
      'topics': [
        {
          'title': '甲交付核验',
          'observation_indices': rows
              .take(middle)
              .map((r) => r['index'])
              .toList(),
        },
        if (rows.length > middle)
          {
            'title': '乙交付核验',
            'observation_indices': rows
                .skip(middle)
                .map((r) => r['index'])
                .toList(),
          },
      ],
    };
  }
  if (stage == 'timeline_reconcile') {
    final topics = input['topics'] as List;
    return {
      'groups': [
        if (topics.length == 4) ...[
          {
            'members': ['t0', 't2'],
          },
          {
            'members': ['t1'],
          },
          {
            'members': ['t3'],
          },
        ] else
          for (final topic in topics)
            {
              'members': [topic['id']],
            },
      ],
    };
  }
  return written(input);
}

void pipelineIntegrationTests() {
  test(
    '160 originals span writing batches, publish only reviewed cards and resume without paid replay',
    () async {
      final data = fixture(160), cache = <String, Map<String, dynamic>>{};
      final requests = <String>[];
      final publications = <TimelinePipelineResult>[];
      var pause = true;
      TimelinePipeline create() => TimelinePipeline(
        cacheScope: 'account-source-model-recipe',
        authorize: () async {},
        loadCheckpoint: (key) async => cache[key],
        saveCheckpoint: (key, value) async {
          cache[key] = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
        },
        onPublish: (result) async {
          publications.add(result);
          if (pause) throw StateError('cancelled');
        },
        complete: (stage, instructions, input) async {
          requests.add(stage);
          if (stage == 'timeline_compose') {
            final messages = input['messages'] as List;
            expect(messages.length, lessThanOrEqualTo(120));
            expect(
              messages.every(
                (r) =>
                    r['text'] ==
                    data.records[int.parse(
                      (r['evidence_id'] as String).substring(1),
                    )]['text'],
              ),
              true,
            );
            if (messages.any((r) => r['evidence_id'] == 'e0')) {
              expect(messages.any((r) => r['evidence_id'] == 'e119'), true);
            }
          }
          return normalComplete(stage, instructions, input);
        },
      );
      await expectLater(
        create().generate(
          data.observations,
          data.records,
          historyComplete: true,
        ),
        throwsStateError,
      );
      expect(requests, [
        'timeline_select',
        'timeline_select',
        'timeline_reconcile',
        'timeline_compose',
        'timeline_review',
      ]);
      expect(publications.single.completedBatches, 1);
      expect(publications.single.pendingBatches, 1);
      expect(publications.single.partial, true);
      expect(publications.single.coverage['final_original_records'], 120);
      pause = false;
      final result = await create().generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      expect(requests.length, 7);
      expect(result.coverage['final_original_records'], 160);
      expect(result.coverage['timeline_cached_stages'], 5);
      expect(result.completedBatches, 2);
      expect(result.pendingBatches, 0);
      expect(result.partial, false);
      expect((jsonDecode(result.entries) as List).length, 3);
      expect(
        (jsonDecode(result.entries) as List)
            .map((e) => e['key'])
            .toSet()
            .length,
        3,
      );
    },
  );
  test(
    'cached output is reauthorized and corrupted quotes cannot reach publication',
    () async {
      final data = fixture(2), cache = <String, Map<String, dynamic>>{};
      var denied = false, calls = 0, published = 0;
      TimelinePipeline create() => TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {
          if (denied) throw StateError('authorization_changed');
        },
        loadCheckpoint: (key) async => cache[key],
        saveCheckpoint: (key, value) async {
          cache[key] = value;
        },
        onPublish: (_) async {
          published++;
        },
        complete: (stage, instructions, input) async {
          calls++;
          return normalComplete(stage, instructions, input);
        },
      );
      await create().generate(
        data.observations,
        data.records,
        historyComplete: false,
      );
      final previousCalls = calls, previousPublications = published;
      denied = true;
      await expectLater(
        create().generate(
          data.observations,
          data.records,
          historyComplete: false,
        ),
        throwsStateError,
      );
      expect(calls, previousCalls);
      expect(published, previousPublications);
      denied = false;
      final cached = cache.values.firstWhere(
        (v) => (v['response'] as Map).containsKey('timeline'),
      );
      cached['response']['timeline'][0]['brief']['facts'][0]['quote'] =
          'invented';
      await expectLater(
        create().generate(
          data.observations,
          data.records,
          historyComplete: false,
        ),
        throwsStateError,
      );
      expect(calls, previousCalls);
      expect(published, previousPublications);
    },
  );
  test(
    'global index belonging to another screening batch is rejected twice before writing',
    () async {
      final data = fixture(81);
      var calls = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          calls++;
          expect(stage, 'timeline_select');
          if ((input['allowed_indices'] as List).first != 0) {
            return {
              'topics': [
                {
                  'title': '错误索引',
                  'observation_indices': [0],
                },
              ],
            };
          }
          return normalComplete(stage, instructions, input);
        },
      );
      await expectLater(
        pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        ),
        throwsA(
          isA<TimelinePipelineValidationFailure>().having(
            (e) => e.detail['reason'],
            'reason',
            'index_outside_batch',
          ),
        ),
      );
      expect(calls, 3);
      final diagnostic = pipeline.validationDiagnostics!;
      expect(diagnostic['first']['reason'], 'index_outside_batch');
      expect(diagnostic['last']['reason'], 'index_outside_batch');
      expect(diagnostic['last']['stage'], 'timeline_select');
      expect(diagnostic['last']['invalid_index'], 0);
      expect(diagnostic['last'].keys.toSet(), {
        'stage',
        'reason',
        'path',
        'invalid_index',
      });
      expect(jsonEncode(diagnostic), isNot(contains('错误索引')));
      await pipeline.generate([], [], historyComplete: true);
      expect(pipeline.validationDiagnostics, isNull);
    },
  );
  for (final members in <List<List<String>>>[
    [
      ['t0'],
    ],
    [
      ['t0'],
      ['t0'],
    ],
    [
      ['t0'],
      ['foreign'],
    ],
  ]) {
    test('reconciliation must include each candidate once: $members', () async {
      final data = fixture(2);
      var calls = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          calls++;
          if (stage == 'timeline_select') {
            return normalComplete(stage, instructions, input);
          }
          expect(stage, 'timeline_reconcile');
          return {
            'groups': [
              for (final ids in members) {'members': ids},
            ],
          };
        },
      );
      await expectLater(
        pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        ),
        throwsStateError,
      );
      expect(calls, 3);
    });
  }
  test(
    'genuinely oversized complete topic is deferred after one refinement and never paid-written',
    () async {
      final data = fixture(121);
      var calls = 0;
      final observations = [
        <String, dynamic>{
          'text': '【事】一个不可分割事项',
          'refs': data.records.map((r) => r['evidence_id']).toList(),
        },
      ];
      final pipeline = TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          calls++;
          expect(stage, 'timeline_select');
          return {
            'topics': [
              {
                'title': '完整不可分割事项',
                'observation_indices': [0],
              },
            ],
          };
        },
      );
      await expectLater(
        pipeline.generate(observations, data.records, historyComplete: true),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'code',
            'profile_timeline_deferred',
          ),
        ),
      );
      expect(calls, 2);
      expect(pipeline.coverage['timeline_pending_batches'], 1);
      expect(pipeline.coverage['timeline_completed_batches'], 0);
    },
  );
  test('empty reviewed timeline never invokes publication', () async {
    final data = fixture(1);
    var published = 0;
    final pipeline = TimelinePipeline(
      cacheScope: 'scope',
      authorize: () async {},
      onPublish: (_) async {
        published++;
      },
      complete: (stage, instructions, input) async {
        if (stage == 'timeline_select') {
          return normalComplete(stage, instructions, input);
        }
        return {'timeline': []};
      },
    );
    final result = await pipeline.generate(
      data.observations,
      data.records,
      historyComplete: true,
    );
    expect(result.entries, '[]');
    expect(published, 0);
    expect(result.partial, false);
  });
  test('timeout and budget failure never trigger contract repair', () async {
    for (final code in [
      'model_timeout',
      'profile_budget_exhausted',
      'authorization_changed',
    ]) {
      final data = fixture(1);
      var calls = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          calls++;
          throw StateError(code);
        },
      );
      await expectLater(
        pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        ),
        throwsA(isA<StateError>().having((e) => e.message, 'code', code)),
      );
      expect(calls, 1);
    }
  });
}

void pipelineScopeTests() {
  test(
    'smaller configured writing batches retain every complete theme',
    () async {
      final data = fixture(2);
      var compositionCalls = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {},
        maxWritingRecords: 1,
        maxWritingCharacters: 1000,
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_compose') {
            compositionCalls++;
            expect((input['messages'] as List).length, 1);
          }
          return normalComplete(stage, instructions, input);
        },
      );
      final result = await pipeline.generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      expect(result.completedBatches, 2);
      expect(compositionCalls, 2);
      expect(result.coverage['final_original_records'], 2);
      expect(result.partial, false);
    },
  );

  test(
    'changed cache scope never reuses an authorized old-account stage',
    () async {
      final data = fixture(1), cache = <String, Map<String, dynamic>>{};
      var calls = 0;
      TimelinePipeline create(String scope) => TimelinePipeline(
        cacheScope: scope,
        authorize: () async {},
        loadCheckpoint: (key) async => cache[key],
        saveCheckpoint: (key, value) async {
          cache[key] = value;
        },
        complete: (stage, instructions, input) async {
          calls++;
          return normalComplete(stage, instructions, input);
        },
      );
      await create(
        'account-a-source-model',
      ).generate(data.observations, data.records, historyComplete: true);
      expect(calls, 3);
      await create(
        'account-b-source-model',
      ).generate(data.observations, data.records, historyComplete: true);
      expect(calls, 6);
    },
  );
  test(
    'authorization revoked by cache read blocks validation and publication',
    () async {
      final data = fixture(1);
      var denied = false, calls = 0, published = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {
          if (denied) throw StateError('authorization_changed');
        },
        loadCheckpoint: (key) async {
          denied = true;
          return null;
        },
        onPublish: (_) async {
          published++;
        },
        complete: (stage, instructions, input) async {
          calls++;
          return normalComplete(stage, instructions, input);
        },
      );
      await expectLater(
        pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        ),
        throwsStateError,
      );
      expect(calls, 0);
      expect(published, 0);
    },
  );
  test(
    'oversized-topic refinement cannot silently drop selected observations',
    () async {
      final data = fixture(121);
      var calls = 0;
      final observations = [
        <String, dynamic>{
          'text': '【事】完整事项',
          'refs': data.records.map((r) => r['evidence_id']).toList(),
        },
      ];
      final pipeline = TimelinePipeline(
        cacheScope: 'scope',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          calls++;
          return calls == 1
              ? {
                  'topics': [
                    {
                      'title': '完整事项',
                      'observation_indices': [0],
                    },
                  ],
                }
              : {'topics': []};
        },
      );
      await expectLater(
        pipeline.generate(observations, data.records, historyComplete: true),
        throwsA(
          isA<TimelinePipelineValidationFailure>().having(
            (e) => e.detail['reason'],
            'reason',
            'refinement_changed_selected_observations',
          ),
        ),
      );
      expect(calls, 2);
      expect(
        pipeline.validationDiagnostics!['first']['reason'],
        'topic_exceeds_writing_capacity',
      );
      expect(
        pipeline.validationDiagnostics!['last']['reason'],
        'refinement_changed_selected_observations',
      );
      expect(
        jsonEncode(pipeline.validationDiagnostics),
        isNot(contains('完整事项')),
      );
    },
  );
}

void pipelineTitleRepairTests() {
  final invalidTitles = <String, Object>{
    'topic_title_type': 42,
    'topic_title_empty': '  \t ',
    'topic_title_too_long': '甲' * 161,
    'topic_title_sensitive': 'api_key=synthetic-private-value',
  };
  for (final invalid in invalidTitles.entries) {
    test(
      '${invalid.key} is content-free and repairs the same theme members once',
      () async {
        final data = fixture(2);
        var selectionCalls = 0;
        final pipeline = TimelinePipeline(
          cacheScope: 'title-scope',
          authorize: () async {},
          complete: (stage, instructions, input) async {
            if (stage == 'timeline_select') {
              selectionCalls++;
              if (selectionCalls == 1) {
                expect(input.containsKey('previous_response'), false);
                return {
                  'topics': [
                    {
                      'title': invalid.value,
                      'observation_indices': [0],
                    },
                    {
                      'title': '乙事项已核验',
                      'observation_indices': [1],
                    },
                  ],
                };
              }
              expect(input['validation_detail'], {
                'stage': 'timeline_select',
                'reason': invalid.key,
                'path': 'topics[0].title',
              });
              expect(instructions, contains('≤160'));
              expect(instructions, contains('非空自然中文'));
              expect(instructions, contains('凭据'));
              return {
                'topics': [
                  {
                    'title': '乙事项已核验',
                    'observation_indices': [1],
                  },
                  {
                    'title': '甲事项已核验',
                    'observation_indices': [0, 0],
                  },
                ],
              };
            }
            return normalComplete(stage, instructions, input);
          },
        );
        final result = await pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        );
        expect(selectionCalls, 2);
        expect(result.partial, false);
        expect((jsonDecode(result.entries) as List).length, 2);
        expect(pipeline.validationDiagnostics!['first'], {
          'stage': 'timeline_select',
          'reason': invalid.key,
          'path': 'topics[0].title',
        });
      },
    );
    test(
      '${invalid.key} repair cannot delete a theme while preserving the index union',
      () async {
        final data = fixture(2);
        var calls = 0;
        final pipeline = TimelinePipeline(
          cacheScope: 'title-scope',
          authorize: () async {},
          complete: (stage, instructions, input) async {
            calls++;
            expect(stage, 'timeline_select');
            return calls == 1
                ? {
                    'topics': [
                      {
                        'title': invalid.value,
                        'observation_indices': [0],
                      },
                      {
                        'title': '乙事项',
                        'observation_indices': [1],
                      },
                    ],
                  }
                : {
                    'topics': [
                      {
                        'title': '合并全部事项',
                        'observation_indices': [0, 1],
                      },
                    ],
                  };
          },
        );
        await expectLater(
          pipeline.generate(
            data.observations,
            data.records,
            historyComplete: true,
          ),
          throwsA(
            isA<TimelinePipelineValidationFailure>().having(
              (e) => e.detail['reason'],
              'reason',
              'title_repair_changed_topic_members',
            ),
          ),
        );
        expect(calls, 2);
      },
    );
  }
  test('title repair never coerces an unvalidated observation index', () async {
    final data = fixture(1);
    var calls = 0;
    final pipeline = TimelinePipeline(
      cacheScope: 'title-scope',
      authorize: () async {},
      complete: (stage, instructions, input) async {
        calls++;
        if (calls == 2) {
          expect(input['validation_detail']['reason'], 'index_not_integer');
        }
        return {
          'topics': [
            {
              'title': 42,
              'observation_indices': ['0'],
            },
          ],
        };
      },
    );
    await expectLater(
      pipeline.generate(data.observations, data.records, historyComplete: true),
      throwsA(
        isA<TimelinePipelineValidationFailure>().having(
          (e) => e.detail['reason'],
          'reason',
          'index_not_integer',
        ),
      ),
    );
    expect(calls, 2);
  });
}
