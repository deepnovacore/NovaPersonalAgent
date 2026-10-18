import assert from 'node:assert/strict'
import {z} from 'zod'
import {applySnapshot, chooseConflict, evictProjection, merge, TodoSyncError, type TodoState} from '../../src/device/todo-sync.js'
import {id, type ContractAdapter, type ContractCase} from '../device-contract-fixture.js'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const conflict = z.object({version: integer, base_version: integer, content: id}).strict()
const phase = z.enum(['queued', 'running', 'verifying', 'waiting', 'completed', 'cancelled', 'failed'])

function run(c: ContractCase): Promise<void> {
  const given = structuredClone(c.given)
  let state: TodoState = {...given.todo, base_version: given.todo.version,
    conflicts: z.array(conflict).parse(given.todo.conflicts), tombstones: given.tombstones,
    projection_visible: !given.tombstones.some(t => t.entity_id === given.todo.id)}
  let error: string | undefined
  for (const step of c.when) {
    const p = step.params
    try {
      switch (step.op) {
        case 'receive_version':
          state = merge(state, conflict.parse(p))
          break
        case 'choose_conflict':
          state = chooseConflict(state, integer.parse(p.expected_version), integer.parse(p.chosen_version))
          break
        case 'evict_projection':
          state = evictProjection(state)
          assert.equal(state.projection_visible, false)
          break
        case 'upload_snapshot':
          state = applySnapshot(state, {version: integer.parse(p.version), phase: phase.parse(p.phase)})
          break
        default: assert.fail('Unsupported todo operation: ' + step.op)
      }
    } catch (cause) {
      if (!(cause instanceof TodoSyncError)) throw cause
      error = cause.code
    }
  }
  // Sync has no authority to mutate these execution-ledger fields.
  const actual: Record<string, unknown> = {
    task_phase: given.task.phase, attempt_status: given.attempt.status,
    approval_status: given.approval.status, effects: given.effects,
    error, accepted_version: state.version, accepted_content: state.content,
    conflicts: state.conflicts, resurrected: state.projection_visible,
    tombstone_version: state.tombstones.filter(t => t.entity_id === state.id)
      .reduce<number | undefined>((max, t) => Math.max(max ?? 0, t.version), undefined),
  }
  for (const [key, expected] of Object.entries(c.then)) {
    assert.ok(Object.hasOwn(actual, key), 'Unchecked expectation: ' + key)
    assert.deepEqual(actual[key], expected, key)
  }
  assert.equal(error, c.then.error)
  if (c.when.some(step => step.op === 'evict_projection')) assert.equal(state.projection_visible, false)
  return Promise.resolve()
}

export const adapters: Record<string, ContractAdapter> = Object.fromEntries([
  'todo-conflict-cas', 'todo-cas-success', 'completed-projection-eviction',
  'permanent-delete-reconnect', 'tombstone-equal-version',
].map(caseId => [caseId, run]))
