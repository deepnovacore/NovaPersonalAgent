import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';

final records = <Map<String, dynamic>>[
  {
    'evidence_id': 'e0',
    'chat': 'c',
    'relation': 'self',
    'created_at': '2026-10-19T00:00:00Z',
    'text': '本人持续关注项目核验。',
  },
];
Map<String, dynamic> output() => {
  'profile': {
    'work': {
      'text': '本人持续关注项目核验。',
      'evidence_ids': ['e0'],
    },
  },
  'timeline': [],
  'todos': [],
};
Map<String, dynamic> observations() => {
  'facts': [
    {
      'text': '【人】本人关注核验',
      'refs': ['e0'],
    },
  ],
};

void main() {
  test(
    'Profile publishes before Timeline starts and remains explicitly partial',
    () async {
      final stages = <String>[];
      final publications = <Map<String, int>>[];
      Future<Map<String, dynamic>> complete(
        String stage,
        String instructions,
        Map<String, dynamic> input,
      ) async {
        stages.add(stage);
        if (stage == 'observations') return observations();
        if (stage == 'timeline_select') {
          expect(publications, hasLength(1));
          throw const AgentFailure('model_http_503');
        }
        expect(instructions, isNot(contains('本次仅基于已核对的部分资料')));
        return stage == 'review' ? {'review_notes': []} : output();
      }

      final writer = ProfileWriter(
        complete: complete,
        timelinePipeline: TimelinePipeline(
          complete: complete,
          authorize: () async {},
          cacheScope: 'fixed-scope',
        ),
        onProfilePublish: (entries, coverage) async {
          expect((jsonDecode(entries) as List).single['key'], 'work');
          publications.add(coverage);
        },
      );
      await expectLater(writer.generate(records), throwsA(isA<AgentFailure>()));
      expect(stages, [
        'observations',
        'draft',
        'review',
        'edit',
        'timeline_select',
      ]);
      expect(publications.single['profile_pending'], 0);
      expect(publications.single['timeline_pending'], 1);
      expect(writer.isPartial, true);
    },
  );

  test('non-Profile output cache cannot publish or reach Timeline', () async {
    final stages = <String>[];
    Future<Map<String, dynamic>> complete(
      String stage,
      String _,
      Map<String, dynamic> input,
    ) async {
      stages.add(stage);
      return observations();
    }

    final writer = ProfileWriter(
      complete: complete,
      timelinePipeline: TimelinePipeline(
        complete: complete,
        authorize: () async {},
        cacheScope: 'fixed-scope',
      ),
      loadProfileOutput: (_) async => jsonEncode([
        {
          'kind': 'todo_candidate',
          'key': 'todo',
          'text': '本人持续关注项目核验。',
          'evidence_ids': ['e0'],
          'time_ref': 'e0',
        },
      ]),
      onProfilePublish: (_, _) async => fail('invalid cache must not publish'),
    );
    await expectLater(
      writer.generate(records),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'code',
          'profile_timeline_checkpoint_invalid',
        ),
      ),
    );
    expect(stages, ['observations']);
    expect(writer.profileFailureCode, isNull);
  });

  test(
    'legacy Profile cache with omitted kind is reused without model payment',
    () async {
      final stages = <String>[];
      Future<Map<String, dynamic>> complete(
        String stage,
        String _,
        Map<String, dynamic> input,
      ) async {
        stages.add(stage);
        return stage == 'observations' ? observations() : {'topics': []};
      }

      final writer = ProfileWriter(
        complete: complete,
        timelinePipeline: TimelinePipeline(
          complete: complete,
          authorize: () async {},
          cacheScope: 'fixed-scope',
        ),
        loadProfileOutput: (_) async => jsonEncode([
          {
            'key': 'work',
            'text': '本人持续关注项目核验。',
            'evidence_ids': ['e0'],
          },
        ]),
      );
      final result = jsonDecode(await writer.generate(records)) as List;
      expect(result.single['key'], 'work');
      expect(stages, ['observations', 'timeline_select']);
      expect(writer.isPartial, false);
    },
  );

  test('empty successful Profile cache remains a successful product', () async {
    final stages = <String>[];
    Future<Map<String, dynamic>> complete(
      String stage,
      String _,
      Map<String, dynamic> input,
    ) async {
      stages.add(stage);
      return stage == 'observations' ? observations() : {'topics': []};
    }

    final writer = ProfileWriter(
      complete: complete,
      timelinePipeline: TimelinePipeline(
        complete: complete,
        authorize: () async {},
        cacheScope: 'fixed-scope',
      ),
      loadProfileOutput: (_) async => '[]',
    );
    expect(jsonDecode(await writer.generate(records)), isEmpty);
    expect(stages, ['observations', 'timeline_select']);
    expect(writer.isPartial, false);
    expect(writer.coverage['profile_pending'], 0);
  });

  for (final failure in <Object>[
    const AgentFailure('profile_budget_exhausted'),
    const AgentFailure('model_http_503'),
    StateError('processing_consent_required'),
  ]) {
    test(
      'Profile operational failure stops before Timeline: $failure',
      () async {
        final stages = <String>[];
        Future<Map<String, dynamic>> complete(
          String stage,
          String _,
          Map<String, dynamic> input,
        ) async {
          stages.add(stage);
          if (stage == 'observations') return observations();
          if (stage == 'timeline_select') return {'topics': []};
          throw failure;
        }

        final writer = ProfileWriter(
          complete: complete,
          timelinePipeline: TimelinePipeline(
            complete: complete,
            authorize: () async {},
            cacheScope: 'fixed-scope',
          ),
        );
        await expectLater(writer.generate(records), throwsA(same(failure)));
        expect(stages, ['observations', 'draft']);
      },
    );
  }

  test(
    'Profile cache save failure stops before publication or Timeline',
    () async {
      final stages = <String>[];
      Future<Map<String, dynamic>> complete(
        String stage,
        String _,
        Map<String, dynamic> input,
      ) async {
        stages.add(stage);
        if (stage == 'observations') return observations();
        if (stage == 'timeline_select') return {'topics': []};
        return stage == 'review' ? {'review_notes': []} : output();
      }

      var published = false;
      final writer = ProfileWriter(
        complete: complete,
        timelinePipeline: TimelinePipeline(
          complete: complete,
          authorize: () async {},
          cacheScope: 'fixed-scope',
        ),
        saveProfileOutput: (_, _) async =>
            throw StateError('profile_checkpoint_storage_full'),
        onProfilePublish: (_, _) async => published = true,
      );
      await expectLater(writer.generate(records), throwsStateError);
      expect(stages, ['observations', 'draft', 'review', 'edit']);
      expect(published, false);
    },
  );
}
