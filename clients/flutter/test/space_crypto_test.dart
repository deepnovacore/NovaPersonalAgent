import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;
import 'support/space_host_fixture.dart';

void main() {
  test(
    'decrypt real TypeScript JOSE dir and ECDH-ES+A256KW fixtures',
    () async {
      final fixture = jsonMap(
        await File('../../relay/test/fixtures/jose-v1.json').readAsString(),
      );
      final host = Map<String, dynamic>.from(fixture['host'] as Map);
      final client = Map<String, dynamic>.from(fixture['client'] as Map);
      final identity = SpaceIdentity(
        signing: Map<String, dynamic>.from(client['signingPrivateKey'] as Map),
        encryption: Map<String, dynamic>.from(
          client['encryptionPrivateKey'] as Map,
        ),
      );
      final envelope = Map<String, dynamic>.from(fixture['envelope'] as Map);
      final record = SpaceRecord(
        id: 'local',
        name: 'Fixture',
        mode: SpaceMode.client,
        remoteSpace: envelope['space'] as String,
        device: client['device'] as String,
        hostDevice: host['device'] as String,
        hostSigningKey: Map<String, dynamic>.from(
          host['signingPublicKey'] as Map,
        ),
      );
      final crypto = SpaceCrypto(record, identity, MemorySpacePersistence());
      await crypto.load();
      await crypto.openEnvelope(
        Map<String, dynamic>.from(fixture['keyEnvelope'] as Map),
      );
      expect(crypto.keys[1], List.generate(32, (i) => i));
      expect(await crypto.openEnvelope(envelope), fixture['plaintext']);
      final corrupt = {...envelope, 'to': 'attacker'};
      await expectLater(crypto.openEnvelope(corrupt), throwsStateError);
      final jws = await crypto.signControl({'v': 1, 'purpose': 'test'});
      expect(
        await SpaceCrypto.verifyJws(
          jws,
          identity.signingPublic,
          type: 'nova-control+jws',
        ),
        {'v': 1, 'purpose': 'test'},
      );
      final encoded = await SpaceCrypto.encryptBody({
        'text': 'Dart 中文🙂',
      }, crypto.keys[1]!);
      expect(utf8.decode(base64Decode(encoded)).split('.').length, 5);
    },
  );

  group('content-key epoch trust', () {
    late TestHost host;
    late SpaceIdentity identity;
    late SpaceRecord record;
    final key1 = List.generate(32, (i) => i);
    final key2 = List.generate(32, (i) => 100 + i);
    setUp(() async {
      host = await TestHost.create();
      identity = await SpaceIdentity.generate();
      record = host.clientRecord('phone');
    });

    Future<SpaceCrypto> paired(MemorySpacePersistence disk) async {
      final crypto = SpaceCrypto(record, identity, disk);
      await crypto.load();
      await crypto.openEnvelope(
        await host.keyDelivery('phone', identity, epoch: 1, key: key1),
      );
      expect(crypto.epoch, 1);
      return crypto;
    }

    test(
      'a forged relay challenge epoch is only signed, never persisted',
      () async {
        final disk = MemorySpacePersistence();
        final crypto = await paired(disk);
        final saved = disk.value;
        const forged = 1 << 40;
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        String? proof;
        server.listen((request) async {
          final body = jsonMap(await utf8.decoder.bind(request).join());
          request.response.headers.contentType = ContentType.json;
          if (request.uri.path == '/v1/auth/challenge') {
            request.response.write(
              jsonEncode({
                'id': 'challenge',
                'nonce': 'nonce',
                'space': body['space'],
                'device': body['device'],
                'epoch': forged,
                'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
              }),
            );
          } else {
            proof = body['proof'] as String;
            request.response.write(
              jsonEncode({
                'token': 'session',
                'expiresAt': DateTime.now().millisecondsSinceEpoch + 600000,
                'selected_version': 1,
                'principal': {
                  'space': record.remoteSpace,
                  'device': record.device,
                  'epoch': forged,
                },
              }),
            );
          }
          await request.response.close();
        });
        final transport = SpaceRelayTransport(
          SpaceCrypto(
            SpaceRecord.fromJson({
              ...record.toJson(),
              'relay': 'http://127.0.0.1:${server.port}',
            }),
            identity,
            disk,
          ),
          allowLoopback: true,
        );
        try {
          await transport.crypto.load();
          await transport.login();
          final signed = await SpaceCrypto.verifyJws(
            proof!,
            identity.signingPublic,
            type: 'nova-control+jws',
          );
          expect(signed['purpose'], 'relay-login');
          expect(signed['epoch'], forged);
          expect(transport.crypto.sessionEpoch, forged);
          expect(transport.crypto.epoch, 1);
          expect(transport.crypto.keys, {1: key1});
          expect(disk.value, saved, reason: 'relay epochs are never persisted');
          expect(transport.crypto.canSeal, false);
          await expectLater(
            transport.crypto.seal({'v': 1}, id: 'op'),
            throwsA(predicate((e) => '$e'.contains('waiting_for_host_key'))),
          );
          // Genuine Host material at the real epoch still decrypts.
          final payload = {'v': 1, 'type': 'snapshot', 'snapshot': {}};
          expect(
            await transport.crypto.openEnvelope(
              await host.content('phone', payload, epoch: 1, key: key1),
            ),
            payload,
          );
          final restarted = SpaceCrypto(record, identity, disk);
          await restarted.load();
          expect(restarted.epoch, 1);
          expect(restarted.keys, {1: key1});
          expect(crypto.keys, {1: key1});
        } finally {
          await transport.dispose();
          await server.close(force: true);
        }
      },
    );

    test('only a Host-signed delivery advances the epoch', () async {
      final disk = MemorySpacePersistence();
      final crypto = await paired(disk);
      final saved = disk.value;
      Future<void> rejected(Map<String, dynamic> envelope) async {
        await expectLater(
          crypto.openEnvelope(envelope),
          throwsA(anyOf(isA<StateError>(), isA<SpaceInvalidKeyDelivery>())),
        );
        expect(crypto.epoch, 1);
        expect(crypto.keys, {1: key1});
        // Only Host-signed evidence may raise the observed epoch, to 2.
        final stored = jsonMap(disk.value!);
        expect(
          {...stored}..remove('observed'),
          {...jsonMap(saved!)}..remove('observed'),
        );
        expect(stored['observed'], 2);
      }

      final newer = {
        'v': 1,
        'type': 'snapshot',
        'snapshot': {'n': 2},
      };
      // Content for an unseen epoch waits for its key and changes nothing.
      await rejected(await host.content('phone', newer, epoch: 2, key: key2));
      // Wrongly signed delivery.
      final attacker = await SpaceIdentity.generate();
      await rejected(
        await host.keyDelivery(
          'phone',
          identity,
          epoch: 2,
          key: key2,
          signer: attacker,
        ),
      );
      // Unsigned delivery, and a signed one whose epoch field was rewritten.
      final genuine = await host.keyDelivery(
        'phone',
        identity,
        epoch: 2,
        key: key2,
      );
      await rejected({...genuine}..remove('sig'));
      final relabelled = await host.keyDelivery(
        'phone',
        identity,
        epoch: 1,
        key: key2,
      );
      await rejected({...relabelled, 'epoch': 3});
      // Signed envelope whose wrapped payload is bound to another epoch.
      await rejected(
        await host.keyDelivery(
          'phone',
          identity,
          epoch: 2,
          key: key2,
          payloadEpoch: 1,
        ),
      );

      expect(await crypto.openEnvelope(genuine), isNull);
      expect(crypto.epoch, 2);
      expect(crypto.keys, {1: key1, 2: key2});
      final restarted = SpaceCrypto(record, identity, disk);
      await restarted.load();
      expect(restarted.epoch, 2);
      expect(restarted.keys, {1: key1, 2: key2});
      expect(
        await crypto.openEnvelope(
          await host.content('phone', newer, epoch: 2, key: key2),
        ),
        newer,
      );

      // An older delivery changes nothing. Older keys are retained (at most
      // [SpaceCrypto.retainedEpochs]) only to open late content; sealing
      // always uses the current epoch's key.
      final current = disk.value;
      expect(
        await crypto.openEnvelope(
          await host.keyDelivery('phone', identity, epoch: 1, key: key2),
        ),
        isNull,
      );
      expect(
        await crypto.openEnvelope(
          await host.content('phone', newer, epoch: 1, key: key1),
        ),
        newer,
      );
      expect(crypto.epoch, 2);
      expect(crypto.keys, {1: key1, 2: key2});
      expect(disk.value, current);
      final sealed = await crypto.seal({'v': 1}, id: 'op');
      expect(sealed['epoch'], 2);
      expect(await decryptBody(sealed['body'] as String, key2), {'v': 1});
      // Retained for at most retainedEpochs epochs.
      for (var e = 3; e <= 6; e++) {
        await crypto.openEnvelope(
          await host.keyDelivery(
            'phone',
            identity,
            epoch: e,
            key: List.filled(32, e),
          ),
        );
      }
      expect(crypto.keys.keys, [3, 4, 5, 6]);
      expect(jsonMap(disk.value!)['keys'].keys, ['3', '4', '5', '6']);
    });

    test('a relay challenge below the signed epoch is stale', () async {
      final disk = MemorySpacePersistence();
      final crypto = await paired(disk);
      await crypto.openEnvelope(
        await host.keyDelivery('phone', identity, epoch: 3, key: key2),
      );
      final saved = disk.value;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        final body = jsonMap(await utf8.decoder.bind(request).join());
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'id': 'challenge',
            'nonce': 'nonce',
            'space': body['space'],
            'device': body['device'],
            'epoch': 2,
            'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
          }),
        );
        await request.response.close();
      });
      final transport = SpaceRelayTransport(
        SpaceCrypto(
          SpaceRecord.fromJson({
            ...record.toJson(),
            'relay': 'http://127.0.0.1:${server.port}',
          }),
          identity,
          disk,
        ),
        allowLoopback: true,
      );
      try {
        await transport.crypto.load();
        await expectLater(
          transport.login(),
          throwsA(predicate((e) => '$e'.contains('stale_epoch'))),
        );
        expect(transport.crypto.epoch, 3);
        expect(disk.value, saved);
      } finally {
        await transport.dispose();
        await server.close(force: true);
      }
    });

    test('concurrent deliveries never move the persisted epoch back', () async {
      final writes = <int>[];
      final disk = _SlowPersistence(writes);
      final crypto = await paired(disk);
      final key3 = List.filled(32, 3);
      final d2 = await host.keyDelivery('phone', identity, epoch: 2, key: key2);
      final d3 = await host.keyDelivery('phone', identity, epoch: 3, key: key3);
      await Future.wait([crypto.openEnvelope(d3), crypto.openEnvelope(d2)]);
      expect(crypto.epoch, 3);
      expect(crypto.keys[3], key3);
      expect(jsonMap(disk.value!)['epoch'], 3);
      for (var i = 1; i < writes.length; i++) {
        expect(writes[i], greaterThanOrEqualTo(writes[i - 1]));
      }
      // A later replay of the older delivery is stale and writes nothing.
      final count = writes.length;
      expect(await crypto.openEnvelope(d2), isNull);
      expect(writes.length, count);
      expect(crypto.epoch, 3);
    });

    test('a rotation installed mid-seal never mislabels the key', () async {
      final delivery = await host.keyDelivery(
        'phone',
        identity,
        epoch: 2,
        key: key2,
      );
      final crypto = _GatedCrypto(record, identity, MemorySpacePersistence());
      await crypto.openEnvelope(
        await host.keyDelivery('phone', identity, epoch: 1, key: key1),
      );
      final sealing = crypto.seal({'v': 1, 'type': 'intent'}, id: 'op');
      // The first seal is parked after encrypting with the epoch-1 key.
      await crypto.parked.future;
      await crypto.openEnvelope(delivery);
      expect(crypto.epoch, 2);
      crypto.gate.complete();
      final envelope = await sealing;
      expect(crypto.signatures, 2, reason: 'the stale seal is discarded');
      expect(envelope['epoch'], 2);
      expect(
        await decryptBody(
          envelope['body'] as String,
          crypto.keys[envelope['epoch']]!,
        ),
        {'v': 1, 'type': 'intent'},
      );
      // The signature covers the same epoch label.
      final signed = await SpaceCrypto.verifyJws(
        utf8.decode(base64Decode(envelope['sig'] as String)),
        identity.signingPublic,
        type: 'nova-envelope+jws',
      );
      expect(signed['epoch'], envelope['epoch']);
    });

    test('key deliveries are accepted only on the mailbox channel', () async {
      final disk = MemorySpacePersistence();
      final crypto = await paired(disk);
      final saved = disk.value;
      await expectLater(
        crypto.openEnvelope(
          await host.keyDelivery(
            'phone',
            identity,
            epoch: 2,
            key: key2,
            chan: 'stream',
          ),
        ),
        throwsA(predicate((e) => '$e'.contains('invalid_key_channel'))),
      );
      expect(crypto.epoch, 1);
      expect(crypto.keys, {1: key1});
      // The Host-signed epoch still counts as rotation evidence.
      expect(jsonMap(disk.value!)['keys'], jsonMap(saved!)['keys']);
      expect(crypto.observedHostEpoch, 2);
      expect(crypto.canSeal, false);
    });

    test('verified rotation evidence blocks sealing until delivery', () async {
      final disk = MemorySpacePersistence();
      final crypto = await paired(disk);
      expect(crypto.canSeal, true);
      final newer = {'v': 1, 'type': 'snapshot', 'snapshot': {}};
      await expectLater(
        crypto.openEnvelope(
          await host.content('phone', newer, epoch: 2, key: key2),
        ),
        throwsA(predicate((e) => '$e'.contains('waiting_for_host_key'))),
      );
      Future<void> refuses(SpaceCrypto c) async {
        expect(c.observedHostEpoch, 2);
        expect(c.epoch, 1);
        expect(c.canSeal, false);
        await expectLater(
          c.seal({'v': 1}, id: 'op'),
          throwsA(predicate((e) => '$e'.contains('waiting_for_host_key'))),
        );
      }

      await refuses(crypto);
      final restarted = SpaceCrypto(record, identity, disk);
      await restarted.load();
      expect(restarted.needsRepair, false);
      await refuses(restarted);
      // An unsigned claim of a newer epoch is not evidence.
      final forged = await host.content('phone', newer, epoch: 5, key: key2);
      await expectLater(
        restarted.openEnvelope({...forged, 'epoch': 6}),
        throwsStateError,
      );
      expect(restarted.observedHostEpoch, 2);
      await restarted.openEnvelope(
        await host.keyDelivery('phone', identity, epoch: 2, key: key2),
      );
      expect(restarted.canSeal, true);
      final sealed = await restarted.seal({'v': 1}, id: 'op');
      expect(sealed['epoch'], 2);
      expect(await decryptBody(sealed['body'] as String, key2), {'v': 1});

      // Evidence seen before any key is not mistaken for a legacy file.
      final unpaired = MemorySpacePersistence();
      final waiting = SpaceCrypto(record, identity, unpaired);
      await waiting.load();
      await expectLater(
        waiting.openEnvelope(
          await host.content('phone', newer, epoch: 3, key: key2),
        ),
        throwsStateError,
      );
      final reloaded = SpaceCrypto(record, identity, unpaired);
      await reloaded.load();
      expect(reloaded.needsRepair, false);
      expect(reloaded.observedHostEpoch, 3);
    });

    test('rotation evidence blocks sealing before it is persisted', () async {
      final disk = _HeldPersistence();
      final crypto = await paired(disk);
      disk.hold = Completer<void>();
      final opening = crypto.openEnvelope(
        await host.content('phone', {'v': 1}, epoch: 2, key: key2),
      );
      await disk.started.future;
      // The write is still open, yet memory already refuses to seal.
      expect(crypto.observedHostEpoch, 2);
      expect(crypto.canSeal, false);
      await expectLater(
        crypto.seal({'v': 1}, id: 'op'),
        throwsA(predicate((e) => '$e'.contains('waiting_for_host_key'))),
      );
      disk.hold!.complete();
      await expectLater(opening, throwsStateError);
      expect(jsonMap(disk.value!)['observed'], 2);
    });

    test('an older instance never lowers what a newer one stored', () async {
      final disk = MemorySpacePersistence();
      final stale = await paired(disk);
      final fresh = SpaceCrypto(record, identity, disk);
      await fresh.load();
      await fresh.openEnvelope(
        await host.keyDelivery('phone', identity, epoch: 2, key: key2),
      );
      // The stale instance, still at epoch 1 with only key 1, writes when it
      // sees verified epoch-2 content: the join keeps key 2 and epoch 2.
      final newer = {
        'v': 1,
        'type': 'snapshot',
        'snapshot': {'n': 2},
      };
      expect(
        await stale.openEnvelope(
          await host.content('phone', newer, epoch: 2, key: key2),
        ),
        newer,
      );
      final stored = jsonMap(disk.value!);
      expect(stored['epoch'], 2);
      expect(stored['keys'], {'1': b64url(key1), '2': b64url(key2)});
      expect(stored['observed'], 2);
      expect(stale.epoch, 2, reason: 'memory adopts the merged record');
      expect(stale.keys, {1: key1, 2: key2});
    });

    test('an equal-epoch write never erases an installed key', () async {
      final disk = MemorySpacePersistence();
      final stale = await paired(disk);
      final fresh = SpaceCrypto(record, identity, disk);
      await fresh.load();
      final key3 = List.filled(32, 3);
      final d3 = await host.keyDelivery('phone', identity, epoch: 3, key: key3);
      await fresh.openEnvelope(
        await host.keyDelivery('phone', identity, epoch: 2, key: key2),
      );
      await fresh.openEnvelope(d3);
      // The stale instance (only key 1 in memory) installs the same epoch 3.
      await stale.openEnvelope(d3);
      final stored = jsonMap(disk.value!);
      expect(stored['epoch'], 3);
      expect(stored['keys'], {
        '1': b64url(key1),
        '2': b64url(key2),
        '3': b64url(key3),
      });
      expect(stale.keys, {1: key1, 2: key2, 3: key3});
    });

    test('observed raised during an install is written afterwards', () async {
      final disk = _HeldPersistence();
      final crypto = await paired(disk);
      disk.hold = Completer<void>();
      final installing = crypto.openEnvelope(
        await host.keyDelivery('phone', identity, epoch: 2, key: key2),
      );
      await disk.started.future;
      // Verified epoch-3 evidence arrives while the install of 2 is in flight.
      final newer = {
        'v': 1,
        'type': 'snapshot',
        'snapshot': {'n': 3},
      };
      final waiting = expectLater(
        crypto.openEnvelope(
          await host.content('phone', newer, epoch: 3, key: key2),
        ),
        throwsA(predicate((e) => '$e'.contains('waiting_for_host_key'))),
      );
      for (var i = 0; i < 200 && crypto.observedHostEpoch < 3; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(crypto.observedHostEpoch, 3);
      disk.hold!.complete();
      await installing;
      await waiting;
      final stored = jsonMap(disk.value!);
      expect(stored['epoch'], 2);
      expect(stored['observed'], 3);
      final restarted = SpaceCrypto(record, identity, disk);
      await restarted.load();
      expect(restarted.observedHostEpoch, 3);
      expect(restarted.canSeal, false);
    });

    test('legacy poisoned state needs re-pair and installs nothing', () async {
      // An older genuine delivery is replayed by the relay.
      final replay = await host.keyDelivery(
        'phone',
        identity,
        epoch: 1,
        key: key1,
      );
      final poisoned = jsonEncode({'epoch': 1 << 40, 'keys': {}});
      final disk = MemorySpacePersistence()..value = poisoned;
      final crypto = SpaceCrypto(record, identity, disk);
      await crypto.load();
      expect(crypto.needsRepair, true);
      expect(crypto.canSeal, false);
      await expectLater(
        crypto.openEnvelope(replay),
        throwsA(predicate((e) => '$e'.contains('needs_repair'))),
      );
      await expectLater(
        crypto.seal({'v': 1}, id: 'op'),
        throwsA(predicate((e) => '$e'.contains('needs_repair'))),
      );
      final transport = SpaceRelayTransport(crypto);
      try {
        await expectLater(
          transport.login(),
          throwsA(
            isA<RelayFailure>().having((e) => e.code, 'code', 'needs_repair'),
          ),
        );
      } finally {
        await transport.dispose();
      }
      expect(crypto.keys, isEmpty);
      expect(disk.value, poisoned);
      // A binding that never saved keys is simply awaiting its first delivery.
      final fresh = SpaceCrypto(record, identity, MemorySpacePersistence());
      await fresh.load();
      expect(fresh.needsRepair, false);
    });
  });
}

