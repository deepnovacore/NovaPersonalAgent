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
      final subscription = server.listen((request) async {
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
      });
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
      } finally {
        catalog.dispose();
        SpaceStorage.active = null;
        await subscription.cancel();
        await server.close(force: true);
      }
    },
  );
}
