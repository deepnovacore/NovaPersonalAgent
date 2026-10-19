import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/profile_writer.dart';

final originals = <String, dynamic>{
  'e1': {
    'text': '我协调接口验收，服务运行在192.168.1.10，localhost用于本地验证。',
    'relation': 'self',
    'created_at': DateTime.utc(2026, 10, 19).millisecondsSinceEpoch,
  },
};
Map<String, dynamic> profile(String text, {String key = 'about'}) => {
  'key': key,
  'kind': 'profile',
  'text': text,
  'evidence_ids': ['e1'],
};

void main() {
  for (final alias in ['p3', 'p11', 'p2', 'c7']) {
    test(
      'unbacked internal alias $alias is rejected with a precise content-free path',
      () {
        expect(
          () => validateProfileEntries([profile('与$alias协调接口')], originals),
          throwsA(
            isA<ProfileValidationFailure>()
                .having((e) => e.message, 'code', 'ungrounded_projection')
                .having((e) => e.detail, 'detail', {
                  'path': 'entries[0].text',
                  'reason': 'internal_alias',
                }),
          ),
        );
      },
    );
  }
  for (final address in [
    '192.168.1.10',
    '10.1.2.3',
    '172.16.2.8',
    '127.0.0.1',
    'localhost',
  ]) {
    test(
      'private or loopback address $address is not published as user prose',
      () {
        expect(
          () => validateProfileEntries([
            profile('正在维护 $address 的服务', key: 'work'),
          ], originals),
          throwsA(
            isA<ProfileValidationFailure>().having(
              (e) => e.detail['reason'],
              'reason',
              'local_address',
            ),
          ),
        );
      },
    );
  }
  test('actual source names and product versions remain valid', () {
    final actual = {
      'e1': {
        ...originals['e1'] as Map,
        'text': '我维护P3与c2工具，版本 10.1.2.3，以及v0.4.0。',
      },
    };
    expect(
      () => validateProfileEntries([
        profile('维护P3与c2工具，版本 10.1.2.3；使用v0.4.0和qwen3-vl-plus。'),
      ], actual),
      returnsNormally,
    );
  });
  test(
    'brief checks display fields while exact source quotes remain untouched',
    () {
      final brief = {
        'title': '本地服务已验证',
        'status_label': '已完成',
        'facts': [
          {
            'text': '接口验证已有结果',
            'ref': 'e1',
            'quote': '服务运行在192.168.1.10，localhost用于本地验证',
          },
        ],
        'why_now': '验证结果支持下一步接口验收。',
        'next_steps': <Object>[],
        'uncertainty': '',
      };
      final entry = {
        'key': 'event',
        'kind': 'timeline',
        'text': '本地服务已验证\n接口验证已有结果',
        'evidence_ids': ['e1'],
        'observed_at': '2026-10-19T00:00:00Z',
        'brief': brief,
      };
      expect(() => validateProfileEntries([entry], originals), returnsNormally);
      expect(
        (brief['facts'] as List).single['quote'],
        contains('192.168.1.10'),
      );
      (entry['brief'] as Map)['why_now'] = 'p3需要这轮结果';
      expect(
        () => validateProfileEntries([entry], originals),
        throwsA(
          isA<ProfileValidationFailure>().having(
            (e) => e.detail['path'],
            'path',
            'entries[0].brief.why_now',
          ),
        ),
      );
      (entry['brief'] as Map)['why_now'] = '验收结果有助后续安排';
      (entry['brief'] as Map)['next_steps'] = [
        {'title': '继续验证', 'detail': '访问localhost核对接口'},
      ];
      expect(
        () => validateProfileEntries([entry], originals),
        throwsA(
          isA<ProfileValidationFailure>().having(
            (e) => e.detail['path'],
            'path',
            'entries[0].brief.next_steps[0].detail',
          ),
        ),
      );
    },
  );
  test(
    'writer repairs the indicated display field without changing originals',
    () async {
      var repairs = 0;
      final record = <String, dynamic>{
        'evidence_id': 'e1',
        'chat': 'c1',
        'speaker': 'p1',
        'relation': 'self',
        'created_at': '2026-10-19T00:00:00Z',
        'text': originals['e1']['text'],
      };
      final before = jsonEncode(record);
      final writer = ProfileWriter(
        complete: (stage, instructions, input) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】本人协调验收',
                  'refs': ['e1'],
                },
              ],
            };
          }
          if (stage == 'timeline_select') return {'topics': []};
          if (stage == 'review') return {'review_notes': []};
          if (stage == 'repair') {
            repairs++;
            expect(input['validation_error'], 'ungrounded_projection');
            expect(input['validation_detail'], {
              'path': 'profile.work.text',
              'reason': repairs == 1 ? 'internal_alias' : 'local_address',
            });
            expect(instructions, contains('服务功能'));
          }
          return {
            'timeline': [],
            'profile': {
              'work': {
                'text': repairs == 0
                    ? '与p11协调验收'
                    : repairs == 1
                    ? '维护localhost上的服务'
                    : '协调接口验收与本地服务验证。',
                'evidence_ids': ['e1'],
              },
            },
          };
        },
      );
      final result = jsonDecode(await writer.generate([record])) as List;
      expect(repairs, 2);
      expect(result.single['text'], '协调接口验收与本地服务验证。');
      expect(jsonEncode(record), before);
    },
  );
}
