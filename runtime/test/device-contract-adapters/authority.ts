import assert from 'node:assert/strict'
import {Authority, AuthorityError, type AuthorityState} from '../../src/device/authority.js'
import {id, type ContractAdapter, type ContractCase} from '../device-contract-fixture.js'

function run(c: ContractCase): Promise<void> {
  const g = c.given
  const state: AuthorityState = {
    lifecycle_generation: g.fence.lifecycle_generation,
    tasks: [{bindings: structuredClone(g.approval.bindings), permissions: [...g.permissions], stopped: false}],
    grants: [{...structuredClone(g.approval), consumed: g.approval.status === 'consumed'}],
    receipts: [],
  }
  const authority = new Authority(state, {now: () => 0})
  const current = state.tasks[0]!
  let phase = g.task.phase
  let attempt = g.attempt.status
  let effects = g.effects
  const extra: Record<string, unknown> = {}
  for (const step of c.when) {
    const p = step.params
    switch (step.op) {
      case 'approve': authority.approveGrant(g.approval.grant_ref); break
      case 'change_binding': {
        const field = id.parse(p.field)
        assert.ok(Object.hasOwn(current.bindings, field))
        Object.assign(current.bindings, {[field]: p.value})
        break
      }
      case 'revoke_permission':
        current.permissions = current.permissions.filter(scope => scope !== id.parse(p.scope))
        break
      case 'dispatch':
        try {
          const result = authority.authorizeDispatch({
            grant_ref: g.approval.grant_ref, operation_id: id.parse(p.operation_id),
            kind: p.kind === undefined ? g.approval.bindings.permission_scope[0]! : id.parse(p.kind),
            bindings: {...structuredClone(g.approval.bindings),
              executable_digest: p.executable_digest === undefined
                ? g.approval.bindings.executable_digest : id.parse(p.executable_digest)},
          })
          if (!result.replayed) {
            // Deterministic external host accepts only newly authorized durable intent.
            effects++
            phase = 'running'
            attempt = 'accepted'
          }
        } catch (error) {
          if (!(error instanceof AuthorityError)) throw error
          extra.error = error.code
        }
        break
      case 'stop_task':
        authority.revokeForStop(g.task.id)
        assert.equal(current.bindings.control_revision, g.fence.control_revision + 1)
        phase = 'cancelled'
        break
      case 'observe_stop_ack':
        assert.ok(current.stopped)
        assert.ok(state.grants.every(grant => grant.status === 'revoked'))
        extra.stop_ack_grant_status = state.grants[0]!.status
        break
      case 'background':
        assert.equal(authority.bumpLifecycleGeneration(), p.lifecycle_generation)
        break
      case 'foreground': break
      case 'deliver_old_reply': {
        assert.equal(typeof p.lifecycle_generation, 'number')
        const {late} = authority.classifyReply({...g.fence, task_id: g.task.id,
          lifecycle_generation: p.lifecycle_generation as number})
        extra.late = late
        if (late && g.attempt.dispatch_started) {
          attempt = 'unknown-effect'
          if (phase !== 'cancelled') phase = 'waiting'
        }
        break
      }
      default: assert.fail('unsupported authority operation: ' + step.op)
    }
  }
  const actual: Record<string, unknown> = {task_phase: phase, attempt_status: attempt,
    approval_status: state.grants[0]!.status, effects, ...extra}
  for (const [key, expected] of Object.entries(c.then)) assert.deepEqual(actual[key], expected, key)
  return Promise.resolve()
}

export const adapters: Record<string, ContractAdapter> = Object.fromEntries([
  'approval-version-expiry', 'approval-single-consumption', 'stop-revokes-before-ack',
  'permission-recheck', 'capability-revision-recheck', 'exec-requires-approval', 'ios-background-reply',
].map(caseId => [caseId, run]))
