// Pure transitions: persist returned state atomically; snapshots grant no authority.
class TodoSyncError implements Exception {
  final String message;
  final String code = 'version_conflict';
  const TodoSyncError(this.message);
  @override
  String toString() => 'TodoSyncError: $message';
}

class TodoVersion {
  final num version;
  final num baseVersion;
  final String content;
  const TodoVersion({
    required this.version,
    required this.baseVersion,
    required this.content,
  });
  factory TodoVersion.fromJson(Map<String, dynamic> json) => TodoVersion(
    version: json['version'] as num,
    baseVersion: json['base_version'] as num,
    content: json['content'] as String,
  );
  Map<String, dynamic> toJson() => {
    'version': version,
    'base_version': baseVersion,
    'content': content,
  };
}

class Tombstone {
  final String entityId;
  final num version;
  final bool permanent;
  const Tombstone({
    required this.entityId,
    required this.version,
    required this.permanent,
  });
  factory Tombstone.fromJson(Map<String, dynamic> json) => Tombstone(
    entityId: json['entity_id'] as String,
    version: json['version'] as num,
    permanent: json['permanent'] as bool,
  );
  Map<String, dynamic> toJson() => {
    'entity_id': entityId,
    'version': version,
    'permanent': permanent,
  };
}

class TodoState extends TodoVersion {
  final String id;
  final List<TodoVersion> conflicts;
  final List<Tombstone> tombstones;
  final bool projectionVisible;
  TodoState({
    required this.id,
    required super.version,
    required super.baseVersion,
    required super.content,
    required List<TodoVersion> conflicts,
    required List<Tombstone> tombstones,
    required this.projectionVisible,
  }) : conflicts = List.unmodifiable(conflicts),
       tombstones = List.unmodifiable(tombstones);
  factory TodoState.fromJson(Map<String, dynamic> json) => TodoState(
    id: json['id'] as String,
    version: json['version'] as num,
    baseVersion: json['base_version'] as num,
    content: json['content'] as String,
    conflicts: (json['conflicts'] as List)
        .map((v) => TodoVersion.fromJson(v as Map<String, dynamic>))
        .toList(),
    tombstones: (json['tombstones'] as List)
        .map((v) => Tombstone.fromJson(v as Map<String, dynamic>))
        .toList(),
    projectionVisible: json['projection_visible'] as bool,
  );
  @override
  Map<String, dynamic> toJson() => {
    ...super.toJson(),
    'id': id,
    'conflicts': conflicts.map((v) => v.toJson()).toList(),
    'tombstones': tombstones.map((v) => v.toJson()).toList(),
    'projection_visible': projectionVisible,
  };
  TodoState copyWith({
    num? version,
    num? baseVersion,
    String? content,
    List<TodoVersion>? conflicts,
    List<Tombstone>? tombstones,
    bool? projectionVisible,
  }) => TodoState(
    id: id,
    version: version ?? this.version,
    baseVersion: baseVersion ?? this.baseVersion,
    content: content ?? this.content,
    conflicts: conflicts ?? this.conflicts,
    tombstones: tombstones ?? this.tombstones,
    projectionVisible: projectionVisible ?? this.projectionVisible,
  );
}

class TodoSnapshot {
  final num version;
  final String phase;
  const TodoSnapshot({required this.version, required this.phase});
  factory TodoSnapshot.fromJson(Map<String, dynamic> json) => TodoSnapshot(
    version: json['version'] as num,
    phase: json['phase'] as String,
  );
  Map<String, dynamic> toJson() => {'version': version, 'phase': phase};
}

void _version(num value) {
  if (!value.isFinite ||
      value < 0 ||
      value > 9007199254740991 ||
      value != value.truncateToDouble()) {
    throw const TodoSyncError('Expected nonnegative int53 version');
  }
}

void _validateVersion(TodoVersion value) {
  _version(value.version);
  _version(value.baseVersion);
  if (value.baseVersion > value.version || value.content.isEmpty) {
    throw const TodoSyncError('Invalid version content or base');
  }
}

