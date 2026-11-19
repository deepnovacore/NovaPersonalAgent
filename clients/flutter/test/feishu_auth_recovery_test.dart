import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

const _identity = 'feishu:cli_fixture:tenant:person';
const _device = FeishuResponse(200, {
  'device_code': 'device',
  'user_code': 'A',
  'verification_uri': 'https://accounts.feishu.cn/verify',
  'expires_in': 300,
  'interval': 1,
});
FeishuResponse _token() => FeishuResponse(200, {
  'access_token': 'new',
  'refresh_token': 'new-refresh',
  'expires_in': 7200,
  'refresh_token_expires_in': 86400,
  'scope': feishuReadScopes.join(' '),
  'token_type': 'Bearer',
});
FeishuResponse _user(String id) => FeishuResponse(200, {
  'code': 0,
  'data': {'open_id': id, 'tenant_key': 'tenant', 'name': id},
});

Future<FeishuHost> _host(
  FeishuApi api,
  DateTime Function() now, {
  bool expired = false,
  bool refreshing = false,
  bool validAccess = false,
  MemoryLifePersistence? sourceDisk,
}) async {
  final disk = MemoryLifePersistence()
    ..value = jsonEncode({
      'version': 1,
      'generation': 1,
      'refreshing': refreshing,
      'app': {'brand': 'feishu', 'app_id': 'cli_fixture', 'secret': 'fixture'},
      'identity': {
        'open_id': 'person',
        'tenant_key': 'tenant',
        'name': 'Person',
      },
      'credential': {
        'access_token': 'old',
        'refresh_token': 'old-refresh',
        'expires_at': validAccess
            ? now().add(const Duration(hours: 1)).millisecondsSinceEpoch
            : 0,
        'refresh_expires_at': expired
            ? 0
            : now().add(const Duration(days: 1)).millisecondsSinceEpoch,
      },
    });
  final sources = SourceStore(sourceDisk ?? MemoryLifePersistence(), now: now);
  await sources.bind(_identity, 1);
  await sources.select('chat', DateTime.utc(2020));
  await sources.ingestPage(
    sources.fence('chat'),
    [
      {
        'message_id': 'saved',
        'create_time': '${now().millisecondsSinceEpoch}',
        'msg_type': 'text',
        'body': {'content': '{"text":"saved source"}'},
      },
    ],
    nextPage: null,
    windowEnd: now(),
  );
  final host = FeishuHost(
    auth: FeishuAuth(disk, api, now: now),
    sources: sources,
  );
  await host.open();
  addTearDown(host.dispose);
  return host;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  for (final phase in ['queued', 'writing']) {
    test(
      'same-account reauthorization rejects an old page while $phase in source storage',
      () async {
        var clock = DateTime.utc(2026, 10, 29);
        final disk = _GateSourceDisk();
        final entered = Completer<void>(),
            response = Completer<FeishuResponse>();
        final page = FeishuResponse(200, {
          'code': 0,
          'data': {
            'items': [
              {
                'message_id': 'old-request',
                'create_time': '${clock.millisecondsSinceEpoch}',
                'msg_type': 'text',
                'body': {'content': '{"text":"must not commit"}'},
              },
            ],
            'has_more': false,
          },
        });
        final host = await _host(
          FeishuApi(
            transport: (_, uri, _, _) async {
              if (uri.path.endsWith('/messages')) {
                entered.complete();
                if (phase == 'writing') {
                  disk.arm();
                  return page;
                }
                return response.future;
              }
              return uri.path.endsWith('device_authorization')
                  ? _device
                  : uri.path.endsWith('user_info')
                  ? _user('person')
                  : _token();
            },
          ),
          () => clock,
          validAccess: true,
          sourceDisk: disk,
        );
        final request = host.ingest.page('chat');
        await entered.future;
        final before = host.sources.checkpoint('chat');
        Future<void>? prior;
        if (phase == 'queued') {
          disk.arm();
          prior = host.sources.setAllAccessible(false);
          await disk.entered.future;
          response.complete(page);
          // Let the response enqueue its source commit behind the held write.
          await Future<void>.delayed(Duration.zero);
        } else {
          await disk.entered.future;
        }
        await host.auth.beginAuthorization();
        clock = clock.add(const Duration(seconds: 1));
        expect(await host.auth.pollAuthorization(), isTrue);
        await host.synchronizeIdentity();
        final rejected = expectLater(request, throwsA(isA<FeishuFailure>()));
        disk.release.complete();
        await prior;
        await rejected;
        expect(host.sources.messages('chat').single['message_id'], 'saved');
        expect(host.sources.checkpoint('chat'), before);
        final persisted = jsonDecode(disk.value!) as Map;
        expect((persisted['messages'] as Map).length, 1);
        expect(persisted['sources']['chat'], before);
      },
    );
  }
  for (final failure in ['network_timeout', 'network_tls_failed']) {
    test(
      '$failure during refresh keeps cached sources and known account',
      () async {
        final host = await _host(
          FeishuApi(
            transport: (_, _, _, _) async => throw FeishuFailure(failure),
          ),
          () => DateTime.utc(2026, 10, 29),
        );
        final snapshot = jsonEncode(host.sources.messages('chat'));
        await expectLater(
          host.auth.accessToken(),
          throwsA(isA<FeishuFailure>()),
        );
        await host.synchronizeIdentity();
        expect(host.auth.authorized, isFalse);
        expect(host.auth.identityKey, _identity);
        expect(host.auth.generation, 1);
        expect(host.ready, isFalse);
        expect(jsonEncode(host.sources.messages('chat')), snapshot);
      },
    );
  }
  test(
    'expired tokens and interrupted token rotation preserve cache while requiring login',
    () async {
      for (final refreshing in [false, true]) {
        final host = await _host(
          FeishuApi(
            transport: (_, _, _, _) async =>
                fail('no network request expected'),
          ),
          () => DateTime.utc(2026, 10, 29),
          expired: !refreshing,
          refreshing: refreshing,
        );
        expect(host.auth.authorized, isFalse);
        expect(host.auth.identityKey, _identity);
        expect(host.auth.generation, 1);
        expect(host.sources.messages('chat'), hasLength(1));
        await expectLater(
          host.auth.accessToken(),
          throwsA(isA<FeishuFailure>()),
        );
      }
    },
  );
  for (final account in ['person', 'someone-else']) {
    test(
      'reauthorization for $account preserves only the same account cache',
      () async {
        var clock = DateTime.utc(2026, 10, 29);
        final host = await _host(
          FeishuApi(
            transport: (_, uri, _, _) async =>
                uri.path.endsWith('device_authorization')
                ? _device
                : uri.path.endsWith('user_info')
                ? _user(account)
                : _token(),
          ),
          () => clock,
          validAccess: true,
        );
        final previousEpoch = host.auth.authorizationEpoch;
        await host.auth.beginAuthorization();
        await host.synchronizeIdentity();
        expect(host.auth.authorized, isFalse);
        expect(host.auth.authorizationEpoch, greaterThan(previousEpoch));
        expect(host.auth.generation, 1);
        expect(host.auth.identityKey, _identity);
        expect(host.sources.messages('chat'), hasLength(1));
        clock = clock.add(const Duration(seconds: 1));
        expect(await host.auth.pollAuthorization(), isTrue);
        await host.synchronizeIdentity();
        expect(host.auth.authorized, isTrue);
        expect(host.auth.generation, account == 'person' ? 1 : 2);
        expect(
          host.sources.messages('chat'),
          hasLength(account == 'person' ? 1 : 0),
        );
        if (account == 'person') {
          await host.auth.disconnect(revoke: true);
          await host.synchronizeIdentity();
          expect(host.auth.authorized, isFalse);
          expect(host.auth.identityKey, isNull);
          expect(host.sources.sources, isEmpty);
        }
      },
    );
  }
  test(
    'a held old page cannot commit after same-account reauthorization',
    () async {
      var clock = DateTime.utc(2026, 10, 29);
      final entered = Completer<void>(), held = Completer<FeishuResponse>();
      final host = await _host(
        FeishuApi(
          transport: (_, uri, _, _) async {
            if (uri.path.endsWith('/messages')) {
              entered.complete();
              return held.future;
            }
            return uri.path.endsWith('device_authorization')
                ? _device
                : uri.path.endsWith('user_info')
                ? _user('person')
                : _token();
          },
        ),
        () => clock,
        validAccess: true,
      );
      final request = host.ingest.page('chat');
      await entered.future;
      await host.auth.beginAuthorization();
      clock = clock.add(const Duration(seconds: 1));
      await host.auth.pollAuthorization();
      await host.synchronizeIdentity();
      held.complete(
        const FeishuResponse(200, {
          'code': 0,
          'data': {'items': [], 'has_more': false},
        }),
      );
      await expectLater(request, throwsA(isA<FeishuFailure>()));
      expect(host.sources.messages('chat'), hasLength(1));
    },
  );
}

class _GateSourceDisk extends MemoryLifePersistence {
  bool _armed = false;
  late Completer<void> entered, release;
  void arm() {
    _armed = true;
    entered = Completer<void>();
    release = Completer<void>();
  }

  @override
  Future<void> write(String value) async {
    if (_armed) {
      _armed = false;
      entered.complete();
      await release.future;
    }
    await super.write(value);
  }
}
