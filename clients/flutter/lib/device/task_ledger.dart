import 'dart:convert';
import 'ownership.dart' show canonicalPayload;

class TaskLedgerError implements Exception {
  final String code;
  const TaskLedgerError(this.code);
  @override
  String toString() => code;
}

Never _fail(String code) => throw TaskLedgerError(code);
Map<String, dynamic> _copy(Map<String, dynamic> value) =>
    jsonDecode(jsonEncode(value)) as Map<String, dynamic>;
void _text(dynamic value) {
  if (value is! String || value.trim().isEmpty) _fail('request_conflict');
}

void _integer(dynamic value) {
  if (value is! num ||
      !value.isFinite ||
      value < 0 ||
      value > 9007199254740991 ||
      value != value.truncateToDouble()) {
    _fail('stale_task');
  }
}

bool _terminal(Map<String, dynamic> task) =>
    ['completed', 'cancelled', 'failed'].contains(task['phase']);

// The host serializes mutations and persists toJson() before ACK or external I/O.
// This local journal is not a device authority or a persistence implementation.
class TaskLedger {
  final String Function() id;
  final num Function() now;
  final Map<String, dynamic> _state;
  TaskLedger({required this.id, required this.now})
    : _state = {
        'tasks': <String, dynamic>{},
        'receipts': <String, dynamic>{},
        'effects': <String, dynamic>{},
        'inputs': <String, dynamic>{},
      };
  TaskLedger.fromJson(
    Map<String, dynamic> json, {
    required this.id,
    required this.now,
  }) : _state = _copy(json) {
    for (final task in _tasks.values.cast<Map<String, dynamic>>()) {
      _text(task['id']);
      _integer(task['control_revision']);
      _integer(task['goal_revision']);
      if (![
        'queued',
        'running',
        'verifying',
        'waiting',
        'completed',
        'cancelled',
        'failed',
      ].contains(task['phase'])) {
        _fail('task_terminal');
      }
    }
    for (final effect in _effects.values) {
      if (![
            'prepared',
            'dispatching',
            'accepted',
            'failed',
            'unknown-effect',
          ].contains(effect['status']) ||
          effect['dispatch_started'] is! bool ||
          effect['status'] == 'prepared' &&
              effect['dispatch_started'] != false ||
          [
                'dispatching',
                'accepted',
                'unknown-effect',
              ].contains(effect['status']) &&
              effect['dispatch_started'] != true) {
        _fail('request_conflict');
      }
      _task(effect['task_id']);
      _integer(effect['fence']['control_revision']);
      _integer(effect['fence']['goal_revision']);
      if (effect['status'] == 'prepared') effect['status'] = 'failed';
      if (effect['status'] == 'dispatching') {
        effect['status'] = 'unknown-effect';
      }
    }
    for (final receipt in _inputs.values) {
      if (![
            'accepted',
            'failed',
            'unknown-effect',
          ].contains(receipt['status']) ||
          receipt['dispatch_started'] != true) {
        _fail('request_conflict');
      }
      _task(receipt['task_id']);
    }
  }
  Map<String, dynamic> get _tasks => _state['tasks'] as Map<String, dynamic>;
  Map<String, dynamic> get _effects =>
      _state['effects'] as Map<String, dynamic>;
  Map<String, dynamic> get _inputs => _state['inputs'] as Map<String, dynamic>;
  Map<String, dynamic> toJson() => _copy(_state);
  Map<String, dynamic> _task(String taskId) =>
      _tasks[taskId] as Map<String, dynamic>? ?? _fail('task_not_found');
  Map<String, dynamic> get(String taskId) => _copy(_task(taskId));
  List<Map<String, dynamic>> list() =>
      _tasks.values.map((t) => _copy(t)).toList();
  Map<String, dynamic> effect(String effectId) => _copy(
    _effects[effectId] as Map<String, dynamic>? ?? _fail('effect_not_found'),
  );
  Map<String, dynamic>? pendingEffect(String taskId) {
    for (final effect in _effects.values) {
      if (effect['task_id'] == taskId &&
          [
            'prepared',
            'dispatching',
            'unknown-effect',
          ].contains(effect['status'])) {
        return _copy(effect);
      }
    }
    return null;
  }

