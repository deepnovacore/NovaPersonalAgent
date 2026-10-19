import 'dart:convert';
import 'package:nova_mobile/context/profile_corrections.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'model can correct pre-write validation only, never storage or consent failures',
    () {
      expect(
        profileRepairReason(StateError('timeline_time_not_grounded')),
        'timeline_time_not_grounded',
      );
      expect(
        profileRepairReason(const FormatException('sensitive body')),
        'invalid_projection',
      );
      for (final code in [
        'stale_inputs',
        'processing_not_allowed',
        'source_expired',
        'storage_failed',
        'secret',
      ]) {
        expect(profileRepairReason(StateError(code)), isNull);
      }
    },
  );
  test(
    'explicit corrections survive regeneration and restart, scoped by account and model',
    () async {
      final disk = MemoryLifePersistence(),
          corrections = ProfileCorrections(persistence: disk);
      await corrections.correct(
        's|account',
        'about',
        'I design software',
        'provider',
      );
      final restored = ProfileCorrections(persistence: disk);
      await restored.open();
      expect(
        restored.context('s|account', 'provider'),
        contains('I design software'),
      );
      expect(restored.context('s|other', 'provider'), '');
      expect(restored.context('s|account', 'other-provider'), '');
      final merged = restored.merged('s|account', 'provider', {
        'work': 'Shared work',
      }, {});
      expect(merged, {'about': 'I design software', 'work': 'Shared work'});
      expect(
        restored.merged(
          's|account',
          'provider',
          {'about': 'New shared statement'},
          {'about': '2999-01-01T00:00:00Z'},
        )['about'],
        'New shared statement',
      );
      expect(
        restored.merged(
          's|account',
          'provider',
          {'about': 'Old shared statement'},
          {'about': '2000-01-01T00:00:00Z'},
        )['about'],
        'I design software',
      );
    },
  );
  test(
    'reopening unchanged source data preserves its published profile',
    () async {
      final disk = MemoryLifePersistence(), now = DateTime.utc(2026, 10, 17);
      final sources = SourceStore(disk, now: () => now);
      await sources.open();
      await sources.bind('self', 1);
      await sources.select('c', now);
      await sources.ingestPage(
        sources.fence('c'),
        [
          {
            'message_id': 'm',
            'sender': {'id_type': 'open_id', 'id': 'self'},
            'create_time': '1792195200000',
            'msg_type': 'text',
            'body': {'content': '{"text":"concise please"}'},
          },
        ],
        nextPage: null,
        windowEnd: now,
      );
      await sources.grantProcessing('p', 'profile', true);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final correctionDisk = MemoryLifePersistence(),
          corrections = ProfileCorrections(persistence: correctionDisk);
      final projectionDisk = MemoryLifePersistence(),
          profile = ProfileRepository(
            projectionDisk,
            authority,
            sources,
            corrections: corrections,
          );
      await profile.open();
      await profile.publish(
        jsonEncode([
          {
            'key': 'about',
            'text': 'Concise replies',
            'evidence_ids': [sources.messages('c').single['evidence_id']],
          },
        ]),
        epoch: 1,
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: 'p',
        incompleteBatches: 2,
      );
      await corrections.correct(
        profile.correctionScope,
        'about',
        'I prefer detailed replies',
        'p',
      );
      expect(
        profile.value!['entries'].single['text'],
        'I prefer detailed replies',
      );
      final reopened = SourceStore(disk, now: () => now);
      await reopened.open();
      final restored = ProfileRepository(
        projectionDisk,
        authority,
        reopened,
        corrections: ProfileCorrections(persistence: correctionDisk),
      );
      await restored.open();
      expect(restored.value, isNotNull);
      expect(restored.value!['incomplete_batches'], 2);
      expect(
        restored.value!['entries'].single['text'],
        'I prefer detailed replies',
      );
    },
  );
  test(
    'timeline dates cite observed messages; other speakers cannot become personal traits',
    () async {
      final sources = SourceStore(
        MemoryLifePersistence(),
        now: () => DateTime.utc(2026, 10, 17),
      );
      await sources.open();
      await sources.bind('self', 1);
      await sources.select('chat', DateTime.utc(2026, 10, 1));
      await sources.ingestPage(
        sources.fence('chat'),
        [
          {
            'message_id': 'm',
            'sender': {'id_type': 'open_id', 'id': 'other'},
            'create_time': '1792195200000',
            'msg_type': 'text',
            'body': {'content': '{"text":"I finished my presentation"}'},
          },
        ],
        nextPage: null,
        windowEnd: DateTime.utc(2026, 10, 17),
      );
      await sources.grantProcessing('p', 'profile', true);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final repo = ProfileRepository(
        MemoryLifePersistence(),
        authority,
        sources,
      );
      await repo.open();
      final evidence = sources.messages('chat').single['evidence_id'];
      Future<dynamic> publish(Map<String, dynamic> entry) => repo.publish(
        jsonEncode([entry]),
        epoch: 1,
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: 'p',
      );
      await expectLater(
        publish({
          'key': 'about',
          'text': 'User writes presentations',
          'evidence_ids': [evidence],
        }),
        throwsStateError,
      );
      await expectLater(
        publish({
          'key': 'event',
          'kind': 'timeline',
          'observed_at': '2026-10-16T00:00:00Z',
          'text': 'Another participant reported completion',
          'evidence_ids': [evidence],
        }),
        throwsStateError,
      );
      await publish({
        'key': 'event',
        'kind': 'timeline',
        'observed_at': '2026-10-17T00:00:00Z',
        'text': 'Another participant reported completion',
        'evidence_ids': [evidence],
      });
      expect(repo.value!['entries'].single['kind'], 'timeline');
    },
  );
  test(
    'a grounded local projection cannot publish after consent withdrawal or PC binding',
    () async {
      final sources = SourceStore(
        MemoryLifePersistence(),
        now: () => DateTime.utc(2026, 10, 17),
      );
      await sources.open();
      await sources.bind('identity', 1);
      await sources.select('chat', DateTime.utc(2026, 10, 1));
      await sources.ingestPage(
        sources.fence('chat'),
        [
          {
            'message_id': 'm',
            'sender': {'id_type': 'open_id', 'id': 'identity'},
            'create_time': '1792195200000',
            'msg_type': 'text',
            'body': {'content': '{"text":"I prefer concise responses"}'},
          },
        ],
        nextPage: null,
        windowEnd: DateTime.utc(2026, 10, 17),
      );
      await sources.grantProcessing('provider', 'profile', true);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final profile = ProfileRepository(
        MemoryLifePersistence(),
        authority,
        sources,
      );
      await profile.open();
      final entries = jsonEncode([
        {
          'key': 'about',
          'text': 'Concise',
          'evidence_ids': [sources.messages('chat').single['evidence_id']],
        },
      ]);
      Future<dynamic> publish() => profile.publish(
        entries,
        epoch: 1,
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: 'provider',
      );
      await publish();
      expect(profile.value?['revision'], 1);
      await authority.freezePublication();
      await expectLater(publish(), throwsStateError);
      await authority.bind(
        hubId: 'hub',
        deviceId: 'phone',
        record: {
          'protocol_version': 1,
          'space_id': 'space',
          'authority_epoch': 2,
          'membership_revision': 2,
          'primary_device_id': 'pc',
          'mode': 'pc_primary',
          'pending': null,
        },
      );
      await expectLater(publish(), throwsStateError);
      expect(profile.value, null);
      await sources.grantProcessing('provider', 'profile', false);
      expect(profile.value, null);
    },
  );
  test(
    'expired originals keep saved history but are unavailable as evidence',
    () async {
      var now = DateTime.utc(2026, 10, 17);
      final sources = SourceStore(MemoryLifePersistence(), now: () => now);
      await sources.open();
      await sources.bind('i', 1);
      await sources.select('c', now);
      await sources.ingestPage(
        sources.fence('c'),
        [
          {
            'message_id': 'm',
            'sender': {'id_type': 'open_id', 'id': 'i'},
            'create_time': '1792195200000',
            'msg_type': 'text',
            'body': {'content': '{"text":"hello"}'},
          },
        ],
        nextPage: null,
        windowEnd: now,
      );
      await sources.grantProcessing('p', 'profile', true);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final profile = ProfileRepository(
        MemoryLifePersistence(),
        authority,
        sources,
      );
      await profile.open();
      await profile.publish(
        jsonEncode([
          {
            'key': 'about',
            'text': 't',
            'evidence_ids': [sources.messages('c').single['evidence_id']],
          },
        ]),
        epoch: 1,
        sourceRevision: sources.revision,
        consentRevision: sources.processingRevision,
        provider: 'p',
      );
      now = now.add(const Duration(days: 31));
      expect(profile.value!['entries'], isNotEmpty);
      expect(profile.value!['available_evidence_ids'], isEmpty);
      expect(profile.value!['historical'], true);
    },
  );
}
