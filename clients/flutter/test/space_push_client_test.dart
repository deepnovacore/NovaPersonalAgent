import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/push_client.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

class _ActualHttp extends HttpOverrides {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'restart after registration disk commit reconstructs same Host operation before returning',
    () async {
      final disk = MemorySpacePersistence()
        ..value = jsonEncode({
          'enabled': true,
          'provider': 'apns',
          'token': 'device-token',
          'handle': 'opaque-handle',
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
        admissionKey: 'deployment-config-only',
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
        admissionKey: 'deployment-config-only',
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
        admissionKey: 'deployment',
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
