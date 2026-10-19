import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/timeline_brief.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';

const source = '本人完成接口验收，完整原文仅作为证据。';
List<Map<String, dynamic>> records() => [
  for (final id in ['e0', 'e1'])
    {
      'evidence_id': id,
      'text': source,
      'relation': 'self',
      'created_at': '2026-10-19T00:00:00Z',
      'chat': 'c1',
      'speaker': 'p1',
    },
];
Map<String, dynamic> brief() => {
  'title': '接口验收完成',
  'status_label': '完成',
  'facts': [
    <String, dynamic>{'text': '本人完成接口验收', 'ref': 'e0', 'quote': '本人完成接口验收'},
  ],
  'why_now': '核验结果已经明确',
  'next_steps': [],
  'uncertainty': '',
};
Map<String, dynamic> output() => {
  'timeline': [
    {
      'brief': brief(),
      'evidence_ids': ['e0'],
      'time_ref': 'e0',
    },
  ],
};
void detail(
  void Function() action,
  String reason,
  String path, {
  String code = 'ungrounded_projection',
}) {
  expect(
    action,
    throwsA(
      isA<ProfileValidationFailure>()
          .having((e) => e.message, 'outer code', code)
          .having((e) => e.detail, 'content-free detail', {
            'reason': reason,
            'path': path,
          }),
    ),
  );
}

