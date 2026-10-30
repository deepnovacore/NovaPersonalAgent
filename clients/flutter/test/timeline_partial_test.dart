import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';
import 'timeline_pipeline_test.dart' show fixture, normalComplete;

void main() {
  for (final failedStage in ['timeline_compose', 'timeline_review']) {
    test(
      'keeps independently valid cards after bounded $failedStage repair',
      () async {
        final data = fixture(2);
        var failedCalls = 0, publications = 0;
        final saved = <Map<String, dynamic>>[];
        final pipeline = TimelinePipeline(
          cacheScope: 'partial',
          authorize: () async {},
          saveCheckpoint: (_, value) async {
            saved.add(value);
          },
          onPublish: (result) async {
            publications++;
            expect(result.partial, true);
          },
          complete: (stage, instructions, input) async {
            final response =
                stage == 'timeline_review' && failedStage == 'timeline_compose'
                ? Map<String, dynamic>.from(input['draft'] as Map)
                : await normalComplete(stage, instructions, input);
            if (stage == failedStage) {
              failedCalls++;
              response['timeline'][1]['brief']['title'] = '与p99核验';
            }
            return response;
          },
        );
        final result = await pipeline.generate(
          data.observations,
          data.records,
          now: DateTime(2026, 10, 30),
          historyComplete: true,
        );
        final cards = jsonDecode(result.entries) as List;
        expect(cards, hasLength(1));
        expect(cards.single['evidence_ids'], ['e0']);
        expect(cards.single['brief']['facts'][0]['quote'], '本人完成核验0');
        expect(result.partial, true);
        expect(result.coverage['timeline_pending_batches'], 1);
        expect(
          result.coverage['timeline_dropped_cards'],
          greaterThanOrEqualTo(1),
        );
        expect(failedCalls, 2);
        expect(publications, greaterThan(0));
        expect(saved.where((s) => jsonEncode(s).contains('p99')), isEmpty);
      },
    );
  }
  test(
    'an entirely rejected batch does not discard later valid batches',
    () async {
      final data = fixture(5);
      var published = 0;
      final pipeline = TimelinePipeline(
        cacheScope: 'batch-isolation',
        maxWritingRecords: 1,
        authorize: () async {},
        onPublish: (result) async {
          published = (jsonDecode(result.entries) as List).length;
        },
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_select') {
            return {
              'topics': [
                for (var i = 0; i < 5; i++)
                  {
                    'title': '核验$i',
                    'observation_indices': [i],
                  },
              ],
            };
          }
          if (stage == 'timeline_reconcile') return {'groups': []};
          final response = await normalComplete(stage, instructions, input);
          if ((input['messages'] as List).first['evidence_id'] == 'e0') {
            response['timeline'][0]['brief']['title'] = '与p99核验';
          }
          return response;
        },
      );
      final result = await pipeline.generate(
        data.observations,
        data.records,
        now: DateTime(2026, 10, 30),
        historyComplete: true,
      );
      expect(jsonDecode(result.entries), hasLength(4));
      expect(published, 4);
      expect(result.partial, true);
      expect(result.completedBatches, 4);
      expect(result.pendingBatches, 1);
    },
  );
  test(
    'review removing all retained cards cannot report a partial publication',
    () async {
      final data = fixture(2);
      var published = false;
      final pipeline = TimelinePipeline(
        cacheScope: 'removed',
        authorize: () async {},
        onPublish: (_) async {
          published = true;
        },
        complete: (stage, instructions, input) async {
          if (stage == 'timeline_review') return {'timeline': []};
          final response = await normalComplete(stage, instructions, input);
          if (stage == 'timeline_compose') {
            response['timeline'][1]['brief']['title'] = '与p99核验';
          }
          return response;
        },
      );
      await expectLater(
        pipeline.generate(
          data.observations,
          data.records,
          now: DateTime(2026, 10, 30),
          historyComplete: true,
        ),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'code',
            'profile_timeline_invalid',
          ),
        ),
      );
      expect(published, false);
    },
  );
  test(
    'a corrupt cached stage is not salvaged or silently regenerated',
    () async {
      final data = fixture(2), cache = <String, Map<String, dynamic>>{};
      var calls = 0;
      TimelinePipeline create() => TimelinePipeline(
        cacheScope: 'cached',
        authorize: () async {},
        loadCheckpoint: (key) async => cache[key],
        saveCheckpoint: (key, value) async {
          cache[key] = jsonDecode(jsonEncode(value));
        },
        complete: (stage, instructions, input) async {
          calls++;
          return normalComplete(stage, instructions, input);
        },
      );
      await create().generate(
        data.observations,
        data.records,
        now: DateTime(2026, 10, 30),
        historyComplete: true,
      );
      for (final value in cache.values) {
        final response = value['response'] as Map;
        if (response['timeline'] is List) {
          response['timeline'][1]['brief']['title'] = '与p99核验';
        }
      }
      calls = 0;
      await expectLater(
        create().generate(
          data.observations,
          data.records,
          now: DateTime(2026, 10, 30),
          historyComplete: true,
        ),
        throwsA(isA<TimelinePipelineValidationFailure>()),
      );
      expect(calls, 0);
    },
  );
}
