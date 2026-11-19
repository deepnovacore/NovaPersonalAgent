import 'dart:async';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter/services.dart' show PlatformException;
import '../agent_core/tool_owner.dart';
import 'local_agent.dart';

/// Errors the native side raises before it creates or launches a task. A run
/// that fails this way never touched the device.
bool _isAdmissionError(String? message) =>
    message != null &&
    (message.startsWith('accessibility_') ||
        const {
          'another_task_is_active',
          'model_settings_required',
          'helper_unavailable',
          'display_unavailable',
          'app_not_allowed',
          'invalid_target_app',
          'space_changed',
          'task_id_conflict',
          'goal_and_acceptance_required',
          'stop_task_before_changing_model',
        }.contains(message));

/// Whether a native task provably did nothing on the device: no attempt in
/// flight, none unresolved, none dispatched. Any dispatched action (three
/// likes already done, say) needs the user to check before a replay. Missing
/// fields count as unsettled.
bool nativeActionsSettled(Map task) =>
    task['action_in_flight'] == false &&
    task['unresolved_actions'] == 0 &&
    task['dispatched_actions'] == 0;

/// True when [task] is the native record of the request. Absent fields cannot
/// contradict it.
bool _sameRequest(Map task, Map<String, dynamic> request) {
  for (final key in ['goal', 'acceptance']) {
    final a = task[key], b = request[key];
    if (a is String && b is String && a.trim() != b.trim()) return false;
  }
  return true;
}

class _Run {
  _Run(this.id, this.owner);
  final String id, owner;
  bool cancelled = false;
}

/// Owns the lifetime of the native work performed for one chat tool call.
/// The fixed chat policy comes from the app, never from model-supplied fields.
/// Only one device task runs at a time; cancellation is scoped to its owner.
class NativeChatTaskRunner {
  NativeChatTaskRunner({
    this.agent = const NativeLocalAgent(),
    this.pollInterval = const Duration(milliseconds: 350),
    this.timeout = const Duration(minutes: 5),
    this.virtualTimeout = const Duration(minutes: 16),
  });
  final LocalAgent agent;
  final Duration pollInterval;

  /// Budget of a main-screen run; a virtual run gets [virtualTimeout], the
  /// native 15 minutes (5 of agent time, up to 10 of takeover) plus a minute
  /// of margin so the native end arrives before this stop does.
  final Duration timeout, virtualTimeout;
  _Run? _active;

  String? get activeId => _active?.id;
  String? get activeOwner => _active?.owner;

  /// The owner of the running task, optionally only if it is task [id].
  String? ownerOf([String? id]) {
    final run = _active;
    return run != null && (id == null || run.id == id) ? run.owner : null;
  }

  /// Stops the running task when [owner] started it. Without an owner the
  /// running task is stopped whoever owns it.
  Future<void> cancel({String? owner}) async {
    final run = _active;
    if (run == null || (owner != null && run.owner != owner)) return;
    await _stop(run);
  }

  Future<void> _stop(_Run run) async {
    run.cancelled = true;
    try {
      await agent
          .call('stop', {'id': run.id})
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      // A failed stop is not evidence that a dispatched action did not happen.
    }
  }

  static Map<String, dynamic> _notExecuted(
    String id,
    String reason, [
    Map<String, dynamic> extra = const {},
  ]) => {
    'status': 'failed',
    'task_id': id,
    'reason': reason,
    'effects': 'none',
    if (reason == 'helper_unavailable') 'summary': _helperUnavailableSummary,
    ...extra,
  };

  static const _helperUnavailableSummary =
      '没有执行：Nova 的手机助手没在运行（更新 Nova 或换了 Wi‑Fi 后常见）。请在「开发者选项」里打开「无线调试」，Nova 会自动重连；还不行就到「设置 → 手机操作」重新配对。';

  /// A native task that ended without completing. Known action outcomes make
  /// it a failure; anything unconfirmed stays an unknown outcome.
  Map<String, dynamic> _ended(Map task, String id, String status) {
    final settled = nativeActionsSettled(task);
    final reason = task['reason'];
    return {
      'status': settled
          ? (status == 'cancelled' ? 'cancelled' : 'failed')
          : 'outcome_unknown',
      'task_id': id,
      if (reason is String) 'reason': reason,
      if (!settled && status == 'cancelled')
        'reason': 'cancelled_after_dispatch',
      'summary': task['summary'] ?? '',
      for (final key in [
        'dispatched_actions',
        'unresolved_actions',
        'action_in_flight',
      ])
        if (task.containsKey(key)) key: task[key],
    };
  }

