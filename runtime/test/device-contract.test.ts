import assert from 'node:assert/strict'
import {existsSync, readdirSync} from 'node:fs'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {z} from 'zod'
import {TaskService} from '../src/personal-agent/tasks.js'
import {TaskLoop} from '../src/personal-agent/task-loop.js'
import {fixture, id, type ContractAdapter} from './device-contract-fixture.js'

// Device-side adapters live in test/device-contract-adapters/*.ts; each exports
// `adapters: Record<caseId, ContractAdapter>` and is picked up here without edits.
const adapterDir = new URL('./device-contract-adapters/', import.meta.url)
const adapters = new Map<string, ContractAdapter>()
if (existsSync(adapterDir)) {
  for (const file of readdirSync(adapterDir).filter(f => f.endsWith('.js')).sort()) {
    const mod = await import(new URL(file, adapterDir).href) as {adapters?: Record<string, ContractAdapter>}
    for (const [caseId, adapter] of Object.entries(mod.adapters ?? {})) {
      assert.ok(!adapters.has(caseId), 'duplicate adapter for ' + caseId)
      adapters.set(caseId, adapter)
    }
  }
}

test('device contract fixture is independent, structured and covers every mandatory semantic', () => {
  assert.equal(new Set(fixture.cases.map(c => c.id)).size, fixture.cases.length)
  assert.deepEqual([...new Set(fixture.cases.flatMap(c => c.semantics))].sort(),
    ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
  for (const required of ['stop-late-reply', 'approval-version-expiry', 'intent-crash', 'ack-lost',
    'same-input-delegation', 'stale-goal-fence', 'todo-conflict-cas', 'todo-cas-success',
    'completed-projection-eviction', 'permanent-delete-reconnect', 'tombstone-equal-version',
    'ios-background-reply', 'owner-lease-expiry', 'session-owner-rule', 'stop-revokes-before-ack',
    'dedup-capacity', 'approval-single-consumption', 'permission-recheck', 'cross-device-payload-conflict',
    'prepared-failed', 'unknown-resolved-completed', 'unknown-resolved-failed',
    'capability-revision-recheck', 'exec-requires-approval'])
    assert.ok(fixture.cases.some(c => c.id === required), required)
  for (const c of fixture.cases) {
    const g = c.given
    assert.equal(g.request_key, JSON.stringify([g.identity.principal, g.identity.device_id, g.identity.request_id]))
    assert.equal(g.fence.todo_version, g.todo.version)
    assert.equal(g.fence.goal_revision, g.goal.revision)
    assert.equal(g.approval.bindings.task_id, g.task.id)
    assert.equal(g.approval.bindings.owner, g.task.owner)
    assert.equal(g.approval.bindings.conversation_generation, g.session.generation)
    for (const step of c.when) {
      assert.ok(Object.hasOwn(fixture.operations, step.op), step.op)
      for (const key of Object.keys(step.params)) assert.ok(fixture.operations[step.op]!.includes(key), key)
    }
    if (c.coverage.adapter === 'pending') assert.ok(c.coverage.reason, c.id)
  }
})

for (const c of fixture.cases) {
  const device = adapters.get(c.id)
  if (device) {
    test(c.id + ' [device]', {timeout: 10000}, () => device(c))
    continue
  }
  if (c.coverage.adapter === 'pending') {
    test(c.id, {todo: c.coverage.reason})
    continue
  }
  test(c.id + ' [' + c.coverage.scope + ']', {timeout: 10000}, async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'device-contract-'))
    const path = join(dir, 'tasks.json')
    let tasks = new TaskService(path)
    let loop: TaskLoop | undefined
    let running: Promise<void> | undefined
    let release: (() => void) | undefined
    try {
      await tasks.open()
      // Only the existing local journal slice is adapted; device authority stays pending.
      assert.equal(c.given.task.phase, 'queued')
      assert.equal(c.given.attempt.status, 'none')
      const task = await tasks.delegate(c.given.request_key, c.given.input)
      const fence = {task_id: task.id, control_revision: c.given.fence.control_revision,
        goal_revision: c.given.fence.goal_revision}
      const actor = {kind: 'nova'} as const
      let effects = c.given.effects
      let effectId = ''
      let receipt: ReturnType<TaskService['inputReceipts']>[number] | undefined
      let deliveries = 0
      let sameTask = true
      const requestKey = (requestId: string) => JSON.stringify([
        c.given.identity.principal, c.given.identity.device_id, requestId,
      ])
      for (const step of c.when) {
        const p = step.params
        const str = (key: string) => id.parse(p[key])
        switch (step.op) {
          case 'restart':
            await tasks.close()
            tasks = new TaskService(path)
            await tasks.open()
            break
          case 'recover_uncertain':
            assert.ok(tasks.pendingEffect(task.id)?.status === 'unknown'
              || tasks.inputReceipts(task.id).some(receipt => receipt.status === 'unknown'))
            await tasks.recoveryWait(task.id, str('reason'))
            break
          case 'replay_delegation': {
            const repeated = await tasks.delegate(c.given.request_key, c.given.input)
            sameTask = repeated.id === task.id && sameTask
            break
          }
          case 'conflicting_delegation':
            await assert.rejects(tasks.delegate(c.given.request_key, {...c.given.input, goal: str('goal')}),
              {message: str('error')})
            break
          case 'persist_intent': effectId = await tasks.reserveInitial(fence); break
          case 'mark_dispatch_started': await tasks.markEffectDispatching(effectId); break
          case 'retry_dispatch':
            await assert.rejects(tasks.reserveInitial(fence).then(() => {effects++}), {message: str('error')})
            break
          case 'bind_work': {
            const bind = () => tasks.bindWork(fence, str('work_id'), p.session_id === undefined ? undefined : str('session_id'))
            if (p.error) await assert.rejects(bind().then(() => {effects++}), {message: str('error')})
            else await bind()
            break
          }
          case 'deliver_input': {
            const result = z.enum(['accepted', 'failed', 'unknown']).parse(p.result)
            assert.equal(await tasks.input(requestKey(str('request_id')), fence, actor, str('session_id'), str('text'),
              () => {effects++; return Promise.resolve(result)}), result)
            const current = tasks.inputReceipts(task.id)[0]!
            assert.ok(current)
            if (receipt) assert.deepEqual(current, receipt, 'replay must return original durable receipt content')
            else receipt = structuredClone(current)
            deliveries++
            break
          }
          case 'revise_goal': await tasks.reviseGoal(requestKey(str('request_id')), fence, actor, str('goal'), []); break
          case 'begin_model_evaluation': {
            await tasks.recordDelivery(fence, str('delivery_id'), str('text'))
            let started!: () => void
            const gate = new Promise<void>(resolve => {release = resolve})
            const ready = new Promise<void>(resolve => {started = resolve})
            loop = new TaskLoop(tasks, {
              evaluate: async () => {
                started()
                await gate
                return {kind: 'correct', instruction: str('instruction'), evidence_refs: ['task-delivery:' + str('delivery_id')]}
              },
              execute: () => {effects++; return Promise.resolve()},
              syncTodo: () => Promise.resolve('synced'),
            })
            running = loop.wake(task.id)
            await ready
            break
          }
          case 'stop_task': await tasks.cancel(requestKey(str('request_id')), fence, actor); break
          case 'deliver_late_correction': release!(); await running; break
          default: assert.fail('missing local operation: ' + step.op)
        }
      }
      assert.equal(tasks.get(task.id).phase, c.then.task_phase)
      assert.equal(effects, c.then.effects)
      const status = tasks.pendingEffect(task.id)?.status ?? receipt?.status ?? 'none'
      assert.equal(status === 'unknown' ? 'unknown-effect' : status, c.then.attempt_status)
      if (c.then.same_task_id !== undefined) assert.equal(sameTask, c.then.same_task_id)
      if (c.then.task_count !== undefined) assert.equal(tasks.list().length, c.then.task_count)
      if (c.then.receipt_replayed) {
        assert.equal(deliveries, 2)
        const expected = z.object({request_id: id, status: id, session_id: id, text: id}).parse(c.then.receipt)
        assert.equal(receipt!.request_id, requestKey(expected.request_id))
        assert.equal(receipt!.status === 'unknown' ? 'unknown-effect' : receipt!.status, expected.status)
        assert.equal(receipt!.session_id, expected.session_id)
        assert.equal(receipt!.text, expected.text)
        assert.deepEqual(receipt!.fence, fence)
        assert.deepEqual(receipt!.actor, actor)
        assert.equal(receipt!.task_id, task.id)
      }
      assert.equal(tasks.get(task.id).conversation_id, c.given.input.conversation_id)
      assert.equal(tasks.get(task.id).origin_ref, c.given.input.origin_ref)
    } finally {
      release?.()
      await running
      await loop?.close()
      await tasks.close()
      await rm(dir, {recursive: true, force: true})
    }
  })
}
