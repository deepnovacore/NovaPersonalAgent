import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Authority, type Bindings, type AuthorityState} from '../src/device/authority.js'

const binding = (): Bindings => ({
  task_id: 'task', owner: 'device', todo_version: 1, goal_revision: 0,
  control_revision: 0, lifecycle_generation: 0, capability_revision: 1,
  conversation_generation: 0, data_version: 1, observation_version: 1,
  permission_scope: ['sandbox.command'], effect_class: 'write',
  proposal_digest: 'action', executable_digest: 'script', expires_at: 100,
})
function setup() {
  const current = binding()
  const state: AuthorityState = {lifecycle_generation: 0,
    tasks: [{bindings: current, permissions: ['sandbox.command'], stopped: false}],
    grants: [], receipts: []}
  let now = 0
  const ledger = new Authority(state, {now: () => now})
  ledger.createGrant('grant', current)
  const request = {grant_ref: 'grant', operation_id: 'op', kind: 'sandbox.command', bindings: binding()}
  return {state, current, ledger, request, time: (value: number) => {now = value}}
}
test('pending exec rejects; exact replay does not consume or dispatch twice', () => {
  const {ledger, request, state} = setup()
  assert.throws(() => ledger.authorizeDispatch(request), {code: 'approval_required'})
  ledger.approveGrant('grant')
  const first = ledger.authorizeDispatch(request)
  assert.equal(first.replayed, false)
  assert.deepEqual(ledger.authorizeDispatch(request), {...first, replayed: true})
  assert.equal(state.receipts.length, 1)
  assert.throws(() => ledger.authorizeDispatch({...request, operation_id: 'op2'}), {code: 'approval_consumed'})
  assert.throws(() => ledger.authorizeDispatch({...request, kind: 'calendar.write'}), {code: 'request_conflict'})
})
test('every binding change expires approval, including consumed grants', () => {
  for (const key of Object.keys(binding()) as (keyof Bindings)[]) {
    const {ledger, request, current, state} = setup()
    ledger.approveGrant('grant')
    ledger.authorizeDispatch(request)
    const value = current[key]
    Object.assign(current, {[key]: Array.isArray(value) ? ['changed'] : typeof value === 'number' ? value + 1 : value + '-new'})
    assert.throws(() => ledger.authorizeDispatch({...request, operation_id: 'next'}))
    assert.equal(state.grants[0]!.status, 'expired', key)
    Object.assign(current, binding())
    assert.throws(() => ledger.approveGrant('grant'))
    assert.throws(() => ledger.authorizeDispatch({...request, operation_id: 'next'}))
  }
})
test('deadline inclusive; terminal records never reapprove', () => {
  const {ledger, time, state} = setup()
  time(100)
  assert.throws(() => ledger.approveGrant('grant'), {code: 'approval_expired'})
  assert.equal(state.grants[0]!.status, 'expired')
  time(0)
  assert.throws(() => ledger.approveGrant('grant'), {code: 'approval_expired'})
})
test('stop revokes all grants and increments control before returning; remains stopped', () => {
  const {ledger, current, state, request} = setup()
  ledger.createGrant('second', current)
  ledger.approveGrant('grant')
  ledger.revokeForStop('task')
  assert.equal(current.control_revision, 1)
  assert.ok(state.grants.every(g => g.status === 'revoked'))
  ledger.revokeForStop('task')
  assert.equal(current.control_revision, 1)
  assert.throws(() => ledger.authorizeDispatch(request), {code: 'approval_revoked'})
})
test('permission withdrawal revokes even with unchanged capability revision', () => {
  const {ledger, request, state} = setup()
  ledger.approveGrant('grant')
  state.tasks[0]!.permissions = []
  assert.throws(() => ledger.authorizeDispatch(request), {code: 'permission_denied'})
  assert.equal(state.grants[0]!.status, 'revoked')
  state.tasks[0]!.permissions = ['sandbox.command']
  assert.throws(() => ledger.authorizeDispatch(request), {code: 'approval_revoked'})
})
test('device background expires all grants; old replies remain late', () => {
  const {ledger, request, state} = setup()
  ledger.approveGrant('grant')
  ledger.authorizeDispatch(request)
  assert.equal(ledger.bumpLifecycleGeneration(), 1)
  assert.equal(state.grants[0]!.status, 'expired')
  assert.equal(ledger.classifyReply(request.bindings).late, true)
  const restored = new Authority(JSON.parse(JSON.stringify(state)) as AuthorityState, {now: () => 0})
  assert.equal(restored.classifyReply(request.bindings).late, true)
  assert.throws(() => restored.authorizeDispatch({...request, operation_id: 'next'}))
})
test('reject invalid int53, empty IDs, scope and executable digest without dispatch', () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    const {ledger, current} = setup()
    assert.throws(() => ledger.createGrant('bad', {...current, data_version: value}), {code: 'stale_fence'})
  }
  const {ledger, request, state} = setup()
  ledger.approveGrant('grant')
  assert.throws(() => ledger.authorizeDispatch({...request, operation_id: ''}))
  assert.throws(() => ledger.authorizeDispatch({...request, kind: 'calendar.write'}), {code: 'permission_denied'})
  assert.throws(() => ledger.authorizeDispatch({...request, bindings: {...request.bindings, executable_digest: ''}}))
  assert.equal(state.receipts.length, 0)
})
test('lifecycle/control overflow fails without partially mutating state', () => {
  const {ledger, state, current} = setup()
  state.lifecycle_generation = Number.MAX_SAFE_INTEGER
  assert.throws(() => ledger.bumpLifecycleGeneration(), {code: 'stale_fence'})
  current.control_revision = Number.MAX_SAFE_INTEGER
  assert.throws(() => ledger.revokeForStop('task'), {code: 'stale_fence'})
  assert.equal(state.tasks[0]!.stopped, false)
})
test('future request fences cannot upgrade authority; replay survives stop and restoration', () => {
  const {ledger, request, state, current} = setup()
  ledger.approveGrant('grant')
  assert.throws(() => ledger.authorizeDispatch({...request,
    bindings: {...request.bindings, capability_revision: 2}}), {code: 'stale_fence'})
  assert.equal(current.capability_revision, 1)
  ledger.authorizeDispatch(request)
  ledger.revokeForStop('task')
  const restored = new Authority(JSON.parse(JSON.stringify(state)) as AuthorityState, {now: () => 0})
  assert.equal(restored.authorizeDispatch(request).replayed, true)
  assert.throws(() => restored.authorizeDispatch({...request, operation_id: 'new'}), {code: 'approval_revoked'})
  assert.throws(() => restored.createGrant('grant', current), {code: 'request_conflict'})
  assert.equal(state.grants[0]!.consumed, true)
})
test('reply classification checks every fence, missing tasks and device-wide generations', () => {
  const {ledger, request, state} = setup()
  assert.equal(ledger.classifyReply(request.bindings).late, false)
  for (const key of ['todo_version', 'goal_revision', 'control_revision', 'lifecycle_generation', 'capability_revision'] as const) {
    assert.equal(ledger.classifyReply({...request.bindings, [key]: request.bindings[key] + 1}).late, true)
  }
  assert.equal(ledger.classifyReply({...request.bindings, task_id: 'missing'}).late, true)
  const second = {...binding(), task_id: 'other'}
  state.tasks.push({bindings: second, permissions: ['sandbox.command'], stopped: false})
  ledger.createGrant('second', second)
  ledger.bumpLifecycleGeneration()
  assert.equal(second.lifecycle_generation, 1)
  assert.ok(state.grants.every(g => g.status === 'expired'))
})
