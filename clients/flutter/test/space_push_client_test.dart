import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:nova_mobile/space/push_invitation_dialog.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/push_client.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

class _ActualHttp extends HttpOverrides {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'disable from another instance wins over a delayed permission grant',
    () async {
      final disk = MemorySpacePersistence()
        ..value = jsonEncode({'enabled': false});
      final installation = MemorySpacePersistence()
        ..value = jsonEncode({
          'installationId': 'one',
          'credential': 'installation-secret',
        });
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      final entered = Completer<void>(), permission = Completer<bool>();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SpacePushClient.channel, (call) async {
            if (call.method == 'requestPermission') {
              entered.complete();
              return permission.future;
            }
            return null;
          });
      SpacePushClient make() => SpacePushClient(
        const SpaceRecord(
          id: 'permission-race',
          name: 'Client',
          mode: SpaceMode.client,
        ),
        state,
        onWake: () async {},
        persistence: disk,
        installationPersistence: installation,
        gatewayUrl: 'https://gateway.example',
        request: (gateway, method, path, credential, {body}) async => {
          'installationId': 'one',
        },
      );
      final first = make(), second = make();
      final enabling = first.enable();
      await entered.future;
      await second.disable();
      permission.complete(true);
      await enabling;
      expect(jsonDecode(disk.value!)['enabled'], false);
      expect(state.pending, isEmpty);
      await first.dispose();
      await second.dispose();
    },
  );
  test('disable wins while an invitation dialog is still pending', () async {
    final disk = MemorySpacePersistence()
      ..value = jsonEncode({'enabled': false});
    final installation = MemorySpacePersistence();
    final state = SpaceClientState(MemorySpacePersistence());
    await state.open();
    final entered = Completer<void>(), invitation = Completer<String?>();
    var httpCalls = 0;
    SpacePushClient make() => SpacePushClient(
      const SpaceRecord(
        id: 'invitation-race',
        name: 'Client',
        mode: SpaceMode.client,
      ),
      state,
      onWake: () async {},
      persistence: disk,
      installationPersistence: installation,
      gatewayUrl: 'https://gateway.example',
      request: (gateway, method, path, credential, {body}) async {
        httpCalls++;
        return {};
      },
    );
    final first = make(), second = make();
    final enabling = first.enable(
      requestInvitation: () {
        entered.complete();
        return invitation.future;
      },
    );
    await entered.future;
    await second.disable();
    invitation.complete('unused-invitation');
    await enabling;
    expect(jsonDecode(disk.value!)['enabled'], false);
    expect(httpCalls, 0);
    await first.dispose();
    await second.dispose();
  });
  test(
    'expired installation asks for a fresh invitation on the same enable action',
    () async {
      final installation = MemorySpacePersistence()
        ..value = jsonEncode({
          'installationId': 'expired',
          'credential': 'expired-credential',
        });
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      var invited = false;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            SpacePushClient.channel,
            (_) async => false,
          );
      final push = SpacePushClient(
        const SpaceRecord(
          id: 'expired-installation',
          name: 'Client',
          mode: SpaceMode.client,
        ),
        state,
        onWake: () async {},
        persistence: MemorySpacePersistence(),
        installationPersistence: installation,
        gatewayUrl: 'https://gateway.example',
        request: (gateway, method, path, credential, {body}) async {
          if (method == 'GET') throw const RelayFailure('gateway_401');
          expect(path, '/v1/installations');
          expect(credential, 'fresh-invitation');
          return {'installationId': 'fresh'};
        },
      );
      await push.enable(
        requestInvitation: () async {
          invited = true;
          return 'fresh-invitation';
        },
      );
      expect(invited, true);
      expect(jsonDecode(installation.value!)['installationId'], 'fresh');
      await push.dispose();
    },
  );
  testWidgets(
    'invitation dialog obscures secrets and can cancel without redemption',
    (tester) async {
      String? redeemed;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                redeemed = await showDialog<String>(
                  context: context,
                  builder: (_) => const PushInvitationDialog(),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).obscureText,
        true,
      );
      await tester.enterText(find.byType(TextField), 'secret-invite');
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(redeemed, isNull);
      expect(tester.takeException(), isNull);
    },
  );
  test(
    'lease rotation resumes the same registration after response loss and never sends installation credential to Host',
    () async {
      final instant = DateTime.utc(2026, 10, 24);
      final disk = MemorySpacePersistence()
        ..value = jsonEncode({
          'enabled': true,
          'provider': 'fcm',
          'token': 'token',
          'handle': 'old-handle',
          'credential': 'old-credential',
          'expiresAt': instant.millisecondsSinceEpoch + 1000,
        });
      final installation = MemorySpacePersistence()
        ..value = jsonEncode({
          'installationId': 'one',
          'credential': 'private-installation-credential',
        });
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            SpacePushClient.channel,
            (call) async => call.method == 'getToken'
                ? {'provider': 'fcm', 'token': 'token'}
                : null,
          );
      final ids = <String>[];
      final deletes = <String>[];
      Future<Map<String, dynamic>> request(
        String gateway,
        String method,
        String path,
        String credential, {
        Map<String, dynamic>? body,
      }) async {
        if (method == 'DELETE') {
          deletes.add(path);
          return {'status': 'unregistered'};
        }
        expect(method, 'POST');
        expect(path, '/v1/registrations');
        expect(credential, 'private-installation-credential');
        ids.add(body!['registrationId'] as String);
        expect(
          (jsonDecode(disk.value!)['pending_registration']
              as Map)['registrationId'],
          ids.last,
        );
        if (ids.length == 1) throw StateError('lost gateway response');
        return {
          'handle': 'new-handle',
          'credential': 'new-scoped-credential',
          'expiresAt': instant
              .add(const Duration(days: 30))
              .millisecondsSinceEpoch,
        };
      }

      SpacePushClient make() => SpacePushClient(
        const SpaceRecord(id: 'leased', name: 'Client', mode: SpaceMode.client),
        state,
        onWake: () async {},
        persistence: disk,
        installationPersistence: installation,
        gatewayUrl: 'https://gateway.example',
        request: request,
        now: () => instant,
      );
      final first = make();
      await expectLater(first.refreshRegistration(), throwsStateError);
      await first.dispose();
      final recovered = make();
      await recovered.refreshRegistration();
      expect(ids.length, 2);
      expect(ids.toSet().length, 1);
      expect(deletes, ['/v1/registrations/old-handle']);
      expect(jsonDecode(disk.value!)['handle'], 'new-handle');
      expect(
        jsonEncode(state.pending),
        isNot(contains('private-installation-credential')),
      );
      expect(state.pending.single['op_id'], 'push_new-handle');
      await recovered.refreshRegistration();
      expect(ids.length, 2);
      await recovered.disable();
      await recovered.refreshRegistration();
      expect(ids.length, 2);
      expect(jsonDecode(disk.value!)['enabled'], false);
      await recovered.dispose();
    },
  );
  test(
    'legacy handle learns its server lease before unchanged-token shortcut',
    () async {
      final disk = MemorySpacePersistence()
        ..value = jsonEncode({
          'enabled': true,
          'provider': 'fcm',
          'token': 'same-token',
          'handle': 'legacy',
          'credential': 'scoped',
        });
      final installation = MemorySpacePersistence();
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      final expiry = DateTime.now()
          .add(const Duration(days: 30))
          .millisecondsSinceEpoch;
      var calls = 0;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            SpacePushClient.channel,
            (call) async => call.method == 'getToken'
                ? {'provider': 'fcm', 'token': 'same-token'}
                : null,
          );
      final push = SpacePushClient(
        const SpaceRecord(id: 'legacy', name: 'legacy', mode: SpaceMode.client),
        state,
        onWake: () async {},
        persistence: disk,
        installationPersistence: installation,
        gatewayUrl: 'https://gateway.example',
        request: (gateway, method, path, credential, {body}) async {
          expect(method, 'PUT');
          expect(credential, 'scoped');
          calls++;
          return {'expiresAt': expiry};
        },
      );
      await push.refreshRegistration();
      await push.refreshRegistration();
      expect(calls, 1);
      expect(jsonDecode(disk.value!)['expiresAt'], expiry);
      await push.dispose();
    },
  );
  test(
    'invitation redemption resumes after response loss and is shared across Spaces',
    () async {
      final installation = MemorySpacePersistence();
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      var attempts = 0;
      final secrets = <String>[];
      Future<Map<String, dynamic>> request(
        String gateway,
        String method,
        String path,
        String credential, {
        Map<String, dynamic>? body,
      }) async {
        if (method == 'GET') throw const RelayFailure('gateway_401');
        expect(path, '/v1/installations');
        expect(credential, 'one-time-invitation');
        secrets.add(body!['credential'] as String);
        expect(jsonDecode(installation.value!)['credential'], secrets.last);
        if (++attempts == 1) throw StateError('lost response');
        return {'installationId': 'installation-one'};
      }

      SpacePushClient client(String id) => SpacePushClient(
        SpaceRecord(id: id, name: id, mode: SpaceMode.client),
        state,
        onWake: () async {},
        gatewayUrl: 'https://gateway.example',
        installationPersistence: installation,
        request: request,
      );
      final first = client('first');
      await expectLater(
        first.redeemInvitation('one-time-invitation'),
        throwsStateError,
      );
      expect(await first.needsInvitation(), true);
      final restarted = client('second');
      await restarted.redeemInvitation('one-time-invitation');
      expect(secrets.toSet().length, 1);
      expect(await first.needsInvitation(), false);
      await restarted.redeemInvitation('another-dialog-invitation');
      expect(attempts, 2);
      expect(jsonDecode(installation.value!).containsKey('invitation'), false);
      expect(state.pending, isEmpty);
    },
  );
  test(
    'restart after registration disk commit reconstructs same Host operation before returning',
    () async {
      final disk = MemorySpacePersistence()
        ..value = jsonEncode({
          'enabled': true,
          'provider': 'apns',
          'token': 'device-token',
          'handle': 'opaque-handle',
          'expiresAt': DateTime.now()
              .add(const Duration(days: 30))
              .millisecondsSinceEpoch,
          'credential': 'scoped-credential',
        });
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            SpacePushClient.channel,
            (call) async => call.method == 'getToken'
                ? {'provider': 'apns', 'token': 'device-token'}
                : null,
          );
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('nova/space_push/events'),
            (_) async => null,
          );
      const space = SpaceRecord(
        id: 'client',
        name: 'Client',
        mode: SpaceMode.client,
      );
      var push = SpacePushClient(
        space,
        state,
        onWake: () async {},
        persistence: disk,
        gatewayUrl: 'https://gateway.example',
      );
      await push.start();
      expect(state.pending.single['op_id'], 'push_opaque-handle');
      expect(
        (state.pending.single['input'] as Map).containsKey('token'),
        false,
      );
      expect(push.status, contains('等待 Host'));
      await push.dispose();
      push = SpacePushClient(
        space,
        state,
        onWake: () async {},
        persistence: disk,
        gatewayUrl: 'https://gateway.example',
      );
      await push.start();
      expect(state.pending.length, 1);
      await push.dispose();
    },
  );
  test(
    'concurrent token refresh key install and disable preserve durable opt-out',
    () async {
      const space = SpaceRecord(
        id: 'concurrent',
        name: 'Client',
        mode: SpaceMode.client,
      );
      final initial = {
        'enabled': true,
        'provider': 'apns',
        'token': 'old-token',
        'handle': 'handle',
        'credential': 'credential',
        'gateway_url': 'https://gateway.example',
      };
      FlutterSecureStorage.setMockInitialValues({
        'nova.space.push.concurrent': jsonEncode(initial),
      });
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      final entered = Completer<void>(), release = Completer<void>();
      Future<Map<String, dynamic>> request(
        String gateway,
        String method,
        String path,
        String credential, {
        Map<String, dynamic>? body,
      }) async {
        if (method == 'PUT') {
          entered.complete();
          await release.future;
        }
        return {'status': 'ok'};
      }

      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SpacePushClient.channel, (_) async => null);
      final push = SpacePushClient(
        space,
        state,
        onWake: () async {},
        gatewayUrl: 'https://gateway.example',
        request: request,
      );
      final refresh = SpacePushClient.refreshSavedTokens(
        {'provider': 'apns', 'token': 'new-token'},
        [space],
        request: request,
      );
      await entered.future;
      final install = push.installKey({
        'handle': 'handle',
        'notification_key': base64UrlEncode(List.filled(32, 7)),
      });
      final disable = push.disable();
      release.complete();
      await refresh;
      await install;
      await disable;
      final saved =
          jsonDecode(
                (await const SpaceSecurePersistence(
                  'nova.space.push.concurrent',
                ).read())!,
              )
              as Map;
      expect(saved['enabled'], false);
      expect(saved.containsKey('notification_key'), false);
      expect(saved.containsKey('handle'), false);
      expect(state.pending.any((p) => p['kind'] == 'push.unregister'), true);
      await push.dispose();
    },
  );
  test(
    'concurrent token refresh merges a received key without losing the refreshed token',
    () async {
      const space = SpaceRecord(
        id: 'key-merge',
        name: 'Client',
        mode: SpaceMode.client,
      );
      FlutterSecureStorage.setMockInitialValues({
        'nova.space.push.key-merge': jsonEncode({
          'enabled': true,
          'provider': 'fcm',
          'token': 'old',
          'handle': 'h',
          'credential': 'c',
          'gateway_url': 'https://gateway.example',
        }),
      });
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      final entered = Completer<void>(), release = Completer<void>();
      Future<Map<String, dynamic>> request(
        String gateway,
        String method,
        String path,
        String credential, {
        Map<String, dynamic>? body,
      }) async {
        entered.complete();
        await release.future;
        return {'status': 'ok'};
      }

      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SpacePushClient.channel, (_) async => null);
      final push = SpacePushClient(
        space,
        state,
        onWake: () async {},
        gatewayUrl: 'https://gateway.example',
        request: request,
      );
      final refresh = SpacePushClient.refreshSavedTokens(
        {'provider': 'fcm', 'token': 'new'},
        [space],
        request: request,
      );
      await entered.future;
      final key = base64UrlEncode(List.filled(32, 9));
      final installed = push.installKey({
        'handle': 'h',
        'notification_key': key,
      });
      release.complete();
      await refresh;
      await installed;
      final saved =
          jsonDecode(
                (await const SpaceSecurePersistence(
                  'nova.space.push.key-merge',
                ).read())!,
              )
              as Map;
      expect(saved['token'], 'new');
      expect(saved['notification_key'], key);
      expect(saved['enabled'], true);
      await push.dispose();
    },
  );
  test(
    'gateway response body has a total deadline and releases a stalled connection',
    () async {
      await HttpOverrides.runWithHttpOverrides(() async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final release = Completer<void>();
        final serving = server.listen((request) async {
          await request.drain<void>();
          request.response.headers.contentType = ContentType.json;
          request.response.write('{"ok":');
          await request.response.flush();
          await release.future;
          try {
            request.response.write('true}');
            await request.response.close();
          } catch (_) {
            /* Client deadline already closed the connection. */
          }
        });
        try {
          await expectLater(
            SpacePushClient.gatewayRequest(
              'http://127.0.0.1:${server.port}',
              'PUT',
              '/v1/registrations/test',
              'test-only',
              body: {'provider': 'fcm', 'token': 'test-token'},
              allowLoopback: true,
              responseBodyTimeout: const Duration(milliseconds: 150),
            ),
            throwsA(isA<TimeoutException>()),
          );
        } finally {
          release.complete();
          await server.close(force: true);
          await serving.cancel();
        }
      }, _ActualHttp());
    },
  );
  test(
    'key inbox is durable before a gateway mutation releases its registration lock',
    () async {
      const space = SpaceRecord(
        id: 'inbox',
        name: 'Client',
        mode: SpaceMode.client,
      );
      FlutterSecureStorage.setMockInitialValues({
        'nova.space.push.inbox': jsonEncode({
          'enabled': true,
          'provider': 'fcm',
          'token': 'old',
          'handle': 'h',
          'credential': 'c',
          'gateway_url': 'https://gateway.example',
        }),
      });
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      final entered = Completer<void>(), release = Completer<void>();
      Future<Map<String, dynamic>> request(
        String gateway,
        String method,
        String path,
        String credential, {
        Map<String, dynamic>? body,
      }) async {
        entered.complete();
        await release.future;
        return {'ok': true};
      }

      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SpacePushClient.channel, (_) async => null);
      final push = SpacePushClient(
        space,
        state,
        onWake: () async {},
        gatewayUrl: 'https://gateway.example',
        request: request,
      );
      final refresh = SpacePushClient.refreshSavedTokens(
        {'provider': 'fcm', 'token': 'new'},
        [space],
        request: request,
      );
      await entered.future;
      final key = base64UrlEncode(List.filled(32, 5));
      await push
          .acceptKey({
            'v': 1,
            'type': 'push.key',
            'handle': 'h',
            'notification_key': key,
          })
          .timeout(const Duration(seconds: 1));
      final inbox =
          jsonDecode(
                (await const SpaceSecurePersistence(
                  'nova.space.push.key-inbox.inbox',
                ).read())!,
              )
              as Map;
      expect((inbox['payload'] as Map)['notification_key'], key);
      expect(release.isCompleted, false);
      release.complete();
      await refresh;
      await push.flushPendingKeys();
      final saved =
          jsonDecode(
                (await const SpaceSecurePersistence(
                  'nova.space.push.inbox',
                ).read())!,
              )
              as Map;
      expect(saved['token'], 'new');
      expect(saved['notification_key'], key);
      expect(
        await const SpaceSecurePersistence(
          'nova.space.push.key-inbox.inbox',
        ).read(),
        '{}',
      );
      await push.dispose();
    },
  );
}
