import 'profile_writer_fixtures.dart';
import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/timeline_pipeline.dart';
import 'package:nova_mobile/context/profile_evidence.dart';
import 'package:nova_mobile/context/secure_persistence.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  final start = DateTime.utc(2026, 10, 18);
  final expiry = start.add(const Duration(days: 1));
  final messages = <Map<String, dynamic>>[
    {
      'evidence_id': 'e1',
      'chat': 'c1',
      'relation': 'self',
      'created_at': start.toIso8601String(),
      'text': '核对依据',
    },
  ];
  final facts = <Map<String, dynamic>>[
    {
      'text': '【风】核对依据',
      'relevance': 'ongoing_work',
      'refs': ['e1'],
    },
  ];
  ProfileObservationCheckpoint make(
    MemoryLifePersistence disk, {
    String scope = 'exact-scope',
    Future<void> Function()? authorize,
    DateTime Function()? now,
    int maxBytes = 2 * 1024 * 1024,
  }) => ProfileObservationCheckpoint(
    disk,
    scope: scope,
    expiresAt: expiry,
    now: now ?? () => start,
    authorize: authorize ?? () async {},
    maxBytes: maxBytes,
  );

  test(
    'persists complete observations and a valid empty batch across reopen',
    () async {
      final disk = MemoryLifePersistence(),
          first = make(MemoryLifePersistence());
      expect(await first.load(messages), isNull);
      await make(disk).save(messages, facts);
      expect(await make(disk).load(messages), facts);
      await make(disk).save(messages, []);
      expect(await make(disk).load(messages), isEmpty);
    },
  );
  test(
    'reopened cache reuses closed batches on append and rejects changed context',
    () async {
      final disk = MemoryLifePersistence();
      final first = messages.single;
      final partner = {...first, 'evidence_id': 'e2', 'text': '共同背景'};
      final appended = {...first, 'evidence_id': 'e3', 'text': '新增消息'};
      await make(disk).save([first, partner], facts);
      var reused = await make(disk).loadReusable([first, partner, appended]);
      expect(reused.recordIds, {'e1', 'e2'});
      expect(reused.facts, facts);
      // A change invalidates the entire original context, including uncited partners.
      reused = await make(disk).loadReusable([
        first,
        {...partner, 'text': '修订背景'},
        appended,
      ]);
      expect(reused.recordIds, isEmpty);
      expect(reused.facts, isEmpty);
      reused = await make(disk).loadReusable([first, appended]);
      expect(reused.recordIds, isEmpty);
      expect(reused.facts, isEmpty);
    },
  );
  test('durable observation identities survive fresh run aliases', () {
    Map<String, dynamic> original(String id, String chat, int time) => {
      'evidence_id': id,
      'chat_id': chat,
      'sender_id': 'person-$id',
      'relation': 'self',
      'created_at': time,
      'fetched_at': time,
      'text': '核对依据$id',
    };
    final a = original('original-a', 'chat-a', start.millisecondsSinceEpoch);
    final b = original('original-b', 'chat-b', start.millisecondsSinceEpoch);
    final first = ProfileEvidence([a]);
    final next = ProfileEvidence([b, a]);
    final stored = first.checkpointRecords(first.records);
    expect(stored.single['evidence_id'], 'original-a');
    expect(next.checkpointRecords([next.records.last]), stored);
    final durable = first.checkpointFacts([
      {
        'text': '【风】依据',
        'relevance': 'ongoing_work',
        'refs': ['e1'],
      },
    ]);
    expect(durable.single['refs'], ['original-a']);
    expect(next.restoreCheckpointFacts(durable).single['refs'], ['e2']);
  });
  test(
    'model capture observes only appended data or the edited/deleted context',
    () async {
      final disk = MemoryLifePersistence();
      final first = messages.single;
      final partner = {...first, 'evidence_id': 'e2', 'text': '共同背景'};
      final added = {...first, 'evidence_id': 'e3', 'text': '新增消息'};
      Future<List<String>> run(
        List<Map<String, dynamic>> input,
        int reused,
      ) async {
        final calls = <String>[];
        final cache = make(disk);
        final writer = fixtureProfileWriter(
          loadReusableObservations: cache.loadReusable,
          loadValidatedBatch: cache.load,
          saveValidatedBatch: cache.save,
          complete: (stage, _, material) async {
            if (stage == 'observations') {
              calls.addAll(
                (material['messages'] as List).map(
                  (m) => m['evidence_id'] as String,
                ),
              );
              return {
                'facts': [
                  for (final record in material['messages'] as List)
                    {
                      'text': '【风】核对依据',
                      'relevance': 'ongoing_work',
                      'refs': [record['evidence_id']],
                    },
                ],
              };
            }
            if (stage == 'review') return {'review_notes': []};
            return {
              'timeline': [],
              'profile': {
                'about': {
                  'text': '持续核对依据',
                  'evidence_ids': ['e1'],
                },
              },
            };
          },
        );
        await writer.generate(input);
        expect(writer.reusedObservationRecordCount, reused);
        expect(writer.validatedObservationRecordCount, input.length);
        return calls;
      }

      expect(await run([first, partner], 0), ['e1', 'e2']);
      expect(await run([first, partner], 2), isEmpty);
      expect(await run([first, partner, added], 2), ['e3']);
      final edited = {...partner, 'text': '修订背景'};
      expect(await run([first, edited, added], 1), ['e1', 'e2']);
      expect(await run([first, added], 1), ['e1']);
    },
  );
  test(
    'corrupt incremental manifest never supplies facts or covered IDs',
    () async {
      final disk = MemoryLifePersistence();
      await make(disk).save(messages, facts);
      final value = jsonDecode(disk.value!) as Map;
      final manifests = value['manifests'] as Map;
      (manifests.values.single as List).single['digest'] = 'corrupt';
      disk.value = jsonEncode(value);
      final reused = await make(disk).loadReusable(messages);
      expect(reused.recordIds, isEmpty);
      expect(reused.facts, isEmpty);
      expect(jsonDecode(disk.value!)['manifests'], isEmpty);
    },
  );
  test(
    'out-of-order observation saves reuse unchanged downstream stages without calls',
    () async {
      final disk = MemoryLifePersistence();
      final reportTime = DateTime.now().toUtc().subtract(
        const Duration(minutes: 2),
      );
      final input = List.generate(
        2,
        (i) => <String, dynamic>{
          ...messages.single,
          'evidence_id': 'e${i + 1}',
          'text': '核对依据${'甲' * 12500}',
          'created_at': reportTime.add(Duration(minutes: i)).toIso8601String(),
        },
      );
      final secondSaved = Completer<void>();
      final savedOrder = <String>[], stages = <String>[];
      final outputs = <String, String>{};
      final pipeline = <String, Map<String, dynamic>>{};
      Future<Map<String, dynamic>> complete(
        String stage,
        String _,
        Map<String, dynamic> material,
      ) async {
        stages.add(stage);
        if (stage == 'observations') {
          return {
            'facts': [
              {
                'text': '【风】持续核对依据',
                'relevance': 'ongoing_work',
                'refs': [(material['messages'] as List).single['evidence_id']],
              },
            ],
          };
        }
        if (stage == 'timeline_compose' || stage == 'timeline_review') {
          return {'timeline': []};
        }
        if (stage == 'review') return {'review_notes': []};
        return {
          'profile': {
            'about': {
              'text': '持续核对依据',
              'evidence_ids': ['e1'],
            },
          },
        };
      }

      ProfileWriter create({bool delayedSave = false}) {
        final cache = make(disk);
        return ProfileWriter(
          complete: complete,
          loadReusableObservations: cache.loadReusable,
          saveValidatedBatch: (batch, valid) async {
            final id = batch.single['evidence_id'] as String;
            if (delayedSave && id == 'e1') await secondSaved.future;
            await cache.save(batch, valid);
            savedOrder.add(id);
            if (delayedSave && id == 'e2') secondSaved.complete();
          },
          loadProfileOutput: (key) async => outputs[key],
          saveProfileOutput: (key, value) async {
            outputs[key] = value;
          },
          timelinePipeline: TimelinePipeline(
            cacheScope: 'same-exact-snapshot',
            complete: complete,
            authorize: () async {},
            loadCheckpoint: (key) async => pipeline[key],
            saveCheckpoint: (key, value) async {
              pipeline[key] = value;
            },
          ),
        );
      }

      final first = await create(delayedSave: true).generate(input);
      expect(savedOrder, ['e2', 'e1']);
      expect(stages.where((stage) => stage == 'observations').length, 2);
      expect(stages, containsAll(['timeline_compose', 'timeline_review']));
      expect(stages, isNot(contains('timeline_select')));
      stages.clear();
      expect(await create().generate(input), first);
      expect(stages, isEmpty);
    },
  );
  test('every changed scope invalidates without reuse', () async {
    final original = {
      'provider': 'qwen3-vl-plus',
      'protocol': 'chatCompletions',
      'account': 'account-a',
      'auth_generation': 1,
      'space': 'space-a',
      'epoch': 1,
      'authority_generation': 0,
      'source_revision': 10,
      'consent_revision': 1,
      'corrections': 'a',
      'evidence': 'digest-a',
      'algorithm': ProfileObservationCheckpoint.algorithm,
    };
    for (final key in original.keys) {
      final disk = MemoryLifePersistence();
      await make(
        disk,
        scope: ProfileObservationCheckpoint.digest(original),
      ).save(messages, facts);
      expect(
        await make(
          disk,
          scope: ProfileObservationCheckpoint.digest({
            ...original,
            key: 'changed',
          }),
        ).load(messages),
        isNull,
      );
      expect(disk.value, 'null');
    }
  });
  test(
    'both observation loaders reject retained expiry crossed during authorization',
    () async {
      for (final reusable in [false, true]) {
        final disk = MemoryLifePersistence();
        await make(disk).save(messages, facts);
        var clock = start.add(const Duration(hours: 12)), checks = 0;
        final cache = ProfileObservationCheckpoint(
          disk,
          scope: 'exact-scope',
          expiresAt: expiry.add(const Duration(days: 1)),
          now: () => clock,
          authorize: () async {
            if (++checks == 2) clock = expiry.add(const Duration(hours: 1));
          },
        );
        if (reusable) {
          final value = await cache.loadReusable(messages);
          expect(value.recordIds, isEmpty);
          expect(value.facts, isEmpty);
        } else {
          expect(await cache.load(messages), isNull);
        }
        expect(disk.value, 'null');
      }
    },
  );
  test(
    'record text, order, identifiers and original ID mapping affect reuse',
    () async {
      final disk = MemoryLifePersistence();
      await make(disk).save(messages, facts);
      for (final field in [
        'evidence_id',
        'text',
        'relation',
        'chat',
        'created_at',
      ]) {
        expect(
          await make(disk).load([
            {...messages.single, field: 'changed'},
          ]),
          isNull,
        );
      }
      final originals = <Map<String, dynamic>>[
        {
          'evidence_id': 'actual-id',
          'chat_id': 'chat',
          'sender_id': 'user',
          'relation': 'self',
          'created_at': start.millisecondsSinceEpoch,
          'text': 'same text',
        },
      ];
      final a = ProfileEvidence(originals);
      final b = ProfileEvidence([
        {...originals.single, 'evidence_id': 'different-original'},
      ]);
      expect(a.records, b.records);
      expect(a.checkpointDigest, isNot(b.checkpointDigest));
    },
  );
  test(
    'expiry and revoked authorization reject before returning cached facts',
    () async {
      for (final expired in [true, false]) {
        final disk = MemoryLifePersistence();
        await make(disk).save(messages, facts);
        final denied = make(
          disk,
          now: () => expired ? expiry : start,
          authorize: () async {
            if (!expired) throw StateError('processing_not_allowed');
          },
        );
        await expectLater(denied.load(messages), throwsStateError);
        expect(disk.value, 'null');
      }
    },
  );
  test(
    'concurrent saves preserve both batches and invalidation erases them',
    () async {
      final disk = MemoryLifePersistence();
      final otherMessages = [
        {...messages.single, 'evidence_id': 'e2'},
      ];
      final otherFacts = <Map<String, dynamic>>[
        {
          'text': '【风】另一依据',
          'relevance': 'ongoing_work',
          'refs': ['e2'],
        },
      ];
      await Future.wait([
        make(disk).save(messages, facts),
        make(disk).save(otherMessages, otherFacts),
      ]);
      expect(await make(disk).load(messages), facts);
      expect(await make(disk).load(otherMessages), otherFacts);
      await ProfileObservationCheckpoint.invalidate(disk);
      expect(await make(disk).load(messages), isNull);
    },
  );
  test(
    'revocation during secure write cannot leave a reusable checkpoint',
    () async {
      var allowed = true;
      final disk = HookDisk()
        ..afterWrite = () {
          allowed = false;
        };
      final cache = make(
        disk,
        authorize: () async {
          if (!allowed) throw StateError('revoked');
        },
      );
      await expectLater(cache.save(messages, facts), throwsStateError);
      expect(disk.value, 'null');
    },
  );
  test(
    'invalid references, corrupted cache and storage overflow never reuse prose',
    () async {
      final disk = MemoryLifePersistence();
      final cache = make(disk);
      await expectLater(
        cache.save(messages, [
          {
            'text': '【风】forged',
            'relevance': 'ongoing_work',
            'refs': ['e999'],
          },
        ]),
        throwsStateError,
      );
      expect(disk.value, isNull);
      await cache.save(messages, facts);
      final raw = jsonDecode(disk.value!) as Map;
      (raw['batches'] as Map)[ProfileObservationCheckpoint.digest(messages)] = [
        {
          'text': '【风】forged',
          'relevance': 'ongoing_work',
          'refs': ['e999'],
        },
      ];
      disk.value = jsonEncode(raw);
      expect(await cache.load(messages), isNull);
      disk.value = '{broken';
      expect(await cache.load(messages), isNull);
      expect(disk.value, 'null');
      await expectLater(
        make(disk, maxBytes: 10).save(messages, facts),
        throwsStateError,
      );
      expect(disk.value, 'null');
    },
  );
  test(
    'cancelled run preserves completed batches and resumes only missing work',
    () async {
      final disk = MemoryLifePersistence();
      final cache = make(disk);
      final records = List.generate(
        3,
        (i) => <String, dynamic>{
          ...messages.single,
          'evidence_id': 'e$i',
          'text': 'x' * 12500,
        },
      );
      final saved = Completer<void>();
      final first = fixtureProfileWriter(
        loadValidatedBatch: cache.load,
        saveValidatedBatch: (batch, valid) async {
          await cache.save(batch, valid);
          saved.complete();
        },
        complete: (stage, _, input) async {
          final id = (input['messages'] as List).first['evidence_id'];
          if (id != 'e0') {
            await saved.future;
            throw StateError('cancelled');
          }
          return {
            'facts': [
              {
                'text': '【风】反复核对依据',
                'relevance': 'ongoing_work',
                'refs': [id],
              },
            ],
          };
        },
      );
      await expectLater(first.generate(records), throwsStateError);
      var newCalls = 0;
      final resumed = fixtureProfileWriter(
        loadValidatedBatch: cache.load,
        saveValidatedBatch: cache.save,
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            newCalls++;
            return {
              'facts': [
                {
                  'text': '【风】反复核对依据',
                  'relevance': 'ongoing_work',
                  'refs': [(input['messages'] as List).first['evidence_id']],
                },
              ],
            };
          }
          if (stage == 'review') return {'review_notes': []};
          return {
            'timeline': [],
            'profile': {
              'about': {
                'text': '持续核对依据',
                'evidence_ids': ['e0'],
              },
            },
          };
        },
      );
      await resumed.generate(records);
      expect(newCalls, 2);
      expect(resumed.reusedObservationRecordCount, 1);
      expect(resumed.observedRecordCount, 2);
      expect(resumed.validatedObservationRecordCount, 3);
    },
  );
  test(
    'source invalidation clears encrypted progress even without a running agent',
    () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      FlutterSecureStorage.setMockInitialValues({
        ProfileObservationCheckpoint.storageKey: 'saved',
        ProfileObservationCheckpoint.incrementalStorageKey: 'incremental-saved',
      });
      final host = FeishuHost();
      await host.sources.bind('new-account', 1);
      expect(
        await SecureContextPersistence(
          ProfileObservationCheckpoint.storageKey,
        ).read(),
        'null',
      );
      expect(
        await SecureContextPersistence(
          ProfileObservationCheckpoint.incrementalStorageKey,
        ).read(),
        'null',
      );
      host.dispose();
    },
  );
}

class HookDisk extends MemoryLifePersistence {
  void Function()? afterWrite;
  @override
  Future<void> write(String value) async {
    await super.write(value);
    afterWrite?.call();
  }
}
