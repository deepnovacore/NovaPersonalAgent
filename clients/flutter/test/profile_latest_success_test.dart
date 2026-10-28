import 'dart:convert';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/context/secure_persistence.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'local_profile_results_test.dart' show ReadyHost;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/local_publication.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  for (final change in [
    'add',
    'rewrite',
    'delete',
    'expire',
    'remove',
    'revoke',
    'account',
  ]) {
    test(
      'last success survives $change with safe history and input boundaries',
      () async {
        var now = DateTime.utc(2026, 10, 19);
        final source = SourceStore(MemoryLifePersistence(), now: () => now);
        await source.bind('fixture:self', 1);
        await source.select('chat', DateTime.utc(1970));
        Map<String, dynamic> message(
          String id,
          String text, {
          bool deleted = false,
        }) => {
          'message_id': id,
          'sender': {'id_type': 'open_id', 'id': 'self'},
          'create_time': '${DateTime.utc(2026, 10, 19).millisecondsSinceEpoch}',
          'msg_type': 'text',
          'body': {
            'content': jsonEncode({'text': text}),
          },
          if (deleted) 'deleted': true,
        };
        Future<void> ingest(List<dynamic> rows) => source.ingestPage(
          source.fence('chat'),
          rows,
          nextPage: null,
          windowEnd: now,
        );
        await ingest([message('first', 'original')]);
        await source.grantProcessing('p', 'profile', true);
        final auth = LocalPublicationContext(MemoryLifePersistence());
        await auth.open();
        final disk = MemoryLifePersistence(),
            profile = ProfileRepository(MemoryLifePersistence(), auth, source);
        final actual = ProfileRepository(disk, auth, source);
        final ref = source.messages('chat').single['evidence_id'];
        final entries = [
          {
            'key': 'event',
            'kind': 'timeline',
            'text': 'last success',
            'evidence_ids': [ref],
            'observed_at': now.toIso8601String(),
          },
        ];
        await actual.publish(
          jsonEncode(entries),

          sourceRevision: source.revision,
          consentRevision: source.processingRevision,
          provider: 'p',
        );
        final saved = disk.value, generated = actual.value!['generated_at'];
        expect(generated, now.toIso8601String());
        now = now.add(const Duration(days: 1));
        switch (change) {
          case 'add':
            await ingest([message('second', 'new information')]);
          case 'rewrite':
            await ingest([message('first', 'changed source')]);
          case 'delete':
            await ingest([message('first', '', deleted: true)]);
          case 'expire':
            now = now.add(const Duration(days: 31));
          case 'remove':
            await source.remove('chat');
          case 'revoke':
            await source.grantProcessing('p', 'profile', false);
          case 'account':
            await source.bind('other:self', 2);
        }
        final reopened = ProfileRepository(disk, auth, source);
        await reopened.open();
        if (change == 'account') {
          expect(reopened.value, isNull);
        } else {
          expect(reopened.value!['entries'], entries);
          expect(reopened.value!['generated_at'], generated);
          expect(
            reopened.value!['available_evidence_ids'],
            change == 'add' ? [ref] : isEmpty,
          );
          expect(reopened.value!['historical'], true);
        }
        expect(disk.value, saved);
        // A failed replacement never erases the committed success.
        await expectLater(
          actual.publish(
            '[{}]',

            sourceRevision: source.revision,
            consentRevision: source.processingRevision,
            provider: 'p',
          ),
          throwsStateError,
        );
        expect(disk.value, saved);
        expect(profile.value, isNull);
      },
    );
  }
  test(
    'a pending open serializes with publication and cannot replace rollback',
    () async {
      final f = await _Fixture.create(), before = f.disk.value;
      final gate = Completer<void>();
      f.disk.readGate = gate;
      final reading = f.profile.open();
      await Future<void>.delayed(Duration.zero);
      final writes = f.disk.writes;
      f.disk.afterWrite = () => f.addMessage('race');
      final publishing = f.publish('unsuccessful attempt');
      final checked = expectLater(publishing, throwsStateError);
      await Future<void>.delayed(Duration.zero);
      expect(f.disk.writes, writes);
      gate.complete();
      await reading;
      await checked;
      expect(f.disk.value, before);
      expect(f.profile.value!['entries'][0]['text'], 'last success');
    },
  );
  test(
    'safe legacy migration retains history without inventing generation time',
    () async {
      final f = await _Fixture.create();
      final legacy = jsonDecode(f.disk.value!) as Map<String, dynamic>;
      for (final field in [
        'history_schema',
        'source_identity',
        'source_generation',
        'processing_provider',
        'evidence_fingerprints',
        'generated_at',
      ]) {
        legacy.remove(field);
      }
      f.disk.value = jsonEncode(legacy);
      final migrated = ProfileRepository(f.disk, f.publication, f.sources);
      await migrated.open();
      expect(migrated.value!['generated_at'], isNull);
      await f.sources.remove('chat');
      expect(migrated.value!['entries'], isNotEmpty);
      expect(migrated.value!['available_evidence_ids'], isEmpty);
      final unsafe = MemoryLifePersistence()..value = jsonEncode(legacy);
      final stale = ProfileRepository(unsafe, f.publication, f.sources);
      await stale.open();
      expect(stale.value, isNull);
      expect(jsonDecode(unsafe.value!).containsKey('history_schema'), false);
    },
  );
  test(
    'post-write race restores last success; a later success replaces it',
    () async {
      final f = await _Fixture.create(), before = f.disk.value;
      f.disk.afterWrite = () => f.addMessage('second');
      await expectLater(f.publish('attempt'), throwsStateError);
      expect(f.disk.value, before);
      expect(f.profile.value!['entries'][0]['text'], 'last success');
      f.now = f.now.add(const Duration(days: 1));
      await f.publish('new success');
      expect(f.profile.value!['entries'][0]['text'], 'new success');
      expect(f.profile.value!['generated_at'], f.now.toIso8601String());
      await f.profile.clear();
      expect(f.profile.value, isNull);
      expect(f.disk.value, 'null');
    },
  );
  test(
    'historical todo never becomes a current task after new evidence',
    () async {
      final f = await _Fixture.create();
      await f.publish('possible task', kind: 'todo_candidate');
      await f.addMessage('completed-later');
      var mutations = 0;
      await expectLater(
        f.profile.adoptTodo(
          'event',
          expectedText: 'possible task',
          mutate: (m, id) async {
            mutations++;
            return {};
          },
        ),
        throwsStateError,
      );
      expect(mutations, 0);
      expect(f.profile.value!['entries'][0]['text'], 'possible task');
    },
  );
  test(
    'source invalidation retains successful storage while explicit clear removes it',
    () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      FlutterSecureStorage.setMockInitialValues({
        'nova.profile.local.v1': '{"success":"synthetic"}',
      });
      await FeishuHost.invalidateDerivedProfile();
      expect(
        await SecureContextPersistence('nova.profile.local.v1').read(),
        '{"success":"synthetic"}',
      );
      await FeishuHost.invalidateDerivedProfile(clearPublished: true);
      expect(
        await SecureContextPersistence('nova.profile.local.v1').read(),
        'null',
      );
    },
  );
  testWidgets(
    'last success remains visible through reload failure with original timestamp',
    (tester) async {
      final f = await _Fixture.create();
      final host = ReadyHost(f.sources);
      f.disk.failRead = true;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: LocalProfileResults(
                host: host,
                publication: f.publication,
                repository: f.profile,
                kind: 'timeline',
              ),
            ),
          ),
        ),
      );
      expect(find.text('last success'), findsOneWidget);
      await tester.pumpAndSettle();
      expect(find.text('last success'), findsOneWidget);
      expect(find.text('更新暂时不可用，保留上次结果。'), findsOneWidget);
      expect(find.textContaining('最近成功整理'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      f.publication.dispose();
    },
  );
}

