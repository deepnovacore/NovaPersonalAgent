import assert from 'node:assert/strict'
import {test} from 'node:test'
import {encodeIdentity, decodeIdentity, expireLease, requireOwner, processInput, recordReceipt, canonicalPayload} from '../src/device/ownership.js'

test('identity is canonical JSON with opaque Unicode and delimiter-bearing IDs', () => {
  const identity = {principal: '人:a', device_id: 'b:"', request_id: 'c\\\n'}
  assert.deepEqual(decodeIdentity(encodeIdentity(identity)), identity)
  for (const key of ['a:b:c', '["a", "b","c"]', '["a","b",""]', '["a","b","c",0]'])
    assert.throws(() => decodeIdentity(key), {code: 'request_conflict'})
  assert.notEqual(encodeIdentity(identity), encodeIdentity({...identity, device_id: 'other'}))
})

test('lease expiry never grants takeover, including after serialization', () => {
  const owner = expireLease({task_id: 't', owner: 'd', lease_expired: false})
  assert.equal(owner.owner, 'd')
  assert.throws(() => requireOwner(owner, 'other'), {code: 'owner_mismatch'})
  assert.doesNotThrow(() => requireOwner(owner, 'd'))
  assert.deepEqual(JSON.parse(JSON.stringify(owner)), owner)
})

test('session admission rejects wrong owner, stale generation and concurrent captured context', () => {
  const session = {id: 's', owner: 'd', generation: 2, context_version: 3}
  assert.throws(() => processInput(session, 'other', 2, 3), {code: 'owner_mismatch'})
  assert.throws(() => processInput(session, 'd', 1, 3), {code: 'stale_fence'})
  const next = processInput(session, 'd', 2, 3)
  assert.equal(next.context_version, 4)
  assert.throws(() => processInput(next, 'd', 2, 3), {code: 'stale_fence'})
  assert.throws(() => processInput({...session, context_version: Number.MAX_SAFE_INTEGER}, 'd', 2, Number.MAX_SAFE_INTEGER), {code: 'stale_fence'})
})

test('receipts replay before capacity checks and cannot conflict or evict', () => {
  const identity = {principal: 'u', device_id: 'd', request_id: 'r'}
  const first = recordReceipt({capacity: 1, receipts: []}, identity, 'digest', {id: 'receipt', status: 'accepted'})
  const replay = recordReceipt(first.state, identity, 'digest', {id: 'ignored', status: 'changed'})
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.receipt, first.receipt)
  assert.throws(() => recordReceipt(first.state, identity, 'other', {id: 'x', status: 'accepted'}), {code: 'request_conflict'})
  assert.throws(() => recordReceipt(first.state, {...identity, request_id: 'new'}, 'digest', {id: 'x', status: 'accepted'}), {code: 'dedup_capacity'})
  assert.equal(first.state.receipts.length, 1)
  assert.equal(canonicalPayload({b: [1, 2], a: 1}), canonicalPayload({a: 1, b: [1, 2]}))
  assert.notEqual(canonicalPayload([1, 2]), canonicalPayload([2, 1]))
  assert.throws(() => canonicalPayload({bad: undefined}), {code: 'request_conflict'})
})

test('canonical payload rejects cycles, sparse arrays and non-JSON or non-int53 values', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const value of [cycle, new Array<unknown>(2), undefined, () => 1, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, 0.5, {nested: undefined}, Symbol('value'), 1n]) {
    assert.throws(() => canonicalPayload(value), {code: 'request_conflict'})
  }
  const shared = {value: 1}
  assert.equal(canonicalPayload([shared, shared]), '[{"value":1},{"value":1}]')
})
