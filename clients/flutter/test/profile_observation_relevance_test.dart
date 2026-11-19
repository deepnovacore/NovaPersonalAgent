import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/profile_evidence.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  final records = [
    for (var i = 1; i <= 2; i++)
      <String, dynamic>{
        'evidence_id': 'e$i',
        'chat': 'c1',
        'relation': 'self',
        'created_at': '2026-10-29T00:00:00Z',
        'text': i == 1 ? '请创建临时验收文件并读回。' : '我明确偏好先核对依据。',
      },
  ];
  for (final relevance in [
    'one_off_task',
    'reference_material',
    'uncertain',
    'repeated_pattern',
    null,
    'invented',
  ]) {
    test('excludes $relevance with only one distinct original', () async {
      final stages = <String>[];
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          stages.add(stage);
          return {
            'facts': [
              {
                'text': '【风】先核对依据',
                'refs': ['e1', 'e1'],
                'relevance': ?relevance,
              },
            ],
          };
        },
      );
      await expectLater(writer.generate(records), throwsStateError);
      expect(stages.every((stage) => stage == 'observations'), isTrue);
      expect(writer.observationCount, 0);
    });
  }
  for (final relevance in [
    'identity',
    'relationship',
    'ongoing_work',
    'stated_preference',
    'repeated_pattern',
  ]) {
    test('retains classified $relevance and excludes one-off source', () async {
      final refs = relevance == 'repeated_pattern' ? ['e1', 'e2'] : ['e2'];
      final writer = ProfileWriter(
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            return {
              'facts': [
                {
                  'text': '【事】临时验收',
                  'refs': ['e1'],
                  'relevance': 'one_off_task',
                },
                {'text': '【风】核对依据', 'refs': refs, 'relevance': relevance},
              ],
            };
          }
          if (stage == 'timeline_select') return {'topics': []};
          expect(
            (input['messages'] as List).map((m) => m['evidence_id']),
            refs,
          );
          expect(
            (input['observations'] as List).single['relevance'],
            relevance,
          );
          if (stage == 'review') return {'review_notes': []};
          return {
            'timeline': [],
            'profile': {
              'about': {
                'text': '你偏好先核对依据。',
                'evidence_ids': ['e2'],
              },
            },
          };
        },
      );
      expect(jsonDecode(await writer.generate(records)), hasLength(1));
      expect(writer.observationCount, 1);
    });
  }

  test('durable identity mapping preserves observation classification', () {
    final evidence = ProfileEvidence([
      {
        'evidence_id': 'original-message',
        'chat_id': 'synthetic-chat',
        'sender_id': 'synthetic-person',
        'relation': 'self',
        'created_at': DateTime.utc(2026, 10, 29).millisecondsSinceEpoch,
        'fetched_at': DateTime.utc(2026, 10, 29).millisecondsSinceEpoch,
        'text': '我明确偏好先核对依据。',
      },
    ]);
    final facts = [
      {
        'text': '偏好',
        'refs': ['e1'],
        'relevance': 'stated_preference',
      },
    ];
    final stored = evidence.checkpointFacts(facts);
    expect(stored.single['relevance'], 'stated_preference');
    expect(stored.single['refs'], ['original-message']);
    expect(evidence.restoreCheckpointFacts(stored), facts);
    // Profile output checkpoints hash JSON, including map insertion order.
    expect(jsonEncode(evidence.restoreCheckpointFacts(stored)), jsonEncode(facts));
  });

  test(
    'old unclassified checkpoint is not reused or accepted for saving',
    () async {
      final now = DateTime.utc(2026, 10, 29);
      final disk = MemoryLifePersistence();
      final cache = ProfileObservationCheckpoint(
        disk,
        scope: 'synthetic',
        expiresAt: now.add(const Duration(days: 1)),
        now: () => now,
        authorize: () async {},
      );
      final old = [
        {
          'text': '旧观察',
          'refs': ['e1'],
        },
      ];
      await disk.write(
        jsonEncode({
          'version': 1,
          'scope': 'synthetic',
          'expires_at': now.add(const Duration(days: 1)).toIso8601String(),
          'batches': {ProfileObservationCheckpoint.digest(records): old},
          'manifests': {
            ProfileObservationCheckpoint.digest(records): [
              for (final record in records)
                {
                  'evidence_id': record['evidence_id'],
                  'digest': ProfileObservationCheckpoint.digest(record),
                },
            ],
          },
        }),
      );
      expect((await cache.loadReusable(records)).recordIds, isEmpty);
      expect(await cache.load(records), isNull);
      await expectLater(cache.save(records, old), throwsStateError);
      final classified = [
        {
          'text': '偏好',
          'refs': ['e2'],
          'relevance': 'stated_preference',
        },
      ];
      await cache.save(records, classified);
      expect(await cache.load(records), classified);
    },
  );

  for (final relation in [
    'participant',
    'addressed',
    'app',
    'unknown',
    'invalid',
  ]) {
    test('self-evidence diagnostics preserve safe $relation label', () {
      final input = [
        {...records.first, 'relation': relation},
      ];
      expect(
        () => ProfileWriter.encodeEntries({
          'profile': {
            'about': {
              'text': '本人完成验收',
              'evidence_ids': ['e1'],
            },
          },
          'timeline': [],
        }, input),
        throwsA(
          isA<ProfileValidationFailure>().having(
            (error) => error.detail['invalid_references'],
            'relations',
            [
              {
                'evidence_id': 'e1',
                'relation': relation == 'invalid' ? 'unknown' : relation,
              },
            ],
          ),
        ),
      );
    });
  }
}
