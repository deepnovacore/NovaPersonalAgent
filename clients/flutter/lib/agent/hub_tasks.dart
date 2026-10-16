import 'dart:convert';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';
import '../protocol/request_id.dart';
import 'local_agent.dart';

typedef HubRequest =
    Future<dynamic> Function(
      String method,
      String path, [
      Map<String, dynamic>? body,
    ]);

/// Delivery journal only; native tasks remain the single execution authority.
/// Polling never accepts a start offer. Acceptance is an explicit local UI action.
class HubTasks {
  HubTasks({
    required this.request,
    required this.persistence,
    required this.agent,
    required this.hubId,
    required this.accountId,
  });
  final HubRequest request;
  bool _disposed = false;
  void dispose() => _disposed = true;
  void _checkActive() {
    if (_disposed) throw StateError('hub_tasks_disposed');
  }

  Future<dynamic> _request(
    String method,
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    _checkActive();
    final result = await request(method, path, body);
    _checkActive();
    return result;
  }

  Future<dynamic> _call(String method, [Map<String, dynamic> args = const {}]) {
    _checkActive();
    return agent.call(method, args);
  }

  final LifePersistence persistence;
  final LocalAgent agent;
  final String hubId, accountId;
  Map<String, dynamic> _data = {};
  Future<void> _tail = Future.value();
  Future<T> _serial<T>(Future<T> Function() work) {
    final future = _tail.then((_) {
      _checkActive();
      return work();
    });
    _tail = future.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return future;
  }

  Future<void> open() async {
    _checkActive();
    final raw = await persistence.read();
    _data = raw == null
        ? {
            'hub_id': hubId,
            'account_id': accountId,
            'outgoing': {},
            'incoming': {},
          }
        : jsonDecode(raw) as Map<String, dynamic>;
    if (_data['hub_id'] != hubId || _data['account_id'] != accountId) {
      throw StateError('task_hub_identity_changed');
    }
    final identity = await _request('GET', 'identity') as Map;
    if (identity['hub_id'] != hubId ||
        identity['account_id'] != accountId ||
        identity['device_id'] is! String) {
      throw StateError('task_hub_identity_changed');
    }
    if (_data['device_id'] != null &&
        _data['device_id'] != identity['device_id']) {
      throw StateError('task_device_identity_changed');
    }
    final next = copyJson(_data);
    next['device_id'] = identity['device_id'];
    await _save(next);
  }

  Future<void> _save(Map<String, dynamic> next) async {
    _checkActive();
    await persistence.write(jsonEncode(next));
    _data = next;
  }

  Future<List<dynamic>> devices() async =>
      (await _request('GET', 'devices') as List)
          .where((device) => device['device_id'] != _data['device_id'])
          .toList();
  Future<List<dynamic>> offers() async {
    final offers = (await _request('GET', 'commands') as List)
        .where((row) => row['command']['kind'] == 'start')
        .toList();
    for (final record in (_data['incoming'] as Map).values) {
      if (record['stage'] == 'consented' &&
          record['decision'] == 'accepted' &&
          (record['command']['expires_at'] as int) >
              DateTime.now().millisecondsSinceEpoch &&
          !offers.any(
            (offer) =>
                offer['command']['command_id'] ==
                record['command']['command_id'],
          )) {
        offers.add({'command': record['command']});
      }
    }
    return offers;
  }

