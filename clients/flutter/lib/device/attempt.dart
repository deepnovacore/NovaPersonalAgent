class AttemptError implements Exception {
  final String code;
  const AttemptError(this.code);
  @override
  String toString() => code;
}

class AttemptState {
  final Map<String, dynamic> _data;
  AttemptState.fromJson(Map<String, dynamic> json)
    : _data = {
        ...json,
        'attempt': Map<String, dynamic>.from(json['attempt'] as Map),
        'evidence': List<String>.from(json['evidence'] as List),
        if (json['consumed_verification_grants'] != null)
          'consumed_verification_grants': List<String>.from(
            json['consumed_verification_grants'] as List,
          ),
      };
  Map<String, dynamic> toJson() => {
    ..._data,
    'attempt': Map<String, dynamic>.from(_data['attempt'] as Map),
    'evidence': List<String>.from(_data['evidence'] as List),
    if (_data['consumed_verification_grants'] != null)
      'consumed_verification_grants': List<String>.from(
        _data['consumed_verification_grants'] as List,
      ),
  };
}

// The host persists the returned state before making an external call.
AttemptState advanceAttempt(AttemptState state, Map<String, dynamic> event) {
  final data = state.toJson();
  final attempt = data['attempt'] as Map<String, dynamic>;
  final terminal = [
    'completed',
    'cancelled',
    'failed',
  ].contains(data['task_phase']);
  List<String> evidence(Object? ref) {
    if (ref is! String || ref.isEmpty) throw const AttemptError('stale_fence');
    return [...(data['evidence'] as List).cast<String>(), ref];
  }

  final effects = data['effects'];
  if (effects is! num ||
      !effects.isFinite ||
      effects < 0 ||
      effects > 9007199254740991 ||
      effects != effects.truncateToDouble() ||
      attempt['id'] == null ||
      attempt['id'] == '' ||
      attempt['id'] == false ||
      attempt['id'] == 0) {
    throw const AttemptError('stale_fence');
  }
  switch (event['op']) {
    case 'persist_intent':
      if (attempt['status'] == 'unknown-effect') {
        throw const AttemptError('unknown_effect');
      }
      if (terminal ||
          attempt['status'] != 'none' ||
          attempt['dispatch_started'] == true) {
        throw const AttemptError('stale_fence');
      }
      attempt['status'] = 'prepared';
    case 'retry_dispatch':
    case 'mark_dispatch_started':
      if (attempt['status'] == 'unknown-effect' ||
          attempt['dispatch_started'] == true) {
        throw const AttemptError('unknown_effect');
      }
      if (terminal || attempt['status'] != 'prepared') {
        throw const AttemptError('stale_fence');
      }
      data['task_phase'] = 'running';
      attempt['status'] = 'dispatching';
      attempt['dispatch_started'] = true;
    case 'restart':
      if (attempt['status'] != 'dispatching' &&
          attempt['status'] != 'unknown-effect') {
        return state;
      }
      if (!terminal) data['task_phase'] = 'waiting';
      attempt['status'] = 'unknown-effect';
    case 'accept':
      if (terminal || attempt['status'] != 'dispatching') {
        throw const AttemptError('stale_fence');
      }
      data['task_phase'] = 'verifying';
      attempt['status'] = 'accepted';
    case 'prove_not_dispatched':
      if (attempt['dispatch_started'] == true) {
        throw const AttemptError('unknown_effect');
      }
      if (terminal || attempt['status'] != 'prepared') {
        throw const AttemptError('stale_fence');
      }
      data['task_phase'] = 'failed';
      attempt['status'] = 'failed';
      data['evidence'] = evidence(event['evidence_ref']);
    case 'verify_outcome':
      if (attempt['status'] != 'unknown-effect' ||
          (terminal && data['task_phase'] != 'cancelled')) {
        throw const AttemptError('stale_fence');
      }
      final grant = event['grant'] as Map<String, dynamic>?;
      final consumed = (data['consumed_verification_grants'] as List?) ?? [];
      if (grant?['status'] != 'approved' ||
          grant?['grant_ref'] == null ||
          grant?['grant_ref'] == '' ||
          grant?['grant_ref'] == data['action_grant_ref'] ||
          grant?['scope'] != 'sandbox.fs.read' ||
          grant?['attempt_id'] != attempt['id'] ||
          consumed.contains(grant?['grant_ref'])) {
        throw const AttemptError('approval_required');
      }
      final outcome = event['outcome'];
      if (outcome != 'completed' && outcome != 'failed') {
        throw const AttemptError('stale_fence');
      }
      if (data['task_phase'] != 'cancelled') data['task_phase'] = outcome;
      attempt['status'] = outcome == 'completed' ? 'accepted' : 'failed';
      data['evidence'] = evidence(event['evidence_ref']);
      data['consumed_verification_grants'] = [...consumed, grant!['grant_ref']];
    default:
      throw const AttemptError('stale_fence');
  }
  return AttemptState.fromJson(data);
}
