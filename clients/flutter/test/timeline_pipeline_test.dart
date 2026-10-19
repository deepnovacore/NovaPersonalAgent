import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';

void main() {
  pipelineIntegrationTests();
  pipelineScopeTests();
  pipelineTitleRepairTests();
  hostFallbackTests();
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
  test(
    'reconciliation lists only confident merges and preserves unlisted themes with shared refs',
    () async {
      final data = fixture(3), cache = <String, Map<String, dynamic>>{};
      data.observations[2]['refs'] = ['e1', 'e2'];
      final requests = <String>[];
      TimelinePipeline create() => TimelinePipeline(
        cacheScope: 'sparse-reconcile',
        authorize: () async {},
        loadCheckpoint: (key) async => cache[key] == null
            ? null
            : jsonDecode(jsonEncode(cache[key])) as Map<String, dynamic>,
        saveCheckpoint: (key, value) async {
          cache[key] = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
        },
        complete: (stage, instructions, input) async {
          requests.add(stage);
          if (stage == 'timeline_select') {
            return {
              'topics': [
                for (var i = 0; i < 3; i++)
                  {
                    'title': '独立事项$i',
                    'observation_indices': [i],
                  },
              ],
            };
          }
          if (stage == 'timeline_reconcile') {
            return {
              'groups': [
                {
                  'members': ['t0', 't1'],
                },
              ],
            };
          }
          expect(input['history_complete'], false);
          expect(instructions, contains('不得推断当前仍未完成'));
          expect(
            (input['timeline_topics'] as List)
                .map((t) => t['evidence_ids'])
                .toList(),
            [
              ['e0', 'e1'],
              ['e1', 'e2'],
            ],
          );
          expect(input['timeline_topics'][1]['title'], '独立事项2');
          return normalComplete(stage, instructions, input);
        },
      );
      final first = await create().generate(
        data.observations,
        data.records,
        historyComplete: false,
      );
      expect(first.coverage['timeline_reconcile_unlisted_topics'], 1);
      expect(first.coverage['timeline_selected_topics'], 2);
      expect(first.coverage['timeline_repair_requests'], 0);
      expect(requests.where((s) => s == 'timeline_reconcile').length, 1);
      final prior = requests.length;
      final replay = await create().generate(
        data.observations,
        data.records,
        historyComplete: false,
      );
      expect(requests.length, prior);
      expect(replay.coverage['timeline_reconcile_unlisted_topics'], 1);
      expect(replay.entries, first.entries);
    },
  );
  test(
    'empty reconciliation preserves all 239 candidates in deterministic writing order',
    () async {
      final data = fixture(239);
      final written = <String>[];
      var reconciliations = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'all-singletons',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_select') {
            return {
              'topics': [
                for (final row in input['observations'] as List)
                  {
                    'title': '独立事项${row['index']}',
                    'observation_indices': [row['index']],
                  },
              ],
            };
          }
          if (stage == 'timeline_reconcile') {
            reconciliations++;
            return {'groups': []};
          }
          if (stage == 'timeline_compose') {
            written.addAll(
              (input['timeline_topics'] as List)
                  .expand((t) => t['evidence_ids'] as List)
                  .cast<String>(),
            );
          }
          return normalComplete(stage, instructions, input);
        },
      );
      final result = await pipeline.generate(
        data.observations,
        data.records,
        historyComplete: false,
      );
      expect(reconciliations, 1);
      expect(written, List.generate(239, (i) => 'e$i'));
      expect(result.coverage['timeline_reconcile_unlisted_topics'], 239);
      expect(result.coverage['timeline_selected_topics'], 239);
      expect(result.completedBatches, 60);
      expect(result.coverage['timeline_repair_requests'], 0);
    },
  );
  test(
    'reconciliation repair resets unlisted count and retains writing capacity gates',
    () async {
      final data = fixture(2);
      var reconciliations = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'sparse-capacity',
        authorize: () async {},
        maxWritingRecords: 1,
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_select') {
            return normalComplete(stage, instructions, input);
          }
          if (stage == 'timeline_reconcile') {
            reconciliations++;
            if (reconciliations == 1) {
              return {
                'groups': [
                  {
                    'members': ['t0', 't1'],
                  },
                ],
              };
            }
            expect(
              input['validation_detail']['reason'],
              'group_exceeds_writing_capacity',
            );
            return {'groups': []};
          }
          expect((input['messages'] as List).length, 1);
          return normalComplete(stage, instructions, input);
        },
      );
      final result = await pipeline.generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      expect(reconciliations, 2);
      expect(result.coverage['timeline_reconcile_unlisted_topics'], 2);
      expect(result.completedBatches, 2);
      expect(result.coverage['timeline_repair_requests'], 1);
      expect(result.coverage['timeline_reconcile_host_fallback'], 0);
    },
  );
  for (final members in <List<List<Object?>>>[
    [[]],
    [
      [42],
    ],
    [
      [null],
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
    test(
      'host fallback discards malformed or repeated reconciliation: $members',
      () async {
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
            if (stage == 'timeline_reconcile') {
              return {
                'groups': [
                  for (final ids in members) {'members': ids},
                ],
              };
            }
            expect((input['timeline_topics'] as List).length, 2);
            return normalComplete(stage, instructions, input);
          },
        );
        final result = await pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        );
        expect(calls, 4);
        expect(result.coverage['timeline_reconcile_host_fallback'], 1);
        expect(result.coverage['timeline_repair_requests'], 0);
        expect(result.coverage['timeline_reconcile_unlisted_topics'], 2);
      },
    );
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
  test(
    'routing title redaction preserves themes and safe reusable checkpoints without repair',
    () async {
      final data = fixture(2), cache = <String, Map<String, dynamic>>{};
      final calls = <String>[];
      TimelinePipeline create() => TimelinePipeline(
        cacheScope: 'safe-routing',
        authorize: () async {},
        loadCheckpoint: (key) async => cache[key] == null
            ? null
            : jsonDecode(jsonEncode(cache[key])) as Map<String, dynamic>,
        saveCheckpoint: (key, value) async {
          cache[key] = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
        },
        complete: (stage, instructions, input) async {
          calls.add(stage);
          expect(jsonEncode(input), isNot(contains('synthetic-private-value')));
          if (stage == 'timeline_select') {
            expect(input.containsKey('previous_response'), false);
            return {
              'topics': [
                {
                  'title': '接口 api_key=synthetic-private-value 已核验',
                  'observation_indices': [0],
                },
                {
                  'title': '另一个独立事项',
                  'observation_indices': [1],
                },
              ],
            };
          }
          if (stage == 'timeline_reconcile') {
            expect(
              (input['topics'] as List)
                  .map((t) => t['observation_indices'])
                  .toList(),
              [
                [0],
                [1],
              ],
            );
            expect(input['topics'][0]['title'], '接口 [redacted] 已核验');
          }
          return normalComplete(stage, instructions, input);
        },
      );
      final first = await create().generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      expect(calls.where((stage) => stage == 'timeline_select').length, 1);
      expect(first.coverage['timeline_repair_requests'], 0);
      expect((jsonDecode(first.entries) as List).length, 2);
      expect(jsonEncode(cache), isNot(contains('synthetic-private-value')));
      final count = calls.length;
      final second = await create().generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      expect(calls.length, count);
      expect(second.coverage['timeline_cached_stages'], 4);
      // Even a legacy cache title must be made safe before routing it downstream.
      final selectionKey = cache.keys.firstWhere(
        (key) => cache[key]!['response']['topics'] is List,
      );
      cache[selectionKey]!['response']['topics'][0]['title'] =
          '接口 api_key=synthetic-private-value 已核验';
      cache.removeWhere((key, _) => key != selectionKey);
      await create().generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      expect(calls.where((stage) => stage == 'timeline_select').length, 1);
      expect(
        jsonEncode(
          cache.entries
              .where((entry) => entry.key != selectionKey)
              .map((entry) => entry.value)
              .toList(),
        ),
        isNot(contains('synthetic-private-value')),
      );
    },
  );
  for (final invalid in <String, Object>{
    'index_not_integer': '0',
    'topic_title_type': {'token': 'synthetic-private-value'},
    'topic_title_too_long': 'token=synthetic-private-value ${'甲' * 161}',
  }.entries) {
    test(
      'routing repair redacts titles without hiding ${invalid.key}',
      () async {
        final data = fixture(2);
        var selections = 0;
        final pipeline = TimelinePipeline(
          cacheScope: 'safe-repair',
          authorize: () async {},
          complete: (stage, instructions, input) async {
            if (stage != 'timeline_select') {
              return normalComplete(stage, instructions, input);
            }
            selections++;
            if (selections == 1) {
              return {
                'topics': [
                  {
                    'title': invalid.key == 'index_not_integer'
                        ? 'token=synthetic-private-value'
                        : invalid.value,
                    'observation_indices': [
                      invalid.key == 'index_not_integer' ? invalid.value : 0,
                    ],
                  },
                  {
                    'title': '接口 api_key=synthetic-private-value 已核验',
                    'observation_indices': [1],
                  },
                ],
              };
            }
            expect(input['validation_detail']['reason'], invalid.key);
            expect(
              jsonEncode(input['previous_response']),
              isNot(contains('synthetic-private-value')),
            );
            expect(
              input['previous_response']['topics'][1]['observation_indices'],
              [1],
            );
            return {
              'topics': [
                {
                  'title': '甲事项',
                  'observation_indices': [0],
                },
                {
                  'title': '乙事项',
                  'observation_indices': [1],
                },
              ],
            };
          },
        );
        final result = await pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        );
        expect(selections, 2);
        expect((jsonDecode(result.entries) as List).length, 2);
      },
    );
  }
  test(
    'routing title expansion trims checkpoint titles before cache replay',
    () async {
      final data = fixture(1), cache = <String, Map<String, dynamic>>{};
      var calls = 0;
      TimelinePipeline create() => TimelinePipeline(
        cacheScope: 'expanded-title',
        authorize: () async {},
        loadCheckpoint: (key) async => cache[key] == null
            ? null
            : jsonDecode(jsonEncode(cache[key])) as Map<String, dynamic>,
        saveCheckpoint: (key, value) async {
          cache[key] = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
        },
        complete: (stage, instructions, input) async {
          calls++;
          if (stage == 'timeline_select') {
            return {
              'topics': [
                {
                  'title': '${' ' * 155}PIN=1',
                  'observation_indices': [0],
                },
              ],
            };
          }
          return {'timeline': []};
        },
      );
      await create().generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      final before = calls;
      expect(
        cache.values.first['response']['topics'][0]['title'],
        '[redacted]',
      );
      await create().generate(
        data.observations,
        data.records,
        historyComplete: true,
      );
      expect(calls, before);
    },
  );
  test(
    'routing title redaction cannot store an expanded overlength title',
    () async {
      final data = fixture(1);
      var calls = 0, saves = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'expanded-overlength',
        authorize: () async {},
        saveCheckpoint: (_, _) async {
          saves++;
        },
        complete: (stage, instructions, input) async {
          calls++;
          if (calls == 2) {
            expect(
              input['validation_detail']['reason'],
              'topic_title_too_long',
            );
          }
          return {
            'topics': [
              {
                'title': '${'甲' * 154} PIN=1',
                'observation_indices': [0],
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
            'topic_title_too_long',
          ),
        ),
      );
      expect(calls, 2);
      expect(saves, 0);
    },
  );
  final invalidTitles = <String, Object>{
    'topic_title_type': 42,
    'topic_title_empty': '  \t ',
    'topic_title_too_long': '甲' * 161,
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

void hostFallbackTests() {
  test(
    'host fallback persists explicit provenance and replays without another model request',
    () async {
      final data = fixture(2), cache = <String, Map<String, dynamic>>{};
      final requests = <String>[];
      TimelinePipeline create() => TimelinePipeline(
        cacheScope: 'host-fallback',
        authorize: () async {},
        loadCheckpoint: (key) async => cache[key] == null
            ? null
            : jsonDecode(jsonEncode(cache[key])) as Map<String, dynamic>,
        saveCheckpoint: (key, value) async {
          cache[key] = jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
        },
        complete: (stage, instructions, input) async {
          requests.add(stage);
          if (stage == 'timeline_reconcile') {
            // Discard even the valid merge when any later member is invalid.
            return {
              'groups': [
                {
                  'members': ['t0', 't1'],
                },
                {
                  'members': ['synthetic-invalid-id'],
                },
              ],
            };
          }
          if (stage == 'timeline_compose' || stage == 'timeline_review') {
            expect(
              (input['timeline_topics'] as List)
                  .map((t) => t['evidence_ids'])
                  .toList(),
              [
                ['e0'],
                ['e1'],
              ],
            );
            expect(input['history_complete'], false);
          }
          return normalComplete(stage, instructions, input);
        },
      );
      final result = await create().generate(
        data.observations,
        data.records,
        historyComplete: false,
      );
      final fallbackKey = cache.keys.singleWhere(
        (key) => cache[key]!['outcome'] == 'host_fallback',
      );
      final saved =
          jsonDecode(jsonEncode(cache[fallbackKey])) as Map<String, dynamic>;
      expect(saved, {
        'recipe': TimelinePipeline.recipe,
        'outcome': 'host_fallback',
        'version': 1,
        'reason': 'member_unknown_or_repeated',
        'response': {'groups': []},
      });
      expect(jsonEncode(cache), isNot(contains('synthetic-invalid-id')));
      expect(result.coverage['timeline_reconcile_host_fallback'], 1);
      expect(result.coverage['timeline_repair_requests'], 0);
      expect(requests, [
        'timeline_select',
        'timeline_reconcile',
        'timeline_compose',
        'timeline_review',
      ]);
      final prior = requests.length;
      final replay = await create().generate(
        data.observations,
        data.records,
        historyComplete: false,
      );
      expect(requests.length, prior);
      expect(replay.entries, result.entries);
      expect(replay.coverage['timeline_reconcile_host_fallback'], 1);
      expect(replay.coverage['timeline_reconcile_unlisted_topics'], 2);
      expect(replay.coverage['timeline_cached_stages'], 4);
      for (final corrupt in <Map<String, dynamic>>[
        {...saved}..remove('outcome'),
        {...saved, 'outcome': 'model_success'},
        {...saved, 'version': 2},
        {...saved, 'version': 1.0},
        {...saved, 'reason': 'profile_budget_exhausted'},
        {...saved, 'unexpected': true},
        {
          ...saved,
          'response': {
            'groups': [
              {
                'members': ['t0', 't1'],
              },
            ],
          },
        },
        {
          ...saved,
          'response': {'groups': [], 'unexpected': true},
        },
      ]) {
        cache[fallbackKey] = corrupt;
        await expectLater(
          create().generate(
            data.observations,
            data.records,
            historyComplete: false,
          ),
          throwsA(
            isA<StateError>().having(
              (e) => e.message,
              'code',
              'profile_timeline_checkpoint_invalid',
            ),
          ),
        );
        expect(requests.length, prior);
      }
      cache[fallbackKey] = saved;
      final selectionKey = cache.keys.singleWhere(
        (key) => cache[key]!['response']['topics'] is List,
      );
      cache[selectionKey] = saved;
      await expectLater(
        create().generate(
          data.observations,
          data.records,
          historyComplete: false,
        ),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'code',
            'profile_timeline_checkpoint_invalid',
          ),
        ),
      );
      expect(requests.length, prior);
    },
  );
  for (final response in <Map<String, dynamic>>[
    {'groups': 'invalid'},
    {
      'groups': [
        {
          'members': ['t0'],
          'extra': true,
        },
      ],
    },
    {
      'outcome': 'host_fallback',
      'version': 1,
      'reason': 'made-up',
      'groups': [],
    },
  ]) {
    test(
      'host fallback is constructed by the host after invalid schema $response',
      () async {
        final data = fixture(2);
        var reconcileCalls = 0;
        Map<String, dynamic>? envelope;
        final pipeline = TimelinePipeline(
          cacheScope: 'host-schema',
          authorize: () async {},
          saveCheckpoint: (_, value) async {
            if (value['outcome'] == 'host_fallback') {
              envelope = value;
            }
          },
          complete: (stage, instructions, input) async {
            if (stage == 'timeline_reconcile') {
              reconcileCalls++;
              return response;
            }
            return normalComplete(stage, instructions, input);
          },
        );
        final result = await pipeline.generate(
          data.observations,
          data.records,
          historyComplete: true,
        );
        expect(reconcileCalls, 1);
        expect(result.coverage['timeline_repair_requests'], 0);
        expect(
          envelope!['reason'],
          response['groups'] is List && !response.containsKey('outcome')
              ? 'members_schema'
              : 'groups_schema',
        );
        expect(envelope!['response'], {'groups': []});
      },
    );
  }
  for (final code in [
    'model_timeout',
    'profile_budget_exhausted',
    'authorization_changed',
    'profile_context_too_large',
    'profile_timeline_checkpoint_invalid',
  ]) {
    test('host fallback does not swallow $code', () async {
      final data = fixture(2);
      var fallbacks = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'host-fail-closed',
        authorize: () async {},
        saveCheckpoint: (_, value) async {
          if (value['outcome'] == 'host_fallback') {
            fallbacks++;
          }
        },
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_reconcile') {
            throw StateError(code);
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
        throwsA(isA<StateError>().having((e) => e.message, 'code', code)),
      );
      expect(fallbacks, 0);
    });
  }
  test('host fallback reauthorizes after saving before any writing', () async {
    final data = fixture(2);
    var revoked = false, writes = 0;
    final pipeline = TimelinePipeline(
      cacheScope: 'host-revoked',
      authorize: () async {
        if (revoked) {
          throw StateError('authorization_changed');
        }
      },
      saveCheckpoint: (_, value) async {
        if (value['outcome'] == 'host_fallback') {
          revoked = true;
        }
      },
      complete: (stage, instructions, input) async {
        if (stage == 'timeline_reconcile') {
          return {
            'groups': [
              {
                'members': ['foreign'],
              },
            ],
          };
        }
        if (stage == 'timeline_compose' || stage == 'timeline_review') {
          writes++;
        }
        return normalComplete(stage, instructions, input);
      },
    );
    await expectLater(
      pipeline.generate(data.observations, data.records, historyComplete: true),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'code',
          'authorization_changed',
        ),
      ),
    );
    expect(writes, 0);
  });
  test('host fallback is zero for successful model reconciliation', () async {
    final data = fixture(2);
    final result = await TimelinePipeline(
      cacheScope: 'model-reconcile',
      authorize: () async {},
      complete: normalComplete,
    ).generate(data.observations, data.records, historyComplete: true);
    expect(result.coverage['timeline_reconcile_host_fallback'], 0);
  });
}
