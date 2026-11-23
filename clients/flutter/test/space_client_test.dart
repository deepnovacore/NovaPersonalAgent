import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_controller.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'support/space_host_fixture.dart';
import 'space_mobile_tools_test.dart' show FakeTools;

class MemorySpacePersistence implements SpacePersistence {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String value) async => this.value = value;
}

/// Relay mailbox fake: pages of two, ACK only records the cursor.
class MailboxTransport extends SpaceRelayTransport {
  MailboxTransport(super.crypto, this.mailbox, {required this.relayEpoch});
  final List<Map<String, dynamic>> mailbox;
  final int relayEpoch;
  final acks = <int>[];
  final sent = <Map<String, dynamic>>[];
  final cursors = <int>[];
  int get pulls => cursors.length;
  List<int> pullsAfter(int index) => cursors.sublist(index);
  @override
  Future<void> login() async => crypto.sessionEpoch = relayEpoch;
  @override
  Future<void> send(Map<String, dynamic> envelope) async => sent.add(envelope);
  @override
  Future<bool> hostOnline() async => true;
  @override
  Future<Map<String, dynamic>> pull(int cursor) async {
    cursors.add(cursor);
    final rest = [
      for (final (i, envelope) in mailbox.indexed)
        if (i + 1 > cursor) {'seq': i + 1, 'envelope': envelope},
    ];
    final page = rest.take(2).toList();
    return {
      'messages': page,
      'nextCursor': page.isEmpty ? cursor : page.last['seq'],
      'hasMore': rest.length > page.length,
    };
  }

  @override
  Future<void> ack(int cursor) async => acks.add(cursor);
}

