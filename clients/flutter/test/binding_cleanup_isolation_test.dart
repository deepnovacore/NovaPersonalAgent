import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/binding_cleanup.dart';
import 'package:nova_mobile/space/client_controller.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;
import 'space_mobile_tools_test.dart' show FakeTools, action;

SpaceRecord record(String id) => SpaceRecord(
  id: id,
  name: id,
  mode: SpaceMode.client,
  remoteSpace: 'same-host',
  hostDevice: 'host',
  device: id,
  relay: 'https://relay.example',
  hostSigningKey: const {'kty': 'OKP', 'crv': 'Ed25519', 'x': 'host'},
);

class CleanupCrypto extends SpaceCrypto {
  CleanupCrypto(SpaceIdentity identity)
    : super(record('keep'), identity, MemorySpacePersistence()) {
    keys[epoch] = List.filled(32, 1);
  }
  @override
  Future<Map<String, dynamic>?> openEnvelope(
    Map<String, dynamic> envelope,
  ) async => envelope;
  @override
  Future<Map<String, dynamic>> seal(
    Map<String, dynamic> payload, {
    required String id,
    String channel = 'mailbox',
    int? expiresAt,
  }) async => {'epoch': epoch, ...payload};
}

class CleanupTransport extends SpaceRelayTransport {
  CleanupTransport(super.crypto);
  final sent = <Map<String, dynamic>>[];
  final acknowledgements = <int>[];
  final firstRevoke = Completer<void>();
  final received = <Map<String, dynamic>>[];
  final receipted = <String>{};
  bool releaseReceipt = false, closed = false;
  int liveConnections = 0, logins = 0, transientPullFailures = 0;
  @override
  Future<void> login() async {
    logins++;
  }

  @override
  Future<void> connectLive() async {
    liveConnections++;
  }

  @override
  Future<bool> hostOnline() async => true;
  @override
  Future<Map<String, dynamic>> pull(int cursor) async {
    if (transientPullFailures > 0) {
      transientPullFailures--;
      throw const RelayFailure('unauthorized');
    }
    final events = [...received];
    received.clear();
    if (releaseReceipt) {
      for (final item in sent) {
        if (item['kind'] == 'device.revoke' &&
            receipted.add(item['op_id'] as String)) {
          events.add({
            'v': 1,
            'type': 'receipt',
            'op_id': item['op_id'],
            'status': 'accepted',
          });
        }
      }
    }
    return {
      'messages': [
        for (var i = 0; i < events.length; i++)
          {
            'seq': cursor + i + 1,
            'envelope': {...events[i], 'chan': 'mailbox'},
          },
      ],
      'nextCursor': cursor + events.length,
      'hasMore': false,
    };
  }

  @override
  Future<void> ack(int cursor) async {
    acknowledgements.add(cursor);
  }

  @override
  Future<void> send(Map<String, dynamic> envelope) async {
    sent.add(Map.of(envelope));
    if (envelope['kind'] == 'device.revoke' && !firstRevoke.isCompleted) {
      firstRevoke.complete();
    }
  }

  @override
  Future<void> dispose() async {
    closed = true;
    await super.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SpaceIdentity identity;
  setUpAll(() async => identity = await SpaceIdentity.generate());

  test(
    'cleanup sends only revokes and snapshot requests without starting normal runtime',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.snapshot = {'owner': true};
      for (final kind in [
        'todo.create',
        'settings.patch',
        'secret.put',
        'mobile.result',
        'device.revoke',
        'snapshot.request',
      ]) {
        await state.enqueue(kind, {'device': 'old'});
      }
      final transport = CleanupTransport(CleanupCrypto(identity));
      final controller = SpaceClientController(
        state,
        transport,
        bindingCleanup: true,
      );
      controller.start();
      expect(transport.logins, 0);
      await controller.sync();
      expect(transport.sent.map((v) => v['kind']), [
        'device.revoke',
        'snapshot.request',
      ]);
      expect(transport.liveConnections, 0);
      expect(controller.push, isNull);
      expect(
        state.pending
            .where(
              (p) => [
                'todo.create',
                'settings.patch',
                'secret.put',
                'mobile.result',
              ].contains(p['kind']),
            )
            .every((p) => p['envelope'] == null),
        true,
      );
      await controller.dispose();
      expect(transport.closed, true);
    },
  );

