import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/hub_tasks.dart';
import 'package:nova_mobile/agent/local_agent.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class RoutingAgent implements LocalAgent {
  int starts = 0, stops = 0;
  bool loseRunReply = false;
  final List<Map<String, dynamic>> tasks = [];
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    switch (method) {
      case 'capabilities':
        return {'platform': 'ios', 'model_configured': true};
      case 'apps':
        return [
          {'package': 'nova', 'label': 'Nova'},
        ];
      case 'tasks':
        return tasks;
      case 'run':
        starts++;
        tasks.add({...input, 'phase': 'running'});
        if (loseRunReply) throw const SocketException('lost response');
        return tasks.last;
      case 'stop':
        stops++;
        tasks.first['phase'] = 'cancelled';
        return tasks.first;
    }
  }
}

class RoutingServer {
  bool loseAck = false, loseEvent = false;
  final List<Map<String, dynamic>> events = [];
  final Map<String, dynamic> offer = {
    'command_id': 'offer',
    'task_id': 'task',
    'target_device_id': 'phone',
    'kind': 'start',
    'expires_at': DateTime.now().millisecondsSinceEpoch + 60000,
    'goal': 'fixture',
    'acceptance': 'one',
    'capability': 'ios_native',
    'target': 'nova',
  };
  bool accepted = false;
  Future<dynamic> request(
    String method,
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    if (path == 'identity') {
      return {'hub_id': 'hub', 'account_id': 'account', 'device_id': 'phone'};
    }
    if (path == 'devices/heartbeat') return {'device_id': 'phone'};
    if (path == 'commands' && method == 'GET') {
      return accepted
          ? []
          : [
              {'command': offer},
            ];
    }
    if (path == 'commands/ack') {
      accepted = true;
      if (loseAck) {
        loseAck = false;
        throw const SocketException('lost ack');
      }
      return {};
    }
    if (path == 'tasks/events') {
      events.add(Map.from(body!));
      if (loseEvent) {
        loseEvent = false;
        throw const SocketException('lost event ack');
      }
      return body;
    }
    return [];
  }
}

void main() {
  test(
    'poll is not dispatch; a lost acceptance reply requires explicit retry',
    () async {
      final server = RoutingServer()..loseAck = true, agent = RoutingAgent();
      final tasks = HubTasks(
        request: server.request,
        persistence: MemoryLifePersistence(),
        agent: agent,
        hubId: 'hub',
        accountId: 'account',
      );
      await tasks.open();
      await tasks.poll();
      expect(agent.starts, 0);
      await expectLater(
        tasks.accept(server.offer, allow: true),
        throwsA(isA<SocketException>()),
      );
      await tasks.poll();
      expect(agent.starts, 0);
      expect((await tasks.offers()).length, 1);
      await tasks.accept(server.offer, allow: true);
      expect(agent.starts, 1);
      await expectLater(
        tasks.accept(server.offer, allow: true),
        throwsStateError,
      );
    },
  );
  test(
    'lost native reply reconciles without another run and replays exact pending event',
    () async {
      final server = RoutingServer(),
          agent = RoutingAgent()..loseRunReply = true;
      final storage = MemoryLifePersistence();
      var tasks = HubTasks(
        request: server.request,
        persistence: storage,
        agent: agent,
        hubId: 'hub',
        accountId: 'account',
      );
      await tasks.open();
      await expectLater(
        tasks.accept(server.offer, allow: true),
        throwsA(isA<SocketException>()),
      );
      tasks = HubTasks(
        request: server.request,
        persistence: storage,
        agent: agent,
        hubId: 'hub',
        accountId: 'account',
      );
      await tasks.open();
      server.loseEvent = true;
      await expectLater(tasks.poll(), throwsA(isA<SocketException>()));
      agent.tasks.first['phase'] = 'completed';
      await tasks.poll();
      expect(agent.starts, 1);
      expect(server.events[0], server.events[1]);
      expect(server.events.map((e) => e['seq']), [1, 1, 2, 3]);
      expect(server.events.last['phase'], 'completed');
      await tasks.poll();
      expect(server.events.length, 4);
      agent.tasks.clear(); // Native recent-history window no longer includes this task.
      await tasks.poll();
      expect(server.events.length, 4, reason: 'a durable terminal receipt must not be downgraded');
    },
  );
  test('delivery journal cannot bind to another Hub', () async {
    final server = RoutingServer(),
        storage = MemoryLifePersistence(),
        agent = RoutingAgent();
    var tasks = HubTasks(
      request: server.request,
      persistence: storage,
      agent: agent,
      hubId: 'hub',
      accountId: 'account',
    );
    await tasks.open();
    await tasks.accept(server.offer, allow: false);
    tasks = HubTasks(
      request: server.request,
      persistence: storage,
      agent: agent,
      hubId: 'other',
      accountId: 'account',
    );
    await expectLater(tasks.open(), throwsStateError);
  });
}