  Future<List<dynamic>> projections() async =>
      await _request('GET', 'tasks') as List;
  String localId(String task) => lifeId('$hubId:$accountId:$task');
  Future<void> send({
    required String device,
    required String capability,
    required String target,
    required String goal,
    required String acceptance,
  }) => _serial(() async {
    final id = requestId(),
        command = {
          'command_id': requestId(),
          'task_id': id,
          'target_device_id': device,
          'kind': 'start',
          'expires_at': DateTime.now().millisecondsSinceEpoch + 5 * 60000,
          'goal': goal,
          'acceptance': acceptance,
          'capability': capability,
          'target': target,
        };
    final next = copyJson(_data);
    next['outgoing'][command['command_id']] = command;
    await _save(next);
    await _flushOutgoing();
  });
  Future<void> cancel(Map<String, dynamic> task) => _serial(() async {
    final command = {
      'command_id': requestId(),
      'task_id': task['task_id'],
      'target_device_id': task['owner_device_id'],
      'kind': 'cancel',
      'expires_at': DateTime.now().millisecondsSinceEpoch + 5 * 60000,
    };
    final next = copyJson(_data);
    next['outgoing'][command['command_id']] = command;
    await _save(next);
    await _flushOutgoing();
  });
  Future<void> _flushOutgoing() async {
    for (final command in (_data['outgoing'] as Map).values.toList()) {
      if ((command['expires_at'] as int) <=
          DateTime.now().millisecondsSinceEpoch) {
        continue;
      }
      await _request('POST', 'commands', Map<String, dynamic>.from(command));
      final next = copyJson(_data);
      next['outgoing'].remove(command['command_id']);
      await _save(next);
    }
  }

  Future<void> accept(
    Map<String, dynamic> command, {
    required bool allow,
  }) => _serial(() async {
    final id = command['command_id'] as String;
    if (command['kind'] != 'start' ||
        (command['expires_at'] as int) <=
            DateTime.now().millisecondsSinceEpoch) {
      throw StateError('offer_expired');
    }
    final prior = _data['incoming'][id];
    if (prior != null) {
      if (prior['stage'] == 'consented' &&
          prior['decision'] == 'accepted' &&
          allow &&
          lifeFingerprint(prior['command']) == lifeFingerprint(command)) {
        await _dispatch(id);
        return;
      }
      throw StateError('offer_already_handled');
    }
    // Consent is durable before ACK. An ACK failure never launches the task.
    final next = copyJson(_data);
    next['incoming'][id] = {
      'command': command,
      'decision': allow ? 'accepted' : 'rejected',
      'stage': 'consented',
      'seq': 0,
      'phase': '',
    };
    await _save(next);
    await _dispatch(id);
  });
  Future<void> _dispatch(String id) async {
    final record = _data['incoming'][id], command = record['command'];
    await _request('POST', 'commands/ack', {
      'command_id': id,
      'decision': record['decision'],
    });
    if (record['decision'] == 'rejected') {
      final next = copyJson(_data);
      next['incoming'][id]['stage'] = 'rejected';
      await _save(next);
      return;
    }
    final next = copyJson(_data);
    next['incoming'][id]['stage'] = 'dispatch_intent';
    await _save(next);
    await _call('run', {
      'id': localId(command['task_id']),
      'goal': command['goal'],
      'acceptance': command['acceptance'],
      'target_package': command['target'],
    });
    final sent = copyJson(_data);
    sent['incoming'][id]['stage'] = 'dispatched';
    await _save(sent);
  }

