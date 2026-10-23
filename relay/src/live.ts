import {assertId, assertPrincipal, encodeEnvelope, RelayError, validateEnvelope} from './protocol.js';
import type {RelayAuthority, RelayEnvelope, RelayPrincipal} from './protocol.js';

export interface LiveReceiver {
  /** Resolves when the transport accepts the frame, NOT when the client persists it.
   * The adapter must not retain unbounded buffers; close must abort pending I/O. */
  send(envelope: RelayEnvelope): Promise<void>;
  close(reason: string): void;
}
export interface LiveConnection {
  heartbeat(): void;
  close(): void;
}
export interface LiveOptions {
  clock?: () => number;
  heartbeatMs?: number;
  maxStreamTtlMs?: number;
  maxMessageBytes?: number;
  /** Limits include the currently in-flight write. */
  maxQueueMessages?: number;
  maxQueueBytes?: number;
  maxConnections?: number;
}
interface Pending { principal: RelayPrincipal; envelope: RelayEnvelope; bytes: number }
interface Connection {
  key: string;
  principal: RelayPrincipal;
  receiver: LiveReceiver;
  deadline: number;
  queue: Pending[];
  messages: number;
  bytes: number;
  pumping: boolean;
  closed: boolean;
}

/** In-memory transport only. It neither persists nor acknowledges messages. Even
 * successful writes may be lost; final replies must separately go through Mailbox
 * and its durable cursor/ACK protocol. Streams are never replayed on reconnect.
 * Invoke sweep periodically from the service to close idle sockets proactively;
 * all device operations independently enforce expiry without relying on a timer. */
export class LiveRelay {
  private readonly connections = new Map<string, Connection>();
  private readonly options: Required<LiveOptions>;
  private lastNow = 0;

  constructor(private readonly authority: RelayAuthority, options: LiveOptions = {}) {
    if (!authority || typeof authority.assertActive !== 'function' || typeof authority.assertCanSend !== 'function') {
      throw new RelayError('authority_required');
    }
    this.options = {clock: Date.now, heartbeatMs: 30_000, maxStreamTtlMs: 60_000,
      maxMessageBytes: 64 * 1024, maxQueueMessages: 64, maxQueueBytes: 1024 * 1024,
      maxConnections: 1024, ...options};
    for (const [key, value] of Object.entries(this.options)) {
      if (key !== 'clock' && (!Number.isSafeInteger(value) || Number(value) <= 0)) throw new RelayError('invalid_limit');
    }
    if (typeof this.options.clock !== 'function') throw new RelayError('invalid_clock');
  }

  connect(principal: RelayPrincipal, receiver: LiveReceiver): LiveConnection {
    const p = this.authenticate(principal);
    this.sweep();
    const key = this.key(p.space, p.device);
    const prior = this.connections.get(key);
    if (!prior && this.connections.size >= this.options.maxConnections) throw new RelayError('connection_limit');
    if (prior) this.drop(prior, 'replaced');
    const connection: Connection = {key, principal: p, receiver, deadline: this.now() + this.options.heartbeatMs,
      queue: [], messages: 0, bytes: 0, pumping: false, closed: false};
    this.connections.set(key, connection);
    return Object.freeze({
      heartbeat: () => {
        this.authenticate(p);
        if (!this.current(connection)) throw new RelayError('stale_connection');
        connection.deadline = this.now() + this.options.heartbeatMs;
      },
      close: () => { this.authenticate(p); this.drop(connection, 'disconnected'); },
    });
  }

  presence(principal: RelayPrincipal, device: string): boolean {
    const p = this.authenticate(principal);
    assertId(device);
    const connection = this.connections.get(this.key(p.space, device));
    return connection !== undefined && this.current(connection);
  }

  /** Accepts only streams; mailbox envelopes must use durable Mailbox.
   * Returns after bounded enqueue, not delivery or persistence. Rejection at
   * later dequeue (expiry/revocation) drops that frame, without an offline queue. */
  send(principal: RelayPrincipal, envelope: RelayEnvelope): void {
    const p = this.authenticate(principal);
    const bytes = validateEnvelope(envelope, p, this.options.maxMessageBytes);
    const snapshot: RelayEnvelope = Object.freeze(JSON.parse(encodeEnvelope(envelope)) as RelayEnvelope);
    this.authority.assertCanSend(p, snapshot);
    if (snapshot.chan !== 'stream') throw new RelayError('stream_required');
    const now = this.now();
    if (snapshot.expiresAt !== null && snapshot.expiresAt <= now) throw new RelayError('expired');
    if (snapshot.chan === 'stream' && snapshot.expiresAt! - now > this.options.maxStreamTtlMs) throw new RelayError('ttl_too_long');
    const connection = this.connections.get(this.key(p.space, snapshot.to));
    if (!connection || !this.current(connection)) throw new RelayError('offline');
    if (connection.messages + 1 > this.options.maxQueueMessages || connection.bytes + bytes > this.options.maxQueueBytes) {
      this.drop(connection, 'backpressure');
      throw new RelayError('backpressure');
    }
    connection.queue.push({principal: p, envelope: snapshot, bytes});
    connection.messages++;
    connection.bytes += bytes;
    if (!connection.pumping) {
      // pump has a rejection handler even if a clock/authority/transport throws.
      void this.pump(connection).catch(() => this.drop(connection, 'transport_failed'));
    }
  }

  /** Trusted service maintenance, not a device endpoint. */
  sweep(): void {
    for (const connection of this.connections.values()) this.current(connection);
  }

  private authenticate(principal: RelayPrincipal): RelayPrincipal {
    const snapshot = Object.freeze({space: principal.space, device: principal.device, epoch: principal.epoch});
    assertPrincipal(snapshot);
    this.authority.assertActive(snapshot);
    return snapshot;
  }
  private now(): number {
    const now = this.options.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new RelayError('invalid_clock');
    this.lastNow = Math.max(this.lastNow, now);
    return this.lastNow;
  }
  private key(space: string, device: string): string { return `${space}:${device}`; }
  private current(connection: Connection): boolean {
    if (connection.closed || this.connections.get(connection.key) !== connection) return false;
    if (connection.deadline <= this.now()) { this.drop(connection, 'heartbeat_expired'); return false; }
    try { this.authority.assertActive(connection.principal); }
    catch { this.drop(connection, 'revoked'); return false; }
    return true;
  }
  private drop(connection: Connection, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.connections.get(connection.key) === connection) this.connections.delete(connection.key);
    connection.queue.length = 0;
    connection.messages = 0;
    connection.bytes = 0;
    try { connection.receiver.close(reason); } catch { /* Transport cleanup must not corrupt relay state. */ }
  }
  private async pump(connection: Connection): Promise<void> {
    connection.pumping = true;
    try {
      while (this.current(connection)) {
        const pending = connection.queue.shift();
        if (!pending) return;
        try {
          const {principal, envelope} = pending;
          if (envelope.expiresAt !== null && envelope.expiresAt <= this.now()) continue;
          try { this.authority.assertActive(principal); this.authority.assertCanSend(principal, envelope); }
          catch { continue; }
          await connection.receiver.send(envelope);
        } finally {
          if (!connection.closed) { connection.messages--; connection.bytes -= pending.bytes; }
        }
      }
    } catch { this.drop(connection, 'transport_failed'); }
    finally { connection.pumping = false; }
  }
}
