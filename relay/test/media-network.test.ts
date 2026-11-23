import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {RelayServer} from '../src/server.js';
import {RelayClient} from '../src/client.js';
import {generateDeviceIdentity,spaceId,signControl,type DeviceIdentity} from '../src/crypto.js';

const BOOT = 'operator-only-bootstrap-secret';
const SID = 'session-netnetnetnetnetnetnet';
function frame(type = 1, size = 64, fill = 7): Uint8Array {
  const value = new Uint8Array(size).fill(fill); value[0] = 1; value[1] = type; value[2] = 0; value[3] = 0; return value;
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'timed out'); await delay(10); }
}
function makeClient(url: string, space: string, identity: DeviceIdentity): RelayClient {
  return new RelayClient({url, space, device: identity.device, signChallenge: c => signControl({v: 1, purpose: 'relay-login', challengeId: c.id, nonce: c.nonce,
    space: c.space, device: c.device, epoch: c.epoch, expiresAt: c.expiresAt}, identity.signingPrivateKey)});
}
async function space(url: string) {
  const host = await generateDeviceIdentity(), phone = await generateDeviceIdentity(), id = spaceId(host.signingPublicKey);
  const h = makeClient(url, id, host), p = makeClient(url, id, phone);
  const publicHost = {device: host.device, signingPublicKey: host.signingPublicKey, encryptionPublicKey: host.encryptionPublicKey};
  await h.createSpace({space: id, host: publicHost, proof: await signControl({v: 1, purpose: 'space-create', space: id, host: publicHost}, host.signingPrivateKey)}, BOOT);
  const invite = await h.createInvitation() as {id: string; secret: string};
  const payload = {v: 1, purpose: 'pair-request', invitationId: invite.id, secret: invite.secret, device: phone.device,
    signingPublicKey: phone.signingPublicKey, encryptionPublicKey: phone.encryptionPublicKey, business_versions: [1]};
  const request = await p.requestPairing({...payload, proof: await signControl(payload, phone.signingPrivateKey)}) as {id: string};
  await h.confirmPairing(request.id, 'confirm-' + request.id);
  return {id, host, phone, h, p};
}
const token = (client: RelayClient): string => (client as unknown as {session: {token: string}}).session.token;

test('with media disabled the media routes do not exist and other routes are unchanged', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT});
  const url = await service.listen();
  try {
    const s = await space(url);
    assert.deepEqual(await s.h.capabilities(), {media: null});
    await assert.rejects(() => s.h.reserveMedia(SID, s.phone.device), /invalid_route/);
    await assert.rejects(() => s.h.connectMedia(SID), /media_rejected|Unexpected server response|404/);
    assert.equal(service.media.enabled, false);
    s.h.stop(); s.p.stop();
  } finally { await service.close(); }
});

test('real WebSocket media: Host reservation, opaque two-way forwarding, roles and two Spaces', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, media: {enabled: true}});
  const url = await service.listen();
  try {
    const a = await space(url), b = await space(url);
    assert.deepEqual((await a.h.capabilities()).media?.codecs, ['pcm16']);
    await assert.rejects(() => a.p.reserveMedia(SID, a.host.device), /host_required/);
    await a.h.reserveMedia(SID, a.phone.device);
    await b.h.reserveMedia(SID, b.phone.device); // same id, different Space
    const hostLeg = await a.h.connectMedia(SID), phoneLeg = await a.p.connectMedia(SID);
    await assert.rejects(() => a.p.connectMedia(SID), /media_role_claimed/);
    await assert.rejects(() => b.p.connectMedia('session-unknownunknownunkn'), /media_session_unknown/);
    const toHost: Uint8Array[] = [], toPhone: Uint8Array[] = [];
    hostLeg.onFrame(f => toHost.push(f)); phoneLeg.onFrame(f => toPhone.push(f));
    const up = frame(1, 1300, 4), down = frame(2, 200, 5);
    await phoneLeg.send(up); await hostLeg.send(down);
    await until(() => toHost.length === 1 && toPhone.length === 1);
    assert.deepEqual([...toHost[0]!], [...up]); assert.deepEqual([...toPhone[0]!], [...down]);
    // Space B's legs are untouched by A's traffic and close.
    const bHost = await b.h.connectMedia(SID); const bClosed: string[] = []; bHost.onClose(r => bClosed.push(r));
    const closed: string[] = []; phoneLeg.onClose(r => closed.push(r));
    hostLeg.close();
    await until(() => closed.length === 1);
    assert.deepEqual(bClosed, []);
    bHost.close();
    await assert.rejects(() => a.h.reserveMedia(SID, a.phone.device), /media_session_exists/);
    for (const c of [a.h, a.p, b.h, b.p]) c.stop();
  } finally { await service.close(); }
});

