// The trusted host serializes calls and saves mutations before ACK or effects.
abstract interface class Clock {
  num now();
}

class AuthorityError implements Exception {
  final String code;
  AuthorityError(this.code);
  @override
  String toString() => code;
}

Never _fail(String code) => throw AuthorityError(code);
const _numbers = [
  'todo_version',
  'goal_revision',
  'control_revision',
  'lifecycle_generation',
  'capability_revision',
  'conversation_generation',
  'data_version',
  'observation_version',
  'expires_at',
];
const _strings = [
  'task_id',
  'owner',
  'effect_class',
  'proposal_digest',
  'executable_digest',
];
const _fenceKeys = [
  'todo_version',
  'goal_revision',
  'control_revision',
  'lifecycle_generation',
  'capability_revision',
];
bool _isInteger(dynamic n) =>
    n is num &&
    n.isFinite &&
    n >= 0 &&
    n <= 9007199254740991 &&
    n == n.truncateToDouble();
void _integer(dynamic n) {
  if (!_isInteger(n)) _fail('stale_fence');
}

void _nonempty(dynamic s) {
  if (s is! String || s.isEmpty) _fail('stale_fence');
}

void _validate(Map<String, dynamic> b) {
  for (final key in _numbers) {
    _integer(b[key]);
  }
  for (final key in _strings) {
    _nonempty(b[key]);
  }
  final scope = b['permission_scope'];
  if (scope is! List || scope.isEmpty) _fail('permission_denied');
  for (final value in scope) {
    _nonempty(value);
  }
}

bool _same(Map<String, dynamic> a, Map<String, dynamic> b) {
  final x = a['permission_scope'] as List;
  final y = b['permission_scope'] as List;
  return [..._numbers, ..._strings].every((k) => a[k] == b[k]) &&
      x.length == y.length &&
      List.generate(x.length, (i) => i).every((i) => x[i] == y[i]);
}

Map<String, dynamic> _copy(Map<String, dynamic> b) => {
  ...b,
  'permission_scope': List<dynamic>.of(b['permission_scope'] as List),
};
dynamic _clone(dynamic value) {
  if (value is Map) {
    return value.map((k, dynamic v) => MapEntry(k as String, _clone(v)));
  }
  if (value is List) return value.map(_clone).toList();
  return value;
}

class Authority {
  final Map<String, dynamic> state;
  final Clock clock;
  Authority(this.state, this.clock);
  factory Authority.fromJson(Map<String, dynamic> json, Clock clock) =>
      Authority(_clone(json) as Map<String, dynamic>, clock);
  Map<String, dynamic> toJson() => _clone(state) as Map<String, dynamic>;
  List<dynamic> get _tasks => state['tasks'] as List<dynamic>;
  List<dynamic> get _grants => state['grants'] as List<dynamic>;
  List<dynamic> get _receipts => state['receipts'] as List<dynamic>;
  Map<String, dynamic>? _find(
    List<dynamic> items,
    bool Function(Map<String, dynamic>) test,
  ) {
    for (final item in items) {
      final map = item as Map<String, dynamic>;
      if (test(map)) return map;
    }
    return null;
  }

  Map<String, dynamic>? _task(dynamic id) =>
      _find(_tasks, (t) => t['bindings']['task_id'] == id);
  Map<String, dynamic> _grant(String ref) =>
      _find(_grants, (g) => g['grant_ref'] == ref) ??
      _fail('approval_required');

  void createGrant(String grantRef, Map<String, dynamic> bindings) {
    _nonempty(grantRef);
    _validate(bindings);
    if (_grants.any((g) => g['grant_ref'] == grantRef)) {
      _fail('request_conflict');
    }
    final task = _task(bindings['task_id']);
    if (task == null ||
        !_same(task['bindings'], bindings) ||
        bindings['lifecycle_generation'] != state['lifecycle_generation']) {
      _fail('stale_fence');
    }
    if (task['stopped'] == true) _fail('approval_revoked');
    _grants.add({
      'grant_ref': grantRef,
      'status': 'pending',
      'bindings': _copy(bindings),
      'consumed': false,
    });
  }

