import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRelay, type LiveReceiver} from '../src/live.js';
import {RelayError, type RelayAuthority, type RelayEnvelope, type RelayPrincipal} from '../src/protocol.js';

const principal = (space = 's', device = 'client', epoch = 1): RelayPrincipal => ({space, device, epoch});
const envelope = (overrides: Partial<RelayEnvelope> = {}): RelayEnvelope => ({v: 1, space: 's', id: 'm', from: 'client', to: 'host', epoch: 1, chan: 'stream', expiresAt: 1100, body: 'YQ==', sig: 'Yg==', ...overrides});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let now = 1000;
  const epochs = new Map<string, number>();
  const authority: RelayAuthority = {
    assertActive(p) { if ((epochs.get(`${p.space}:${p.device}`) ?? 1) !== p.epoch) throw new RelayError('revoked'); },
    assertCanSend(p, e) { this.assertActive(p); if (e.sig !== 'Yg==') throw new RelayError('bad_signature'); },
  };
  const relay = new LiveRelay(authority, {clock: () => now, heartbeatMs: 100, maxStreamTtlMs: 200, ...options});
  return {relay, epochs, time: (n: number) => { now = n; }};
}
function receiver() {
  const received: RelayEnvelope[] = [], closed: string[] = [];
  const sink: LiveReceiver = {send: async e => { received.push(e); }, close: reason => { closed.push(reason); }};
  return {sink, received, closed};
}

test('one current generation; stale close and heartbeat cannot affect replacement', () => {
  const {relay} = fixture(); const old = receiver(), next = receiver();
  const first = relay.connect(principal('s', 'host'), old.sink);
  const second = relay.connect(principal('s', 'host'), next.sink);
  assert.deepEqual(old.closed, ['replaced']);
  first.close(); assert.throws(() => first.heartbeat(), /stale_connection/);
  second.heartbeat(); assert.equal(relay.presence(principal(), 'host'), true);
  second.close(); assert.equal(relay.presence(principal(), 'host'), false);
});

test('space isolation and offline streams fail immediately without replay', async () => {
  const {relay} = fixture(); const a = receiver(), b = receiver();
  relay.connect(principal('s', 'host'), a.sink); relay.connect(principal('other', 'host'), b.sink);
  relay.send(principal(), envelope()); await flush();
  assert.equal(a.received.length, 1); assert.equal(b.received.length, 0);
  assert.throws(() => relay.send(principal(), envelope({to: 'missing'})), /offline/);
  const late = receiver(); relay.connect(principal('s', 'missing'), late.sink); await flush();
  assert.equal(late.received.length, 0);
});

test('heartbeat expiry is inclusive and cannot be revived by heartbeat or clock rollback', () => {
  const {relay, time} = fixture(); const r = receiver(); const c = relay.connect(principal('s', 'host'), r.sink);
  time(1099); assert.equal(relay.presence(principal(), 'host'), true);
  time(1100); assert.throws(() => c.heartbeat(), /stale_connection/);
  time(1000); assert.equal(relay.presence(principal(), 'host'), false);
  assert.deepEqual(r.closed, ['heartbeat_expired']);
});

test('all device operations recheck epochs and signatures; recipient revocation removes presence', () => {
  const {relay, epochs} = fixture(); const r = receiver(); const c = relay.connect(principal('s', 'host'), r.sink);
  assert.throws(() => relay.send(principal(), envelope({sig: 'Yw=='})), /bad_signature/);
  assert.throws(() => relay.send(principal(), envelope({from: 'forged'})), /sender_mismatch/);
  epochs.set('s:client', 2);
  assert.throws(() => relay.send(principal(), envelope()), /revoked/);
  assert.throws(() => relay.presence(principal(), 'host'), /revoked/);
  assert.throws(() => relay.connect(principal(), r.sink), /revoked/);
  epochs.set('s:host', 2);
  assert.throws(() => c.heartbeat(), /revoked/);
  assert.throws(() => c.close(), /revoked/);
  assert.equal(relay.presence(principal('s', 'client', 2), 'host'), false);
});

test('slow consumers count in-flight messages and bytes; overflow closes and discards queue', async () => {
  for (const options of [{maxQueueMessages: 1}, {maxQueueBytes: Buffer.byteLength(JSON.stringify(envelope())) + 1}]) {
    const {relay} = fixture(options); const r = receiver(); let finish!: () => void;
    r.sink.send = async e => { r.received.push(e); await new Promise<void>(resolve => { finish = resolve; }); };
    relay.connect(principal('s', 'host'), r.sink);
    relay.send(principal(), envelope());
    assert.throws(() => relay.send(principal(), envelope({id: 'n'})), /backpressure/);
    assert.deepEqual(r.closed, ['backpressure']); assert.equal(relay.presence(principal(), 'host'), false);
    finish(); await flush(); assert.equal(r.received.length, 1);
  }
});

test('queued stream expires at dequeue; deadlines short and compulsory', async () => {
  const {relay, time} = fixture({heartbeatMs: 1000}); const r = receiver(); let finish!: () => void;
  r.sink.send = async e => { r.received.push(e); if (e.id === 'm') await new Promise<void>(resolve => { finish = resolve; }); };
  relay.connect(principal('s', 'host'), r.sink);
  assert.throws(() => relay.send(principal(), envelope({expiresAt: null})), /deadline_required/);
  assert.throws(() => relay.send(principal(), envelope({expiresAt: 1201})), /ttl_too_long/);
  assert.throws(() => relay.send(principal(), envelope({expiresAt: 1000})), /expired/);
  relay.send(principal(), envelope()); relay.send(principal(), envelope({id: 'queued'}));
  time(1100); finish(); await flush(); assert.deepEqual(r.received.map(e => e.id), ['m']);
});