void main() {
  test('safe diagnostics reject prose paths and discard all extra values', () {
    final good = ProfileValidationFailure('ungrounded_projection', {
      'reason': 'fact_quote_not_exact',
      'path': 'timeline[2].brief.facts[1].quote',
      'source': source,
      'quote': 'private-model-marker',
      'ref': 'private-ref-marker',
    });
    expect(safeTimelineValidationDetail(good), {
      'reason': 'fact_quote_not_exact',
      'path': 'timeline[2].brief.facts[1].quote',
    });
    for (final bad in [
      {'reason': 'private-model-marker', 'path': 'timeline[0]'},
      {'reason': 'entry_schema', 'path': 'timeline[0].private-model-marker'},
      {'reason': 'entry_schema', 'path': 'timeline[private-ref-marker]'},
      {'reason': 'entry_schema', 'path': 'timeline[0].brief.facts[-1].quote'},
      {'reason': 'entry_schema', 'path': 'profile.private-model-marker'},
    ]) {
      expect(
        safeTimelineValidationDetail(
          ProfileValidationFailure('ungrounded_projection', bad),
        ),
        isNull,
      );
    }
  });
  final cases = <String, ({Object? value, String field, String path})>{
    'fact_ref_type': (value: 7, field: 'ref', path: 'ref'),
    'fact_ref_not_cited': (
      value: 'private-ref-marker',
      field: 'ref',
      path: 'ref',
    ),
    'fact_quote_type': (value: 7, field: 'quote', path: 'quote'),
    'fact_quote_empty': (value: '  ', field: 'quote', path: 'quote'),
    'fact_quote_too_long': (value: '甲' * 601, field: 'quote', path: 'quote'),
    'fact_quote_not_exact': (
      value: 'private-model-marker',
      field: 'quote',
      path: 'quote',
    ),
  };
  for (final entry in cases.entries) {
    test('writer distinguishes ${entry.key} with exact field path', () {
      final value = output();
      value['timeline'][0]['brief']['facts'][0][entry.value.field] =
          entry.value.value;
      detail(
        () => ProfileWriter.encodeEntries(value, records(), requireBrief: true),
        entry.key,
        'timeline[0].brief.facts[0].${entry.value.path}',
      );
    });
  }
  test('sensitive exact quote remains rejected without echoing it', () {
    final value = output(), originals = records();
    const token = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
    originals[0]['text'] = token;
    value['timeline'][0]['brief']['facts'][0]['quote'] = token;
    detail(
      () => ProfileWriter.encodeEntries(value, originals, requireBrief: true),
      'fact_quote_sensitive',
      'timeline[0].brief.facts[0].quote',
    );
  });
  for (final entry in {
    'fact_source_missing': null,
    'fact_source_text_type': {'text': 7},
  }.entries) {
    test('brief distinguishes ${entry.key}', () {
      detail(
        () => normalizeTimelineBrief(brief(), ['e0'], {'e0': entry.value}),
        entry.key,
        'brief.facts[0].ref',
      );
    });
  }
  test('unknown reference is identified without reference value', () {
    final value = output();
    value['timeline'][0]['evidence_ids'] = ['private-ref-marker'];
    detail(
      () => ProfileWriter.encodeEntries(value, records()),
      'evidence_id_unknown',
      'timeline[0].evidence_ids[0]',
    );
  });
  test('cross-topic refs retain grounding rejection', () {
    final value = output();
    value['timeline'][0]['evidence_ids'] = ['e0', 'e1'];
    detail(
      () => ProfileWriter.encodeEntries(
        value,
        records(),
        timelineGroups: [
          ['e0'],
          ['e1'],
        ],
      ),
      'timeline_refs_cross_topic',
      'timeline[0].evidence_ids',
    );
  });
  test('schema rejection never reflects untrusted field names', () {
    final value = output();
    value['timeline'][0]['private-model-marker'] = source;
    detail(
      () => ProfileWriter.encodeEntries(value, records()),
      'entry_schema',
      'timeline[0]',
    );
  });
  test('brief schema keeps outer invalid_projection code', () {
    final value = output();
    value['timeline'][0]['brief']['facts'][0]['private-model-marker'] = source;
    detail(
      () => ProfileWriter.encodeEntries(value, records()),
      'fact_schema',
      'timeline[0].brief.facts[0]',
      code: 'invalid_projection',
    );
  });
  test('repository reports derived text mismatch without generated text', () {
    final entries =
        jsonDecode(ProfileWriter.encodeEntries(output(), records())) as List;
    entries[0]['text'] = 'private-model-marker';
    detail(
      () => validateProfileEntries(entries, {
        for (final record in records())
          record['evidence_id']: {
            ...record,
            'created_at': DateTime.parse(
              record['created_at'] as String,
            ).millisecondsSinceEpoch,
          },
      }),
      'brief_text_mismatch',
      'entries[0].text',
    );
  });
  test('valid projection remains identical and fully grounded', () {
    final entries = jsonDecode(
      ProfileWriter.encodeEntries(output(), records(), requireBrief: true),
    );
    expect(entries[0]['text'], '接口验收完成\n本人完成接口验收');
    expect(entries[0]['brief'], brief());
  });
  for (final reason in ['fact_quote_not_exact', 'internal_alias']) {
    test('pipeline repair and diagnostics retain safe $reason path', () async {
      var compose = 0;
      final pipeline = TimelinePipeline(
        authorize: () async {},
        cacheScope: 'diagnostic-test',
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_select') {
            return {
              'topics': [
                {
                  'title': '接口验收',
                  'observation_indices': [0],
                },
              ],
            };
          }
          if (stage == 'timeline_reconcile') return {'groups': []};
          if (stage == 'timeline_compose') {
            compose++;
            if (compose == 2) {
              expect(input['validation_detail'], {
                'stage': 'timeline_compose',
                'reason': reason,
                'path': reason == 'internal_alias'
                    ? 'timeline[0].brief.title'
                    : 'timeline[0].brief.facts[0].quote',
              });
            }
            final value = output();
            if (reason == 'internal_alias') {
              value['timeline'][0]['brief']['title'] = '与p99完成验收';
            } else {
              value['timeline'][0]['brief']['facts'][0]['quote'] =
                  'private-model-marker';
            }
            return value;
          }
          throw StateError('unexpected-stage');
        },
      );
      await expectLater(
        pipeline.generate(
          [
            {
              'text': '本人完成验收',
              'refs': ['e0'],
            },
          ],
          records(),
          historyComplete: false,
        ),
        throwsA(
          isA<TimelinePipelineValidationFailure>().having(
            (e) => e.message,
            'outer code',
            'profile_timeline_invalid',
          ),
        ),
      );
      expect(compose, 2);
      expect(pipeline.validationDiagnostics!['last']['reason'], reason);
      final diagnostics = jsonEncode(pipeline.validationDiagnostics);
      expect(diagnostics, isNot(contains('private-model-marker')));
      expect(diagnostics, isNot(contains(source)));
    });
  }
}
