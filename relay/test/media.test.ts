import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaRelay, type MediaAuthority, type MediaEndpoint, type MediaOptions} from '../src/media.js';
import {RelayError, type RelayPrincipal} from '../src/protocol.js';

const SID = 'session-aaaaaaaaaaaaaaaaaaaaaa';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const p = (device: string, space = 's', epoch = 1): RelayPrincipal => ({space, device, epoch});
function frame(type = 1, size = 64, fill = 7): Uint8Array {
  const value = new Uint8Array(size).fill(fill); value[0] = 1; value[1] = type; value[2] = 0; value[3] = 0; return value;
}
function fixture(options: MediaOptions = {}) {
  let now = 1000;
  const epochs = new Map<string, number>();
  const revoked = new Set<string>();
  const hosts = new Map([['s', 'host'], ['t', 'host2']]);
  const authority: MediaAuthority = {
    assertActive(x) { if ((epochs.get(x.space) ?? 1) !== x.epoch) throw new RelayError('stale_epoch'); if (revoked.has(`${x.space}:${x.device}`)) throw new RelayError('device_inactive'); },
    assertCanSend() { throw new Error('unused'); },
    hostOf(space) { const host = hosts.get(space); if (!host) throw new RelayError('space_unknown'); return host; },
    assertMember(space, device) { if (revoked.has(`${space}:${device}`) || !['host', 'host2', 'phone', 'phone2', 'other'].includes(device)) throw new RelayError('device_inactive'); },
  };
  const relay = new MediaRelay(authority, {enabled: true, clock: () => now, ...options});
  return {relay, epochs, revoked, advance: (ms: number) => { now += ms; }, set: (ms: number) => { now = ms; }};
}
function endpoint(options: {authorized?: () => boolean; hold?: boolean} = {}) {
  const written: Uint8Array[] = [], closed: string[] = [];
  let release: (() => void) | undefined;
  const sink: MediaEndpoint = {
    write: async value => { written.push(value); if (options.hold) await new Promise<void>(resolve => { release = resolve; }); },
    close: reason => { closed.push(reason); },
    ...(options.authorized ? {authorized: options.authorized} : {}),
  };
  return {sink, written, closed, release: () => release?.()};
}

test('media is disabled by default and every entry point reports invalid_route', () => {
  const relay = new MediaRelay({assertActive() {}, assertCanSend() {}, hostOf: () => 'host', assertMember() {}});
  assert.equal(relay.enabled, false);
  assert.throws(() => relay.reserve(p('host'), {session: SID, client: 'phone'}), /invalid_route/);
  assert.throws(() => relay.join(p('host'), SID, endpoint().sink), /invalid_route/);
});

test('only the registered Host reserves, for a distinct active member, with a server lifetime cap', () => {
  const {relay, revoked} = fixture({maxSessionMinutes: 1});
  assert.throws(() => relay.reserve(p('phone'), {session: SID, client: 'host'}), /host_required/);
  assert.throws(() => relay.reserve(p('host'), {session: SID, client: 'host'}), /invalid_media_client/);
  assert.throws(() => relay.reserve(p('host'), {session: SID, client: 'stranger'}), /device_inactive/);
  revoked.add('s:phone2');
  assert.throws(() => relay.reserve(p('host'), {session: SID, client: 'phone2'}), /device_inactive/);
  assert.throws(() => relay.reserve(p('host'), {session: 'short', client: 'phone'}), /invalid_media_session/);
  const reserved = relay.reserve(p('host'), {session: SID, client: 'phone', ttlMs: 3_600_000});
  assert.equal(reserved.expiresAt, 1000 + 60_000);
  assert.throws(() => relay.reserve(p('host'), {session: SID, client: 'phone'}), /media_session_exists/);
});

test('the same session id in two Spaces is independent, and a closed id is never reusable', async () => {
  const {relay} = fixture();
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  relay.reserve(p('host2', 't'), {session: SID, client: 'phone2'});
  const a = endpoint(), b = endpoint(), c = endpoint(), d = endpoint();
  const hostA = relay.join(p('host'), SID, a.sink); const phoneA = relay.join(p('phone'), SID, b.sink);
  relay.join(p('host2', 't'), SID, c.sink); relay.join(p('phone2', 't'), SID, d.sink);
  phoneA.receive(frame(1, 64, 9)); await flush();
  assert.equal(a.written.length, 1); assert.equal(c.written.length, 0);
  hostA.close();
  assert.deepEqual(b.closed, ['peer_closed']); assert.equal(d.closed.length, 0);
  assert.throws(() => relay.reserve(p('host'), {session: SID, client: 'phone'}), /media_session_exists/);
});

