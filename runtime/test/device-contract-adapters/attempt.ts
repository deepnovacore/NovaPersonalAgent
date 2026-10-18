import assert from 'node:assert/strict'
import {z} from 'zod'
import {advanceAttempt, AttemptError, type AttemptState, type VerificationGrant} from '../../src/device/attempt.js'
import {id, type ContractAdapter} from '../device-contract-fixture.js'

const run: ContractAdapter = c => {
  const g = c.given
  let state: AttemptState = {task_phase: g.task.phase, attempt: {...g.attempt}, effects: g.effects,
    evidence: [], action_grant_ref: g.approval.grant_ref}
  let grant: VerificationGrant | undefined
  let errorCode: string | undefined
  for (const step of c.when) {
    const p = step.params
    try {
      switch (step.op) {
        case 'prove_not_dispatched':
          state = advanceAttempt(state, {op: step.op, evidence_ref: id.parse(p.evidence_ref)})
          break
        case 'authorize_verification':
          grant = {grant_ref: id.parse(p.grant_ref), scope: id.parse(p.scope), status: 'approved', attempt_id: state.attempt.id}
          break
        case 'verify_outcome':
          state = advanceAttempt(state, {op: step.op, outcome: z.enum(['completed', 'failed']).parse(p.outcome),
            evidence_ref: id.parse(p.evidence_ref), ...(grant ? {grant} : {})})
          break
        default: assert.fail('unsupported operation ' + step.op)
      }
    } catch (error) {
      if (!(error instanceof AttemptError)) throw error
      errorCode = error.code
    }
  }
  const actual: Record<string, unknown> = {task_phase: state.task_phase, attempt_status: state.attempt.status,
    approval_status: g.approval.status, effects: state.effects, error: errorCode}
  for (const [key, expected] of Object.entries(c.then)) assert.deepEqual(actual[key], expected, key)
  return Promise.resolve()
}
export const adapters: Record<string, ContractAdapter> = {
  'prepared-failed': run, 'unknown-resolved-completed': run, 'unknown-resolved-failed': run,
}
