import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'refresh is single flight; persisted uncertain rotation requires a new login',
    () async {
      final clock = DateTime.utc(2026, 10, 17), disk = MemoryLifePersistence();
      disk.value = jsonEncode({
        'version': 1,
        'generation': 1,
        'app': {
          'brand': 'feishu',
          'app_id': 'cli_fixture',
          'secret': 'synthetic',
        },
        'identity': {'open_id': 'person'},
        'credential': {
          'access_token': 'expired',
          'refresh_token': 'old',
          'expires_at': 0,
          'refresh_expires_at': clock
              .add(const Duration(days: 1))
              .millisecondsSinceEpoch,
        },
      });
      final entered = Completer<void>(), response = Completer<FeishuResponse>();
      var calls = 0;
      final api = FeishuApi(
        transport: (m, u, h, b) async {
          calls++;
          entered.complete();
          return response.future;
        },
      );
      final auth = FeishuAuth(disk, api, now: () => clock);
      await auth.open();
      final one = auth.accessToken(), two = auth.accessToken();
      await entered.future;
      final crashDisk = MemoryLifePersistence()..value = disk.value;
      final reopened = FeishuAuth(crashDisk, api, now: () => clock);
      await reopened.open();
      expect(reopened.authorized, false);
      response.complete(
        FeishuResponse(200, {
          'access_token': 'new',
          'refresh_token': 'rotated',
          'expires_in': 7200,
          'refresh_token_expires_in': 86400,
          'scope': feishuReadScopes.join(' '),
          'token_type': 'Bearer',
        }),
      );
      expect(await one, 'new');
      expect(await two, 'new');
      expect(calls, 1);
    },
  );
  test(
    'expired refresh and failed remote revocation never silently restore authorization',
    () async {
      final disk = MemoryLifePersistence(), clock = DateTime.utc(2026, 10, 17);
      disk.value = jsonEncode({
        'version': 1,
        'generation': 1,
        'app': {
          'brand': 'feishu',
          'app_id': 'cli_fixture',
          'secret': 'synthetic',
        },
        'identity': {'open_id': 'person'},
        'credential': {
          'access_token': 'expired',
          'refresh_token': 'old',
          'expires_at': 0,
          'refresh_expires_at': 0,
        },
      });
      var attempts = 0;
      final auth = FeishuAuth(
        disk,
        FeishuApi(
          transport: (m, u, h, b) async {
            attempts++;
            return FeishuResponse(
              attempts == 1 ? 503 : 200,
              attempts == 1 ? {'error': 'unavailable'} : {},
            );
          },
        ),
        now: () => clock,
      );
      await auth.open();
      await expectLater(auth.accessToken(), throwsA(isA<FeishuFailure>()));
      expect(attempts, 0);
      await expectLater(
        auth.disconnect(revoke: true),
        throwsA(isA<FeishuFailure>()),
      );
      expect(auth.authorized, false);
      expect(auth.revocationPending, true);
      await auth.retryRevocation();
      expect(auth.revocationPending, false);
      expect(auth.authorized, false);
    },
  );
  test(
    'device authorization verifies identity and scopes before storing a usable credential',
    () async {
      var clock = DateTime.utc(2026, 10, 17);
      var polls = 0;
      final api = FeishuApi(
        transport: (method, uri, headers, body) async {
          expect(uri.scheme, 'https');
          expect(['accounts.feishu.cn', 'open.feishu.cn'], contains(uri.host));
          if (uri.path == '/oauth/v1/device_authorization') {
            expect(headers['authorization'], startsWith('Basic '));
            return const FeishuResponse(200, {
              'device_code': 'private-code',
              'user_code': 'ABCD',
              'verification_uri_complete':
                  'https://accounts.feishu.cn/verify?user_code=ABCD',
              'expires_in': 300,
              'interval': 5,
            });
          }
          if (uri.path == '/oauth/v3/token') {
            polls++;
            if (polls == 1) {
              return const FeishuResponse(400, {'error': 'slow_down'});
            }
            return FeishuResponse(200, {
              'access_token': 'access',
              'refresh_token': 'refresh',
              'expires_in': 7200,
              'refresh_token_expires_in': 86400,
              'scope': feishuReadScopes.join(' '),
              'token_type': 'Bearer',
            });
          }
          expect(uri.path, '/open-apis/authen/v1/user_info');
          return const FeishuResponse(200, {
            'code': 0,
            'data': {
              'open_id': 'person',
              'tenant_key': 'tenant',
              'name': 'Fixture',
            },
          });
        },
      );
      final auth = FeishuAuth(MemoryLifePersistence(), api, now: () => clock);
      await auth.open();
      await auth.bindApp(
        brand: 'feishu',
        appId: 'cli_fixture',
        secret: 'fixture-secret',
      );
      expect(auth.authorized, false);
      final session = await auth.beginAuthorization();
      expect(session.userCode, 'ABCD');
      expect(await auth.pollAuthorization(), false);
      expect(polls, 0);
      clock = clock.add(const Duration(seconds: 5));
      expect(await auth.pollAuthorization(), false);
      clock = clock.add(const Duration(seconds: 5));
      expect(await auth.pollAuthorization(), false);
      expect(polls, 1);
      clock = clock.add(const Duration(seconds: 5));
      expect(await auth.pollAuthorization(), true);
      expect(auth.authorized, true);
      expect(auth.identity?['open_id'], 'person');
    },
  );

  test(
    'late token response cannot restore an account after local disconnect',
    () async {
      var clock = DateTime.utc(2026);
      final response = Completer<FeishuResponse>();
      final entered = Completer<void>();
      final api = FeishuApi(
        transport: (method, uri, headers, body) async {
          if (uri.path.endsWith('device_authorization')) {
            return const FeishuResponse(200, {
              'device_code': 'private',
              'user_code': 'A',
              'verification_uri': 'https://accounts.feishu.cn/verify',
              'expires_in': 300,
              'interval': 1,
            });
          }
          entered.complete();
          return response.future;
        },
      );
      final auth = FeishuAuth(MemoryLifePersistence(), api, now: () => clock);
      await auth.open();
      await auth.bindApp(
        brand: 'feishu',
        appId: 'cli_fixture',
        secret: 'secret',
      );
      await auth.beginAuthorization();
      clock = clock.add(const Duration(seconds: 1));
      final polling = auth.pollAuthorization();
      await entered.future;
      await auth.disconnect();
      response.complete(
        FeishuResponse(200, {
          'access_token': 'old',
          'refresh_token': 'old',
          'expires_in': 7200,
          'refresh_token_expires_in': 86400,
          'scope': feishuReadScopes.join(' '),
          'token_type': 'Bearer',
        }),
      );
      await expectLater(polling, throwsA(isA<FeishuFailure>()));
      expect(auth.authorized, false);
    },
  );

  test(
    'verification URI cannot exfiltrate a device authorization to another host',
    () async {
      final auth = FeishuAuth(
        MemoryLifePersistence(),
        FeishuApi(
          transport: (m, u, h, b) async => const FeishuResponse(200, {
            'device_code': 'secret',
            'user_code': 'A',
            'verification_uri': 'https://attacker.invalid/verify',
            'expires_in': 300,
            'interval': 5,
          }),
        ),
      );
      await auth.open();
      await auth.bindApp(
        brand: 'feishu',
        appId: 'cli_fixture',
        secret: 'secret',
      );
      await expectLater(
        auth.beginAuthorization(),
        throwsA(isA<FeishuFailure>()),
      );
      expect(auth.authorized, false);
    },
  );
}
