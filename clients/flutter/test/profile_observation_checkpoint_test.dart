import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/profile_writer.dart';
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
      final first = ProfileWriter(
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
                'refs': [id],
              },
            ],
          };
        },
      );
      await expectLater(first.generate(records), throwsStateError);
      var newCalls = 0;
      final resumed = ProfileWriter(
        loadValidatedBatch: cache.load,
        saveValidatedBatch: cache.save,
        complete: (stage, _, input) async {
          if (stage == 'observations') {
            newCalls++;
            return {
              'facts': [
                {
                  'text': '【风】反复核对依据',
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
      });
      final host = FeishuHost();
      await host.sources.bind('new-account', 1);
      expect(
        await const SecureContextPersistence(
          ProfileObservationCheckpoint.storageKey,
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