  test(
    'mobile actions block cleanup before effects, cursor advancement or ACK',
    () async {
      final disk = MemorySpacePersistence();
      final state = SpaceClientState(disk);
      await state.open();
      state.snapshot = {'owner': true};
      state.cursor = 7;
      await state.enqueue('device.revoke', {'device': 'old'});
      final tools = FakeTools();
      final transport = CleanupTransport(CleanupCrypto(identity))
        ..received.add(action());
      final controller = SpaceClientController(
        state,
        transport,
        tools: tools,
        bindingCleanup: true,
      );
      await controller.sync();
      expect(state.error, 'cleanup_waiting_for_mobile_action');
      expect(state.cursor, 7);
      expect(transport.acknowledgements, isEmpty);
      expect(transport.sent, isEmpty);
      expect(tools.executions, 0);
      expect(state.effects, isEmpty);
      await controller.dispose();
    },
  );

  test(
    'push keys block cleanup before one-shot delivery can be ACKed',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.snapshot = {'owner': true};
      state.cursor = 17;
      await state.enqueue('device.revoke', {'device': 'old'});
      final transport = CleanupTransport(CleanupCrypto(identity))
        ..received.add({'v': 1, 'type': 'push.key', 'credential': 'one-shot'});
      final controller = SpaceClientController(
        state,
        transport,
        bindingCleanup: true,
      );
      await controller.sync();
      expect(state.error, 'cleanup_waiting_for_push_key');
      expect(state.cursor, 17);
      expect(transport.acknowledgements, isEmpty);
      expect(transport.sent, isEmpty);
      await controller.dispose();
      expect(transport.closed, true);
    },
  );

  test(
    'catalog retires bindings only after the accepted revoke receipt',
    () async {
      final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
      catalog.spaces.addAll([record('keep'), record('old')]);
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.snapshot = {'owner': true};
      final transport = CleanupTransport(CleanupCrypto(identity));
      final controller = SpaceClientController(
        state,
        transport,
        bindingCleanup: true,
      );
      final cleanup = consolidateClientBindings(
        catalog,
        record('keep'),
        open: (_) async => controller,
      );
      await transport.firstRevoke.future;
      expect(catalog.spaces, hasLength(2));
      expect(catalog.retired, isEmpty);
      expect(state.completedOperations, isEmpty);
      transport.releaseReceipt = true;
      await cleanup;
      expect(catalog.spaces.map((s) => s.id), ['keep']);
      expect(catalog.retired.map((s) => s.id), ['old']);
      expect(state.completedOperations, hasLength(1));
      expect(transport.closed, true);
    },
  );

  test(
    'cleanup retries a transient stale-session failure before accepting the revoke receipt',
    () async {
      final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
      catalog.spaces.addAll([record('keep'), record('old')]);
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.snapshot = {'owner': true};
      final transport = CleanupTransport(CleanupCrypto(identity));
      final controller = SpaceClientController(
        state,
        transport,
        bindingCleanup: true,
      );
      final cleanup = consolidateClientBindings(
        catalog,
        record('keep'),
        open: (_) async => controller,
      );
      await transport.firstRevoke.future;
      transport.transientPullFailures = 1;
      transport.releaseReceipt = true;
      expect(catalog.spaces, hasLength(2));
      await cleanup;
      expect(transport.transientPullFailures, 0);
      expect(transport.logins, greaterThanOrEqualTo(4));
      expect(catalog.spaces.map((s) => s.id), ['keep']);
      expect(catalog.retired.map((s) => s.id), ['old']);
      expect(state.completedOperations, hasLength(1));
      expect(transport.closed, true);
    },
  );

  test(
    'blocked mobile action fails cleanup promptly and preserves catalog',
    () async {
      final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
      catalog.spaces.addAll([record('keep'), record('old')]);
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.snapshot = {'owner': true};
      final transport = CleanupTransport(CleanupCrypto(identity))
        ..received.add(action());
      final controller = SpaceClientController(
        state,
        transport,
        bindingCleanup: true,
      );
      await expectLater(
        consolidateClientBindings(
          catalog,
          record('keep'),
          open: (_) async => controller,
        ),
        throwsStateError,
      );
      expect(catalog.spaces, hasLength(2));
      expect(catalog.retired, isEmpty);
      expect(transport.sent, isEmpty);
      expect(transport.acknowledgements, isEmpty);
      expect(transport.closed, true);
    },
  );
}