  void _recheck(Map<String, dynamic> grant) {
    final b = grant['bindings'] as Map<String, dynamic>;
    final task = _task(b['task_id']);
    if (task == null) {
      grant['status'] = 'expired';
      _fail('stale_fence');
    }
    if (task['stopped'] == true) {
      grant['status'] = 'revoked';
      _fail('approval_revoked');
    }
    if (!(b['permission_scope'] as List).every(
      (s) => (task['permissions'] as List).contains(s),
    )) {
      grant['status'] = 'revoked';
      _fail('permission_denied');
    }
    _validate(task['bindings']);
    _integer(state['lifecycle_generation']);
    final now = clock.now();
    _integer(now);
    if (grant['status'] != 'revoked' &&
        (now >= b['expires_at'] ||
            !_same(b, task['bindings']) ||
            b['lifecycle_generation'] != state['lifecycle_generation'])) {
      grant['status'] = 'expired';
      _fail(now >= b['expires_at'] ? 'approval_expired' : 'stale_fence');
    }
    if (grant['status'] == 'revoked') _fail('approval_revoked');
    if (grant['status'] == 'expired') _fail('approval_expired');
  }

  void approveGrant(String grantRef) {
    final grant = _grant(grantRef);
    _recheck(grant);
    if (grant['consumed'] == true || grant['status'] == 'consumed') {
      _fail('approval_consumed');
    }
    if (grant['status'] != 'pending') _fail('approval_required');
    grant['status'] = 'approved';
  }

  Map<String, dynamic> authorizeDispatch(Map<String, dynamic> request) {
    _nonempty(request['operation_id']);
    _nonempty(request['grant_ref']);
    _nonempty(request['kind']);
    _validate(request['bindings']);
    final previous = _find(
      _receipts,
      (r) => r['request']['operation_id'] == request['operation_id'],
    );
    if (previous != null) {
      final p = previous['request'];
      if (p['grant_ref'] != request['grant_ref'] ||
          p['kind'] != request['kind'] ||
          !_same(p['bindings'], request['bindings'])) {
        _fail('request_conflict');
      }
      // Replay is evidence, never permission to repeat an external effect.
      return {'intent': previous['intent'], 'replayed': true};
    }
    final grant = _grant(request['grant_ref']);
    _recheck(grant);
    if (!_same(grant['bindings'], request['bindings'])) _fail('stale_fence');
    if (!(grant['bindings']['permission_scope'] as List).contains(
      request['kind'],
    )) {
      _fail('permission_denied');
    }
    if (grant['consumed'] == true || grant['status'] == 'consumed') {
      _fail('approval_consumed');
    }
    if (grant['status'] != 'approved') _fail('approval_required');
    _receipts.add({
      'request': {...request, 'bindings': _copy(request['bindings'])},
      'intent': 'prepared',
    });
    grant['consumed'] = true;
    grant['status'] = 'consumed';
    return {'intent': 'prepared', 'replayed': false};
  }

  void revokeForStop(String taskId) {
    final task = _task(taskId) ?? _fail('stale_fence');
    if (task['stopped'] != true) {
      _integer(task['bindings']['control_revision'] + 1);
      task['bindings']['control_revision']++;
      task['stopped'] = true;
    }
    for (final grant in _grants) {
      if (grant['bindings']['task_id'] == taskId) grant['status'] = 'revoked';
    }
  }

  num bumpLifecycleGeneration() {
    _integer(state['lifecycle_generation'] + 1);
    state['lifecycle_generation']++;
    for (final task in _tasks) {
      task['bindings']['lifecycle_generation'] = state['lifecycle_generation'];
    }
    for (final grant in _grants) {
      if (grant['status'] != 'revoked') grant['status'] = 'expired';
    }
    return state['lifecycle_generation'];
  }

  Map<String, bool> classifyReply(Map<String, dynamic> fence) {
    final task = _task(fence['task_id']);
    return {
      'late':
          task == null ||
          task['stopped'] == true ||
          fence['lifecycle_generation'] != state['lifecycle_generation'] ||
          _fenceKeys.any(
            (k) => !_isInteger(fence[k]) || fence[k] != task['bindings'][k],
          ),
    };
  }
}
