import assert from 'node:assert/strict'
import {test} from 'node:test'
import {advanceAttempt, type AttemptState, type VerificationGrant} from '../src/device/attempt.js'

const state = (): AttemptState => ({task_phase: 'running', attempt: {id: 'a', status: 'prepared', dispatch_started: false}, effects: 0, evidence: [], action_grant_ref: 'write'})
const grant = (): VerificationGrant => ({grant_ref: 'read', status: 'approved', scope: 'sandbox.fs.read', attempt_id: 'a'})

test('prepared failure requires proof and never treats a started dispatch as no effect', () => {
  assert.throws(() => advanceAttempt(state(), {op: 'prove_not_dispatched', evidence_ref: ''}), {code: 'stale_fence'})
  const failed = advanceAttempt(state(), {op: 'prove_not_dispatched', evidence_ref: 'journal'})
  assert.equal(failed.task_phase, 'failed')
  assert.equal(failed.attempt.status, 'failed')
  assert.deepEqual(failed.evidence, ['journal'])
  assert.throws(() => advanceAttempt({...state(), attempt: {...state().attempt, dispatch_started: true}}, {op: 'prove_not_dispatched', evidence_ref: 'journal'}), {code: 'unknown_effect'})
})

test('dispatch recovery is uncertain, serializable and cannot retry', () => {
  const dispatched = advanceAttempt(state(), {op: 'mark_dispatch_started'})
  assert.equal(dispatched.attempt.dispatch_started, true)
  const recovered = advanceAttempt(dispatched, {op: 'restart'})
  assert.equal(recovered.attempt.status, 'unknown-effect')
  assert.equal(recovered.task_phase, 'waiting')
  assert.throws(() => advanceAttempt(recovered, {op: 'mark_dispatch_started'}), {code: 'unknown_effect'})
  assert.deepEqual(JSON.parse(JSON.stringify(recovered)), recovered)
  assert.equal(advanceAttempt(state(), {op: 'restart'}).attempt.status, 'prepared')
})

test('reconciliation needs a separate approved read and preserves effects and cancellation', () => {
  const unknown: AttemptState = {...state(), effects: 1, attempt: {id: 'a', status: 'unknown-effect', dispatch_started: true}}
  const event = {op: 'verify_outcome', outcome: 'failed', evidence_ref: 'proof'} as const
  assert.throws(() => advanceAttempt(unknown, event), {code: 'approval_required'})
  for (const invalid of [{...grant(), grant_ref: 'write'}, {...grant(), scope: 'sandbox.command'}, {...grant(), attempt_id: 'other'}, {...grant(), status: 'revoked' as const}])
    assert.throws(() => advanceAttempt(unknown, {...event, grant: invalid}), {code: 'approval_required'})
  for (const outcome of ['completed', 'failed'] as const) {
    const resolved = advanceAttempt(unknown, {...event, outcome, grant: grant()})
    assert.equal(resolved.task_phase, outcome)
    assert.equal(resolved.attempt.status, outcome === 'completed' ? 'accepted' : 'failed')
    assert.equal(resolved.effects, 1)
    assert.deepEqual(resolved.evidence, ['proof'])
    assert.deepEqual(resolved.consumed_verification_grants, ['read'])
    assert.equal(advanceAttempt({...unknown, task_phase: 'cancelled'}, {...event, outcome, grant: grant()}).task_phase, 'cancelled')
    assert.throws(() => advanceAttempt(resolved, {...event, grant: grant()}), {code: 'stale_fence'})
  }
})

test('unknown runtime events fail closed with a contract error', () => {
  // Simulate an unrecognized event received across a language-neutral boundary.
  assert.throws(() => advanceAttempt(state(), {op: 'future_event'} as never), {code: 'stale_fence'})
})