test('queued sends reauthorize sender before delivery and reject cleanup is handled', async () => {
  const {relay, epochs} = fixture(); const r = receiver(); let fail!: (error: Error) => void;
  r.sink.send = async e => { r.received.push(e); await new Promise<void>((_, reject) => { fail = reject; }); };
  relay.connect(principal('s', 'host'), r.sink);
  relay.send(principal(), envelope()); relay.send(principal(), envelope({id: 'queued'}));
  fail(new Error('transport')); await flush();
  assert.deepEqual(r.closed, ['transport_failed']); assert.equal(r.received.length, 1);
  const next = receiver(); let finish!: () => void;
  next.sink.send = async e => { next.received.push(e); if (e.id === 'm') await new Promise<void>(resolve => { finish = resolve; }); };
  relay.connect(principal('s', 'host'), next.sink);
  relay.send(principal(), envelope()); relay.send(principal(), envelope({id: 'queued'}));
  epochs.set('s:client', 2); finish(); await flush(); assert.equal(next.received.length, 1);
});

test('global connection limit and immutable caller snapshots', async () => {
  const {relay} = fixture({maxConnections: 1}); const r = receiver(); const p = {...principal('s', 'host')};
  relay.connect(p, r.sink); p.space = 'changed';
  assert.throws(() => relay.connect(principal('other', 'host'), receiver().sink), /connection_limit/);
  const e = {...envelope()};
  relay.send(principal(), e); e.body = 'Yw=='; await flush();
  assert.equal(r.received[0]?.body, 'YQ==');
  const next = receiver(); relay.connect(principal('s', 'host'), next.sink); await flush();
  assert.equal(next.received.length, 0);
});

test('old asynchronous transport rejection cannot close a replacement connection', async () => {
  const {relay} = fixture(); const old = receiver(), next = receiver(); let fail!: (e: Error) => void;
  old.sink.send = async () => new Promise<void>((_, reject) => { fail = reject; });
  relay.connect(principal('s', 'host'), old.sink); relay.send(principal(), envelope());
  relay.connect(principal('s', 'host'), next.sink);
  fail(new Error('old failure')); await flush();
  assert.equal(relay.presence(principal(), 'host'), true); assert.deepEqual(next.closed, []);
  relay.send(principal(), envelope({id: 'new'})); await flush(); assert.equal(next.received.length, 1);
});

test('queued caller snapshots and recipient epochs are checked independently', async () => {
  const {relay, epochs} = fixture(); const r = receiver(); let finish!: () => void;
  r.sink.send = async e => { r.received.push(e); if (e.id === 'm') await new Promise<void>(resolve => { finish = resolve; }); };
  relay.connect(principal('s', 'host'), r.sink); relay.send(principal(), envelope());
  const p = {...principal()}, e = {...envelope({id: 'queued'})};
  relay.send(p, e); p.epoch = 99; e.body = 'Yw=='; finish(); await flush();
  assert.equal(r.received[1]?.body, 'YQ==');
  relay.send(principal(), envelope()); relay.send(principal(), envelope({id: 'revoked_queue'}));
  epochs.set('s:host', 2); finish(); await flush();
  assert.deepEqual(r.closed, ['revoked']);
  assert.equal(r.received.some(value => value.id === 'revoked_queue'), false);
});

test('sweep releases expired capacity; transport throws are contained', () => {
  const {relay, time} = fixture({maxConnections: 1}); const r = receiver();
  relay.connect(principal('s', 'host'), r.sink); time(1100); relay.sweep();
  assert.deepEqual(r.closed, ['heartbeat_expired']);
  const other = receiver();
  other.sink.send = () => { throw new Error('sync send'); };
  other.sink.close = () => { throw new Error('sync close'); };
  relay.connect(principal('other', 'host'), other.sink);
  relay.send(principal('other'), envelope({space: 'other', expiresAt: 1200}));
  assert.equal(relay.presence(principal('other'), 'host'), false);
});

test('invalid limits, oversized payloads and invalid clocks reject explicitly', () => {
  assert.throws(() => fixture({maxConnections: 0}), /invalid_limit/);
  const {relay, time} = fixture({maxMessageBytes: 220});
  relay.connect(principal('s', 'host'), receiver().sink);
  assert.throws(() => relay.send(principal(), envelope({body: Buffer.alloc(200).toString('base64')})), /message_too_large/);
  time(Number.NaN); assert.throws(() => relay.presence(principal(), 'host'), /invalid_clock/);
});


test('constructor requires both trusted authority methods', () => {
  for (const authority of [undefined, null, {}, {assertActive() {}}, {assertActive() {}, assertCanSend: true}]) {
    assert.throws(() => new LiveRelay(authority as unknown as RelayAuthority), /authority_required/);
  }
});

test('mailbox messages must use durable Mailbox instead of live transport', () => {
  const {relay} = fixture(); const r = receiver();
  relay.connect(principal('s', 'host'), r.sink);
  assert.throws(() => relay.send(principal(), envelope({chan: 'mailbox', expiresAt: null})), /stream_required/);
  assert.equal(r.received.length, 0);
});
