import {assertId, assertPrincipal, RelayError, type RelayAuthority, type RelayPrincipal} from './protocol.js';

/**
 * Opaque two-party media forwarding for Space voice (docs/design/space-voice.md §1, §6).
 * The relay never decrypts or verifies frames: endpoints authenticate every frame with
 * per-call AEAD keys. This kernel only enforces who may join, the clear 12-byte header
 * shape, bounded queues and rate budgets. It is disabled unless the operator enables it.
 */
export interface MediaAuthority extends RelayAuthority {
  /** Registered Host device of the Space. Throws for an unknown Space. */
  hostOf(space: string): string;
  /** Throws unless the device is an active (non-revoked) member of the Space. */
  assertMember(space: string, device: string): void;
}
export interface MediaOptions {
  enabled?: boolean;
  clock?: () => number;
  maxKbpsPerDirection?: number;
  maxFramesPerSecond?: number;
  maxFrameBytes?: number;
  queueFrames?: number;
  queueBytes?: number;
  controlQueueFrames?: number;
  blockedPeerMs?: number;
  overLimitCloseMs?: number;
  maxSessionsPerSpace?: number;
  maxSessionsGlobal?: number;
  maxPendingPerSpace?: number;
  maxPendingGlobal?: number;
  maxHalfJoinedPerSpace?: number;
  maxHalfJoinedGlobal?: number;
  maxTombstones?: number;
  joinDeadlineMs?: number;
  maxSessionMinutes?: number;
  idleTimeoutMs?: number;
}
type Limits = Required<Omit<MediaOptions, 'enabled' | 'clock'>>;
export const MEDIA_DEFAULTS: Limits = Object.freeze({
  maxKbpsPerDirection: 512, maxFramesPerSecond: 40, maxFrameBytes: 4096, queueFrames: 16, queueBytes: 64 * 1024,
  controlQueueFrames: 8, blockedPeerMs: 2000, overLimitCloseMs: 3000, maxSessionsPerSpace: 1, maxSessionsGlobal: 64,
  maxPendingPerSpace: 2, maxPendingGlobal: 128, maxHalfJoinedPerSpace: 2, maxHalfJoinedGlobal: 128, maxTombstones: 4096,
  joinDeadlineMs: 15_000, maxSessionMinutes: 60, idleTimeoutMs: 20_000,
});
/** Frame header in the clear: ver(1) type(1) flags(2) seq(8), then ciphertext and a 16-byte tag. */
export const MEDIA_HEADER_BYTES = 12;
export const MEDIA_MIN_FRAME_BYTES = MEDIA_HEADER_BYTES + 16;
export const MEDIA_FRAME_AUDIO = 1;
export const MEDIA_FRAME_CONTROL = 2;
export const MEDIA_FRAME_KEEPALIVE = 3;

/** Transport adapter for one joined socket. `write` resolves once the bytes were handed to the socket. */
export interface MediaEndpoint {
  write(frame: Uint8Array): Promise<void>;
  close(reason: string): void;
  /** Re-validates the socket's current credential (token expiry). Optional for kernel tests. */
  authorized?(): boolean;
}
export interface MediaLeg {
  readonly role: 'host' | 'client';
  /** One inbound binary frame from this leg, forwarded to the peer after checks and charging. */
  receive(frame: Uint8Array): void;
  /** Swap the credential principal after an in-band renewal; must be the identical principal. */
  renew(principal: RelayPrincipal): void;
  close(): void;
}
interface Bucket { tokens: number; at: number }
interface Direction {
  endpoint: MediaEndpoint;
  principal: RelayPrincipal;
  audio: Uint8Array[];
  control: Uint8Array[];
  bytes: number;
  writing: boolean;
  /** Last time the queue was empty or a write completed. */
  progressAt: number;
  lastReceivedAt: number;
  byteBucket: Bucket;
  frameBucket: Bucket;
  overSince: number | null;
  lastDropAt: number | null;
}
interface Session {
  key: string;
  space: string;
  epoch: number;
  session: string;
  host: string;
  client: string;
  createdAt: number;
  expiresAt: number;
  legs: {host?: Direction; client?: Direction};
  /** Control frames sent before the peer joined (bounded by controlQueueFrames), delivered at its join. */
  early: {host: Uint8Array[]; client: Uint8Array[]};
  closed: boolean;
}

