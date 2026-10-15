import assert from 'node:assert/strict'
import {test} from 'node:test'
import {applyTombstone, applySnapshot, chooseConflict, evictProjection, merge, type TodoState} from '../src/device/todo-sync.js'

const initial = (): TodoState => ({id: 'todo', version: 1, base_version: 1, content: 'original', conflicts: [],
  tombstones: [], projection_visible: true})

test('merge preserves base versions, is immutable and idempotent; CAS retains displaced content', () => {
  const original = initial()
  const incoming = {version: 2, base_version: 1, content: 'other'}
  const merged = merge(original, incoming)
  assert.equal(original.version, 1)
  assert.deepEqual(merge(merged, incoming), merged)
  const chosen = chooseConflict(merged, 2, 1)
  assert.equal(chosen.version, 3)
  assert.equal(chosen.content, 'original')
  assert.deepEqual(chosen.conflicts, [incoming])
  assert.throws(() => chooseConflict(chosen, 2, 2), {code: 'version_conflict'})
  assert.throws(() => chooseConflict(chosen, 3, 99), {code: 'version_conflict'})
})

test('older and equal divergent versions are retained, ambiguous choices reject', () => {
  let state = merge(initial(), {version: 3, base_version: 1, content: 'new'})
  state = merge(state, {version: 2, base_version: 1, content: 'offline'})
  state = merge(state, {version: 2, base_version: 1, content: 'divergent'})
  assert.equal(state.version, 3)
  assert.equal(state.conflicts.length, 3)
  assert.throws(() => chooseConflict(state, 3, 2), {code: 'version_conflict'})
})

test('permanent tombstones survive JSON roundtrip and block even newer untrusted snapshots', () => {
  const state = {...initial(), tombstones: [{entity_id: 'todo', version: 2, permanent: true as const}]}
  for (const version of [0, 1, 2, 3]) {
    const result = applySnapshot(JSON.parse(JSON.stringify(state)) as TodoState, {version, phase: 'running'})
    assert.equal(result.projection_visible, false)
    assert.deepEqual(result.tombstones, state.tombstones)
    assert.equal(result.version, 1)
  }
  assert.equal(applySnapshot({...initial(), tombstones: [{entity_id: 'other', version: 2, permanent: true}]},
    {version: 2, phase: 'queued'}).projection_visible, true)
})

test('evicted projection stays evicted across reconnect without deleting content', () => {
  const state = evictProjection(initial())
  const restored = applySnapshot(JSON.parse(JSON.stringify(state)) as TodoState, {version: 4, phase: 'running'})
  assert.deepEqual(restored, state)
  assert.equal(restored.content, 'original')
})

test('int53 validation and overflow fail without mutation', () => {
  for (const version of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => merge(initial(), {version, base_version: 1, content: 'bad'}), {code: 'version_conflict'})
    assert.throws(() => applySnapshot(initial(), {version, phase: 'queued'}), {code: 'version_conflict'})
  }
  const state = {...initial(), version: Number.MAX_SAFE_INTEGER}
  assert.throws(() => chooseConflict(state, state.version, state.version), {code: 'version_conflict'})
  assert.equal(state.content, 'original')
})

test('tombstone writes retain the greatest version and cannot be undone by replay', () => {
  const tombstone = {entity_id: 'todo', version: 2, permanent: true as const}
  const deleted = applyTombstone(initial(), tombstone)
  assert.equal(deleted.projection_visible, false)
  assert.deepEqual(applyTombstone(deleted, {...tombstone, version: 1}), deleted)
  assert.deepEqual(applyTombstone(deleted, tombstone), deleted)
  assert.equal(applyTombstone(deleted, {...tombstone, version: 3}).tombstones[0]?.version, 3)
  assert.equal(merge(deleted, {version: 4, base_version: 1, content: 'resurrection'}).content, 'original')
  assert.throws(() => chooseConflict(deleted, 1, 1), {code: 'version_conflict'})
})