class _HookDisk extends MemoryLifePersistence {
  Future<void> Function()? afterWrite;
  bool failRead = false;
  Completer<void>? readGate;
  int writes = 0;
  @override
  Future<String?> read() async {
    if (failRead) throw StateError('read failed');
    final value = await super.read();
    await readGate?.future;
    return value;
  }

  @override
  Future<void> write(String next) async {
    writes++;
    await super.write(next);
    final callback = afterWrite;
    afterWrite = null;
    await callback?.call();
  }
}

class _Fixture {
  DateTime now = DateTime.utc(2026, 10, 19);
  final disk = _HookDisk();
  late final sources = SourceStore(MemoryLifePersistence(), now: () => now);
  final publication = LocalPublicationContext(MemoryLifePersistence());
  late final profile = ProfileRepository(disk, publication, sources);
  late String ref;
  static Future<_Fixture> create() async {
    final f = _Fixture();
    await f.sources.bind('fixture:self', 1);
    await f.sources.select('chat', DateTime.utc(1970));
    await f.addMessage('first');
    await f.sources.grantProcessing('p', 'profile', true);
    await f.publication.open();
    f.ref = f.sources.messages('chat').single['evidence_id'];
    await f.publish('last success');
    return f;
  }

  Future<void> addMessage(String id) => sources.ingestPage(
    sources.fence('chat'),
    [
      {
        'message_id': id,
        'sender': {'id_type': 'open_id', 'id': 'self'},
        'create_time': '${DateTime.utc(2026, 10, 19).millisecondsSinceEpoch}',
        'msg_type': 'text',
        'body': {'content': '{"text":"synthetic original"}'},
      },
    ],
    nextPage: null,
    windowEnd: now,
  );
  Future<Map<String, dynamic>> publish(
    String text, {
    String kind = 'timeline',
  }) => profile.publish(
    jsonEncode([
      {
        'key': 'event',
        'kind': kind,
        'text': text,
        'evidence_ids': [ref],
        'observed_at': DateTime.utc(2026, 10, 19).toIso8601String(),
      },
    ]),

    sourceRevision: sources.revision,
    consentRevision: sources.processingRevision,
    provider: 'p',
  );
}