/** In-memory media kernel. Sessions never survive a restart; endpoints must handshake afresh. */
export class MediaRelay {
  readonly enabled: boolean;
  private readonly limits: Limits;
  private readonly clock: () => number;
  private readonly sessions = new Map<string, Session>();
  private readonly tombstones = new Map<string, number>();
  private lastNow = 0;

  constructor(private readonly authority: MediaAuthority, options: MediaOptions = {}) {
    this.enabled = options.enabled === true;
    const {enabled: _enabled, clock, ...rest} = options;
    this.limits = {...MEDIA_DEFAULTS, ...rest};
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RelayError('invalid_limit');
    }
    if (this.limits.maxFrameBytes < MEDIA_MIN_FRAME_BYTES) throw new RelayError('invalid_limit');
    this.clock = clock ?? Date.now;
  }

  get maxFrameBytes(): number { return this.limits.maxFrameBytes; }
  get maxKbpsPerDirection(): number { return this.limits.maxKbpsPerDirection; }

  /** Host-only reservation for a distinct, active Client device (§1 step 2). */
  reserve(principal: RelayPrincipal, input: {session: unknown; client: unknown; ttlMs?: unknown}): {session: string; expiresAt: number} {
    this.requireEnabled();
    const p = this.authenticate(principal);
    assertSessionId(input.session); assertId(input.client);
    if (this.authority.hostOf(p.space) !== p.device) throw new RelayError('host_required');
    if (input.client === p.device) throw new RelayError('invalid_media_client');
    this.authority.assertMember(p.space, input.client);
    const ttl = input.ttlMs === undefined ? this.limits.maxSessionMinutes * 60_000 : input.ttlMs;
    if (!Number.isSafeInteger(ttl) || (ttl as number) <= 0) throw new RelayError('invalid_media_ttl');
    this.sweep();
    const key = this.key(p.space, p.epoch, input.session);
    if (this.sessions.has(key) || this.tombstones.has(key)) throw new RelayError('media_session_exists');
    if (this.tombstones.size >= this.limits.maxTombstones) throw new RelayError('media_capacity');
    const pending = [...this.sessions.values()].filter(s => !this.active(s));
    if (pending.length >= this.limits.maxPendingGlobal ||
        pending.filter(s => s.space === p.space).length >= this.limits.maxPendingPerSpace) throw new RelayError('media_capacity');
    const now = this.now();
    const expiresAt = now + Math.min(ttl as number, this.limits.maxSessionMinutes * 60_000);
    this.sessions.set(key, {key, space: p.space, epoch: p.epoch, session: input.session, host: p.device, client: input.client,
      createdAt: now, expiresAt, legs: {}, early: {host: [], client: []}, closed: false});
    return {session: input.session, expiresAt};
  }

  /** Atomic role claim; no replacement of a claimed role in v1 (§1 step 4). */
  join(principal: RelayPrincipal, sessionId: unknown, endpoint: MediaEndpoint): MediaLeg {
    this.requireEnabled();
    const p = this.authenticate(principal);
    assertSessionId(sessionId);
    this.sweep();
    const session = this.sessions.get(this.key(p.space, p.epoch, sessionId));
    if (!session || session.closed) throw new RelayError('media_session_unknown');
    const role: 'host' | 'client' | undefined = p.device === session.host ? 'host' : p.device === session.client ? 'client' : undefined;
    if (!role) throw new RelayError('media_forbidden');
    if (session.legs[role]) throw new RelayError('media_role_claimed');
    const other = role === 'host' ? 'client' : 'host';
    if (!session.legs[other]) {
      const half = [...this.sessions.values()].filter(s => !s.closed && (s.legs.host === undefined) !== (s.legs.client === undefined));
      if (half.length >= this.limits.maxHalfJoinedGlobal ||
          half.filter(s => s.space === p.space).length >= this.limits.maxHalfJoinedPerSpace) throw new RelayError('media_capacity');
    } else {
      const active = [...this.sessions.values()].filter(s => this.active(s));
      if (active.length >= this.limits.maxSessionsGlobal ||
          active.filter(s => s.space === p.space).length >= this.limits.maxSessionsPerSpace) throw new RelayError('media_session_limit');
    }
    const now = this.now();
    const rate = this.limits.maxKbpsPerDirection * 125;
    const leg: Direction = {endpoint, principal: p, audio: [], control: [], bytes: 0, writing: false, progressAt: now, lastReceivedAt: now,
      byteBucket: {tokens: rate, at: now}, frameBucket: {tokens: this.limits.maxFramesPerSecond, at: now}, overSince: null, lastDropAt: null};
    session.legs[role] = leg;
    // A fast peer's first sealed control frame (its `ready`) waits for this leg instead of being lost.
    const early = session.early[role]; session.early[role] = [];
    for (const frame of early) this.enqueue(session, leg, frame, now);
    return Object.freeze({
      role,
      receive: (frame: Uint8Array) => this.forward(session, role, leg, frame),
      renew: (next: RelayPrincipal) => {
        const n = this.authenticate(next);
        if (session.legs[role] !== leg || session.closed) throw new RelayError('stale_media_leg');
        if (n.space !== leg.principal.space || n.device !== leg.principal.device || n.epoch !== leg.principal.epoch) {
          this.close(session, 'renewal_mismatch');
          throw new RelayError('renewal_mismatch');
        }
        leg.principal = n;
      },
      // Late close of a replaced/closed socket must never affect another session or leg.
      close: () => { if (session.legs[role] === leg && !session.closed) this.close(session, 'peer_closed'); },
    });
  }

  /** Service maintenance (1 s): membership/epoch, credentials, deadlines, idle and blocked peers. */
  sweep(): void {
    const now = this.now();
    for (const [key, until] of this.tombstones) if (until <= now) this.tombstones.delete(key);
    for (const session of [...this.sessions.values()]) {
      if (session.closed) continue;
      if (now >= session.expiresAt) { this.close(session, 'max_duration'); continue; }
      if (!this.active(session) && now - session.createdAt >= this.limits.joinDeadlineMs) { this.close(session, 'join_deadline'); continue; }
      for (const leg of [session.legs.host, session.legs.client]) {
        if (!leg || session.closed) continue;
        try { this.authority.assertActive(leg.principal); this.authority.assertMember(leg.principal.space, leg.principal.device); }
        catch { this.close(session, 'revoked'); break; }
        if (leg.endpoint.authorized && !safe(() => leg.endpoint.authorized!())) { this.close(session, 'credential_expired'); break; }
        if (this.active(session) && now - leg.lastReceivedAt >= this.limits.idleTimeoutMs) { this.close(session, 'idle'); break; }
        if ((leg.audio.length || leg.control.length) && now - leg.progressAt >= this.limits.blockedPeerMs) { this.close(session, 'blocked_peer'); break; }
      }
    }
  }

  /** Number of live (non-closed) sessions; diagnostics and tests only. */
  get size(): number { return this.sessions.size; }

  private forward(session: Session, role: 'host' | 'client', from: Direction, frame: Uint8Array): void {
    if (session.closed || session.legs[role] !== from) return;
    const now = this.now();
    // Charge before any forward/drop decision so dropping is never free for the sender.
    const bytesOk = take(from.byteBucket, frame.byteLength, this.limits.maxKbpsPerDirection * 125, now);
    const framesOk = take(from.frameBucket, 1, this.limits.maxFramesPerSecond, now);
    if (!bytesOk || !framesOk) {
      // Over-limit is sustained while drops keep recurring within a second of each other.
      if (from.lastDropAt === null || now - from.lastDropAt > 1000) from.overSince = now;
      from.lastDropAt = now;
      if (now - from.overSince! >= this.limits.overLimitCloseMs) this.close(session, 'rate_limited');
      return;
    }
    if (!validHeader(frame, this.limits.maxFrameBytes)) { this.close(session, 'invalid_frame'); return; }
    from.lastReceivedAt = now;
    const peer = role === 'host' ? 'client' : 'host';
    const to = session.legs[peer];
    const copy = Uint8Array.from(frame);
    if (!to) {
      // Half-joined: only a bounded number of control frames wait for the peer; audio is dropped.
      if (copy[1] !== MEDIA_FRAME_CONTROL) return;
      if (session.early[peer].length >= this.limits.controlQueueFrames) { this.close(session, 'blocked_peer'); return; }
      session.early[peer].push(copy); return;
    }
    this.enqueue(session, to, copy, now);
  }

  /** Queue one frame for a joined leg. Audio and control share queueFrames/queueBytes. */
  private enqueue(session: Session, to: Direction, copy: Uint8Array, now: number): void {
    const over = (): boolean => to.audio.length + to.control.length > this.limits.queueFrames || to.bytes > this.limits.queueBytes;
    if (copy[1] === MEDIA_FRAME_AUDIO) {
      to.audio.push(copy); to.bytes += copy.byteLength;
    } else {
      if (to.control.length >= this.limits.controlQueueFrames) { this.close(session, 'blocked_peer'); return; }
      to.control.push(copy); to.bytes += copy.byteLength;
    }
    // Realtime, latest-wins: shed the oldest audio first. Control may evict audio but never exceed the caps.
    while (over()) { const dropped = to.audio.shift(); if (!dropped) break; to.bytes -= dropped.byteLength; }
    if (over()) { this.close(session, 'blocked_peer'); return; }
    if (to.audio.length + to.control.length === 1 && !to.writing) to.progressAt = now;
    if (!to.writing) void this.pump(session, to);
  }

  private async pump(session: Session, to: Direction): Promise<void> {
    to.writing = true;
    try {
      while (!session.closed) {
        const frame = to.control.shift() ?? to.audio.shift();
        if (!frame) return;
        to.bytes -= frame.byteLength;
        await to.endpoint.write(frame);
        to.progressAt = this.now();
      }
    } catch { this.close(session, 'transport_failed'); }
    finally { to.writing = false; }
  }

  private close(session: Session, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.key);
    // Tombstone until the lifetime cap passes: a session id is never reusable.
    this.tombstones.set(session.key, Math.max(session.expiresAt, this.now() + 1));
    for (const leg of [session.legs.host, session.legs.client]) {
      if (!leg) continue;
      leg.audio.length = 0; leg.control.length = 0; leg.bytes = 0;
    }
    session.early.host.length = 0; session.early.client.length = 0;
    for (const leg of [session.legs.host, session.legs.client]) {
      if (!leg) continue;
      try { leg.endpoint.close(reason); } catch { /* transport cleanup must not corrupt relay state */ }
    }
  }
  private active(session: Session): boolean { return !session.closed && !!session.legs.host && !!session.legs.client; }
  private requireEnabled(): void { if (!this.enabled) throw new RelayError('invalid_route'); }
  private authenticate(principal: RelayPrincipal): RelayPrincipal {
    const p = Object.freeze({space: principal.space, device: principal.device, epoch: principal.epoch});
    assertPrincipal(p); this.authority.assertActive(p); return p;
  }
  private key(space: string, epoch: number, session: string): string { return `${space}\u0000${epoch}\u0000${session}`; }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new RelayError('invalid_clock');
    this.lastNow = Math.max(this.lastNow, now); return this.lastNow;
  }
}

function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(value)) throw new RelayError('invalid_media_session');
}
function validHeader(frame: Uint8Array, max: number): boolean {
  return frame.byteLength >= MEDIA_MIN_FRAME_BYTES && frame.byteLength <= max && frame[0] === 1 &&
    (frame[1] === MEDIA_FRAME_AUDIO || frame[1] === MEDIA_FRAME_CONTROL || frame[1] === MEDIA_FRAME_KEEPALIVE) &&
    frame[2] === 0 && frame[3] === 0;
}
function take(bucket: Bucket, cost: number, perSecond: number, now: number): boolean {
  bucket.tokens = Math.min(perSecond, bucket.tokens + (now - bucket.at) * perSecond / 1000);
  bucket.at = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost; return true;
}
function safe(check: () => boolean): boolean { try { return check(); } catch { return false; } }