  List<Map<String, dynamic>> inputReceipts(String taskId) => _inputs.values
      .where((r) => r['task_id'] == taskId)
      .map((r) => _copy(r))
      .toList();

  Map<String, dynamic> _request(
    String key,
    Map<String, dynamic> payload,
    Map<String, dynamic> Function() change,
  ) {
    _text(key);
    final body = canonicalPayload(payload);
    final receipts = _state['receipts'] as Map<String, dynamic>;
    final prior = receipts[key];
    if (prior != null) {
      if (prior['payload'] != body) _fail('request_conflict');
      return _copy(prior['result']);
    }
    final result = change();
    receipts[key] = {'payload': body, 'result': _copy(result)};
    return _copy(result);
  }

  Map<String, dynamic> delegate(String key, Map<String, dynamic> input) {
    for (final field in ['conversation_id', 'origin_ref', 'goal']) {
      _text(input[field]);
    }
    if (input['acceptance'] is! List) _fail('request_conflict');
    for (final criterion in input['acceptance']) {
      _text(criterion);
    }
    if (input.containsKey('conversation_generation')) {
      _integer(input['conversation_generation']);
    }
    if (input.containsKey('todo_ref')) {
      _text(input['todo_ref']['id']);
      _integer(input['todo_ref']['version']);
    }
    return _request(key, input, () {
      final taskId = id();
      _text(taskId);
      if (_tasks.containsKey(taskId)) _fail('request_conflict');
      final task = <String, dynamic>{
        ..._copy(input),
        'id': taskId,
        'phase': 'queued',
        'control_revision': 0,
        'goal_revision': 0,
        'work_ids': <String>[],
        'session_ids': <String>[],
        'waiting_reason': null,
      };
      _tasks[taskId] = task;
      return task;
    });
  }

  void assertCurrent(Map<String, dynamic> fence) {
    _text(fence['task_id']);
    _integer(fence['control_revision']);
    _integer(fence['goal_revision']);
    final task = _task(fence['task_id']);
    if (task['control_revision'] != fence['control_revision'] ||
        task['goal_revision'] != fence['goal_revision']) {
      _fail('stale_task');
    }
  }

  void assertWritable(Map<String, dynamic> fence) {
    assertCurrent(fence);
    if (_terminal(_task(fence['task_id']))) _fail('task_terminal');
  }

  void bindWork(
    Map<String, dynamic> fence,
    String workId, [
    String? sessionId,
  ]) {
    _text(workId);
    if (sessionId != null) _text(sessionId);
    assertWritable(fence);
    final task = _task(fence['task_id']);
    for (final other in _tasks.values) {
      if (other['id'] == task['id']) continue;
      if (!_terminal(other) && (other['work_ids'] as List).contains(workId)) {
        _fail('work_active');
      }
      if (sessionId != null &&
          (other['session_ids'] as List).contains(sessionId)) {
        _fail('session_active');
      }
    }
    if (['queued', 'waiting'].contains(task['phase'])) {
      task['phase'] = 'running';
      task['waiting_reason'] = null;
    }
    if (!(task['work_ids'] as List).contains(workId)) {
      task['work_ids'].add(workId);
    }
    if (sessionId != null &&
        !(task['session_ids'] as List).contains(sessionId)) {
      task['session_ids'].add(sessionId);
    }
  }

  Map<String, dynamic> cancel(String key, Map<String, dynamic> fence) =>
      _request(key, {'operation': 'cancel', 'fence': fence}, () {
        assertWritable(fence);
        final task = _task(fence['task_id']);
        task['phase'] = 'cancelled';
        task['waiting_reason'] =
            _uncertain(task['id']) || (task['work_ids'] as List).isNotEmpty
            ? 'cancellation_pending'
            : null;
        return task;
      });
  Map<String, dynamic> reviseGoal(
    String key,
    Map<String, dynamic> fence,
    String goal,
    List<String> acceptance,
  ) {
    _text(goal);
    for (final item in acceptance) {
      _text(item);
    }
    return _request(
      key,
      {
        'operation': 'revise_goal',
        'fence': fence,
        'goal': goal,
        'acceptance': acceptance,
      },
      () {
        assertWritable(fence);
        final task = _task(fence['task_id']);
        if (task['goal'] != goal ||
            canonicalPayload(task['acceptance']) !=
                canonicalPayload(acceptance)) {
          _integer(task['goal_revision'] + 1);
          task['goal_revision']++;
          task['goal'] = goal;
          task['acceptance'] = List<String>.of(acceptance);
        }
        return task;
      },
    );
  }

