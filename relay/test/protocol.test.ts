import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeEnvelope, validateEnvelope, type RelayEnvelope} from '../src/protocol.js';

const principal = {space: 'space', device: 'host', epoch: 1};
const envelope: RelayEnvelope = {v: 1, space: 'space', id: 'message', from: 'host', to: 'phone',
  chan: 'mailbox', epoch: 1, expiresAt: null, body: 'Y2lwaGVydGV4dA==', sig: 'c2lnbmF0dXJl'};

test('envelope bounds and sender identity are enforced before delivery', () => {
  assert.ok(validateEnvelope(envelope, principal, 4096) > 0);
  for (const patch of [{space: 'other'}, {from: 'other'}, {epoch: 2}]) {
    assert.throws(() => validateEnvelope({...envelope, ...patch}, principal, 4096), /sender_mismatch/);
  }
  assert.throws(() => validateEnvelope(envelope, principal, 10), /message_too_large|invalid_encoding/);
  for (const body of ['', 'plaintext', 'YQ', 'YQ==\n']) {
    assert.throws(() => validateEnvelope({...envelope, body}, principal, 4096), /invalid_encoding/);
  }
  for (const expiresAt of [-1, NaN, Infinity, 0.1]) {
    assert.throws(() => validateEnvelope({...envelope, expiresAt}, principal, 4096), /invalid_deadline/);
  }
  assert.throws(() => validateEnvelope({...envelope, chan: 'stream'}, principal, 4096), /deadline_required/);
});

test('serialized envelope has only opaque delivery fields and stable ordering', () => {
  const unexpected = {...envelope, kind: 'business-secret', goal: 'private'};
  assert.equal(encodeEnvelope(unexpected), encodeEnvelope(envelope));
  assert.ok(!encodeEnvelope(unexpected).includes('business-secret'));
  assert.deepEqual(JSON.parse(encodeEnvelope(envelope)), envelope);
});
