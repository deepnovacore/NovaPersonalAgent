import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';

void main() {
  test(
    'advancing only Profile coverage reuses all raw Timeline stages',
    () async {
      final now = DateTime.now();
      final records = [
        for (var i = 0; i < 2; i++)
          <String, dynamic>{
            'evidence_id': 'e$i',
            'chat': 'c1',
            'relation': 'self',
            'created_at': now.toUtc().toIso8601String(),
            'local_date': now.toIso8601String().substring(0, 10),
            'text': '本人持续推进合成项目 $i',
          },
      ];
      final checkpoints = <String, Map<String, dynamic>>{};
      var calls = 0;
      final historyComplete = <bool>[];
      ProfileWriter create(bool fullyObserved) => ProfileWriter(
        writeProfile: false,
        loadValidatedBatch: (_) async => fullyObserved ? [] : null,
        complete: (_, _, _) async =>
            throw StateError('unexpected_profile_call'),
        timelinePipeline: TimelinePipeline(
          cacheScope: 'same-source',
          authorize: () async {},
          loadCheckpoint: (key) async => checkpoints[key],
          saveCheckpoint: (key, value) async {
            checkpoints[key] = value;
          },
          complete: (_, _, input) async {
            calls++;
            historyComplete.add(input['history_complete'] as bool);
            return {'timeline': []};
          },
        ),
      );
      await create(false).generate(records, savedObservationsOnly: true);
      final initialCalls = calls;
      expect(initialCalls, greaterThan(0));
      await create(true).generate(records, savedObservationsOnly: true);
      expect(calls, initialCalls);
      expect(historyComplete, everyElement(true));
    },
  );

  for (final failure in ['empty', 'invalid', 'format']) {
    test(
      'Timeline receives raw records despite $failure Profile observations',
      () async {
        final records = <Map<String, dynamic>>[
          {
            'evidence_id': 'e0',
            'chat': 'c1',
            'relation': 'participant',
            'created_at': DateTime.now().toUtc().toIso8601String(),
            'local_date': DateTime.now().toIso8601String().substring(0, 10),
            'text': '合成协作记录',
          },
        ];
        var timelineCalled = false;
        final reachedTimeline = StateError('reached_timeline');
        final writer = ProfileWriter(
          complete: (stage, _, input) async {
            expect(stage, 'observations');
            if (failure == 'format') throw const ProfileResponseFormatFailure();
            return failure == 'invalid' ? {'facts': 'invalid'} : {'facts': []};
          },
          timelinePipeline: TimelinePipeline(
            complete: (stage, _, input) async {
              timelineCalled = true;
              throw reachedTimeline;
            },
            authorize: () async {},
            cacheScope: 'independent-test',
          ),
        );
        await expectLater(
          writer.generate(records),
          throwsA(same(reachedTimeline)),
        );
        expect(timelineCalled, true);
        expect(
          writer.profileFailureCode,
          failure == 'format'
              ? 'invalid_profile_json'
              : failure == 'invalid'
              ? 'invalid_profile_observations'
              : 'insufficient_profile_evidence',
        );
        expect(writer.coverage['profile_pending'], 1);
      },
    );
  }
}
