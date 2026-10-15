import assert from 'node:assert/strict'
import {test, type TestContext} from 'node:test'
import {mkdtemp, rm, rename, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DeviceLedger, emptyDeviceState} from '../src/device/ledger.js'
import {DeviceGateway} from '../src/device/gateway.js'
import type {Bindings} from '../src/device/authority.js'

const bindings: Bindings = {
  task_id: 'task', owner: 'device', todo_version: 1, goal_revision: 1, control_revision: 1,
  lifecycle_generation: 0, capability_revision: 1, conversation_generation: 1,
  data_version: 1, observation_version: 1, permission_scope: ['sandbox.fs.write'],
  effect_class: 'write', proposal_digest: 'proposal', executable_digest: 'executable', expires_at: 100,
}
const request = {grant_ref: 'grant', operation_id: 'operation', kind: 'sandbox.fs.write', bindings}
async function fixture(t: TestContext, limit?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'device-gateway-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const path = join(dir, 'ledger.json')
  const state = emptyDeviceState()
  state.authority.tasks.push({bindings, permissions: bindings.permission_scope, stopped: false})
  const ledger = new DeviceLedger(path, {initialState: state, ...(limit === undefined ? {} : {limit})})
  const gateway = new DeviceGateway(ledger, {now: () => 1})
  return {path, ledger, gateway}
}
test('grant writes survive restart and snapshots cannot mutate authority', async t => {
  const {path, ledger, gateway} = await fixture(t)
  await gateway.createGrant('grant', bindings)
  await gateway.approveGrant('grant')
  const state = await ledger.snapshot()
  state.authority.grants[0]!.status = 'revoked'
  const restarted = new DeviceLedger(path)
  assert.equal((await restarted.snapshot()).authority.grants[0]!.status, 'approved')
  assert.equal((await ledger.snapshot()).authority.grants[0]!.status, 'approved')
})
test('durable dispatch intent becomes unknown-effect on restart and replay never reauthorizes', async t => {
  const {path, ledger, gateway} = await fixture(t)
  await gateway.createGrant('grant', bindings)
  await gateway.approveGrant('grant')
  assert.equal((await gateway.authorizeDispatch(request)).replayed, false)
  assert.equal((await gateway.authorizeDispatch(request)).replayed, true)
  assert.equal((await ledger.snapshot()).authority.receipts.length, 1)
  const restarted = new DeviceLedger(path)
  const next = new DeviceGateway(restarted, {now: () => 1})
  assert.equal((await restarted.snapshot()).attempts[0]!.state.attempt.status, 'unknown-effect')
  assert.equal((await next.authorizeDispatch(request)).replayed, true)
  assert.equal((await restarted.snapshot()).attempts[0]!.state.attempt.status, 'unknown-effect')
  await assert.rejects(next.authorizeDispatch({...request, kind: 'different'}), /request_conflict/)
})
test('stop is idempotent, persists, and classifies replies as late', async t => {
  const {path, gateway} = await fixture(t)
  await gateway.createGrant('grant', bindings)
  await gateway.revokeForStop('task')
  await gateway.revokeForStop('task')
  const ledger = new DeviceLedger(path)
  const next = new DeviceGateway(ledger)
  assert.equal((await ledger.snapshot()).authority.tasks[0]!.bindings.control_revision, 2)
  assert.equal((await ledger.snapshot()).authority.grants[0]!.status, 'revoked')
  assert.deepEqual(await next.classifyReply(bindings), {late: true})
  await assert.rejects(next.approveGrant('grant'), /approval_revoked/)
  await next.revokeForStop('unregistered')
})
test('failed persistence does not publish memory mutations and queue recovers', async t => {
  const {path, ledger, gateway} = await fixture(t)
  await gateway.createGrant('grant', bindings)
  await rename(path, path + '.saved')
  await mkdir(path)
  await assert.rejects(gateway.approveGrant('grant'))
  assert.equal((await ledger.snapshot()).authority.grants[0]!.status, 'pending')
  await rm(path, {recursive: true})
  await rename(path + '.saved', path)
  await gateway.approveGrant('grant')
  assert.equal((await ledger.snapshot()).authority.grants[0]!.status, 'approved')
})
test('capacity is rejected without consuming authority', async t => {
  const {ledger, gateway} = await fixture(t, 1600)
  await gateway.createGrant('grant', bindings)
  await gateway.approveGrant('grant')
  await assert.rejects(gateway.authorizeDispatch(request), /store_capacity/)
  assert.equal((await ledger.snapshot()).authority.grants[0]!.status, 'approved')
  assert.equal((await ledger.snapshot()).attempts.length, 0)
})