  Future<void> poll() => _serial(() async {
    await _flushOutgoing();
    final caps = await _call('capabilities') as Map;
    final platform = caps['platform'];
    if (caps['model_configured'] == true &&
        (platform == 'ios' || caps['accessibility'] == true)) {
      final capability = platform == 'ios' ? 'ios_native' : 'android_native';
      final apps = await _call('apps') as List;
      final identity =
          await _request('POST', 'devices/heartbeat', {
                'name': platform == 'ios' ? '我的 iPhone' : '我的 Android',
                'capabilities': [capability],
                'targets': apps
                    .take(256)
                    .map(
                      (app) => {
                        'id': app['package'],
                        'label': app['label'],
                        'capability': capability,
                      },
                    )
                    .toList(),
              })
              as Map;
      if (_data['device_id'] != null &&
          _data['device_id'] != identity['device_id']) {
        throw StateError('task_device_identity_changed');
      }
      if (_data['device_id'] == null) {
        final next = copyJson(_data);
        next['device_id'] = identity['device_id'];
        await _save(next);
      }
    }
    // Resume only delivery acknowledgements. A native call with an uncertain
    // outcome is reconciled from its task ID, never blindly dispatched again.
    for (final id in (_data['incoming'] as Map).keys.toList()) {
      final record = _data['incoming'][id];
      if (record['stage'] == 'consented' && record['decision'] == 'rejected') {
        await _request('POST', 'commands/ack', {
          'command_id': id,
          'decision': 'rejected',
        });
        final next = copyJson(_data);
        next['incoming'][id]['stage'] = 'rejected';
        await _save(next);
      }
    }
    final inbox = await _request('GET', 'commands') as List;
    for (final entry in inbox) {
      final command = Map<String, dynamic>.from(entry['command']);
      if (command['kind'] != 'cancel') continue;
      final owned = (_data['incoming'] as Map).values.any(
        (r) =>
            r['command']['task_id'] == command['task_id'] &&
            r['decision'] == 'accepted',
      );
      if (!owned) continue;
      await _call('stop', {'id': localId(command['task_id'])});
      await _request('POST', 'commands/ack', {
        'command_id': command['command_id'],
        'decision': 'accepted',
      });
    }
    final native = await _call('tasks') as List;
    for (final id in (_data['incoming'] as Map).keys.toList()) {
      var record = _data['incoming'][id];
      if (record['decision'] != 'accepted' ||
          !['dispatch_intent', 'dispatched'].contains(record['stage'])) {
        continue;
      }
      // A completed delivery receipt outlives the bounded native recent list.
      // Flush an uncertain event ACK before deciding whether it is terminal.
      if (record['pending_event'] != null) {
        await _event(id, Map<String, dynamic>.from(record['pending_event']));
        record = _data['incoming'][id];
      }
      if (['completed', 'cancelled', 'interrupted'].contains(record['phase'])) {
        continue;
      }
      final task = native
          .where((task) => task['id'] == localId(record['command']['task_id']))
          .firstOrNull;
      if (task == null) {
        if (record['phase'] != 'interrupted') {
          if (record['pending_event'] != null) {
            await _event(
              id,
              Map<String, dynamic>.from(record['pending_event']),
            );
          }
          record = _data['incoming'][id];
          await _event(id, {
            'task_id': record['command']['task_id'],
            'seq': (record['seq'] as int) + 1,
            'phase': 'interrupted',
            'summary': '本机未能确认任务启动，未自动重试。请核对后重新委托。',
          });
        }
        continue;
      }
      // Replay the exact pending event before reading a newer native phase.
      if (record['pending_event'] != null) {
        await _event(id, Map<String, dynamic>.from(record['pending_event']));
      }
      record = _data['incoming'][id];
      if (record['phase'] == task['phase'] ||
          ['completed', 'cancelled', 'interrupted'].contains(record['phase'])) {
        continue;
      }
      if (task['phase'] == 'completed' && record['phase'] != 'verifying') {
        await _event(id, {
          'task_id': record['command']['task_id'],
          'seq': (record['seq'] as int) + 1,
          'phase': 'verifying',
          'summary': '本机已产生待核验结果',
        });
        record = _data['incoming'][id];
      }
      await _event(id, {
        'task_id': record['command']['task_id'],
        'seq': (record['seq'] as int) + 1,
        'phase': task['phase'],
        'summary': (task['summary'] as String? ?? '').substring(
          0,
          (task['summary'] as String? ?? '').length.clamp(0, 2000),
        ),
      });
    }
  });
  Future<void> _event(String id, Map<String, dynamic> event) async {
    var next = copyJson(_data);
    next['incoming'][id]['pending_event'] = event;
    await _save(next);
    await _request('POST', 'tasks/events', event);
    next = copyJson(_data);
    next['incoming'][id].remove('pending_event');
    next['incoming'][id]['seq'] = event['seq'];
    next['incoming'][id]['phase'] = event['phase'];
    await _save(next);
  }
}