test('role claims are atomic: third, replacement and foreign sockets are rejected; late close is harmless', async () => {
  const {relay} = fixture();
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  assert.throws(() => relay.join(p('other'), SID, endpoint().sink), /media_forbidden/);
  assert.throws(() => relay.join(p('phone', 't'), SID, endpoint().sink), /media_session_unknown/);
  const h = endpoint(), c = endpoint();
  const host = relay.join(p('host'), SID, h.sink); const phone = relay.join(p('phone'), SID, c.sink);
  assert.throws(() => relay.join(p('phone'), SID, endpoint().sink), /media_role_claimed/);
  // A second call (new session) for the same pair stays isolated from a late close of the first.
  host.close();
  const SID2 = 'session-bbbbbbbbbbbbbbbbbbbbbb';
  relay.reserve(p('host'), {session: SID2, client: 'phone'});
  const h2 = endpoint(), c2 = endpoint();
  relay.join(p('host'), SID2, h2.sink); const phone2 = relay.join(p('phone'), SID2, c2.sink);
  phone.close(); host.close();
  assert.equal(h2.closed.length + c2.closed.length, 0);
  phone2.receive(frame()); await flush(); assert.equal(h2.written.length, 1);
});

test('join deadline and half-joined caps bound unpaired sockets', () => {
  const {relay, advance} = fixture({maxHalfJoinedPerSpace: 1, maxPendingPerSpace: 2});
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  const SID2 = 'session-cccccccccccccccccccccc';
  relay.reserve(p('host'), {session: SID2, client: 'phone'});
  assert.throws(() => relay.reserve(p('host'), {session: 'session-dddddddddddddddddddddd', client: 'phone'}), /media_capacity/);
  const first = endpoint();
  relay.join(p('host'), SID, first.sink);
  assert.throws(() => relay.join(p('host'), SID2, endpoint().sink), /media_capacity/);
  advance(15_000); relay.sweep();
  assert.deepEqual(first.closed, ['join_deadline']);
  assert.throws(() => relay.join(p('phone'), SID, endpoint().sink), /media_session_unknown/);
});

test('frames are forwarded byte-identical; malformed headers close the session', async () => {
  const {relay} = fixture();
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint(), c = endpoint();
  const host = relay.join(p('host'), SID, h.sink); relay.join(p('phone'), SID, c.sink);
  const sent = frame(2, 100, 3); host.receive(sent); await flush();
  assert.deepEqual([...c.written[0]!], [...sent]);
  const bad = frame(1, 64); bad[2] = 1; host.receive(bad);
  assert.deepEqual(h.closed, ['invalid_frame']);
});

test('byte and frame buckets charge before drop and sustained excess closes the session', async () => {
  const {relay, advance} = fixture({maxFramesPerSecond: 2, overLimitCloseMs: 1000});
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint(), c = endpoint();
  const host = relay.join(p('host'), SID, h.sink); relay.join(p('phone'), SID, c.sink);
  host.receive(frame()); host.receive(frame()); host.receive(frame()); await flush();
  assert.equal(c.written.length, 2); // the third frame was charged and dropped
  // An invalid frame is charged too: with no tokens it is dropped before inspection, not forwarded.
  const malformed = frame(); malformed[0] = 9; host.receive(malformed);
  assert.equal(h.closed.length, 0);
  advance(500); host.receive(frame()); host.receive(frame()); host.receive(frame());
  assert.equal(h.closed.length, 0);
  advance(500); host.receive(frame()); host.receive(frame());
  assert.deepEqual(h.closed, ['rate_limited']);
});

test('bounded app queue sheds oldest audio, control overflow and a blocked peer close the session', async () => {
  const {relay, advance} = fixture({queueFrames: 2, controlQueueFrames: 1, maxFramesPerSecond: 100, blockedPeerMs: 500});
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint(), c = endpoint({hold: true});
  const host = relay.join(p('host'), SID, h.sink); relay.join(p('phone'), SID, c.sink);
  host.receive(frame(1, 64, 1)); // in flight, held
  host.receive(frame(1, 64, 2)); host.receive(frame(1, 64, 3)); host.receive(frame(1, 64, 4));
  c.release(); await flush(); c.release(); await flush(); c.release(); await flush();
  assert.deepEqual(c.written.map(f => f[5]), [1, 3, 4]);
  host.receive(frame(2, 64, 5)); // in flight, held
  host.receive(frame(2, 64, 6)); host.receive(frame(2, 64, 7));
  assert.deepEqual(h.closed, ['blocked_peer']);
  const second = fixture({blockedPeerMs: 500});
  second.relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h2 = endpoint(), c2 = endpoint({hold: true});
  const host2 = second.relay.join(p('host'), SID, h2.sink); second.relay.join(p('phone'), SID, c2.sink);
  host2.receive(frame()); host2.receive(frame());
  second.advance(499); second.relay.sweep(); assert.deepEqual(h2.closed, []);
  second.advance(1); second.relay.sweep(); assert.deepEqual(h2.closed, ['blocked_peer']);
  void advance;
});