void main() {
  test(
    'rejected dependencies become actionable transitively and survive recovery',
    () async {
      final disk = MemorySpacePersistence();
      var state = SpaceClientState(disk);
      final key = await state.enqueue('secret.put', {
        'name': 'OPENAI_API_KEY',
        'value': 'private',
      });
      final route = await state.enqueue(
        'settings.patch',
        {'method': 'models.configure'},
        dependsOn: [key],
      );
      await state.enqueue(
        'life.mutate',
        {'title': 'dependent'},
        dependsOn: [route],
      );
      await state.apply({
        'v': 1,
        'type': 'receipt',
        'op_id': key,
        'status': 'rejected',
      });
      expect(state.pending.every((p) => p['status'] == 'rejected'), true);
      expect(
        state.pending.skip(1).every((p) => p['error'] == 'dependency_rejected'),
        true,
      );
      expect(jsonEncode(state.pending), isNot(contains('private')));
      state = SpaceClientState(disk);
      await state.open();
      expect(state.pending.every((p) => p['status'] == 'rejected'), true);
      // Recover queues written by older clients which did not propagate failure.
      state.pending[1]['status'] = 'pending';
      state.pending[2]['status'] = 'pending';
      await state.save();
      state = SpaceClientState(disk);
      await state.open();
      expect(state.pending.every((p) => p['status'] == 'rejected'), true);
    },
  );

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
  test('a refused Host key is dropped from the phone queue', () async {
    final disk = MemorySpacePersistence();
    var state = SpaceClientState(disk);
    await state.open();
    final op = await state.enqueue('secret.put', {
      'name': 'OPENAI_API_KEY',
      'value': 'sk-refused',
    });
    await state.apply({
      'v': 1,
      'type': 'receipt',
      'op_id': op,
      'status': 'rejected',
      'error': 'owner_required',
    });
    state = SpaceClientState(disk);
    await state.open();
    expect(state.pending.single['status'], 'rejected');
    expect(state.pending.single['input'], {'name': 'OPENAI_API_KEY'});
    expect(state.pending.single.containsKey('envelope'), false);
  });
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
    'failed final retains sanitized reason across persistence and snapshot',
    () async {
      final persistence = MemorySpacePersistence();
      final state = SpaceClientState(persistence);
      await state.open();
      await state.apply({
        'v': 1,
        'type': 'chat.final',
        'op_id': 'turn',
        'message_id': 'failure',
        'conversation_id': 'chat:main',
        'status': 'failed',
        'text': '',
        'error': 'authentication',
      });
      final restored = SpaceClientState(persistence);
      await restored.open();
      expect(restored.messages.single['error'], 'authentication');
      await restored.apply({
        'v': 1,
        'type': 'snapshot',
        'snapshot': {
          'schema_version': 1,
          'chat': [
            {
              'id': 'user_turn',
              'role': 'user',
              'status': 'failed',
              'failure_reason': 'network',
              'text': 'hi',
            },
          ],
        },
      });
      expect(restored.messages.last['failure_reason'], 'network');
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

  group('mailbox key recovery', () {
    late TestHost host;
    late SpaceIdentity identity;
    final key1 = List.filled(32, 1),
        key2 = List.filled(32, 2),
        key3 = List.filled(32, 3);
    setUp(() async {
      TestWidgetsFlutterBinding.ensureInitialized();
      host = await TestHost.create();
      identity = await SpaceIdentity.generate();
    });
    Map<String, dynamic> snapshot(int n) => {
      'v': 1,
      'type': 'snapshot',
      'snapshot': {
        'schema_version': 1,
        'revision': n,
        'profile': {'about': 'n$n', 'version': n},
      },
    };
    Future<Map<String, dynamic>> content(int n, int epoch, List<int> key) =>
        host.content('phone', snapshot(n), epoch: epoch, key: key, id: 'c$n');
    Future<Map<String, dynamic>> delivery(int epoch, List<int> key) =>
        host.keyDelivery('phone', identity, epoch: epoch, key: key);
    Future<
      ({
        SpaceCrypto crypto,
        MailboxTransport transport,
        SpaceClientState state,
        SpaceClientController controller,
      })
    >
    harness(
      List<Map<String, dynamic>> mailbox, {
      required int relayEpoch,
      bool paired = true,
      bool replay = false,
      MemorySpacePersistence? stateDisk,
      void Function(String? state)? onKeyWrite,
      void Function(String written)? onKeyWritten,
    }) async {
      final keyStateDisk = stateDisk ?? MemorySpacePersistence();
      final crypto = SpaceCrypto(
        host.clientRecord('phone'),
        identity,
        _WatchedPersistence((written) {
          onKeyWrite?.call(keyStateDisk.value);
          onKeyWritten?.call(written);
        }),
      );
      if (paired) await crypto.openEnvelope(await delivery(1, key1));
      final transport = replay
          ? _ReplayTransport(crypto, mailbox, relayEpoch: relayEpoch)
          : MailboxTransport(crypto, mailbox, relayEpoch: relayEpoch);
      final state = SpaceClientState(keyStateDisk);
      await state.open();
      final controller = SpaceClientController(
        state,
        transport,
        tools: FakeTools(),
        bindingCleanup: true,
      );
      addTearDown(controller.dispose);
      return (
        crypto: crypto,
        transport: transport,
        state: state,
        controller: controller,
      );
    }

    String about(SpaceClientState state) =>
        (state.snapshot['profile'] as Map)['about'] as String;

    test('converges when new-epoch content precedes its key', () async {
      final h = await harness([
        await content(1, 1, key1),
        await content(2, 2, key2),
        // A stream envelope replayed into the mailbox is skipped.
        await host.content(
          'phone',
          snapshot(9),
          epoch: 2,
          key: key2,
          id: 'replayed-stream',
          chan: 'stream',
        ),
        await content(3, 2, key2),
        await delivery(2, key2),
      ], relayEpoch: 2);
      // Before delivery the stale local key cannot seal for the new session.
      await h.transport.login();
      expect(h.crypto.canSeal, false);
      await h.controller.sync();
      expect(h.state.error, isNull);
      expect(h.crypto.epoch, 2);
      expect(h.crypto.keys, {1: key1, 2: key2});
      expect(h.state.cursor, 5);
      expect(about(h.state), 'n3');
      expect(h.transport.acks.last, 5);
      // An exact-epoch install skips nothing, so no resync is needed.
      expect(h.transport.sent, isEmpty);
      expect(h.state.pending, isEmpty);
    });

    test(
      'prefers the blocked epoch and jumps only when it is unrecoverable',
      () async {
        // Exact delivery exists after a newer one: epoch 2 content is kept.
        var h = await harness([
          await content(2, 2, key2),
          await delivery(3, key3),
          await delivery(2, key2),
          await content(3, 3, key3),
        ], relayEpoch: 3);
        await h.controller.sync();
        expect(h.state.error, isNull);
        expect(h.crypto.epoch, 3);
        expect(h.state.cursor, 4);
        expect(about(h.state), 'n3');

        // No epoch-2 delivery at all: jump to 3, resync instead of dropping.
        String? atInstall;
        h = await harness(
          [
            await content(2, 2, key2),
            await delivery(3, key3),
            await content(3, 3, key3),
          ],
          relayEpoch: 3,
          onKeyWrite: (state) => atInstall = state,
        );
        // An older pending request is never reused for the resync.
        final earlier = await h.state.enqueue('snapshot.request', {});
        atInstall = null;
        await h.controller.sync();
        expect(h.state.error, isNull);
        expect(h.crypto.epoch, 3);
        expect(h.state.cursor, 3);
        expect(about(h.state), 'n3');
        final requests = h.state.pending
            .where((p) => p['kind'] == 'snapshot.request')
            .map((p) => p['op_id'])
            .toList();
        expect(requests, hasLength(2));
        expect(requests.first, earlier);
        expect(requests.last, isNot(earlier));
        // The fresh request was durable before the jumped key was written.
        expect(atInstall, contains(requests.last as String));
        expect(h.transport.sent.map((e) => e['epoch']), [3, 3]);
      },
    );

    test('a forged newer delivery cannot shadow a genuine one', () async {
      final attacker = await SpaceIdentity.generate();
      final h = await harness([
        await content(2, 2, key2),
        await delivery(3, key3),
        await host.keyDelivery(
          'phone',
          identity,
          epoch: 9,
          key: key3,
          signer: attacker,
        ),
      ], relayEpoch: 3);
      await h.controller.sync();
      // The verified epoch-3 delivery won the scan. The forged envelope is
      // then refused in order and holds the mailbox, as any forgery does.
      expect(h.crypto.epoch, 3);
      expect(h.crypto.keys, {1: key1, 3: key3});
      expect(h.state.cursor, 2);
      expect(h.state.error, contains('invalid_signature'));
    });

    test('read-ahead records verified newer epochs durably', () async {
      String? atExactInstall;
      final h = await harness(
        [
          await content(2, 2, key2),
          await delivery(3, key3),
          await delivery(2, key2),
        ],
        relayEpoch: 3,
        onKeyWritten: (written) {
          if (jsonMap(written)['epoch'] == 2) atExactInstall ??= written;
        },
      );
      await h.controller.sync();
      // A crash right after the epoch-2 install reloads this record.
      final reloaded = SpaceCrypto(
        host.clientRecord('phone'),
        identity,
        MemorySpacePersistence()..value = atExactInstall,
      );
      await reloaded.load();
      expect(reloaded.epoch, 2);
      expect(reloaded.observedHostEpoch, 3);
      expect(reloaded.canSeal, false);
      await expectLater(
        reloaded.seal({'v': 1}, id: 'op'),
        throwsA(predicate((e) => '$e'.contains('waiting_for_host_key'))),
      );
    });

    Future<Map<String, dynamic>> capabilitySnapshot() => host.content(
      'phone',
      {
        'v': 1,
        'type': 'snapshot',
        'snapshot': {
          'schema_version': 1,
          'revision': 1,
          'profile': {'about': 'caps', 'version': 1},
          'host_capabilities': ['voice.v1'],
        },
      },
      epoch: 1,
      key: key1,
      id: 'caps',
    );

    test(
      'a key delivery (no payload) re-evaluates the capability binding and hides a stale hint',
      () async {
        final h = await harness([await capabilitySnapshot()], relayEpoch: 1);
        await h.controller.sync();
        expect(h.state.hostCapability('voice.v1'), isTrue);
        // The real delivery path: openEnvelope installs epoch 2 and returns null.
        expect(await h.crypto.openEnvelope(await delivery(2, key2)), isNull);
        expect(h.crypto.epoch, 2);
        expect(h.state.hostCapability('voice.v1'), isFalse);
      },
    );

    test(
      'a reopened client requests a fresh snapshot before trusting a stored capability',
      () async {
        final disk = MemorySpacePersistence();
        final first = await harness(
          [await capabilitySnapshot()],
          relayEpoch: 1,
          stateDisk: disk,
        );
        await first.controller.sync();
        expect(first.state.hostCapability('voice.v1'), isTrue);
        expect(
          first.state.pending.where((p) => p['kind'] == 'snapshot.request'),
          isEmpty,
        );
        // Reopen over the same stored state: the snapshot is there, the binding is not.
        final reopened = await harness(
          [await capabilitySnapshot()],
          relayEpoch: 1,
          stateDisk: disk,
        );
        expect(reopened.state.snapshot['host_capabilities'], ['voice.v1']);
        expect(reopened.state.hostCapability('voice.v1'), isFalse);
        await reopened.controller.sync();
        expect(
          reopened.state.pending.where((p) => p['kind'] == 'snapshot.request'),
          hasLength(1),
        );
        expect(reopened.transport.sent, hasLength(1));
      },
    );

    test('a failed install is retried by the next sync', () async {
      var failures = 1;
      final h = await harness(
        [await content(2, 2, key2), await delivery(2, key2)],
        relayEpoch: 2,
        onKeyWritten: (written) {
          if (jsonMap(written)['epoch'] == 2 && failures-- > 0) {
            throw const FileSystemException('storage unavailable');
          }
        },
      );
      await h.controller.sync();
      expect(h.state.error, contains('storage unavailable'));
      expect(h.crypto.epoch, 1);
      await h.controller.sync();
      expect(h.state.error, isNull);
      expect(h.crypto.epoch, 2);
      expect(about(h.state), 'n2');
      expect(h.state.cursor, 2);
    });

    test('intermediate epochs replay before a higher key', () async {
      final h = await harness([
        await content(2, 2, key2),
        await delivery(3, key3),
        await content(3, 3, key3),
        await delivery(4, List.filled(32, 4)),
      ], relayEpoch: 4);
      await h.controller.sync();
      expect(h.state.error, isNull);
      expect(h.crypto.epoch, 4);
      expect(about(h.state), 'n3', reason: 'epoch-3 content was applied');
      expect(h.state.cursor, 4);
    });

    test('an initial epoch without its key waits for delivery', () async {
      final h = await harness(
        [await content(1, 1, key1), await delivery(1, key1)],
        relayEpoch: 1,
        paired: false,
      );
      expect(h.crypto.keys, isEmpty);
      await h.controller.sync();
      expect(h.state.error, isNull);
      expect(h.crypto.keys, {1: key1});
      expect(about(h.state), 'n1');
      expect(h.state.cursor, 2);
    });

    test(
      'a delivery beyond one scan bound is reached on a later sync',
      () async {
        final filler = await content(0, 1, key1);
        final mailbox = [
          await content(2, 2, key2),
          for (var i = 0; i < 140; i++) filler,
          await delivery(2, key2),
        ];
        final h = await harness(mailbox, relayEpoch: 2);
        await h.controller.sync();
        expect(h.state.error, contains('waiting_for_host_key'));
        expect(h.crypto.epoch, 1);
        expect(h.state.cursor, 0, reason: 'the durable cursor never moves');
        final firstScan = h.transport.pulls;
        await h.controller.sync();
        expect(h.state.error, isNull);
        expect(h.crypto.epoch, 2);
        expect(h.state.cursor, mailbox.length);
        expect(about(h.state), 'n2');
        // After rereading the blocked page, the second scan resumed where the
        // first stopped instead of restarting from the durable cursor.
        final second = h.transport.pullsAfter(firstScan);
        expect(second[0], 0);
        expect(second[1], greaterThan(100));
      },
    );

    test(
      'an unusable signed delivery is skipped and resync is not repeated',
      () async {
        final key4 = List.filled(32, 4);
        final mailbox = [
          await content(2, 2, key2),
          // Host-signed, but the wrapped payload is bound to another epoch.
          await host.keyDelivery(
            'phone',
            identity,
            epoch: 3,
            key: key3,
            payloadEpoch: 99,
          ),
        ];
        final h = await harness(mailbox, relayEpoch: 4);
        int requests() => h.state.pending
            .where((p) => p['kind'] == 'snapshot.request')
            .length;
        await h.controller.sync();
        await h.controller.sync();
        expect(h.state.error, contains('waiting_for_host_key'));
        expect(h.crypto.epoch, 1);
        expect(requests(), 1);
        // The good delivery arrives later; recovery no longer stalls on 3.
        mailbox.addAll([await delivery(4, key4), await content(4, 4, key4)]);
        await h.controller.sync();
        expect(h.state.error, isNull);
        expect(h.crypto.epoch, 4);
        expect(h.state.cursor, 4);
        expect(about(h.state), 'n4');
        expect(requests(), 1);
      },
    );

    test('a relay replaying older seqs cannot move the scan back', () async {
      final filler = await content(0, 1, key1);
      final mailbox = [
        await content(2, 2, key2),
        for (var i = 0; i < 140; i++) filler,
        await delivery(2, key2),
      ];
      final h = await harness(mailbox, relayEpoch: 2, replay: true);
      await h.controller.sync();
      expect(h.crypto.epoch, 1);
      await h.controller.sync();
      expect(h.state.error, isNull);
      expect(h.crypto.epoch, 2);
      expect(h.state.cursor, mailbox.length);
      expect(about(h.state), 'n2');
    });

    test('content of an older epoch decrypts after a newer key', () async {
      final key4 = List.filled(32, 4);
      // No delivery of key 2: the jump installs 3, then the replay installs
      // 4 before content(3) is reached; retained key 3 still opens it.
      final h = await harness([
        await content(2, 2, key2),
        await delivery(4, key4),
        await content(3, 3, key3),
        await delivery(3, key3),
      ], relayEpoch: 4);
      await h.controller.sync();
      expect(h.state.error, isNull);
      expect(h.crypto.epoch, 4);
      expect(h.crypto.keys.containsKey(2), false);
      expect(about(h.state), 'n3');
      expect(h.state.cursor, 4);
      expect(h.transport.sent.map((e) => e['epoch']), everyElement(4));
    });

    test('a send aborts without writing once rotation is verified', () async {
      final bodies = <String>[];
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        bodies.add(await utf8.decoder.bind(request).join());
        request.response.headers.contentType = ContentType.json;
        request.response.write('{}');
        await request.response.close();
      });
      addTearDown(() => server.close(force: true));
      final crypto = SpaceCrypto(
        SpaceRecord.fromJson({
          ...host.clientRecord('phone').toJson(),
          'relay': 'http://127.0.0.1:${server.port}',
        }),
        identity,
        MemorySpacePersistence(),
      );
      await crypto.openEnvelope(await delivery(1, key1));
      final rotated = await content(2, 2, key2);
      final disk = _HookedPersistence();
      final state = SpaceClientState(disk);
      await state.open();
      final controller = SpaceClientController(
        state,
        _OfflineLoginTransport(crypto),
        tools: FakeTools(),
        bindingCleanup: true,
      );
      addTearDown(controller.dispose);
      // Verified rotation evidence arrives while beginChat persists the turn.
      disk.onWrite = () async {
        disk.onWrite = null;
        await expectLater(
          crypto.openEnvelope(rotated),
          throwsA(predicate((e) => '$e'.contains('waiting_for_host_key'))),
        );
      };
      await expectLater(
        controller.sendChat('hello'),
        throwsA(predicate((e) => '$e' == SpaceRelayTransport.sendAborted)),
      );
      expect(crypto.observedHostEpoch, 2);
      expect(bodies, isEmpty, reason: 'no epoch-1 body is written');
      expect(state.chatRequests.values.single['status'], 'failed');
    });

    test('read-ahead keeps one candidate per epoch, at most a few', () async {
      final key3 = List.filled(32, 3);
      final replayed = await delivery(3, key3);
      // More than one scan bound, so the candidates stay cached.
      var h = await harness([
        await content(2, 2, key2),
        for (var i = 0; i < 150; i++) replayed,
      ], relayEpoch: 3);
      await h.controller.sync();
      expect(h.controller.keyCandidateCount, 1);

      h = await harness([
        await content(2, 2, key2),
        for (var e = 3; e < 23; e++) await delivery(e, List.filled(32, e)),
        for (var i = 0; i < 150; i++) replayed,
      ], relayEpoch: 3);
      await h.controller.sync();
      expect(
        h.controller.keyCandidateCount,
        SpaceClientController.maxKeyCandidates,
      );
    });

    test('reopening while blocked keeps one resync request', () async {
      final stateDisk = MemorySpacePersistence();
      final mailbox = [
        await content(2, 2, key2),
        await host.keyDelivery(
          'phone',
          identity,
          epoch: 3,
          key: key3,
          payloadEpoch: 99,
        ),
      ];
      late SpaceClientState state;
      for (var i = 0; i < 3; i++) {
        final h = await harness(mailbox, relayEpoch: 3, stateDisk: stateDisk);
        await h.controller.sync();
        expect(h.state.error, contains('waiting_for_host_key'));
        state = h.state;
      }
      expect(
        state.pending.where((p) => p['kind'] == 'snapshot.request'),
        hasLength(1),
      );
    });

    test('a malformed signed delivery is skipped, not retried', () async {
      final h = await harness([
        await host.keyDelivery(
          'phone',
          identity,
          epoch: 2,
          key: key2,
          enc: 'A128CBC-HS256',
        ),
        await delivery(2, key2),
        await content(2, 2, key2),
      ], relayEpoch: 2);
      await h.controller.sync();
      expect(h.state.error, isNull);
      expect(h.crypto.epoch, 2);
      expect(h.state.cursor, 3);
      expect(about(h.state), 'n2');
    });
  });
}

