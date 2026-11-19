import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';
import 'timeline_pipeline_test.dart' show written;

Map<String, dynamic> record(String id, String relation, bool self) => {
  'evidence_id': id,
  'chat': 'c1',
  'author': {'key': self ? 'self' : 'p1', 'kind': 'person', 'is_user': self},
  'relation': relation,
  'created_at': DateTime.now().toUtc().toIso8601String(),
  'local_date': DateTime.now().toIso8601String().substring(0, 10),
  'text': self ? '请核验接口' : '我验证完成',
};

void main() {
  test('small raw input bypasses Profile observations and selection', () async {
    final calls = <String>[];
    final records = [
      record('e0', 'self', true),
      record('e1', 'participant', false),
    ];
    final result = await TimelinePipeline(
      cacheScope: 'raw-contract',
      authorize: () async {},
      complete: (stage, instructions, input) async {
        calls.add(stage);
        expect(instructions, isNot(contains('画像始终描述账号本人')));
        expect(input['messages'], records);
        expect(input['context']['viewer_names'], isEmpty);
        expect(input['messages'][1]['author']['is_user'], false);
        if (stage == 'timeline_compose') {
          return {
            'timeline': [
              {
                'brief': {
                  'title': '本人完成核验',
                  'facts': [
                    {'text': '本人完成核验', 'ref': 'e1', 'quote': '我验证完成'},
                  ],
                  'status_label': '已完成',
                  'why_now': '请求得到回复',
                  'next_steps': [],
                  'uncertainty': '',
                  'temporal': {'kind': 'unknown', 'dates': []},
                },
                'evidence_ids': ['e1'],
                'time_ref': 'e1',
              },
            ],
          };
        }
        expect(stage, 'timeline_review');
        // The independent reviewer uses author metadata, not first-person prose.
        expect(input['draft']['timeline'], hasLength(1));
        return {'timeline': []};
      },
    ).generate([], records, historyComplete: true);
    expect(calls, ['timeline_compose', 'timeline_review']);
    expect(jsonDecode(result.entries), isEmpty);
    expect(result.partial, false);
  });

  test(
    'unrelated participant-only input yields no cards, not failure',
    () async {
      final stages = <String>[];
      final result =
          await TimelinePipeline(
            cacheScope: 'unrelated',
            authorize: () async {},
            complete: (stage, instructions, input) async {
              stages.add(stage);
              return {'timeline': []};
            },
          ).generate([], [
            record('e1', 'participant', false),
          ], historyComplete: true);
      expect(stages, ['timeline_compose', 'timeline_review']);
      expect(jsonDecode(result.entries), isEmpty);
      expect(result.partial, false);
    },
  );
  test(
    'recent window excludes old raw except trusted prior references',
    () async {
      final now = DateTime(2026, 10, 30, 12);
      Map<String, dynamic> dated(String id, String day) => {
        ...record(id, 'self', true),
        'local_date': day,
        'created_at': '${day}T08:00:00Z',
      };
      final raw = [
        dated('recent', '2026-10-16'),
        dated('history', '2026-09-01'),
        dated('legacy', '2026-09-02'),
        dated('unreferenced', '2026-09-03'),
      ];
      var calls = 0;
      final result =
          await TimelinePipeline(
            cacheScope: 'window',
            authorize: () async {},
            complete: (stage, instructions, input) async {
              calls++;
              expect(input['context']['local_date'], '2026-10-30');
              expect(input['context']['recent_since'], '2026-10-16');
              final messages = input['messages'] as List;
              expect(messages.map((r) => r['evidence_id']), [
                'recent',
                'history',
              ]);
              expect(messages.first.containsKey('history_only'), false);
              expect(messages.last['history_only'], true);
              return {'timeline': []};
            },
          ).generate(
            [],
            raw,
            historyComplete: false,
            now: now,
            priorCards: [
              {
                'policy_revision': 2,
                'evidence_ids': ['history'],
              },
              {
                'policy_revision': 1,
                'evidence_ids': ['legacy'],
              },
            ],
          );
      expect(calls, 2);
      expect(result.coverage['timeline_outside_window_records'], 2);
    },
  );

  test(
    'large raw input selects in batches without Profile summaries',
    () async {
      final raw = List.generate(
        121,
        (i) => record('e$i', 'participant', false),
      );
      var selections = 0;
      final result =
          await TimelinePipeline(
            cacheScope: 'large',
            authorize: () async {},
            complete: (stage, instructions, input) async {
              expect(stage, 'timeline_select');
              expect(instructions, isNot(contains('画像始终描述账号本人')));
              expect(input.containsKey('observations'), false);
              final rows = input['records'] as List;
              expect(rows.first['author']['is_user'], false);
              expect(rows.first['text'], '我验证完成');
              expect(
                rows.first.keys,
                containsAll([
                  'key',
                  'group',
                  'at',
                  'relation',
                  'author',
                  'text',
                ]),
              );
              selections++;
              return {'topics': []};
            },
          ).generate(
            [
              {
                'text': 'must not be used',
                'refs': ['missing'],
              },
            ],
            raw,
            historyComplete: false,
          );
      expect(selections, greaterThan(1));
      expect(jsonDecode(result.entries), isEmpty);
      expect(result.partial, false);
    },
  );
  for (final relation in ['app', 'self']) {
    test(
      'bot report or forwarded self report never implies user execution: $relation',
      () async {
        final raw = {
          ...record('e0', relation, relation == 'self'),
          'author': {
            'key': relation == 'self' ? 'self' : 'p1',
            'kind': relation == 'app' ? 'app' : 'person',
            'is_user': relation == 'self',
          },
          'text': '助手回报：已帮你部署完成',
          'links': {'forwarded_in': 'outside_window'},
        };
        final result = await TimelinePipeline(
          cacheScope: 'report-$relation',
          authorize: () async {},
          complete: (stage, instructions, input) async {
            expect(input['messages'].single, raw);
            expect(
              input['messages'].single['author']['kind'],
              relation == 'app' ? 'app' : 'person',
            );
            return {'timeline': []};
          },
        ).generate([], [raw], historyComplete: true);
        expect(jsonDecode(result.entries), isEmpty);
        expect(result.partial, false);
      },
    );
  }

  test(
    'temporal roles are checked per card before partial publication',
    () async {
      final raw = {
        ...record('e0', 'self', true),
        'local_date': '2026-10-29',
        'created_at': '2026-10-29T08:00:00Z',
        'text': '2026-10-28完成接口核验',
      };
      Map<String, dynamic> card(String kind) => {
        'evidence_ids': ['e0'],
        'time_ref': 'e0',
        'brief': {
          'title': '接口核验完成',
          'status_label': '完成',
          'facts': [
            {'text': '接口核验完成', 'ref': 'e0', 'quote': raw['text']},
          ],
          'why_now': '本人关注的接口已有核验结果',
          'next_steps': [],
          'uncertainty': '',
          'temporal': {
            'kind': kind,
            'dates': [
              {
                'role': 'occurred',
                'date': '2026-10-28',
                'ref': 'e0',
                'quote': raw['text'],
              },
            ],
          },
        },
      };
      final result = await TimelinePipeline(
        cacheScope: 'mixed-time',
        authorize: () async {},
        complete: (stage, instructions, input) async =>
            stage == 'timeline_review'
            ? Map<String, dynamic>.from(input['draft'] as Map)
            : {
                'timeline': [card('event'), card('deadline')],
              },
      ).generate([], [raw], historyComplete: true, now: DateTime(2026, 10, 30));
      final entries = jsonDecode(result.entries) as List;
      expect(entries, hasLength(1));
      expect(entries.single['policy_revision'], 2);
      expect(entries.single['time']['anchor_date'], '2026-10-28');
      expect(result.partial, true);
    },
  );

  test(
    'background and old occurrence are omitted, not repaired into recent events',
    () async {
      final raw = {
        ...record('e0', 'self', true),
        'local_date': '2026-10-29',
        'created_at': '2026-10-29T08:00:00Z',
        'text': '转发：2026-09-01完成接口核验',
      };
      var compose = 0;
      final result = await TimelinePipeline(
        cacheScope: 'old-time',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_compose') compose++;
          return {
            'timeline': [
              for (final kind in ['event', 'background'])
                {
                  'evidence_ids': ['e0'],
                  'time_ref': 'e0',
                  'brief': {
                    'title': '历史核验结果',
                    'status_label': '完成',
                    'facts': [
                      {'text': '接口核验完成', 'ref': 'e0', 'quote': raw['text']},
                    ],
                    'why_now': '收到历史核验结果',
                    'next_steps': [],
                    'uncertainty': '',
                    'temporal': {
                      'kind': kind,
                      'dates': [
                        {
                          'role': 'occurred',
                          'date': '2026-09-01',
                          'ref': 'e0',
                          'quote': raw['text'],
                        },
                      ],
                    },
                  },
                },
            ],
          };
        },
      ).generate([], [raw], historyComplete: true, now: DateTime(2026, 10, 30));
      expect(jsonDecode(result.entries), isEmpty);
      expect(result.partial, false);
      expect(compose, 1);
    },
  );
  test(
    'oversized raw is deferred whole without losing usable neighbors',
    () async {
      final raw = [
        {...record('huge', 'self', true), 'text': '甲' * 49000},
        record('small', 'participant', false),
      ];
      final seen = <String>[];
      final result = await TimelinePipeline(
        cacheScope: 'raw-capacity',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          seen.add(stage);
          if (stage != 'timeline_select') return {'timeline': []};
          expect(input['records'], hasLength(1));
          expect(input['records'].single['text'], '我验证完成');
          return {
            'topics': [
              {
                'title': '独立事项',
                'observation_indices': [1],
              },
            ],
          };
        },
      ).generate([], raw, historyComplete: true);
      expect(seen, ['timeline_select', 'timeline_compose', 'timeline_review']);
      expect(result.partial, true);
      expect(result.deferredTopics, 1);
      expect(result.pendingBatches, 1);
    },
  );
  test(
    'direct input keeps two independent cards inside one evidence scope',
    () async {
      final raw = [
        {...record('e0', 'self', true), 'text': '接口核验完成'},
        {...record('e1', 'self', true), 'text': '文档发布完成'},
      ];
      final stages = <String>[];
      final result = await TimelinePipeline(
        cacheScope: 'direct-independent',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          stages.add(stage);
          expect(input['timeline_topics'], hasLength(1));
          return written(input);
        },
      ).generate([], raw, historyComplete: true);
      expect(stages, ['timeline_compose', 'timeline_review']);
      final cards = jsonDecode(result.entries) as List;
      expect(cards, hasLength(2));
      expect(cards.map((c) => c['evidence_ids']).toList(), [
        ['e0'],
        ['e1'],
      ]);
    },
  );

  test(
    '20k raw message in large pool survives selection and full composition',
    () async {
      final raw = List.generate(121, (i) => record('e$i', 'self', true));
      raw[0]['text'] = '接口核验完成${'甲' * 20000}';
      final stages = <String>{};
      final result = await TimelinePipeline(
        cacheScope: 'long-raw',
        authorize: () async {},
        complete: (stage, instructions, input) async {
          stages.add(stage);
          expect(instructions, isNot(contains('画像始终描述账号本人')));
          if (stage == 'timeline_select') {
            final rows = input['records'] as List;
            return {
              'topics': [
                for (final row in rows)
                  if (row['key'] == 0 || row['key'] == 1)
                    {
                      'title': '独立核验',
                      'observation_indices': [row['key']],
                    },
              ],
            };
          }
          if (stage == 'timeline_reconcile') return {'groups': []};
          final messages = input['messages'] as List;
          expect(messages.first['text'], raw.first['text']);
          expect((messages.first['text'] as String).length, greaterThan(20000));
          return {'timeline': []};
        },
      ).generate([], raw, historyComplete: true);
      expect(stages, {
        'timeline_select',
        'timeline_reconcile',
        'timeline_compose',
        'timeline_review',
      });
      expect(result.partial, false);
    },
  );
}
