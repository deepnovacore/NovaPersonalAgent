import test from 'node:test';
import assert from 'node:assert/strict';
import {MailboxStore} from '../src/mailbox.js';
import {LiveRelay} from '../src/live.js';
import type {RelayAuthority, RelayEnvelope, RelayPrincipal} from '../src/protocol.js';

test('lost preview does not lose a durable final; retry and independent clients retain cursors', () => {
  const host: RelayPrincipal = {space: 'space', device: 'host', epoch: 1};
  const phone = {...host, device: 'phone'};
  const tablet = {...host, device: 'tablet'};
  // Test-only authority stands in for the NOT YET IMPLEMENTED pairing/signature adapter.
  const authority: RelayAuthority = {
    assertActive(p) { assert.equal(p.space, 'space'); assert.equal(p.epoch, 1); },
    assertCanSend(p, e) { assert.equal(e.from, p.device); assert.equal(e.space, p.space); },
  };
  const mailbox = new MailboxStore(':memory:', authority);
  const live = new LiveRelay(authority, {clock: () => 100});
  const preview: RelayEnvelope = {v: 1, space: 'space', from: 'host', to: 'phone', epoch: 1,
    chan: 'stream', expiresAt: 200, id: 'preview', body: 'Y2lwaGVydGV4dA==', sig: 'c2ln'};
  const observed: RelayEnvelope[] = [];
  try {
    const connection = live.connect(phone, {send: async e => { observed.push(e); }, close() {}});
    live.send(host, preview);
    assert.equal(observed.length, 1);
    connection.close();
    assert.throws(() => live.send(host, {...preview, id: 'preview2'}), /offline/);
    const final: RelayEnvelope = {...preview, id: 'final-phone', chan: 'mailbox', expiresAt: null};
    const first = mailbox.send(host, final);
    assert.deepEqual(mailbox.send(host, final), {seq: first.seq, duplicate: true});
    mailbox.send(host, {...final, id: 'final-tablet', to: 'tablet'});
    live.connect(phone, {send: async e => { observed.push(e); }, close() {}});
    // No preview replay; a reconnected app reads the final through durable delivery.
    assert.equal(observed.length, 1);
    const page = mailbox.read(phone);
    assert.deepEqual(page.messages.map(m => m.envelope.id), ['final-phone']);
    mailbox.acknowledge(phone, page.nextCursor);
    assert.equal(mailbox.read(phone).messages.length, 0);
    assert.equal(mailbox.read(tablet).messages.length, 1);
  } finally { mailbox.close(); }
});
