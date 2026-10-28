import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'local_profile_results_test.dart' show ReadyHost;

class _CountingSources extends SourceStore {
  _CountingSources(super.persistence, {super.now});
  int chatScans = 0;
  final lookups = <List<Object?>>[];
  @override
  List<Map<String, dynamic>> messagesByEvidenceIds(Iterable<Object?> ids) {
    final requested = ids.toList();
    lookups.add(requested);
    return super.messagesByEvidenceIds(requested);
  }

  @override
  List<Map<String, dynamic>> messages(String id) {
    chatScans++;
    return super.messages(id);
  }
}

class _Fixture {
  var now = DateTime.utc(2026, 10, 20);
  final disk = MemoryLifePersistence();
  late final sources = _CountingSources(disk, now: () => now);
  final publication = LocalPublicationContext(MemoryLifePersistence());
  final profileDisk = MemoryLifePersistence();
  late final profile = ProfileRepository(profileDisk, publication, sources);
  late String ref;

  Future<void> open() async {
    await publication.open();
    await sources.bind('fixture:self', 1);
    for (final chat in ['selected', 'unrelated']) {
      await sources.select(chat, DateTime.utc(1970));
      await sources.ingestPage(
        sources.fence(chat),
        [
          for (var i = 0; i < 20; i++)
            {
              'message_id': '$chat-$i',
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time': '${now.millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {
                'content': jsonEncode({'text': '$chat original $i'}),
              },
            },
        ],
        nextPage: null,
        windowEnd: now,
      );
    }
    ref = sources.messages('selected').first['evidence_id'] as String;
    await sources.grantProcessing('p', 'profile', true);
    await profile.publish(
      jsonEncode([
        {
          'key': 'event',
          'kind': 'timeline',
          'text': 'Grounded event',
          'observed_at': now.toIso8601String(),
          'evidence_ids': [ref],
        },
      ]),

      sourceRevision: sources.revision,
      consentRevision: sources.processingRevision,
      provider: 'p',
    );
    sources.chatScans = 0;
  }

  void dispose() {
    sources.dispose();
    publication.dispose();
  }
}

void main() {
  for (final withdrawn in [false, true]) {
    test(
      'profile value avoids whole-chat scans, withdrawn=$withdrawn',
      () async {
        final f = _Fixture();
        await f.open();
        addTearDown(f.dispose);
        if (withdrawn) await f.sources.grantProcessing('p', 'profile', false);
        final value = f.profile.value!;
        expect(value['available_evidence_ids'], withdrawn ? isEmpty : [f.ref]);
        expect(f.sources.chatScans, 0);
        expect(
          f.sources.lookups,
          withdrawn
              ? isEmpty
              : [
                  [f.ref],
                ],
        );
        value['entries'][0]['text'] = 'mutated caller copy';
        expect(f.profile.value!['entries'][0]['text'], 'Grounded event');
      },
    );
  }

  test(
    'narrow lookup matches old selection and returns defensive copies',
    () async {
      final f = _Fixture();
      await f.open();
      addTearDown(f.dispose);
      final refs = [f.ref, 'missing', f.ref, null, 42];
      final expected = f.sources.sources
          .expand(f.sources.messages)
          .where((m) => refs.contains(m['evidence_id']))
          .toList();
      final actual = f.sources.messagesByEvidenceIds(refs);
      expect(actual, expected);
      actual.single['text'] = 'caller edit';
      actual.clear();
      expect(f.sources.messagesByEvidenceIds([f.ref]), expected);
      await f.sources.remove('selected');
      expect(f.sources.messagesByEvidenceIds([f.ref]), isEmpty);
    },
  );

  test(
    'lookup respects live access deadline, membership and map identity',
    () async {
      var now = DateTime.utc(2026, 10, 20);
      final accessed = now.millisecondsSinceEpoch;
      final disk = MemoryLifePersistence()
        ..value = jsonEncode({
          'version': 1,
          'history_policy': 'fetch-v1',
          'identity': 'fixture:self',
          'generation': 1,
          'revision': 0,
          'processing_revision': 0,
          'sources': {'selected': {}},
          'tombstones': {},
          'grants': {},
          'messages': {
            for (final id in [
              'fetched',
              'legacy',
              'orphan',
              'wrong-key',
              'deleted',
            ])
              id: {
                'evidence_id': id == 'wrong-key' ? 'different-id' : id,
                'chat_id': id == 'orphan' ? 'removed' : 'selected',
                'created_at': id == 'fetched' ? 0 : accessed,
                if (id == 'fetched') 'fetched_at': accessed,
                'status': id == 'deleted' ? 'deleted' : 'available',
                'metadata': {
                  'nested': ['original'],
                },
              },
          },
        });
      var clockReads = 0;
      final sources = SourceStore(
        disk,
        now: () {
          clockReads++;
          return now;
        },
      );
      await sources.open();
      addTearDown(sources.dispose);
      clockReads = 0;
      final refs = ['fetched', 'legacy', 'orphan', 'wrong-key', 'deleted'];
      final found = sources.messagesByEvidenceIds(refs);
      expect(clockReads, 1);
      expect(found.map((m) => m['evidence_id']), [
        'fetched',
        'legacy',
        'deleted',
      ]);
      found.first['metadata']['nested'][0] = 'caller edit';
      expect(
        sources.messagesByEvidenceIds(['fetched']).single['metadata']['nested'],
        ['original'],
      );
      now = now
          .add(const Duration(days: 30))
          .subtract(const Duration(milliseconds: 1));
      expect(sources.messagesByEvidenceIds(refs), hasLength(3));
      now = now.add(const Duration(milliseconds: 1));
      expect(sources.messagesByEvidenceIds(refs), isEmpty);
    },
  );

  test(
    'changed referenced content loses original availability immediately',
    () async {
      final f = _Fixture();
      await f.open();
      addTearDown(f.dispose);
      await f.sources.ingestPage(
        f.sources.fence('selected'),
        [
          {
            'message_id': 'selected-0',
            'sender': {'id_type': 'open_id', 'id': 'self'},
            'create_time': '${f.now.millisecondsSinceEpoch}',
            'msg_type': 'text',
            'body': {
              'content': jsonEncode({'text': 'Changed evidence'}),
            },
          },
        ],
        nextPage: null,
        windowEnd: f.now,
      );
      expect(f.profile.value!['available_evidence_ids'], isEmpty);
      expect(f.profile.value!['entries'][0]['text'], 'Grounded event');
      expect(f.sources.chatScans, 0);
    },
  );

  testWidgets('profile expiry and source dialog avoid whole-chat scans', (
    tester,
  ) async {
    final f = _Fixture();
    await f.open();
    final host = ReadyHost(f.sources);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalProfileResults(
            host: host,
            publication: f.publication,
            repository: f.profile,
            kind: 'timeline',
            language: 'en',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Grounded event'), findsOneWidget);
    expect(f.sources.chatScans, 0);
    await tester.tap(find.text('Grounded event'));
    await tester.pumpAndSettle();
    expect(find.text('selected original 0'), findsOneWidget);
    expect(find.textContaining('unrelated original'), findsNothing);
    expect(f.sources.chatScans, 0);
    await tester.pumpWidget(const SizedBox.shrink());
    host.dispose();
    f.publication.dispose();
  });
}