/// Persistence whose writes yield, so concurrent installs interleave.
class _SlowPersistence extends MemorySpacePersistence {
  _SlowPersistence(this.writes);
  final List<int> writes;
  @override
  Future<void> write(String value) async {
    await Future<void>.delayed(const Duration(milliseconds: 5));
    writes.add(jsonMap(value)['epoch'] as int);
    await super.write(value);
  }
}

/// Parks the first envelope signature so a rotation can land mid-seal.
class _GatedCrypto extends SpaceCrypto {
  _GatedCrypto(super.space, super.identity, super.secrets);
  final parked = Completer<void>(), gate = Completer<void>();
  int signatures = 0;
  @override
  Future<String> signControl(
    Map<String, dynamic> payload, {
    String type = 'nova-control+jws',
  }) async {
    if (type == 'nova-envelope+jws' && signatures++ == 0) {
      parked.complete();
      await gate.future;
    }
    return super.signControl(payload, type: type);
  }
}

/// Persistence whose next write can be held open.
class _HeldPersistence extends MemorySpacePersistence {
  Completer<void>? hold;
  final started = Completer<void>();
  @override
  Future<void> write(String value) async {
    final gate = hold;
    if (gate != null) {
      if (!started.isCompleted) started.complete();
      await gate.future;
    }
    await super.write(value);
  }
}
