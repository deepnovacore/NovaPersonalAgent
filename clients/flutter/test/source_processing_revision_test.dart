import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_observation_checkpoint.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'fetch-v1 legacy scope is pinned without invalidating empty syncs',
    () async {
      var now = DateTime.utc(2026, 10, 18);
      final disk = MemoryLifePersistence();
      final initial = SourceStore(disk, now: () => now);
      await initial.bind('fixture:self', 1);
      await initial.select('chat', DateTime.utc(2026, 10, 1));
      await initial.grantProcessing('provider', 'profile', true);
      final legacy = jsonDecode(disk.value!) as Map<String, dynamic>;
      final originalFrom = legacy['sources']['chat']['from'];
      legacy['sources']['chat'].remove('history_from');
      disk.value = jsonEncode(legacy);
      initial.dispose();
      var invalidations = 0;
      final reopened = SourceStore(
        disk,
        now: () => now,
        onInvalidated: () async {
          invalidations++;
        },
      );
      await reopened.open();
      expect(reopened.revision, legacy['revision']);
      expect(reopened.processingRevision, legacy['processing_revision']);
      expect(
        jsonDecode(disk.value!)['sources']['chat']['history_from'],
        originalFrom,
      );
      for (var i = 0; i < 2; i++) {
        now = now.add(const Duration(minutes: 10));
        await reopened.ingestPage(
          reopened.fence('chat'),
          [],
          nextPage: null,
          windowEnd: now,
        );
        expect(reopened.revision, legacy['revision']);
        expect(reopened.processingRevision, legacy['processing_revision']);
        expect(invalidations, 0);
        final saved = jsonDecode(disk.value!);
        expect(saved['sources']['chat']['history_from'], originalFrom);
        expect(saved['grants'], legacy['grants']);
      }
      reopened.dispose();
    },
  );

  test(
    'cursor-only pages and identical refetches preserve authorized results and checkpoint',
    () async {
      var now = DateTime.utc(2026, 10, 18);
      var invalidations = 0;
      final profileDisk = MemoryLifePersistence(),
          cacheDisk = MemoryLifePersistence();
      final source = SourceStore(
        MemoryLifePersistence(),
        now: () => now,
        onInvalidated: () async {
          invalidations++;
          profileDisk.value = 'null';
          cacheDisk.value = 'null';
        },
      );
      await source.bind('fixture:self', 1);
      await source.select('chat', DateTime.utc(1970));
      final raw = {
        'message_id': 'm',
        'sender': {'id_type': 'open_id', 'id': 'self'},
        'create_time': '${now.millisecondsSinceEpoch}',
        'msg_type': 'text',
        'body': {'content': '{"text":"确定的计划"}'},
      };
      await source.ingestPage(
        source.fence('chat'),
        [raw],
        nextPage: null,
        windowEnd: now,
      );
      await source.grantProcessing('provider', 'profile', true);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final repo = ProfileRepository(profileDisk, authority, source);
      await repo.publish(
        jsonEncode([
          {
            'key': 'e',
            'kind': 'timeline',
            'text': '确定的计划',
            'evidence_ids': [source.messages('chat').single['evidence_id']],
            'observed_at': now.toIso8601String(),
          },
        ]),
        epoch: authority.epoch,
        sourceRevision: source.revision,
        consentRevision: source.processingRevision,
        provider: 'provider',
      );
      final originals = <Map<String, dynamic>>[
        {'evidence_id': 'e1'},
      ];
      final oldExpiry = sourceAccessExpiry(source.messages('chat').single);
      final checkpoint = ProfileObservationCheckpoint(
        cacheDisk,
        scope: 'unchanged-content',
        expiresAt: oldExpiry,
        now: () => now,
        authorize: () async {},
      );
      await checkpoint.save(originals, [
        {
          'text': '【事】确定的计划',
          'refs': ['e1'],
        },
      ]);
      final savedProfile = profileDisk.value,
          savedCache = cacheDisk.value,
          revision = source.revision,
          invalidated = invalidations;
      now = now.add(const Duration(minutes: 10));
      await source.ingestPage(
        source.fence('chat'),
        [],
        nextPage: null,
        windowEnd: now,
      );
      expect(source.revision, revision);
      expect(invalidations, invalidated);
      expect(profileDisk.value, savedProfile);
      expect(cacheDisk.value, savedCache);
      expect(repo.value, isNotNull);
      now = now.add(const Duration(minutes: 10));
      await source.ingestPage(
        source.fence('chat'),
        [raw],
        nextPage: null,
        windowEnd: now,
      );
      expect(source.revision, revision);
      expect(invalidations, invalidated);
      expect(profileDisk.value, savedProfile);
      expect(cacheDisk.value, savedCache);
      expect(
        sourceAccessExpiry(source.messages('chat').single).isAfter(oldExpiry),
        true,
      );
      final refreshed = ProfileObservationCheckpoint(
        cacheDisk,
        scope: 'unchanged-content',
        expiresAt: sourceAccessExpiry(source.messages('chat').single),
        now: () => now,
        authorize: () async {},
      );
      expect(await refreshed.load(originals), hasLength(1));
      expect(cacheDisk.value, savedCache);
      await source.ingestPage(
        source.fence('chat'),
        [
          {
            ...raw,
            'body': {'content': '{"text":"计划已取消"}'},
          },
        ],
        nextPage: null,
        windowEnd: now,
      );
      expect(source.revision, greaterThan(revision));
      expect(profileDisk.value, 'null');
      expect(cacheDisk.value, 'null');
      expect(repo.value, isNull);
    },
  );
  test(
    'authorization, identity and selected range changes still invalidate processing',
    () async {
      var invalidations = 0;
      final now = DateTime.utc(2026);
      final source = SourceStore(
        MemoryLifePersistence(),
        now: () => now,
        onInvalidated: () async {
          invalidations++;
        },
      );
      await source.bind('self', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.grantProcessing('p', 'profile', true);
      final before = source.revision, count = invalidations;
      await source.grantProcessing('p', 'profile', false);
      expect(source.revision, greaterThan(before));
      expect(invalidations, count + 1);
      final revoked = source.revision;
      await source.select('chat', now, updateRange: true);
      expect(source.revision, greaterThan(revoked));
      final ranged = source.revision;
      await source.bind('other', 2);
      expect(source.revision, greaterThan(ranged));
    },
  );
}