test('revocation, epoch rotation, expired credentials and idle legs are swept', () => {
  for (const [name, mutate, reason] of [
    ['revoked device', (f: ReturnType<typeof fixture>) => f.revoked.add('s:phone'), 'revoked'],
    ['epoch rotation', (f: ReturnType<typeof fixture>) => f.epochs.set('s', 2), 'revoked'],
    ['idle', (f: ReturnType<typeof fixture>) => f.advance(20_000), 'idle'],
    ['max duration', (f: ReturnType<typeof fixture>) => f.advance(60 * 60_000), 'max_duration'],
  ] as const) {
    const f = fixture();
    f.relay.reserve(p('host'), {session: SID, client: 'phone'});
    const h = endpoint(); f.relay.join(p('host'), SID, h.sink); f.relay.join(p('phone'), SID, endpoint().sink);
    mutate(f); f.relay.sweep();
    assert.deepEqual(h.closed, [reason], name);
  }
  const f = fixture(); let valid = true;
  f.relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint({authorized: () => valid}); f.relay.join(p('host'), SID, h.sink);
  f.relay.sweep(); assert.deepEqual(h.closed, []);
  valid = false; f.relay.sweep(); assert.deepEqual(h.closed, ['credential_expired']);
});

test('renewal must present the identical principal', () => {
  const f = fixture();
  f.relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint(); const host = f.relay.join(p('host'), SID, h.sink);
  host.renew(p('host'));
  assert.throws(() => host.renew(p('phone')), /renewal_mismatch/);
  assert.deepEqual(h.closed, ['renewal_mismatch']);
});

test('control frames share queueFrames and queueBytes: they evict queued audio but never exceed the caps', async () => {
  const {relay} = fixture({queueFrames: 3, queueBytes: 500, controlQueueFrames: 8, maxFramesPerSecond: 100});
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint(), c = endpoint({hold: true});
  const host = relay.join(p('host'), SID, h.sink); relay.join(p('phone'), SID, c.sink);
  host.receive(frame(1, 64, 1)); // in flight, held
  host.receive(frame(1, 100, 2)); host.receive(frame(1, 100, 3)); host.receive(frame(1, 100, 4));
  // A control frame evicts the oldest queued audio to stay within three frames.
  host.receive(frame(2, 100, 5));
  assert.deepEqual(h.closed, []);
  // Byte cap: a large control frame evicts audio until the bytes fit.
  host.receive(frame(2, 250, 6));
  assert.deepEqual(h.closed, []);
  for (let i = 0; i < 4; i++) { c.release(); await flush(); }
  assert.deepEqual(c.written.map(f => f[5]), [1, 5, 6, 4]);
  // Control alone beyond the frame cap closes the session instead of growing the queue.
  const f2 = fixture({queueFrames: 2, controlQueueFrames: 8, maxFramesPerSecond: 100});
  f2.relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h2 = endpoint(), c2 = endpoint({hold: true});
  const host2 = f2.relay.join(p('host'), SID, h2.sink); f2.relay.join(p('phone'), SID, c2.sink);
  host2.receive(frame(2, 64, 1)); host2.receive(frame(2, 64, 2)); host2.receive(frame(2, 64, 3));
  assert.deepEqual(h2.closed, []);
  host2.receive(frame(2, 64, 4));
  assert.deepEqual(h2.closed, ['blocked_peer']);
});

test('a fast peer: control frames sent before the other leg joins are delivered at its join; audio is not buffered', async () => {
  const {relay} = fixture({controlQueueFrames: 2});
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint(), c = endpoint();
  const phone = relay.join(p('phone'), SID, c.sink);
  phone.receive(frame(2, 64, 1)); phone.receive(frame(1, 64, 2)); phone.receive(frame(2, 64, 3));
  relay.join(p('host'), SID, h.sink); await flush(); await flush();
  assert.deepEqual(h.written.map(f => [f[1], f[5]]), [[2, 1], [2, 3]]);
  // The early buffer is bounded.
  const f2 = fixture({controlQueueFrames: 1});
  f2.relay.reserve(p('host'), {session: SID, client: 'phone'});
  const c2 = endpoint(), phone2 = f2.relay.join(p('phone'), SID, c2.sink);
  phone2.receive(frame(2)); phone2.receive(frame(2));
  assert.deepEqual(c2.closed, ['blocked_peer']);
});

test('control frames overtake queued audio, so playback.terminal must carry its end position', async () => {
  const {relay} = fixture({maxFramesPerSecond: 100});
  relay.reserve(p('host'), {session: SID, client: 'phone'});
  const h = endpoint(), c = endpoint({hold: true});
  const host = relay.join(p('host'), SID, h.sink); relay.join(p('phone'), SID, c.sink);
  host.receive(frame(1, 64, 1)); host.receive(frame(1, 64, 2)); host.receive(frame(2, 64, 9));
  for (let i = 0; i < 3; i++) { c.release(); await flush(); }
  // The control frame (e.g. terminal) arrives before audio 2: the endpoint, not the relay, decides completeness.
  assert.deepEqual(c.written.map(f => f[5]), [1, 9, 2]);
});
