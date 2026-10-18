import 'dart:convert';
import 'package:flutter/foundation.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';
import '../protocol/request_id.dart';
import 'schedule_time.dart';

/// Fixed local owner. Sharing a definition never enables another scheduler.
class ScheduleRepository extends ChangeNotifier {
  ScheduleRepository(
    this.persistence, {
    required this.deviceId,
    required this.clock,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;
  final LifePersistence persistence;
  final String deviceId;
  final ScheduleClock clock;
  final DateTime Function() now;
  Map<String, dynamic> _data = {'version': 1, 'items': [], 'runs': []};
  Future<void> _tail = Future.value();
  bool _disposed = false;
  List<Map<String, dynamic>> get items =>
      (_data['items'] as List).map((e) => copyJson(e)).toList();
  List<Map<String, dynamic>> get runs =>
      (_data['runs'] as List).map((e) => copyJson(e)).toList();
  Map<String, dynamic> run(String id) =>
      runs.firstWhere((e) => e['run_id'] == id);
  Future<void> open() async {
    final raw = await persistence.read();
    if (raw != null) {
      final value = jsonDecode(raw) as Map<String, dynamic>;
      if (value['version'] != 1) throw StateError('schedule_schema');
      _data = value;
    }
    await _write((data) async {
      for (final run in data['runs'] as List) {
        if (['bound', 'running', 'waiting_approval'].contains(run['status'])) {
          run['status'] = 'outcome_unknown';
          run['reason'] = 'process_interrupted';
        }
      }
    });
  }

  Future<T> _write<T>(Future<T> Function(Map<String, dynamic>) change) {
    final result = _tail.then((_) async {
      if (_disposed) throw StateError('schedule_disposed');
      final next = copyJson(_data);
      final result = await change(next);
      final text = jsonEncode(next);
      if (text.length > 2000000) throw StateError('schedule_capacity');
      await persistence.write(text);
      _data = next;
      if (!_disposed) notifyListeners();
      return result;
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<Map<String, dynamic>> create(Map<String, dynamic> input) =>
      _write((data) async {
        if (input.keys.toSet().difference({
          'title',
          'goal',
          'acceptance',
          'rule',
          'provider',
          'context',
        }).isNotEmpty) {
          throw StateError('invalid_schedule');
        }
        for (final field in ['title', 'goal', 'acceptance', 'provider']) {
          if (input[field] is! String ||
              (input[field] as String).trim().isEmpty ||
              (input[field] as String).length > 8000) {
            throw StateError('invalid_schedule');
          }
        }
        if (input['context'] is! Map ||
            (input['context'] as Map).keys.toSet().difference({
              'life',
              'web',
            }).isNotEmpty ||
            input['context']['life'] is! bool ||
            input['context']['web'] is! bool) {
          throw StateError('invalid_context');
        }
        final rule = Map<String, dynamic>.from(input['rule'] as Map),
            instant = now().toUtc();
        final next = await clock.next(rule, instant);
        if (next == null) throw StateError('schedule_in_past');
        if ((data['items'] as List).length >= 64) {
          throw StateError('schedule_capacity');
        }
        final item = {
          ...copyJson(input),
          'id': requestId(),
          'owner_device_id': deviceId,
          'revision': 1,
          'enabled': true,
          'cursor': instant.toIso8601String(),
          'next_slot': next,
          'missed_count': 0,
          'dst_gap_count': 0,
        };
        (data['items'] as List).add(item);
        return copyJson(item);
      });
  Future<void> setEnabled(String id, int revision, bool enabled) =>
      _write((data) async {
        final item = (data['items'] as List).firstWhere((e) => e['id'] == id);
        if (item['owner_device_id'] != deviceId || item['revision'] != revision) {
          throw StateError('stale_schedule');
        }
        item['enabled'] = enabled;
        item['revision'] = (item['revision'] as int) + 1;
        if (enabled) {
          final cursor = DateTime.parse(item['cursor']);
          final after = now().isAfter(cursor) ? now() : cursor;
          item['cursor'] = after.toUtc().toIso8601String();
          item['next_slot'] = await clock.next(
            Map<String, dynamic>.from(item['rule']),
            after,
          );
        }
      });
  Future<List<Map<String, dynamic>>> claimDue() => _write((data) async {
    final claimed = <Map<String, dynamic>>[], instant = now().toUtc();
    for (final item in data['items'] as List) {
      if (item['enabled'] != true || item['owner_device_id'] != deviceId) {
        continue;
      }
      final after = DateTime.parse(item['cursor']);
      if (!instant.isAfter(after)) continue;
      final rule = Map<String, dynamic>.from(item['rule'] as Map),
          due = await clock.due(rule, after, instant);
      item['cursor'] = instant.toIso8601String();
      item['next_slot'] = await clock.next(rule, instant);
      item['missed_count'] = (item['missed_count'] as int) + due.missed;
      item['dst_gap_count'] = (item['dst_gap_count'] as int) + due.gaps.length;
      if (due.latest == null) continue;
      // Epoch is intentionally absent: a relationship change is not a new slot.
      final id = lifeFingerprint({
        'owner': deviceId,
        'schedule': item['id'],
        'slot': due.latest!['slot_key'],
      });
      if ((data['runs'] as List).any((r) => r['run_id'] == id)) continue;
      if ((data['runs'] as List).any(
        (r) =>
            r['schedule_id'] == item['id'] &&
            !['completed', 'cancelled', 'failed'].contains(r['status']),
      )) {
        item['missed_count'] = (item['missed_count'] as int) + 1;
        continue;
      }
      final run = {
        'run_id': id,
        'schedule_id': item['id'],
        'definition': copyJson(item),
        'slot': due.latest,
        'status': 'claimed',
        'control_revision': 0,
        'task_id': null,
        'claimed_at': instant.toIso8601String(),
      };
      (data['runs'] as List).add(run);
      claimed.add(copyJson(run));
    }
    return claimed;
  });
  Future<void> bindTask(String id, String taskId) => _write((data) async {
    final run = (data['runs'] as List).firstWhere((e) => e['run_id'] == id);
    if (run['status'] != 'claimed' || run['task_id'] != null) {
      throw StateError('run_already_bound');
    }
    run['task_id'] = taskId;
    run['status'] = 'bound';
  });
  Future<void> checkpoint(
    String id,
    int revision,
    String status, {
    String? reason,
  }) => _write((data) async {
    final run = (data['runs'] as List).firstWhere((e) => e['run_id'] == id);
    if (run['control_revision'] != revision ||
        [
          'cancelled',
          'completed',
          'outcome_unknown',
          'failed',
        ].contains(run['status'])) {
      throw StateError('stale_run');
    }
    const transitions = {
      'bound': {'running', 'failed'},
      'running': {'waiting_approval', 'completed', 'failed', 'outcome_unknown'},
      'waiting_approval': {'running', 'outcome_unknown'},
    };
    if (!(transitions[run['status']] ?? {}).contains(status)) {
      throw StateError('invalid_run_transition');
    }
    run['status'] = status;
    if (reason != null) run['reason'] = reason;
  });
  Future<void> cancel(String id, int revision) => _write((data) async {
    final run = (data['runs'] as List).firstWhere((e) => e['run_id'] == id);
    if (run['control_revision'] != revision ||
        ['completed', 'cancelled'].contains(run['status'])) {
      throw StateError('stale_run');
    }
    run['control_revision'] = revision + 1;
    run['status'] = 'cancelled';
  });
  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
