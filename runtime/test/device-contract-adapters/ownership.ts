import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {canonicalPayload, encodeIdentity, expireLease, processInput, recordReceipt, requireOwner, OwnershipError} from '../../src/device/ownership.js'
import {id, type ContractAdapter} from '../device-contract-fixture.js'

const identitySchema = z.object({principal: id, device_id: id, request_id: id}).strict()
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const run: ContractAdapter = c => {
  const g = c.given
  let owner = {task_id: g.task.id, owner: g.task.owner, lease_expired: false}
  let session = {...g.session}
  const digest = (payload: unknown) => 'sha256:' + createHash('sha256').update(canonicalPayload(payload), 'utf8').digest('hex')
  // The fixture's symbolic original digest denotes given.input, not an actual SHA-256 value.
  let receipts = {...g.dedup, receipts: g.dedup.receipts.map(r => ({...r,
    payload_digest: r.payload_digest === 'sha256:original' ? digest(g.input) : r.payload_digest}))}
  const actual: Record<string, unknown> = {task_phase: g.task.phase, attempt_status: g.attempt.status,
    approval_status: g.approval.status, effects: g.effects}
  for (const step of c.when) {
    const p = step.params
    try {
      switch (step.op) {
        case 'expire_owner_lease': owner = expireLease(owner); break
        case 'takeover': requireOwner(owner, id.parse(p.device_id)); break
        case 'process_input': session = processInput(session, id.parse(p.device_id), integer.parse(p.generation), integer.parse(p.context_version)); break
        case 'delegate_new':
          receipts = recordReceipt(receipts, {...g.identity, request_id: id.parse(p.request_id)}, digest(g.input), {id: 'new-receipt', status: 'accepted'}).state
          break
        case 'replay_via_device': {
          id.parse(p.transport_device)
          const identity = identitySchema.parse(p.identity)
          assert.equal(encodeIdentity(g.identity), g.request_key)
          receipts = recordReceipt(receipts, identity, digest({...g.input, goal: id.parse(p.goal)}), {id: 'replayed-receipt', status: 'accepted'}).state
          break
        }
        default: assert.fail('unsupported operation ' + step.op)
      }
    } catch (error) {
      if (!(error instanceof OwnershipError)) throw error
      actual.error = error.code
    }
  }
  actual.owner = owner.owner
  actual.retained_receipts = receipts.receipts.map(r => r.id)
  for (const [key, expected] of Object.entries(c.then)) assert.deepEqual(actual[key], expected, key)
  return Promise.resolve()
}
export const adapters: Record<string, ContractAdapter> = {
  'owner-lease-expiry': run, 'session-owner-rule': run, 'dedup-capacity': run, 'cross-device-payload-conflict': run,
}
