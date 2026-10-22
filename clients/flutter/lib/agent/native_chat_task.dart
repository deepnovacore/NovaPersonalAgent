import 'dart:async';
import 'package:flutter/foundation.dart' show debugPrint;
import 'local_agent.dart';

/// Owns the lifetime of the native work performed for one chat tool call.
/// The fixed chat policy comes from the app, never from model-supplied fields.
class NativeChatTaskRunner {
  NativeChatTaskRunner({
    this.agent = const NativeLocalAgent(),
    this.pollInterval = const Duration(milliseconds: 350),
    this.timeout = const Duration(minutes: 5),
  });
  final LocalAgent agent;
  final Duration pollInterval, timeout;
  String? _active;
  bool _cancelled = false;

  Future<void> cancel() async {
    _cancelled = true;
    final id = _active;
    if (id == null) return;
    try {
      await agent.call('stop', {'id': id}).timeout(const Duration(seconds: 5));
    } catch (_) {
      // A failed stop is not evidence that a dispatched action did not happen.
    }
  }

  Future<Map<String, dynamic>> run(
    Map<String, dynamic> request,
    String id,
  ) async {
    if (request.containsKey('target_package')) {
      try {
        final apps =
            await agent.call('apps').timeout(const Duration(seconds: 10))
                as List;
        if (!apps.any((app) => app['package'] == request['target_package'])) {
          return {'status': 'failed', 'error': 'target_app_not_installed'};
        }
      } catch (_) {
        return {'status': 'failed', 'error': 'installed_apps_unavailable'};
      }
    }
    if (_active != null) return {'status': 'failed', 'reason': 'task_busy'};
    _active = id;
    _cancelled = false;
    final deadline = DateTime.now().add(timeout);
    try {
      var task = Map<String, dynamic>.from(
        await agent
                .call('run', {
                  'id': id,
                  'goal': request['goal'],
                  'acceptance': request['acceptance'],
                  'target_package':
                      request['target_package'] ?? request['scope'],
                  'interaction_mode': 'chat',
                })
                .timeout(const Duration(seconds: 15))
            as Map,
      );
      while (true) {
        if (_cancelled) {
          await cancel();
          return {'status': 'cancelled', 'task_id': id};
        }
        switch (task['phase']) {
          case 'completed':
            return {
              'status': 'completed',
              'task_id': id,
              'summary': task['summary'] ?? '',
              'operations': task['operations'] ?? [],
            };
          case 'cancelled':
            return {'status': 'cancelled', 'task_id': id};
          case 'verifying':
            if (request.containsKey('target_package') &&
                task['evidence'] is String &&
                (task['evidence'] as String).isNotEmpty) {
              return {
                'status': 'completed',
                'task_id': id,
                'summary': task['summary'] ?? '',
              };
            }
            return {
              'status': 'outcome_unknown',
              'task_id': id,
              'summary': task['summary'] ?? '',
            };
          case 'interrupted':
            debugPrint('[NovaAgent] native interrupted: ${task['reason']}');
            return {
              'status':
                  request.containsKey('target_package') &&
                      isNativeReadFailure(task)
                  ? 'failed'
                  : 'outcome_unknown',
              if (task['reason'] is String) 'reason': task['reason'],
              'task_id': id,
              'summary': task['summary'] ?? '',
            };
        }
        if (!DateTime.now().isBefore(deadline)) {
          await cancel();
          return {
            'status': 'outcome_unknown',
            'task_id': id,
            'reason': 'task_timeout',
          };
        }
        await Future<void>.delayed(pollInterval);
        if (_cancelled) continue;
        final tasks =
            await agent.call('tasks').timeout(const Duration(seconds: 10))
                as List;
        final current = tasks
            .cast<Map>()
            .where((t) => t['id'] == id)
            .firstOrNull;
        if (current == null) throw StateError('task_missing');
        task = Map<String, dynamic>.from(current);
      }
    } catch (_) {
      await cancel();
      return {'status': 'outcome_unknown', 'task_id': id};
    } finally {
      _active = null;
    }
  }
}
