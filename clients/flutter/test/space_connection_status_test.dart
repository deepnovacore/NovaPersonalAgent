import 'dart:convert';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/connection_status.dart';
import 'package:nova_mobile/space/native_scope.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

SpaceRecord client(String id) => SpaceRecord(
  id: id,
  name: '电脑 $id',
  mode: SpaceMode.client,
  remoteSpace: id,
  hostDevice: 'host',
  hostSigningKey: const {'kty': 'OKP', 'crv': 'Ed25519', 'x': 'host'},
  relay: 'https://relay.example',
  device: id,
);

class PresenceTransport extends SpaceRelayTransport {
  PresenceTransport(super.crypto, {this.online = true, this.failure});
  final bool online;
  final Object? failure;
  bool closed = false;
  int logins = 0, presenceReads = 0;
  @override
  Future<void> login() async {
    logins++;
    if (failure != null) throw failure!;
    await crypto.setEpoch(2);
  }

  @override
  Future<bool> hostOnline() async {
    presenceReads++;
    return online;
  }

  @override
  Future<void> dispose() async {
    closed = true;
    await super.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late String identity;
  setUpAll(
    () async =>
        identity = jsonEncode((await SpaceIdentity.generate()).toJson()),
  );
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    SpaceNativeScope.resetForTesting();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SpaceNativeScope.channel, (_) async => null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('nova/space_push/events'),
          (_) async => null,
        );
  });
  tearDown(() => SpaceStorage.active = null);

  test(
    'presence probes read saved keys, never persist login epochs, and close transports',
    () async {
      for (final online in [true, false]) {
        final saved = {
          'nova.space.identity.one': identity,
          'nova.space.keys.one': jsonEncode({'epoch': 1, 'keys': {}}),
        };
        final before = Map.of(saved);
        final reads = <String>[];
        late PresenceTransport transport;
        final status = await probeSpaceConnection(
          client('one'),
          readSecret: (key) async {
            reads.add(key);
            return saved[key];
          },
          createTransport: (crypto) =>
              transport = PresenceTransport(crypto, online: online),
        );
        expect(
          status,
          online ? SpaceConnectionStatus.online : SpaceConnectionStatus.offline,
        );
        expect(transport.logins, 1);
        expect(transport.presenceReads, 1);
        expect(transport.closed, true);
        expect(saved, before);
        expect(reads, ['nova.space.identity.one', 'nova.space.keys.one']);
      }
    },
  );

  test(
    'inactive devices await approval only with a saved pairing request',
    () async {
      for (final pending in [true, false]) {
        late PresenceTransport transport;
        final status = await probeSpaceConnection(
          client('one'),
          readSecret: (key) async => key.contains('identity')
              ? identity
              : key.contains('pair-request') && pending
              ? '{}'
              : null,
          createTransport: (crypto) => transport = PresenceTransport(
            crypto,
            failure: const RelayFailure('inactive_device'),
          ),
        );
        expect(
          status,
          pending
              ? SpaceConnectionStatus.awaitingApproval
              : SpaceConnectionStatus.unreachable,
        );
        expect(transport.closed, true);
        expect(transport.presenceReads, 0);
      }
      expect(
        await probeSpaceConnection(
          client('missing'),
          readSecret: (_) async => null,
        ),
        SpaceConnectionStatus.unreachable,
      );
      late PresenceTransport failed;
      expect(
        await probeSpaceConnection(
          client('one'),
          readSecret: (key) async => key.contains('identity') ? identity : null,
          createTransport: (crypto) => failed = PresenceTransport(
            crypto,
            failure: StateError('private URL'),
          ),
        ),
        SpaceConnectionStatus.unreachable,
      );
      expect(failed.closed, true);
    },
  );

  testWidgets(
    'chooser shows status icons, probes visible bindings only, and pauses in background',
    (tester) async {
      SharedPreferences.setMockInitialValues({'language': 'zh'});
      tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      );
      final records = [
        client('online'),
        client('offline'),
        client('unreachable'),
        client('pending'),
      ];
      final duplicate = SpaceRecord(
        id: 'old-online',
        name: '旧电脑',
        mode: SpaceMode.client,
        remoteSpace: 'online',
        hostDevice: 'host',
      hostSigningKey: const {'kty': 'OKP', 'crv': 'Ed25519', 'x': 'host'},
        relay: 'https://relay.example',
        device: 'old',
      );
      final catalog = SpaceCatalog(
        persistence: MemorySpacePersistence()
          ..value = jsonEncode({
            'selected': null,
            'spaces': [...records, duplicate].map((s) => s.toJson()).toList(),
          }),
      );
      final calls = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: SpaceRoot(
            catalog: catalog,
            standaloneBuilder: (_) => const Text('Local'),
            connectionProbe: (space) async {
              calls.add(space.id);
              return switch (space.id) {
                'online' => SpaceConnectionStatus.online,
                'offline' => SpaceConnectionStatus.offline,
                'pending' => SpaceConnectionStatus.awaitingApproval,
                _ => SpaceConnectionStatus.unreachable,
              };
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final text in ['电脑在线', '电脑离线', '暂时无法连接', '等待电脑批准']) {
        expect(find.text(text), findsOneWidget);
      }
      expect(find.byIcon(CupertinoIcons.checkmark_circle_fill), findsOneWidget);
      expect(find.byIcon(CupertinoIcons.wifi_exclamationmark), findsOneWidget);
      expect(find.byIcon(CupertinoIcons.lock), findsOneWidget);
      expect(find.text('旧电脑'), findsNothing);
      expect(calls, records.map((s) => s.id).toList());
      await tester.pump(const Duration(seconds: 15));
      await tester.pumpAndSettle();
      expect(calls, hasLength(8));
      tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.paused,
      );
      await tester.pump(const Duration(seconds: 30));
      expect(calls, hasLength(8));
      tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      );
      await tester.pumpAndSettle();
      expect(calls, hasLength(12));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
      expect(calls, hasLength(12));
    },
  );
}
