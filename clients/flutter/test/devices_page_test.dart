import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/hub_tasks.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/ui/devices_page.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class NoNativeCalls implements LocalAgent {
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) => throw StateError('Devices must not call native execution: $method');
}

class DeviceHost extends LifeHost {
  DeviceHost(this.tasks);
  final HubTasks? tasks;
  @override
  bool get hubConfigured => tasks != null;
  @override
  Future<void> open() async {}
  @override
  Future<HubTasks?> getTasks() async => tasks;
}

void main() {
  Future<void> mount(WidgetTester tester, DeviceHost host) async {
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: novaTheme(),
        home: DevicesPage(host: host),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'unconfigured phone explains Hub setup without invented discovery',
    (tester) async {
      await mount(tester, DeviceHost(null));
      expect(find.text('这台手机'), findsOneWidget);
      expect(find.text('未配置 Hub'), findsOneWidget);
      expect(find.text('连接设置'), findsOneWidget);
      expect(find.byType(Switch), findsNothing);
    },
  );

  testWidgets(
    'reads real devices and presence without heartbeat or native polling',
    (tester) async {
      final requests = <String>[];
      final tasks = HubTasks(
        persistence: MemoryLifePersistence(),
        agent: NoNativeCalls(),
        hubId: 'hub',
        accountId: 'account',
        request: (method, path, [body]) async {
          requests.add('$method $path');
          if (path == 'identity') {
            return {
              'hub_id': 'hub',
              'account_id': 'account',
              'device_id': 'phone',
            };
          }
          return [
            {'device_id': 'phone', 'name': 'Self', 'capabilities': []},
            {
              'device_id': 'mac',
              'name': 'My Mac',
              'capabilities': ['desktop_coding'],
              'online': false,
              'last_seen': 1700000000000,
            },
          ];
        },
      );
      await tasks.open();
      await mount(tester, DeviceHost(tasks));
      expect(find.text('My Mac'), findsOneWidget);
      expect(find.text('Self'), findsNothing);
      expect(find.textContaining('离线'), findsOneWidget);
      expect(find.textContaining('代码任务'), findsOneWidget);
      expect(requests, ['GET identity', 'GET devices']);
    },
  );

  testWidgets(
    'failed device read can retry and does not expose transport secrets',
    (tester) async {
      var fail = true;
      final tasks = HubTasks(
        persistence: MemoryLifePersistence(),
        agent: NoNativeCalls(),
        hubId: 'hub',
        accountId: 'account',
        request: (method, path, [body]) async {
          if (path == 'identity') {
            return {
              'hub_id': 'hub',
              'account_id': 'account',
              'device_id': 'phone',
            };
          }
          if (fail) throw StateError('secret-token');
          return [];
        },
      );
      await tasks.open();
      await mount(tester, DeviceHost(tasks));
      expect(find.text('暂时无法读取设备'), findsOneWidget);
      expect(find.textContaining('secret-token'), findsNothing);
      fail = false;
      await tester.tap(find.text('重试'));
      await tester.pumpAndSettle();
      expect(find.text('暂无其他设备'), findsOneWidget);
    },
  );
}
