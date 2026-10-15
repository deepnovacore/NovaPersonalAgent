// Pure transitions; rejections throw TodoSyncError with a contract error code.
// Persist the returned state atomically; snapshots never grant execution authority.
export class TodoSyncError extends Error {
  readonly code = 'version_conflict'
  constructor(message: string) { super(message) }
}

export interface TodoVersion {
  version: number
  base_version: number
  content: string
}
export interface Tombstone {
  entity_id: string
  version: number
  permanent: true
}
export interface TodoState extends TodoVersion {
  id: string
  conflicts: TodoVersion[]
  tombstones: Tombstone[]
  projection_visible: boolean
}
export interface TodoSnapshot {
  version: number
  phase: 'queued' | 'running' | 'verifying' | 'waiting' | 'completed' | 'cancelled' | 'failed'
}

function version(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TodoSyncError('Expected nonnegative int53 version')
}
function validateVersion(value: TodoVersion): void {
  version(value.version)
  version(value.base_version)
  if (value.base_version > value.version || typeof value.content !== 'string' || !value.content.length)
    throw new TodoSyncError('Invalid version content or base')
}
function validate(state: TodoState): void {
  validateVersion(state)
  if (typeof state.id !== 'string' || !state.id.length || typeof state.projection_visible !== 'boolean')
    throw new TodoSyncError('Invalid todo state')
  for (const conflict of state.conflicts) validateVersion(conflict)
  for (const tombstone of state.tombstones) {
    version(tombstone.version)
    if (typeof tombstone.entity_id !== 'string' || !tombstone.entity_id.length || tombstone.permanent !== true)
      throw new TodoSyncError('Invalid tombstone')
  }
}
function entry(state: TodoVersion): TodoVersion {
  return {version: state.version, base_version: state.base_version, content: state.content}
}
function same(a: TodoVersion, b: TodoVersion): boolean {
  return a.version === b.version && a.base_version === b.base_version && a.content === b.content
}
function deleted(state: TodoState): boolean {
  return state.tombstones.some(t => t.entity_id === state.id)
}
function retain(conflicts: TodoVersion[], value: TodoVersion): TodoVersion[] {
  return conflicts.some(c => same(c, value)) ? conflicts : [...conflicts, entry(value)]
}

/** Incoming revisions are authority-assigned, not device timestamps. Equal divergent
 * revisions remain conflicts; only an explicit, unambiguous CAS can choose one. */
export function merge(local: TodoState, incoming: TodoVersion): TodoState {
  validate(local)
  validateVersion(incoming)
  if (deleted(local)) return {...local, projection_visible: false}
  if (same(local, incoming)) return local
  if (incoming.version <= local.version)
    return {...local, conflicts: retain(local.conflicts, incoming)}
  return {...local, ...entry(incoming), conflicts: retain(local.conflicts.filter(c => !same(c, incoming)), local)}
}

/** Called by the entity authority after the user confirms the displayed version. */
export function chooseConflict(local: TodoState, expectedVersion: number, chosenVersion: number): TodoState {
  validate(local)
  version(expectedVersion)
  version(chosenVersion)
  if (deleted(local) || expectedVersion !== local.version || local.version === Number.MAX_SAFE_INTEGER)
    throw new TodoSyncError('Accepted version changed or unavailable')
  const candidates = [entry(local), ...local.conflicts].filter(c => c.version === chosenVersion)
  if (candidates.length !== 1) throw new TodoSyncError('Choice missing or ambiguous')
  const chosen = candidates[0]!
  // Never allocate a revision that could collide with retained authority history.
  const nextVersion = local.conflicts.reduce((max, c) => Math.max(max, c.version), local.version) + 1
  version(nextVersion)
  const conflicts = local.conflicts.filter(c => !same(c, chosen))
  return {...local, version: nextVersion, base_version: local.version, content: chosen.content,
    conflicts: same(local, chosen) ? conflicts : retain(conflicts, local)}
}

export function evictProjection(local: TodoState): TodoState {
  validate(local)
  return {...local, projection_visible: false}
}

/** Projection uploads are not authority revisions. A permanent tombstone blocks
 * even newer untrusted uploads; an evicted card cannot be restored by replay. */
export function applySnapshot(local: TodoState, incoming: TodoSnapshot): TodoState {
  validate(local)
  version(incoming.version)
  if (!['queued', 'running', 'verifying', 'waiting', 'completed', 'cancelled', 'failed'].includes(incoming.phase))
    throw new TodoSyncError('Unknown snapshot phase')
  return deleted(local) ? {...local, projection_visible: false} : local
}

/** Retain deletion authority until a new synchronization baseline retires replay. */
export function applyTombstone(local: TodoState, incoming: Tombstone): TodoState {
  validate(local)
  validate({...local, tombstones: [incoming]})
  const previous = local.tombstones.filter(t => t.entity_id === incoming.entity_id)
  const retainedVersion = previous.reduce((max, t) => Math.max(max, t.version), incoming.version)
  const state = {...local, tombstones: [
    ...local.tombstones.filter(t => t.entity_id !== incoming.entity_id),
    {...incoming, version: retainedVersion},
  ]}
  return deleted(state) ? {...state, projection_visible: false} : state
}