  Future<Map<String, dynamic>> run(
    Map<String, dynamic> request,
    String id, {
    String? owner,
  }) async {
    final held = _active;
    if (held != null) {
      return {
        'status': 'failed',
        'reason': 'device_busy',
        'held_by': ToolOwner.lane(held.owner),
        'effects': 'none',
      };
    }
    final run = _active = _Run(id, owner ?? ToolOwner.current);
    final started = DateTime.now();
    var deadline = started.add(timeout);
    var admitted = false;
    try {
      var target = request['target_package'] as String?;
      final appName = (request['app_name'] as String?)?.trim();
      if (target != null || (appName != null && appName.isNotEmpty)) {
        try {
          final apps =
              await agent.call('apps').timeout(const Duration(seconds: 10))
                  as List;
          if (run.cancelled) return {'status': 'cancelled', 'task_id': id};
          if (target != null) {
            if (!apps.any((app) => app['package'] == target)) {
              return {'status': 'failed', 'error': 'target_app_not_installed'};
            }
          } else {
            final labels = apps.whereType<Map>();
            final lower = appName!.toLowerCase();
            var matches = labels
                .where((a) => '${a['label']}'.toLowerCase() == lower)
                .toList();
            if (matches.isEmpty) {
              matches = labels
                  .where((a) => '${a['label']}'.toLowerCase().contains(lower))
                  .toList();
            }
            if (matches.isEmpty) {
              return {'status': 'failed', 'error': 'target_app_not_installed'};
            }
            if (matches.length > 1) {
              return {
                'status': 'failed',
                'error': 'app_name_ambiguous',
                'candidates': [for (final a in matches.take(5)) a['label']],
              };
            }
            target = matches.single['package'] as String;
          }
        } catch (_) {
          if (run.cancelled) return {'status': 'cancelled', 'task_id': id};
          return {'status': 'failed', 'error': 'installed_apps_unavailable'};
        }
      } else if (request['scope'] == null) {
        return {'status': 'failed', 'error': 'app_name_required'};
      }
      if (run.cancelled) return {'status': 'cancelled', 'task_id': id};
      var task = Map<String, dynamic>.from(
        await agent
                .call('run', {
                  'id': id,
                  'goal': request['goal'],
                  'acceptance': request['acceptance'],
                  'target_package': target ?? request['scope'],
                  'interaction_mode': 'chat',
                })
                .timeout(const Duration(seconds: 15))
            as Map,
      );
      final refused = task['reason'] ?? task['error'];
      if (['failed', 'rejected'].contains(task['phase']) &&
          refused is String &&
          _isAdmissionError(refused)) {
        return _notExecuted(id, refused);
      }
      admitted = true;
      if (task['tier'] == 'virtual') deadline = started.add(virtualTimeout);
      while (true) {
        switch (task['phase']) {
          case 'completed':
            return {
              'status': 'completed',
              'task_id': id,
              'summary': task['summary'] ?? '',
              'operations': task['operations'] ?? [],
            };
          case 'cancelled':
            return _ended(task, id, 'cancelled');
          case 'verifying':
            if (task['evidence'] is String &&
                (task['evidence'] as String).isNotEmpty &&
                _sameRequest(task, request)) {
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
          case 'failed':
            debugPrint('[NovaAgent] native ended: ${task['reason']}');
            return _ended(task, id, 'interrupted');
        }
        if (run.cancelled) {
          await _stop(run);
          // Stopping a dispatched task cannot undo earlier device actions.
          return {
            'status': 'outcome_unknown',
            'task_id': id,
            'reason': 'cancelled_after_dispatch',
          };
        }
        if (!DateTime.now().isBefore(deadline)) {
          await _stop(run);
          return {
            'status': 'outcome_unknown',
            'task_id': id,
            'reason': 'task_timeout',
          };
        }
        await Future<void>.delayed(pollInterval);
        if (run.cancelled) continue;
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
    } catch (error) {
      // Native admission checks run before a task is created or launched.
      if (!admitted &&
          error is PlatformException &&
          error.code == 'local_agent_error' &&
          _isAdmissionError(error.message)) {
        return _notExecuted(id, error.message!);
      }
      await _stop(run);
      return {'status': 'outcome_unknown', 'task_id': id};
    } finally {
      if (identical(_active, run)) _active = null;
    }
  }
}