test('token expiry boundary: renewal keeps the leg, a stale token closes it, a foreign token is refused', async () => {
  let offset = 0;
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, media: {enabled: true}, clock: () => Date.now() + offset});
  const url = await service.listen();
  try {
    const s = await space(url);
    await s.h.reserveMedia(SID, s.phone.device);
    const hostLeg = await s.h.connectMedia(SID);
    await s.p.login();
    const ws = new WebSocket(new URL('/v1/media', url.replace('http', 'ws')), {headers: {authorization: `Bearer ${token(s.p)}`, 'x-nova-media-session': SID}});
    const phoneClosed: string[] = [];
    ws.on('close', (_c, reason) => phoneClosed.push(reason.toString()));
    await new Promise(resolve => ws.once('message', resolve));
    // Renew the phone just before its 900 s token expires.
    offset = 899_000;
    const toHost: Uint8Array[] = []; hostLeg.onFrame(f => toHost.push(f));
    await s.p.login(); ws.send(JSON.stringify({type: 'renew', token: token(s.p)}));
    ws.send(frame(3, 28)); await until(() => toHost.length === 1);
    // The Host never renewed: past its expiry the sweep closes the whole session.
    offset = 900_500; await s.p.login(); ws.send(JSON.stringify({type: 'renew', token: token(s.p)}));
    await until(() => phoneClosed.length === 1);
    assert.equal(phoneClosed[0], 'credential_expired');
    // Renewal with another device's token is refused and ends the session.
    offset = 0; const second = 'session-renewrenewrenewrenewr';
    await s.h.login(); await s.h.reserveMedia(second, s.phone.device);
    await s.p.login();
    const w2 = new WebSocket(new URL('/v1/media', url.replace('http', 'ws')), {headers: {authorization: `Bearer ${token(s.p)}`, 'x-nova-media-session': second}});
    await new Promise(resolve => w2.once('message', resolve));
    const reasons: string[] = []; w2.on('close', (_c, r) => reasons.push(r.toString()));
    w2.send(JSON.stringify({type: 'renew', token: token(s.h)}));
    await until(() => reasons.length === 1);
    assert.equal(reasons[0], 'renewal_mismatch');
    s.h.stop(); s.p.stop();
  } finally { await service.close(); }
});

test('revocation during join closes the session and refuses rejoin', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, media: {enabled: true}});
  const url = await service.listen();
  try {
    const s = await space(url);
    await s.h.reserveMedia(SID, s.phone.device);
    const phoneLeg = await s.p.connectMedia(SID); // half-joined: Host not yet connected
    const closed: string[] = []; phoneLeg.onClose(r => closed.push(r));
    await s.h.revokeDevice(s.phone.device, 'revoke-phone');
    await until(() => closed.length === 1);
    assert.equal(closed[0], 'revoked');
    await assert.rejects(() => s.h.connectMedia(SID), /media_session_unknown|stale|unauthorized/);
    s.h.stop(); s.p.stop();
  } finally { await service.close(); }
});

test('with media disabled a raw media request falls through to the plain 404 before any body parsing', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT});
  const url = await service.listen();
  try {
    const s = await space(url); await s.h.login();
    for (const [method, path] of [['POST', '/v1/media/sessions'], ['GET', '/v1/capabilities'], ['POST', '/v1/media']] as const) {
      const response = await fetch(url + path, {method, headers: {authorization: `Bearer ${token(s.h)}`, 'content-type': 'text/plain'}, ...(method === 'POST' ? {body: 'not json'} : {})});
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), {error: 'invalid_route'});
    }
  } finally { await service.close(); }
});

