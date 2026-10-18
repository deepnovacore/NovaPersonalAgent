import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test('registration starts without secrets and discovers Lark', () async {
    var clock = DateTime.utc(2026, 10, 18);
    final disk = MemoryLifePersistence();
    var calls = 0;
    final auth = FeishuAuth(
      disk,
      FeishuApi(
        transport: (m, u, h, b) async {
          expect(u.path, '/oauth/v1/app/registration');
          expect(h.containsKey('authorization'), false);
          final form = Uri.splitQueryString(b!);
          calls++;
          if (form['action'] == 'begin') {
            expect(u.host, 'accounts.feishu.cn');
            expect(form['archetype'], 'PersonalAgent');
            return const FeishuResponse(200, {
              'device_code': 'fixture',
              'user_code': 'A&B',
              'expire_in': 600,
            });
          }
          if (calls == 2) {
            return const FeishuResponse(400, {
              'error': 'authorization_pending',
              'user_info': {'tenant_brand': 'lark'},
            });
          }
          expect(u.host, 'accounts.larksuite.com');
          if (calls == 3) {
            return const FeishuResponse(400, {'error': 'slow_down'});
          }
          return const FeishuResponse(200, {
            'client_id': 'cli_fixture',
            'client_secret': 'synthetic',
            'user_info': {'tenant_brand': 'lark'},
          });
        },
      ),
      now: () => clock,
    );
    await auth.open();
    final session = await auth.beginAppRegistration('lark');
    expect(session.verificationUri.host, 'open.larksuite.com');
    expect(session.verificationUri.queryParameters['user_code'], 'A&B');
    expect(await auth.pollAppRegistration(), false);
    expect(calls, 3);
    clock = clock.add(const Duration(seconds: 5));
    expect(await auth.pollAppRegistration(), false);
    expect(calls, 3);
    clock = clock.add(const Duration(seconds: 5));
    expect(await auth.pollAppRegistration(), true);
    expect(auth.configured, true);
    expect(auth.authorized, false);
    expect(auth.brand, 'lark');
    expect(jsonDecode(disk.value!)['app']['secret'], 'synthetic');
    expect(disk.value, isNot(contains('device_code')));
  });

  test('cancel rejects late registration credentials', () async {
    final reply = Completer<FeishuResponse>(), entered = Completer<void>();
    final auth = FeishuAuth(
      MemoryLifePersistence(),
      FeishuApi(
        transport: (m, u, h, b) async {
          if (Uri.splitQueryString(b!)['action'] == 'begin') {
            return const FeishuResponse(200, {
              'device_code': 'fixture',
              'user_code': 'test',
            });
          }
          entered.complete();
          return reply.future;
        },
      ),
    );
    await auth.beginAppRegistration('feishu');
    final poll = auth.pollAppRegistration();
    final check = expectLater(poll, throwsA(isA<FeishuFailure>()));
    await entered.future;
    await auth.cancelAppRegistration();
    reply.complete(
      const FeishuResponse(200, {
        'client_id': 'cli_late',
        'client_secret': 'synthetic',
      }),
    );
    await check;
    expect(auth.configured, false);
  });

  for (final outcome in ['access_denied', 'expired_token', 'invalid_grant']) {
    test('terminal $outcome never stores registration credentials', () async {
      final auth = FeishuAuth(
        MemoryLifePersistence(),
        FeishuApi(
          transport: (m, u, h, b) async {
            return Uri.splitQueryString(b!)['action'] == 'begin'
                ? const FeishuResponse(200, {
                    'device_code': 'fixture',
                    'user_code': 'test',
                  })
                : FeishuResponse(400, {'error': outcome});
          },
        ),
      );
      await auth.beginAppRegistration('feishu');
      await expectLater(
        auth.pollAppRegistration(),
        throwsA(isA<FeishuFailure>()),
      );
      expect(auth.configured, false);
    });
  }
}
