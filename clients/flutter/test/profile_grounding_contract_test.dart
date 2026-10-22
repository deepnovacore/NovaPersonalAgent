import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';

void main() {
  test(
    'sparse evidence stays brief and only reviewed claims are published',
    () async {
      final records = [
        for (final (id, text) in [
          ('role', '我是图书管理员。'),
          ('catalog', '今天完成了目录检索功能开发。'),
          ('return', '归还登记功能已经测试通过。'),
        ])
          <String, dynamic>{
            'evidence_id': id,
            'text': text,
            'relation': 'self',
            'created_at': '2026-10-20T00:00:00Z',
            'chat': 'c1',
          },
      ];
      final observations = [
        for (final record in records)
          <String, dynamic>{
            'text': '【事】${record['text']}',
            'refs': [record['evidence_id']],
          },
      ];
      final timelineRecords = records.skip(1).toList();
      final stages = <String>[];
      Map<String, dynamic> profile(String text) => {
        'timeline': [],
        'profile': {
          'about': {
            'text': text,
            'evidence_ids': ['role'],
          },
          'work': null,
          'interests': null,
        },
      };
      Map<String, dynamic> timeline(String text) => {
        'timeline': [
          {
            'brief': {
              'title': '目录检索开发完成',
              'status_label': '开发完成',
              'facts': [
                {'text': text, 'ref': 'catalog', 'quote': records[1]['text']},
                {
                  'text': records[2]['text'],
                  'ref': 'return',
                  'quote': records[2]['text'],
                },
              ],
              'why_now': '本人完成了一项功能开发。',
              'next_steps': [],
              'uncertainty': '',
            },
            'evidence_ids': ['catalog', 'return'],
            'time_ref': 'catalog',
          },
        ],
      };
      Future<Map<String, dynamic>> complete(
        String stage,
        String instructions,
        Map<String, dynamic> input,
      ) async {
        stages.add(stage);
        if (stage == 'observations') return {'facts': observations};
        if (stage == 'timeline_select') {
          return {
            'topics': [
              {
                'title': '目录与归还功能进展',
                'observation_indices': [1, 2],
              },
            ],
          };
        }
        if (stage.startsWith('timeline_')) {
          expect(input['messages'], timelineRecords);
          expect(instructions, isNot(contains('约35至65字')));
          if (stage == 'timeline_compose') {
            return timeline('目录检索已经上线并测试通过。');
          }
          expect(stage, 'timeline_review');
          expect(jsonEncode(input['draft']), contains('目录检索已经上线并测试通过'));
          return timeline(records[1]['text'] as String);
        }
        expect(input['messages'], records);
        expect(instructions, isNot(contains('about写3到6')));
        if (stage == 'draft') return profile('善于管理团队的图书管理员。');
        if (stage == 'review') {
          expect(jsonEncode(input['draft']), contains('善于管理团队'));
          return {
            'review_notes': ['职位不能推出管理能力，仅保留本人说明的职位。'],
          };
        }
        expect(stage, 'edit');
        expect(input['review_notes'], ['职位不能推出管理能力，仅保留本人说明的职位。']);
        return profile('本人是图书管理员。');
      }

      final writer = ProfileWriter(
        complete: complete,
        timelinePipeline: TimelinePipeline(
          complete: complete,
          authorize: () async {},
          cacheScope: 'synthetic-grounding',
        ),
      );
      final output = await writer.generate(records);
      final entries = (jsonDecode(output) as List).cast<Map>();
      expect(
        entries.singleWhere((e) => e['kind'] == 'profile')['text'],
        '本人是图书管理员。',
      );
      final card = entries.singleWhere((e) => e['kind'] == 'timeline');
      expect(card['brief']['facts'][0]['text'], records[1]['text']);
      expect(card['brief']['facts'][1]['text'], records[2]['text']);
      expect(output, isNot(contains('已经上线')));
      expect(output, isNot(contains('善于管理团队')));
      expect(stages, [
        'observations',
        'draft',
        'review',
        'edit',
        'timeline_select',
        'timeline_compose',
        'timeline_review',
      ]);
    },
  );
}