/// Key persistence that reports each write before storing it.
class _WatchedPersistence extends MemorySpacePersistence {
  _WatchedPersistence(this.onWrite);
  final void Function(String value) onWrite;
  @override
  Future<void> write(String value) async {
    onWrite(value);
    await super.write(value);
  }
}

/// A relay that appends an already-delivered item to every later page and
/// reports a cursor behind it.
class _ReplayTransport extends MailboxTransport {
  _ReplayTransport(super.crypto, super.mailbox, {required super.relayEpoch});
  @override
  Future<Map<String, dynamic>> pull(int cursor) async {
    final page = await super.pull(cursor);
    if (cursor == 0) return page;
    return {
      ...page,
      'messages': [
        ...page['messages'] as List,
        {'seq': 1, 'envelope': mailbox.first},
      ],
      'nextCursor': 1,
    };
  }
}

/// Client-state persistence that can run a hook on its next write.
class _HookedPersistence extends MemorySpacePersistence {
  Future<void> Function()? onWrite;
  @override
  Future<void> write(String value) async {
    await onWrite?.call();
    await super.write(value);
  }
}

/// Real HTTP sends, with login and presence answered locally.
class _OfflineLoginTransport extends SpaceRelayTransport {
  _OfflineLoginTransport(super.crypto) : super(allowLoopback: true);
  @override
  Future<void> login() async => crypto.sessionEpoch = crypto.epoch;
  @override
  Future<bool> hostOnline() async => true;
}