  bool _uncertain(String taskId) =>
      pendingEffect(taskId) != null ||
      inputReceipts(taskId).any((r) => r['status'] == 'unknown-effect');
  String reserveInitial(Map<String, dynamic> fence) {
    assertWritable(fence);
    final task = _task(fence['task_id']);
    if (_uncertain(task['id']) || (task['work_ids'] as List).isNotEmpty) {
      _fail('task_effect_unknown');
    }
    if (_effects.values.any(
      (e) =>
          e['task_id'] == task['id'] &&
          canonicalPayload(e['fence']) == canonicalPayload(fence) &&
          e['status'] != 'failed',
    )) {
      _fail('task_initial_pending');
    }
    final effectId = id();
    _text(effectId);
    if (_effects.containsKey(effectId)) _fail('request_conflict');
    _effects[effectId] = {
      'id': effectId,
      'task_id': task['id'],
      'fence': _copy(fence),
      'instruction': task['goal'],
      'status': 'prepared',
      'dispatch_started': false,
    };
    return effectId;
  }

  void markEffectDispatching(String effectId) {
    final effect = _effects[effectId];
    if (effect == null || effect['status'] != 'prepared') {
      _fail('effect_not_pending');
    }
    assertWritable(effect['fence']);
    effect['status'] = 'dispatching';
    effect['dispatch_started'] = true;
  }

  void settleEffect(String effectId, String status) {
    if (!['accepted', 'failed', 'unknown-effect'].contains(status)) {
      _fail('request_conflict');
    }
    final effect = _effects[effectId];
    if (effect == null) _fail('effect_not_found');
    if (effect['status'] == 'prepared' && status != 'failed') {
      _fail('effect_not_pending');
    }
    if (['prepared', 'dispatching'].contains(effect['status'])) {
      effect['status'] = status;
    }
  }

  void recoveryWait(String taskId, String reason) {
    _text(reason);
    final task = _task(taskId);
    if (_terminal(task)) return;
    task['phase'] = 'waiting';
    task['waiting_reason'] = reason;
  }

  Future<String> input(
    String key,
    Map<String, dynamic> fence,
    String sessionId,
    String text,
    Future<String> Function() send,
  ) async {
    _text(key);
    _text(sessionId);
    _text(text);
    final body = canonicalPayload({
      'fence': fence,
      'session_id': sessionId,
      'text': text,
    });
    final prior = _inputs[key];
    if (prior != null) {
      if (prior['payload'] != body) _fail('request_conflict');
      return prior['status'] as String;
    }
    assertWritable(fence);
    if (_uncertain(fence['task_id'])) _fail('task_effect_unknown');
    if (!(_task(fence['task_id'])['session_ids'] as List).contains(sessionId)) {
      _fail('session_not_found');
    }
    final at = now();
    _integer(at);
    final receipt = <String, dynamic>{
      'request_id': key,
      'payload': body,
      'task_id': fence['task_id'],
      'fence': _copy(fence),
      'actor': {'kind': 'nova'},
      'session_id': sessionId,
      'text': text,
      'status': 'unknown-effect',
      'dispatch_started': true,
      'created_at': at,
    };
    _inputs[key] = receipt;
    // send must persist this intent before calling the external service.
    try {
      final status = await send();
      receipt['status'] = ['accepted', 'failed'].contains(status)
          ? status
          : 'unknown-effect';
    } catch (_) {
      receipt['status'] = 'unknown-effect';
    }
    return receipt['status'] as String;
  }
}
