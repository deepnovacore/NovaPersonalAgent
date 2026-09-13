import assert from 'node:assert/strict'
import {test} from 'node:test'
import {VirtualClock} from '../src/core/clock.js'
import {PendingDecision} from '../src/core/pending-decision.js'

test('decision deadlines preserve replacement, held decisions and reentrant FIFO promotion', async () => {
  const clock = new VirtualClock()
  const decisions = new PendingDecision<string, object>(clock)
  const first = {}, second = {}, third = {}
  const expired: object[] = []
  decisions.offer('approval', first, 10, (_kind, payload) => expired.push(payload))
  assert.equal(decisions.offer('approval', second, 10, (_kind, payload) => {
    expired.push(payload)
    decisions.offer('approval', third, 30, (_nextKind, next) => expired.push(next))
  }), first)
  assert.equal(decisions.consume(first), false)
  assert.equal(decisions.hold(second), true)
  clock.advanceTo(20)
  await Promise.resolve()
  assert.deepEqual(expired, [])
  assert.equal(decisions.release(second, 20), true)
  assert.deepEqual(expired, [])
  clock.advanceTo(20)
  await Promise.resolve()
  assert.deepEqual(expired, [second])
  assert.equal(decisions.hold(third), true)
  assert.equal(decisions.consume(third), true)
  assert.equal(decisions.consume(third), false)
  assert.equal(clock.waiterCount(), 0)
})

test('an early wake keeps waiting until the same clock reaches the exact deadline', async () => {
  let now = 0, sleeps = 0, expired = 0
  const decisions = new PendingDecision<string, object>({
    now: () => now,
    sleep: () => { now = ++sleeps === 1 ? 9 : 10; return Promise.resolve() },
  })
  decisions.offer('project', {}, 10, () => { expired += 1 })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(sleeps, 2)
  assert.equal(expired, 1)
})
