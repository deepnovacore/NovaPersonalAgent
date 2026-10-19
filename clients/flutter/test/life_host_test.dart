import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/hub_tasks.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'hub_tasks_test.dart' show RoutingAgent;
import 'local_life_test.dart' show MemoryLifePersistence, TestHub;

class LocalHttpOverrides extends HttpOverrides {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
    'one owner opens once; mutations survive restart and snapshot is readonly',
    () async {
      final disk = MemoryLifePersistence();
      final host = LifeHost(repository: LocalLife(disk));
      expect(identical(host.open(), host.open()), isTrue);
      await host.open();
      host.didChangeAppLifecycleState(AppLifecycleState.paused);
      final store = host.store;
      var changes = 0;
      host.changes.addListener(() => changes++);
      final input = {'op': 'create', 'kind': 'todo', 'title': 'Offline'};
      final first = await host.mutate(input, operationId: 'once');
      expect(await host.mutate(input, operationId: 'once'), first);
      expect(host.snapshot()['todos'], hasLength(1));
      expect(
        () => host.snapshot()['todos'][0]['title'] = 'Changed',
        throwsUnsupportedError,
      );
      expect(
        () => (host.snapshot()['todos'] as List).clear(),
        throwsUnsupportedError,
      );
      expect(changes, greaterThan(0));
      await host.open();
      expect(identical(host.store, store), isTrue);
      expect(host.hubConfigured, isFalse);
      await host.sync();
      host.dispose();
      await expectLater(
        host.mutate(input, operationId: 'late'),
        throwsStateError,
      );
      final restored = LifeHost(repository: LocalLife(disk));
      await restored.open();
      restored.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(await restored.mutate(input, operationId: 'once'), first);
      expect(restored.snapshot()['todos'], hasLength(1));
      restored.dispose();
    },
  );

  test('conflicts block host mutations', () async {
    final repo = LocalLife(MemoryLifePersistence());
    final host = LifeHost(repository: repo);
    await host.open();
    host.didChangeAppLifecycleState(AppLifecycleState.paused);
    final created = await host.mutate({
      'op': 'create',
      'kind': 'todo',
      'title': 'Original',
    }, operationId: 'create');
    final hub = TestHub(Map<String, dynamic>.from(repo.life['todos'][0]));
    await repo.sync(hub);
    await host.mutate({
      'op': 'update',
      'kind': 'todo',
      'id': created['id'],
      'expected_version': 1,
      'title': 'Local',
    }, operationId: 'edit');
    hub.row = {...hub.row, 'version': 2, 'title': 'Remote'};
    await repo.sync(hub);
    expect(host.hasConflict, isTrue);
    await expectLater(
      host.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Blocked',
      }, operationId: 'blocked'),
      throwsStateError,
    );
    host.dispose();
  });

  test(
    'settings reject invalid address and blank credential without saving',
    () async {
      final host = LifeHost(repository: LocalLife(MemoryLifePersistence()));
      await host.open();
      host.didChangeAppLifecycleState(AppLifecycleState.paused);
      await expectLater(
        host.configureHub(url: 'http://example.com', token: 'secret'),
        throwsFormatException,
      );
      await expectLater(
        host.configureHub(url: 'https://example.com', token: ' '),
        throwsFormatException,
      );
      expect(await host.readHubUrl(), isNull);
      expect(host.error, isNot(contains('secret')));
      expect(host.busy, isFalse);
      host.dispose();
    },
  );

  test('first QR connection verifies scanned identity before saving', () async {
    final host = LifeHost(repository: LocalLife(MemoryLifePersistence()));
    await host.open();
    host.didChangeAppLifecycleState(AppLifecycleState.paused);
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'schema_version': 1,
          'hub_id': 'wrong-hub',
          'account_id': 'scanned-account',
          'cursor': 0,
          'state': host.repo!.life,
          'tombstones': {},
        }),
      );
      await request.response.close();
    });
    try {
      await expectLater(
        HttpOverrides.runWithHttpOverrides(
          () => host.configureHub(
            url: 'http://127.0.0.1:${server.port}',
            token: 'credential',
            expectedHubId: 'scanned-hub',
            expectedAccountId: 'scanned-account',
          ),
          LocalHttpOverrides(),
        ),
        throwsStateError,
      );
      expect(host.hubConfigured, isFalse);
      expect(
        await const FlutterSecureStorage().read(
          key: 'nova.local.hub.credentials',
        ),
        isNull,
      );
    } finally {
      host.dispose();
      await server.close(force: true);
    }
  });

  test('settings reject another account before saving credentials', () async {
    final repo = LocalLife(MemoryLifePersistence());
    final host = LifeHost(repository: repo);
    await host.open();
    host.didChangeAppLifecycleState(AppLifecycleState.paused);
    await host.mutate({
      'op': 'create',
      'kind': 'todo',
      'title': 'Bound',
    }, operationId: 'bound');
    final hub = TestHub(Map<String, dynamic>.from(repo.life['todos'][0]));
    await repo.sync(hub);
    final snapshot = await hub.snapshot();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var mismatch = false;
    server.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({...snapshot, if (mismatch) 'account_id': 'other'}),
      );
      await request.response.close();
    });
    try {
      final url = 'http://127.0.0.1:${server.port}';
      await HttpOverrides.runWithHttpOverrides(
        () => host.configureHub(url: url, token: 'first'),
        LocalHttpOverrides(),
      );
      expect(host.hubConfigured, isTrue);
      final before = await const FlutterSecureStorage().read(
        key: 'nova.local.hub.credentials',
      );
      mismatch = true;
      await expectLater(
        HttpOverrides.runWithHttpOverrides(
          () => host.configureHub(url: url, token: 'second'),
          LocalHttpOverrides(),
        ),
        throwsStateError,
      );
      expect(
        await const FlutterSecureStorage().read(
          key: 'nova.local.hub.credentials',
        ),
        before,
      );
      expect(jsonDecode(before!)['token'], 'first');
    } finally {
      host.dispose();
      await server.close(force: true);
    }
  });

  test(
    'disposing tasks stops an in-flight ACK before native dispatch',
    () async {
      final ack = Completer<dynamic>();
      final entered = Completer<void>();
      final agent = RoutingAgent();
      final tasks = HubTasks(
        request: (method, path, [body]) async {
          if (path == 'identity') {
            return {
              'hub_id': 'hub',
              'account_id': 'account',
              'device_id': 'phone',
            };
          }
          entered.complete();
          return ack.future;
        },
        persistence: MemoryLifePersistence(),
        agent: agent,
        hubId: 'hub',
        accountId: 'account',
      );
      await tasks.open();
      final accepting = tasks.accept({
        'command_id': 'offer',
        'task_id': 'task',
        'kind': 'start',
        'expires_at': DateTime.now().millisecondsSinceEpoch + 60000,
        'goal': 'Task',
        'acceptance': 'Check',
        'target': 'nova',
      }, allow: true);
      await entered.future;
      tasks.dispose();
      ack.complete({});
      await expectLater(accepting, throwsStateError);
      expect(agent.starts, 0);
      await expectLater(tasks.poll(), throwsStateError);
    },
  );
}
