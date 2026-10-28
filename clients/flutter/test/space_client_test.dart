import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/space_storage.dart';

class MemorySpacePersistence implements SpacePersistence {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String value) async => this.value = value;
}

void main() {
  test(
    'interrupted chat displays unknown after restart without resending',
    () async {
      final disk = MemorySpacePersistence();
      final state = SpaceClientState(disk);
      await state.beginChat('interrupted', 'hello', 1);
      final recovered = SpaceClientState(disk);
      await recovered.open();
      expect(recovered.chatRequests['interrupted']?['status'], 'unknown');
      expect(recovered.messages.single['status'], 'unknown');
      expect(recovered.pending, isEmpty);
    },
  );

  test(
    'pending survives restart; dependency remap and conflicts retain edit',
    () async {
      final disk = MemorySpacePersistence();
      var state = SpaceClientState(disk);
      await state.open();
      final goal = await state.enqueue('life.mutate', {
        'op': 'create',
        'kind': 'goal',
        'title': 'Goal',
      }, tempId: 'tmp-goal');
      final todo = await state.enqueue(
        'life.mutate',
        {
          'op': 'create',
          'kind': 'todo',
          'title': 'Todo',
          'goal_id': 'tmp-goal',
        },
        dependsOn: [goal],
      );
      state = SpaceClientState(disk);
      await state.open();
      expect(state.pending.map((v) => v['op_id']), [goal, todo]);
      await state.apply({
        'v': 1,
        'type': 'receipt',
        'op_id': goal,
        'status': 'accepted',
        'id_map': {'tmp-goal': 'host-goal'},
      });
      expect((state.pending.single['input'] as Map)['goal_id'], 'host-goal');
      await state.apply({
        'v': 1,
        'type': 'receipt',
        'op_id': todo,
        'status': 'conflict',
        'snapshot': {
          'schema_version': 1,
          'revision': 1,
          'profile': {'about': 'Host', 'version': 3},
        },
      });
      expect(state.pending.single['status'], 'conflict');
      expect((state.pending.single['input'] as Map)['title'], 'Todo');
      expect((state.snapshot['profile'] as Map)['about'], 'Host');
    },
  );
  test(
    'chat final replaces preview and mailbox duplicate by message id',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.messages.add({
        'id': 'user_turn',
        'role': 'user',
        'turn_id': 'turn',
        'text': 'Hello',
      });
      await state.save();
      await state.apply({
        'v': 1,
        'type': 'chat.delta',
        'op_id': 'turn',
        'text': 'partial',
        'sequence': 1,
      });
      await state.apply({
        'v': 1,
        'type': 'chat.delta',
        'op_id': 'turn',
        'text': 'stale',
        'sequence': 0,
      });
      expect(state.previews['turn']?['text'], 'partial');
      final finalMessage = {
        'v': 1,
        'type': 'chat.final',
        'op_id': 'turn',
        'message_id': 'reply',
        'text': 'Final',
        'status': 'completed',
      };
      await state.apply(finalMessage);
      await state.apply(finalMessage);
      await state.apply({
        'v': 1,
        'type': 'chat.delta',
        'op_id': 'turn',
        'text': 'late',
        'sequence': 2,
      });
      expect(state.messages.where((m) => m['role'] == 'assistant').length, 1);
      expect(state.previews, isEmpty);
      expect(
        jsonDecode(
          (state.persistence as MemorySpacePersistence).value!,
        )['messages'].where((m) => m['role'] == 'assistant').length,
        1,
      );
    },
  );
  test(
    'unknown display cards retain generic text and future fields ignored',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      await state.apply({
        'v': 1,
        'type': 'snapshot',
        'snapshot': {
          'schema_version': 1,
          'revision': 1,
          'future': 'ok',
          'feed': [
            {
              'id': '1',
              'kind': 'future.card',
              'title': 'Safe title',
              'body': 'Safe body',
            },
          ],
        },
      });
      expect(state.cards('feed').single['body'], 'Safe body');
      expect(state.cards('feed').single['kind'], 'future.card');
      expect(state.snapshot.containsKey('future'), false);
    },
  );
  test('chat cannot enter durable state outbox', () async {
    final state = SpaceClientState(MemorySpacePersistence());
    await state.open();
    await expectLater(
      state.enqueue('chat.send', {'text': 'offline'}),
      throwsStateError,
    );
    expect(state.pending, isEmpty);
  });
  test(
    'chat receipt failures remain visible without entering offline outbox',
    () async {
      final disk = MemorySpacePersistence();
      final state = SpaceClientState(disk);
      await state.open();
      await state.beginChat('turn', 'Hello', 1);
      await state.markChat('turn', 'sent');
      await state.apply({
        'v': 1,
        'type': 'receipt',
        'op_id': 'turn',
        'status': 'rejected',
        'error': 'conversation_busy',
      });
      expect(state.chatRequests['turn']!['status'], 'failed');
      expect(state.messages.single['error'], 'conversation_busy');
      expect(state.pending, isEmpty);
    },
  );
  test(
    'Host snapshot replaces local user identity by turn without duplicate',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      await state.beginChat('turn', 'Hello', 1);
      await state.apply({
        'v': 1,
        'type': 'snapshot',
        'snapshot': {
          'schema_version': 1,
          'revision': 1,
          'chat': [
            {
              'id': 'host-user',
              'turn_id': 'turn',
              'role': 'user',
              'text': 'Hello',
            },
          ],
        },
      });
      expect(state.messages.length, 1);
      expect(state.messages.single['id'], 'host-user');
    },
  );
  test(
    'large snapshot chunks survive restart and replace cache only when complete',
    () async {
      final disk = MemorySpacePersistence();
      var state = SpaceClientState(disk);
      await state.open();
      final serialized = jsonEncode({
        'schema_version': 1,
        'revision': 1,
        'feed': [
          {'id': 'a', 'kind': 'future', 'title': 'Large', 'body': 'x' * 100000},
        ],
      });
      final first = serialized.substring(0, 50000),
          second = serialized.substring(50000);
      await state.apply({
        'v': 1,
        'type': 'snapshot.chunk',
        'snapshot_id': 'snap',
        'index': 0,
        'total': 2,
        'data': first,
      }, sequence: 1);
      expect(state.snapshot, isEmpty);
      state = SpaceClientState(disk);
      await state.open();
      expect(state.cursor, 1);
      await state.apply({
        'v': 1,
        'type': 'snapshot.chunk',
        'snapshot_id': 'snap',
        'index': 1,
        'total': 2,
        'data': second,
      }, sequence: 2);
      expect(state.cards('feed').single['body'], 'x' * 100000);
      expect(state.chunks, isEmpty);
      expect(state.cursor, 2);
    },
  );
  test(
    'phone source facts depend on frozen authorization and revocation cancels unsent upload',
    () async {
      final disk = MemorySpacePersistence();
      var state = SpaceClientState(disk);
      await state.open();
      final source = await state.collectSource(
        name: 'Phone note',
        text: 'User supplied fact',
        provider: 'https://model.example|model-v1',
        allowProcessing: true,
      );
      expect(state.pending.length, 2);
      final grant = state.pending.first, fact = state.pending.last;
      expect((fact['depends_on'] as List).single, grant['op_id']);
      expect((fact['input'] as Map)['source_version'], '1');
      expect(
        (grant['input'] as Map)['provider'],
        'https://model.example|model-v1',
      );
      state = SpaceClientState(disk);
      await state.open();
      await state.revokeSource(source);
      expect(state.pending.length, 1);
      expect((state.pending.single['input'] as Map)['allow_upload'], false);
      expect(state.clientSources[source]!['status'], 'revoking');
    },
  );
  test(
    'source processing projection caches only safe status and downgrades unknown values',
    () async {
      final disk = MemorySpacePersistence();
      var state = SpaceClientState(disk);
      await state.open();
      await state.apply({
        'v': 1,
        'type': 'snapshot',
        'snapshot': {
          'schema_version': 1,
          'revision': 1,
          'source_processing': {
            'status': 'future-state',
            'needs_update': true,
            'error': 'PRIVATE ERROR',
            'draft': {'about': 'PRIVATE INFERENCE'},
          },
        },
      });
      expect(state.snapshot['source_processing'], {
        'status': 'idle',
        'needs_update': true,
      });
      state = SpaceClientState(disk);
      await state.open();
      expect(state.snapshot['source_processing'], {
        'status': 'idle',
        'needs_update': true,
      });
      expect(state.hostOnline, false);
    },
  );
}