void _validate(TodoState state) {
  _validateVersion(state);
  if (state.id.isEmpty) throw const TodoSyncError('Invalid todo state');
  for (final conflict in state.conflicts) {
    _validateVersion(conflict);
  }
  for (final tombstone in state.tombstones) {
    _version(tombstone.version);
    if (tombstone.entityId.isEmpty || !tombstone.permanent)
      throw const TodoSyncError('Invalid tombstone');
  }
}

TodoVersion _entry(TodoVersion value) => TodoVersion(
  version: value.version,
  baseVersion: value.baseVersion,
  content: value.content,
);
bool _same(TodoVersion a, TodoVersion b) =>
    a.version == b.version &&
    a.baseVersion == b.baseVersion &&
    a.content == b.content;
bool _deleted(TodoState state) =>
    state.tombstones.any((t) => t.entityId == state.id);
List<TodoVersion> _retain(List<TodoVersion> conflicts, TodoVersion value) =>
    conflicts.any((c) => _same(c, value))
    ? conflicts
    : [...conflicts, _entry(value)];

TodoState merge(TodoState local, TodoVersion incoming) {
  _validate(local);
  _validateVersion(incoming);
  if (_deleted(local)) return local.copyWith(projectionVisible: false);
  if (_same(local, incoming)) return local;
  if (incoming.version <= local.version)
    return local.copyWith(conflicts: _retain(local.conflicts, incoming));
  return local.copyWith(
    version: incoming.version,
    baseVersion: incoming.baseVersion,
    content: incoming.content,
    conflicts: _retain(
      local.conflicts.where((c) => !_same(c, incoming)).toList(),
      local,
    ),
  );
}

TodoState chooseConflict(
  TodoState local,
  num expectedVersion,
  num chosenVersion,
) {
  _validate(local);
  _version(expectedVersion);
  _version(chosenVersion);
  if (_deleted(local) ||
      expectedVersion != local.version ||
      local.version == 9007199254740991) {
    throw const TodoSyncError('Accepted version changed or unavailable');
  }
  final candidates = [
    _entry(local),
    ...local.conflicts,
  ].where((c) => c.version == chosenVersion).toList();
  if (candidates.length != 1)
    throw const TodoSyncError('Choice missing or ambiguous');
  final chosen = candidates.single;
  final nextVersion =
      local.conflicts.fold<num>(
        local.version,
        (max, c) => c.version > max ? c.version : max,
      ) +
      1;
  _version(nextVersion);
  final conflicts = local.conflicts.where((c) => !_same(c, chosen)).toList();
  return local.copyWith(
    version: nextVersion,
    baseVersion: local.version,
    content: chosen.content,
    conflicts: _same(local, chosen) ? conflicts : _retain(conflicts, local),
  );
}

TodoState evictProjection(TodoState local) {
  _validate(local);
  return local.copyWith(projectionVisible: false);
}

TodoState applySnapshot(TodoState local, TodoSnapshot incoming) {
  _validate(local);
  _version(incoming.version);
  if (![
    'queued',
    'running',
    'verifying',
    'waiting',
    'completed',
    'cancelled',
    'failed',
  ].contains(incoming.phase)) {
    throw const TodoSyncError('Unknown snapshot phase');
  }
  return _deleted(local) ? local.copyWith(projectionVisible: false) : local;
}

TodoState applyTombstone(TodoState local, Tombstone incoming) {
  _validate(local);
  _validate(local.copyWith(tombstones: [incoming]));
  final retainedVersion = local.tombstones
      .where((t) => t.entityId == incoming.entityId)
      .fold<num>(
        incoming.version,
        (max, t) => t.version > max ? t.version : max,
      );
  final state = local.copyWith(
    tombstones: [
      ...local.tombstones.where((t) => t.entityId != incoming.entityId),
      Tombstone(
        entityId: incoming.entityId,
        version: retainedVersion,
        permanent: incoming.permanent,
      ),
    ],
  );
  return _deleted(state) ? state.copyWith(projectionVisible: false) : state;
}
