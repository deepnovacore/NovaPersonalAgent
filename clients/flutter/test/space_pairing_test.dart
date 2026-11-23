import 'dart:convert';
import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'retrying a scan after a lost response reuses its Space and device keys',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      HttpOverrides.global = null;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final host = await SpaceIdentity.generate();
      final requests = <Map<String, dynamic>>[];
      var admitted = false;
      Future<void> handle(HttpRequest request) async {
        final body = jsonMap(await utf8.decoder.bind(request).join());
        request.response.headers.contentType = ContentType.json;
        if (request.uri.path == '/v1/auth/challenge') {
          request.response.statusCode = admitted ? 200 : 401;
          request.response.write(
            jsonEncode(
              admitted
                  ? {
                      'id': 'challenge',
                      'nonce': 'nonce',
                      'space': body['space'],
                      'device': body['device'],
                      'epoch': 2,
                      'expiresAt':
                          DateTime.now().millisecondsSinceEpoch + 60000,
                    }
                  : {'error': 'device_inactive'},
            ),
          );
        } else if (request.uri.path == '/v1/auth/session') {
          request.response.write(
            jsonEncode({
              'token': 'session',
              'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
              'selected_version': 1,
              'principal': {
                'space': signingFingerprint(host.signingPublic),
                'device': requests.last['device'],
                'epoch': 2,
              },
            }),
          );
        } else {
          requests.add(body);
          request.response.statusCode = requests.length == 1 ? 503 : 200;
          request.response.write(
            jsonEncode(
              requests.length == 1
                  ? {'error': 'temporary_unavailable'}
                  : {'id': 'pending'},
            ),
          );
        }
        await request.response.close();
      }

      final subscription = server.listen(handle);
      final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
      await catalog.open();
      final invitation = SpaceInvitation.parse(
        jsonEncode({
          'id': 'invitation',
          'space': signingFingerprint(host.signingPublic),
          'host': 'host',
          'hostSigningPublicKey': host.signingPublic,
          'relay': 'http://127.0.0.1:${server.port}',
          'secret': 'one-time-secret',
          'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
          'business_versions': [1],
        }),
        allowLoopback: true,
      );
      try {
        await expectLater(
          invitation.pair('Remote', catalog, allowLoopback: true),
          throwsA(isA<RelayFailure>()),
        );
        final first = catalog.spaces.single;
        final identity = await SpaceSecurePersistence(
          'nova.space.identity.${first.id}',
        ).read();
        final retried = await invitation.pair(
          'Remote again',
          catalog,
          allowLoopback: true,
        );
        expect(catalog.spaces, hasLength(1));
        expect(retried.id, first.id);
        expect(retried.device, first.device);
        expect(catalog.selectedId, first.id);
        expect(
          await SpaceSecurePersistence(
            'nova.space.identity.${first.id}',
          ).read(),
          identity,
        );
        expect(
          requests[1]['signingPublicKey'],
          requests[0]['signingPublicKey'],
        );
        final keys = SpaceSecurePersistence('nova.space.keys.${first.id}');
        final saved = jsonEncode({
          'epoch': 2,
          'keys': {'2': b64url(List.filled(32, 7))},
        });
        await keys.write(saved);
        admitted = true;
        final active = await invitation.pair(
          'Already paired',
          catalog,
          allowLoopback: true,
        );
        expect(active.id, first.id);
        expect(requests, hasLength(2));
        expect(
          await keys.read(),
          saved,
          reason: 'an existing content key must survive a new scan',
        );
        final moved = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final movedSubscription = moved.listen(handle);
        try {
          final movedInvite = SpaceInvitation.parse(
            jsonEncode({
              ...invitation.value,
              'relay': 'http://127.0.0.1:${moved.port}',
            }),
            allowLoopback: true,
          );
          final rebound = await movedInvite.pair(
            'Renamed computer',
            catalog,
            allowLoopback: true,
          );
          expect(rebound.id, first.id);
          expect(rebound.device, first.device);
          expect(catalog.spaces, hasLength(1));
          expect(catalog.spaces.single.relay, 'http://127.0.0.1:${moved.port}');
          expect(catalog.spaces.single.name, 'Renamed computer');
          expect(await keys.read(), saved);
          expect(
            await SpaceSecurePersistence(
              'nova.space.identity.${first.id}',
            ).read(),
            identity,
          );
        } finally {
          await movedSubscription.cancel();
          await moved.close(force: true);
        }
      } finally {
        catalog.dispose();
        SpaceStorage.active = null;
        await subscription.cancel();
        await server.close(force: true);
      }
    },
  );

  for (final poisoned in [false, true]) {
    test(
      poisoned
          ? 'a legacy binding with an unproven epoch re-pairs as a fresh device'
          : 'an inactive answer pairs a fresh device and never loses the old binding',
      () async {
        FlutterSecureStorage.setMockInitialValues({});
        HttpOverrides.global = null;
        final host = await SpaceIdentity.generate();
        final space = signingFingerprint(host.signingPublic);
        final old = await SpaceIdentity.generate();
        final requests = <Map<String, dynamic>>[];
        final logins = <String>[];
        // The relay keeps revoked rows (their ids and keys are taken), and it
        // can also answer "inactive" falsely: the client cannot tell which.
        const oldDevice = 'old-device';
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final subscription = server.listen((request) async {
          final body = jsonMap(await utf8.decoder.bind(request).join());
          request.response.headers.contentType = ContentType.json;
          if (request.uri.path == '/v1/auth/challenge') {
            logins.add(body['device'] as String);
            request.response.statusCode = 401;
            request.response.write(jsonEncode({'error': 'device_inactive'}));
          } else {
            requests.add(body);
            final taken =
                body['device'] == oldDevice ||
                jsonEncode(body['signingPublicKey']) ==
                    jsonEncode(old.signingPublic);
            request.response.statusCode = taken ? 409 : 200;
            request.response.write(
              jsonEncode(
                taken ? {'error': 'device_exists'} : {'id': 'pending'},
              ),
            );
          }
          await request.response.close();
        });
        final relay = 'http://127.0.0.1:${server.port}';
        final previous = SpaceRecord(
          id: 'old-binding',
          name: 'Computer',
          mode: SpaceMode.client,
          remoteSpace: space,
          hostDevice: 'host',
          hostSigningKey: host.signingPublic,
          relay: relay,
          device: oldDevice,
        );
        final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
        await catalog.open();
        await catalog.add(previous);
        Future<Map<String, String?>> oldSecrets() async => {
          for (final name in ['identity', 'keys', 'pair-request'])
            name: await SpaceSecurePersistence(
              'nova.space.$name.old-binding',
            ).read(),
        };
        await SpaceSecurePersistence(
          'nova.space.identity.old-binding',
        ).write(jsonEncode(old.toJson()));
        await SpaceSecurePersistence('nova.space.keys.old-binding').write(
          jsonEncode(
            poisoned
                // Written by older builds from a relay-supplied epoch.
                ? {'epoch': 1 << 40, 'keys': {}}
                : {
                    'epoch': 1,
                    'keys': {'1': b64url(List.filled(32, 9))},
                  },
          ),
        );
        // The original pairing request survives admission and revocation.
        await SpaceSecurePersistence(
          'nova.space.pair-request.old-binding',
        ).write(jsonEncode({'invitationId': 'first', 'device': oldDevice}));
        final before = await oldSecrets();
        final invitation = SpaceInvitation.parse(
          jsonEncode({
            'id': 'second',
            'space': space,
            'host': 'host',
            'hostSigningPublicKey': host.signingPublic,
            'relay': relay,
            'secret': 'one-time-secret',
            'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
            'business_versions': [1],
          }),
          allowLoopback: true,
        );
        try {
          final paired = await invitation.pair(
            'Computer',
            catalog,
            allowLoopback: true,
          );
          expect(
            logins,
            poisoned ? isEmpty : [oldDevice],
            reason: 'a legacy binding is never used to log in',
          );
          expect(paired.id, isNot('old-binding'));
          expect(paired.device, isNot(oldDevice));
          expect(catalog.selectedId, paired.id);
          final fresh = SpaceIdentity.fromJson(
            jsonMap(
              (await SpaceSecurePersistence(
                'nova.space.identity.${paired.id}',
              ).read())!,
            ),
          );
          expect(fresh.signingPublic, isNot(old.signingPublic));
          expect(fresh.encryptionPublic, isNot(old.encryptionPublic));
          final sent = requests.single;
          expect(sent['invitationId'], 'second');
          expect(sent['device'], paired.device);
          expect(sent['signingPublicKey'], fresh.signingPublic);
          expect(sent['encryptionPublicKey'], fresh.encryptionPublic);
          final proof = await SpaceCrypto.verifyJws(
            sent['proof'] as String,
            fresh.signingPublic,
            type: 'nova-control+jws',
          );
          expect(proof['device'], paired.device);
          // The old binding is never retired or erased automatically; only
          // the Host-confirmed cleanup flow removes it.
          expect(catalog.spaces.map((v) => v.id), ['old-binding', paired.id]);
          expect(catalog.retired, isEmpty);
          expect(await oldSecrets(), before);
          expect(catalog.bindings(paired), hasLength(2));
        } finally {
          catalog.dispose();
          SpaceStorage.active = null;
          await subscription.cancel();
          await server.close(force: true);
        }
      },
    );
  }
}
