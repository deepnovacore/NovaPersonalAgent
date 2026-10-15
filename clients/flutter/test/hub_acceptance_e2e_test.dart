import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/hub_tasks.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'package:nova_mobile/personal/hub_transport.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

// Only the native executor is fake: Hub, CLI, HTTP, sync and routing are real.
class AcceptanceAgent implements LocalAgent {
  final List<Map<String, dynamic>> tasks = [];
  int starts = 0, stops = 0;
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    switch (method) {
      case 'capabilities':
        return {
          'platform': 'android',
          'model_configured': true,
          'accessibility': true,
        };
      case 'apps':
        return [
          {'package': 'com.nova.fixture', 'label': 'Fixture'},
        ];
      case 'run':
        starts++;
        tasks.add({...input, 'phase': 'running', 'summary': 'Started locally'});
        return tasks.last;
      case 'stop':
        stops++;
        final task = tasks.singleWhere((task) => task['id'] == input['id']);
        task['phase'] = 'cancelled';
        return task;
      case 'tasks':
        return tasks;
      default:
        throw StateError('Unexpected native method: $method');
    }
  }
}

void main() {
  final root = Directory.current.parent.parent.path;
  late Directory directory;
  late Process server;
  late String url, phoneToken, macToken, phoneId;
  late HttpLifeSync transport;
  late HubTasks phone;
  late AcceptanceAgent agent;

  Future<ProcessResult> cli(List<String> args, {String? token}) => Process.run(
    'node',
    ['runtime/dist/src/hub/cli.js', ...args],
    workingDirectory: root,
    environment: {'NOVA_HUB_URL': url, 'NOVA_HUB_TOKEN': token ?? macToken},
  ).timeout(const Duration(seconds: 20));

  Future<Map<String, dynamic>> send() async {
    final result = await cli([
      'send',
      '--to',
      phoneId,
      '--goal',
      'Read fixture',
      '--acceptance',
      'Fixture verified',
      '--target',
      'com.nova.fixture',
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return jsonDecode(result.stdout as String) as Map<String, dynamic>;
  }

  Future<void> accept(String taskId) async {
    await phone.poll();
    final offers = await phone.offers();
    final offer = offers.singleWhere(
      (offer) => offer['command']['task_id'] == taskId,
    );
    await phone.accept(
      Map<String, dynamic>.from(offer['command']),
      allow: true,
    );
    await phone.poll();
  }

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('nova-hub-acceptance-');
    addTearDown(() => directory.delete(recursive: true));
    server = await Process.start(
      'node',
      [
        '--input-type=module',
        '-e',
        '''
      import {HubStore} from './runtime/dist/src/hub/store.js';
      import {createHubServer} from './runtime/dist/src/hub/server.js';
      const store = new HubStore(process.env.TEST_HUB_DB);
      const phone = store.enroll('acceptance','phone');
      const mac = store.enroll('acceptance','mac');
      const server = createHubServer(store);
      server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,phone,mac})));
      process.once('SIGTERM',()=>server.close(()=>{store.close();process.exit(0)}));
    ''',
      ],
      workingDirectory: root,
      environment: {'TEST_HUB_DB': '${directory.path}/hub.db'},
    );
    final stderr = server.stderr.drain<void>();
    addTearDown(() async {
      server.kill();
      await server.exitCode.timeout(const Duration(seconds: 10));
      await stderr;
    });
    final line = await server.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .first
        .timeout(
          const Duration(seconds: 15),
          onTimeout: () =>
              throw StateError('Hub startup timeout; build runtime first'),
        );
    final info = jsonDecode(line) as Map;
    url = 'http://127.0.0.1:${info['port']}';
    phoneToken = info['phone']['token'] as String;
    macToken = info['mac']['token'] as String;
    phoneId = info['phone']['device_id'] as String;
    transport = HttpLifeSync(url, phoneToken);
    final identity = await transport.request('GET', 'identity') as Map;
    agent = AcceptanceAgent();
    phone = HubTasks(
      request: transport.request,
      persistence: MemoryLifePersistence(),
      agent: agent,
      hubId: identity['hub_id'] as String,
      accountId: 'acceptance',
    );
    await phone.open();
  });

  test(
    'Mac todo and delegated task round-trip through real Hub to Dart phone',
    () async {
      final added = await cli([
        'todo',
        'add',
        '--title',
        'Hub acceptance todo',
        '--note',
        'From Mac',
      ]);
      expect(added.exitCode, 0, reason: '${added.stderr}');
      final life = LocalLife(MemoryLifePersistence());
      await life.open();
      await life.sync(transport);
      expect(life.life['todos'].single['title'], 'Hub acceptance todo');
      expect(life.life['todos'].single['note'], 'From Mac');
      await phone.poll();
      final devices = await cli(['devices']);
      expect(devices.exitCode, 0);
      final device = (jsonDecode(devices.stdout as String) as List).single;
      expect(device['device_id'], phoneId);
      expect(device['online'], true);
      final receipt = await send();
      await phone.poll();
      expect(agent.starts, 0, reason: 'Delivery must not imply user consent');
      final taskId = receipt['task_id'] as String;
      await accept(taskId);
      expect(agent.starts, 1);
      expect(agent.tasks.single['target_package'], 'com.nova.fixture');
      final watching = cli([
        'watch',
        '--task',
        taskId,
        '--timeout-seconds',
        '10',
      ]);
      agent.tasks.single['phase'] = 'verifying';
      await phone.poll();
      agent.tasks.single['phase'] = 'completed';
      agent.tasks.single['summary'] = 'Fixture verified';
      await phone.poll();
      final watched = await watching;
      expect(watched.exitCode, 0, reason: '${watched.stderr}');
      final lines = (watched.stdout as String).trim().split('\n');
      expect((jsonDecode(lines.last) as Map)['phase'], 'completed');
      final projection = (await phone.projections()).single;
      expect(projection['seq'], 3);
      expect(projection['owner_device_id'], phoneId);
    },
  );

  test(
    'Mac cancellation reaches the owner and watch reports non-success terminal',
    () async {
      await phone.poll();
      final receipt = await send(), taskId = receipt['task_id'] as String;
      await accept(taskId);
      final cancelled = await cli([
        'cancel',
        '--task',
        taskId,
        '--to',
        phoneId,
      ]);
      expect(cancelled.exitCode, 0, reason: '${cancelled.stderr}');
      expect(agent.stops, 0, reason: 'Receipt alone does not stop native work');
      await phone.poll();
      expect(agent.stops, 1);
      final watched = await cli([
        'watch',
        '--task',
        taskId,
        '--timeout-seconds',
        '2',
      ]);
      expect(watched.exitCode, 1);
      expect(
        (jsonDecode((watched.stdout as String).trim()) as Map)['phase'],
        'cancelled',
      );
      await phone.poll();
      expect(agent.stops, 1);
    },
  );

  test(
    'no heartbeat refuses delivery and revoked phone receives HTTP 401',
    () async {
      final offline = await cli([
        'send',
        '--to',
        phoneId,
        '--goal',
        'Offline',
        '--acceptance',
        'Must not execute',
      ]);
      expect(offline.exitCode, isNot(0));
      expect(offline.stderr, contains('target_unavailable'));
      expect(await phone.projections(), isEmpty);
      expect(agent.starts, 0);
      await phone.poll();
      final revoked = await cli([
        'revoke',
        '${directory.path}/hub.db',
        'acceptance',
        phoneId,
      ]);
      expect(revoked.exitCode, 0, reason: '${revoked.stderr}');
      await expectLater(
        phone.poll(),
        throwsA(
          isA<HttpException>().having(
            (e) => e.message,
            'message',
            contains('unauthorized'),
          ),
        ),
      );
      await expectLater(transport.snapshot(), throwsA(isA<HttpException>()));
      final denied = await cli(['devices'], token: phoneToken);
      expect(denied.exitCode, isNot(0));
      expect(denied.stderr, contains('HTTP 401: unauthorized'));
      expect((await cli(['devices'])).exitCode, 0);
      expect(agent.starts, 0);
    },
  );
}
