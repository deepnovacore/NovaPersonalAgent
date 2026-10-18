import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'local_profile_results_test.dart' show ReadyHost;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_writer.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test('todo candidates require original self evidence and grounded dates', () {
    final original = {
      'evidence_id': 'e1',
      'relation': 'self',
      'created_at': '2026-10-18T00:00:00.000Z',
    };
    final result = {
      'todos': [
        {
          'text': 'Review the proposal',
          'evidence_ids': ['e1'],
          'time_ref': 'e1',
        },
      ],
    };
    final entries = jsonDecode(ProfileWriter.encodeEntries(result, [original]));
    expect(entries.single['kind'], 'todo_candidate');
    expect(entries.single['observed_at'], original['created_at']);
    expect(
      () => ProfileWriter.encodeEntries(result, [
        {...original, 'relation': 'participant'},
      ]),
      throwsStateError,
    );
    expect(
      () => ProfileWriter.encodeEntries(
        {
          'todos': [
            {
              'text': 'Invented',
              'evidence_ids': ['e2'],
              'time_ref': 'e2',
            },
          ],
        },
        [original],
      ),
      throwsStateError,
    );
  });

  test(
    'publishing does not create todos; explicit adoption dedupes and revocation blocks it',
    () async {
      final now = DateTime.utc(2026, 10, 18);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:person', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [
          {
            'message_id': 'm',
            'create_time': '${now.millisecondsSinceEpoch}',
            'msg_type': 'text',
            'sender': {'id_type': 'open_id', 'id': 'person'},
            'body': {'content': '{"text":"I will review the proposal"}'},
          },
        ],
        nextPage: null,
        windowEnd: now,
      );
      await source.grantProcessing('provider', 'profile', true);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final repo = ProfileRepository(
        MemoryLifePersistence(),
        authority,
        source,
      );
      await repo.publish(
        jsonEncode([
          {
            'key': 'todo_1',
            'kind': 'todo_candidate',
            'text': 'Review the proposal',
            'evidence_ids': [source.messages('chat').single['evidence_id']],
            'observed_at': now.toIso8601String(),
          },
        ]),
        epoch: authority.epoch,
        sourceRevision: source.revision,
        consentRevision: source.processingRevision,
        provider: 'provider',
      );
      final life = LocalLife(MemoryLifePersistence());
      await life.open();
      expect(life.life['todos'], isEmpty);
      Future<Map<String, dynamic>> adopt(
        Map<String, dynamic> input,
        String operation,
      ) => life.mutate(input, operationId: operation);
      await repo.adoptTodo(
        'todo_1',
        expectedText: 'Review the proposal',
        mutate: adopt,
      );
      await repo.adoptTodo(
        'todo_1',
        expectedText: 'Review the proposal',
        mutate: adopt,
      );
      expect(life.life['todos'], hasLength(1));
      await source.grantProcessing('provider', 'profile', false);
      await expectLater(
        repo.adoptTodo(
          'todo_1',
          expectedText: 'Review the proposal',
          mutate: adopt,
        ),
        throwsStateError,
      );
      expect(life.life['todos'], hasLength(1));
    },
  );

  testWidgets(
    'candidate stays a suggestion until confirmation; cancellation never mutates Life',
    (tester) async {
      final now = DateTime.utc(2026, 10, 18);
      final source = SourceStore(MemoryLifePersistence(), now: () => now);
      await source.bind('fixture:person', 1);
      await source.select('chat', DateTime.utc(1970));
      await source.ingestPage(
        source.fence('chat'),
        [
          {
            'message_id': 'm',
            'create_time': '${now.millisecondsSinceEpoch}',
            'msg_type': 'text',
            'sender': {'id_type': 'open_id', 'id': 'person'},
            'body': {'content': '{"text":"I will review the proposal"}'},
          },
        ],
        nextPage: null,
        windowEnd: now,
      );
      await source.grantProcessing('provider', 'profile', true);
      final authority = SpaceAuthorityRepository(MemoryLifePersistence());
      await authority.open();
      final repo = ProfileRepository(
        MemoryLifePersistence(),
        authority,
        source,
      );
      await repo.publish(
        jsonEncode([
          {
            'key': 'todo_1',
            'kind': 'todo_candidate',
            'text': 'Review the proposal',
            'evidence_ids': [source.messages('chat').single['evidence_id']],
            'observed_at': now.toIso8601String(),
          },
        ]),
        epoch: authority.epoch,
        sourceRevision: source.revision,
        consentRevision: source.processingRevision,
        provider: 'provider',
      );
      final host = ReadyHost(source);
      final life = LocalLife(MemoryLifePersistence());
      await life.open();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalProfileResults(
              host: host,
              authority: authority,
              repository: repo,
              kind: 'all',
              adoptTodo: (input, operation) =>
                  life.mutate(input, operationId: operation),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(life.life['todos'], isEmpty);
      await tester.tap(find.text('加入待办'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(life.life['todos'], isEmpty);
      await tester.tap(find.text('加入待办'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '加入'));
      await tester.pumpAndSettle();
      expect(life.life['todos'], hasLength(1));
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      authority.dispose();
    },
  );
}