test('closing a media socket while its renewal login is in flight leaves no timer and sends no renewal', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, media: {enabled: true}});
  const url = await service.listen();
  try {
    const s = await space(url); await s.h.login(); await s.p.login();
    await s.h.reserveMedia(SID, s.phone.device);
    const session = (s.h as unknown as {session: {expiresAt: number}}).session;
    session.expiresAt = Date.now() + 60_000; // renewal fires after the 1 s floor
    const leg = await s.h.connectMedia(SID);
    let release!: () => void, logins = 0;
    (s.h as unknown as {login: () => Promise<void>}).login = () => { logins++; return new Promise<void>(resolve => { release = resolve; }); };
    await until(() => logins === 1);
    assert.equal(leg.renewalPending, false);
    // The socket is fully closed before the in-flight login completes.
    let closed = false; leg.onClose(() => { closed = true; });
    leg.close(); await until(() => closed); release(); await delay(50);
    assert.equal(leg.renewalPending, false);
    await delay(1200);
    assert.equal(logins, 1);
  } finally { await service.close(); }
});

test('a peer control frame sent before this leg joined arrives after ready: the Node client is not rejected and keeps it', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, media: {enabled: true}});
  const url = await service.listen();
  try {
    const s = await space(url);
    await s.h.reserveMedia(SID, s.phone.device);
    const phoneLeg = await s.p.connectMedia(SID); // half-joined
    const early = frame(2, 64, 9);
    await phoneLeg.send(early); await delay(50); // queued as an early control frame for the Host
    const hostLeg = await s.h.connectMedia(SID); // drains the early frame right at join
    const toHost: Uint8Array[] = [];
    await delay(50); // the frame arrived before any onFrame subscriber
    hostLeg.onFrame(f => toHost.push(f));
    await until(() => toHost.length === 1);
    assert.deepEqual([...toHost[0]!], [...early]);
    s.h.stop(); s.p.stop();
  } finally { await service.close(); }
});

test('a raw socket sees the relay ready text frame before any drained binary frame', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, media: {enabled: true}});
  const url = await service.listen();
  try {
    const s = await space(url);
    await s.h.reserveMedia(SID, s.phone.device);
    const phoneLeg = await s.p.connectMedia(SID);
    await phoneLeg.send(frame(2, 64, 1)); await phoneLeg.send(frame(2, 64, 2)); await delay(50);
    await s.h.login();
    const ws = new WebSocket(new URL('/v1/media', url.replace('http', 'ws')), {headers: {authorization: `Bearer ${token(s.h)}`, 'x-nova-media-session': SID}});
    const seen: string[] = [];
    ws.on('message', (data, isBinary) => seen.push(isBinary ? 'binary' : JSON.parse(data.toString()).type));
    await until(() => seen.length === 3);
    assert.deepEqual(seen, ['ready', 'binary', 'binary']);
    ws.close(); s.h.stop(); s.p.stop();
  } finally { await service.close(); }
});

test('overflowing the pre-subscriber frame buffer fails the leg with media_overflow instead of dropping frames', async () => {
  const service = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, media: {enabled: true}});
  const url = await service.listen();
  try {
    const s = await space(url);
    await s.h.reserveMedia(SID, s.phone.device);
    const hostLeg = await s.h.connectMedia(SID), phoneLeg = await s.p.connectMedia(SID);
    const closed: string[] = []; hostLeg.onClose(r => closed.push(r));
    // Paced so the relay writes each one (its own queue sheds bursty audio).
    for (let i = 0; i < 36 && !closed.length; i++) { await phoneLeg.send(frame(1, 64, i)).catch(() => undefined); await delay(5); }
    await until(() => closed.length === 1);
    assert.equal(closed[0], 'media_overflow');
    const late: Uint8Array[] = []; hostLeg.onFrame(f => late.push(f));
    assert.equal(late.length, 0);
    s.h.stop(); s.p.stop();
  } finally { await service.close(); }
});
