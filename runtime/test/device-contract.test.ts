import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {z} from 'zod'
import {TaskService, taskInputSchema} from '../src/personal-agent/tasks.js'
import {TaskLoop} from '../src/personal-agent/task-loop.js'

const fixture = z.object({
  contract_version: z.literal(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    semantics: z.array(z.enum(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])).min(1),
    given: z.object({request_id: z.string().min(1), input: taskInputSchema}),
    when: z.array(z.string().min(1)).min(1),
    then: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    coverage: z.object({adapter: z.string(), scope: z.string().min(1), reason: z.string().min(1).optional()}),
  })).min(1),
}).parse(JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/device-contract/v1/cases.json', import.meta.url), 'utf8',
)))

const sequences: Record<string, string[]> = {
  'stop-late-reply': ['begin_model_evaluation', 'stop_task', 'deliver_late_correction'],
  'intent-crash': ['persist_intent', 'mark_dispatch_started', 'restart_without_receipt', 'retry_dispatch'],
  'ack-lost': ['write_once_without_ack', 'restart', 'retry_same_request'],
  'same-input-delegation': ['delegate', 'replay_same_request', 'restart', 'replay_same_request', 'reuse_key_with_changed_payload'],
  'stale-goal-fence': ['delegate', 'revise_goal', 'write_with_old_fence'],
}

test('device contract fixture covers every mandatory semantic and known scenario', () => {
  assert.equal(new Set(fixture.cases.map(c => c.id)).size, fixture.cases.length)
  assert.deepEqual([...new Set(fixture.cases.flatMap(c => c.semantics))].sort(),
    ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
  for (const id of ['stop-late-reply', 'approval-version-expiry', 'intent-crash',
    'ack-lost', 'todo-conflict-cas', 'completed-projection-eviction',
    'permanent-delete-reconnect', 'same-input-delegation', 'ios-background-reply', 'owner-lease-expiry'])
    assert.ok(fixture.cases.some(c => c.id === id), id)
  for (const c of fixture.cases) {
    if (c.coverage.adapter === 'pending') assert.ok(c.coverage.reason, c.id)
    else {
      assert.equal(c.coverage.adapter, c.id)
      assert.deepEqual(c.when, sequences[c.id], 'unimplemented event sequence: ' + c.id)
    }
  }
})

for (const c of fixture.cases) {
  if (c.coverage.adapter === 'pending') {
    test(c.id, {todo: c.coverage.reason})
    continue
  }
  test(c.id + ' [' + c.coverage.scope + ']', {timeout: 10000}, async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'device-contract-'))
    const path = join(dir, 'tasks.json')
    let tasks = new TaskService(path)
    const restart = async () => {
      await tasks.close()
      tasks = new TaskService(path)
      await tasks.open()
    }
    try {
      await tasks.open()
      const task = await tasks.delegate(c.given.request_id, c.given.input)
      const fence = {task_id: task.id, control_revision: 0, goal_revision: 0}
      const actor = {kind: 'nova'} as const
      let effects = 0
      switch (c.coverage.adapter) {
        case 'same-input-delegation': {
          const repeated = await tasks.delegate(c.given.request_id, c.given.input)
          await restart()
          const restored = await tasks.delegate(c.given.request_id, c.given.input)
          assert.equal(repeated.id === task.id && restored.id === task.id, c.then.same_task_id)
          assert.equal(tasks.list().length, c.then.task_count)
          await assert.rejects(tasks.delegate(c.given.request_id, {...c.given.input, goal: 'Changed'}),
            {message: c.then.conflict_error})
          assert.equal(restored.conversation_id, c.given.input.conversation_id)
          assert.equal(restored.origin_ref, c.given.input.origin_ref)
          break
        }
        case 'intent-crash': {
          const effect = await tasks.reserveInitial(fence)
          await tasks.markEffectDispatching(effect)
          await restart()
          assert.equal(tasks.pendingEffect(task.id)?.status, c.then.effect_status)
          await assert.rejects(tasks.reserveInitial(fence).then(() => {effects++}),
            {message: c.then.retry_error})
          assert.equal(effects, c.then.new_effects)
          break
        }
        case 'ack-lost': {
          await tasks.bindWork(fence, 'work-1', 'session-1')
          const send = () => {effects++; return Promise.resolve('unknown' as const)}
          const deliver = () => tasks.input('input-write-1', fence, actor, 'session-1', 'Write once', send)
          assert.equal(await deliver(), c.then.effect_status)
          await restart()
          assert.equal(await deliver(), c.then.effect_status)
          assert.equal(effects, c.then.total_effects)
          break
        }
        case 'stale-goal-fence': {
          await tasks.reviseGoal('revise-1', fence, actor, 'New goal', [])
          await assert.rejects(tasks.bindWork(fence, 'stale-work').then(() => {effects++}),
            {message: c.then.error})
          assert.equal(effects, c.then.new_effects)
          break
        }
        case 'stop-late-reply': {
          await tasks.recordDelivery(fence, 'reply-1', 'Needs correction')
          let release!: () => void
          let started!: () => void
          const gate = new Promise<void>(resolve => {release = resolve})
          const ready = new Promise<void>(resolve => {started = resolve})
          const loop = new TaskLoop(tasks, {
            evaluate: async () => {
              started()
              await gate
              return {kind: 'correct', instruction: 'Write late', evidence_refs: ['task-delivery:reply-1']}
            },
            execute: () => {effects++; return Promise.resolve()},
            syncTodo: () => Promise.resolve('synced'),
          })
          const running = loop.wake(task.id)
          try {
            await ready
            await tasks.cancel('stop-1', fence, actor)
          } finally {
            release()
            await running
            await loop.close()
          }
          assert.equal(tasks.get(task.id).phase, c.then.phase)
          assert.equal(effects, c.then.new_effects)
          break
        }
        default: assert.fail('missing adapter: ' + c.coverage.adapter)
      }
    } finally {
      await tasks.close()
      await rm(dir, {recursive: true, force: true})
    }
  })
}
