import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {assertPrincipal, encodeEnvelope, RelayError, validateEnvelope,
  type RelayAuthority, type RelayEnvelope, type RelayPrincipal} from './protocol.js';

export interface MailboxOptions {
  maxMessageBytes?: number;
  maxMessages?: number;
  maxMessagesPerDevice?: number;
  maxBytes?: number;
  maxBytesPerDevice?: number;
  maxHistory?: number;
  maxHistoryPerDevice?: number;
  maxPageSize?: number;
  now?: () => number;
}
export interface MailboxPage {
  messages: {seq: number; envelope: RelayEnvelope}[];
  nextCursor: number;
  ackCursor: number;
  hasMore: boolean;
}
export interface MailboxStatus {
  lastCursor: number;
  ackCursor: number;
  deliveredCursor: number;
  retainedAfter: number;
}
interface DeviceState {last: number; ack: number; delivered: number; floor: number}
const defaults = {maxMessageBytes: 16_384, maxMessages: 100_000, maxMessagesPerDevice: 20_000,
  maxBytes: 256 * 1024 * 1024, maxBytesPerDevice: 64 * 1024 * 1024,
  maxHistory: 1_000_000, maxHistoryPerDevice: 100_000, maxPageSize: 100};

/** Synchronous, transactional opaque mailbox kernel; callers must supply trusted authority.
 * Dedup hashes are never evicted: history quotas deliberately fail closed when full.
 * prune releases payload capacity, not ID history. Database lifecycle/reset needs a new
 * namespace and external snapshot coordination, never reuse this namespace after deleting history.
 */
export class MailboxStore {
  private readonly db: DatabaseSync;
  private readonly limits: typeof defaults;
  private readonly clock: () => number;
  private lastNow = 0;
  constructor(path: string, private readonly authority: RelayAuthority, options: MailboxOptions = {}) {
    if (!authority || typeof authority.assertActive !== 'function' || typeof authority.assertCanSend !== 'function') {
      throw new RelayError('authority_required');
    }
    this.limits = {...defaults};
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      const value = options[key] ?? defaults[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new RelayError('invalid_options');
      this.limits[key] = value;
    }
    this.clock = options.now ?? Date.now;
    if (typeof this.clock !== 'function') throw new RelayError('invalid_clock');
    this.db = new DatabaseSync(path);
    // DELETE journal avoids a long-lived WAL growing behind readers; SQLite reuses freed pages.
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mailbox_devices (
        space TEXT NOT NULL, device TEXT NOT NULL, last INTEGER NOT NULL DEFAULT 0,
        ack INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
        floor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(space, device));
      CREATE TABLE IF NOT EXISTS mailbox_history (
        space TEXT NOT NULL, sender TEXT NOT NULL, id TEXT NOT NULL, recipient TEXT NOT NULL,
        seq INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(space,sender,id));
      CREATE INDEX IF NOT EXISTS mailbox_history_recipient ON mailbox_history(space,recipient);
      CREATE TABLE IF NOT EXISTS mailbox_messages (
        space TEXT NOT NULL, recipient TEXT NOT NULL, seq INTEGER NOT NULL,
        payload TEXT NOT NULL, bytes INTEGER NOT NULL, expires INTEGER,
        PRIMARY KEY(space,recipient,seq));`);
  }
  // Clamp only within this instance. The adapter must provide trustworthy wall time across restarts.
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new RelayError('invalid_clock');
    this.lastNow = Math.max(this.lastNow, now);
    return this.lastNow;
  }
  private active(p: RelayPrincipal): void {
    this.authority.assertActive(p);
    assertPrincipal(p);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result = operation(); this.db.exec('COMMIT'); return result;}
    catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }
  private state(p: RelayPrincipal): DeviceState {
    return this.db.prepare('SELECT last,ack,delivered,floor FROM mailbox_devices WHERE space=? AND device=?')
      .get(p.space,p.device) as unknown as DeviceState ?? {last:0,ack:0,delivered:0,floor:0};
  }
  private cursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RelayError('invalid_cursor');
  }
  send(p: RelayPrincipal, envelope: RelayEnvelope): {seq: number; duplicate: boolean} {
    this.active(p);
    validateEnvelope(envelope,p,this.limits.maxMessageBytes);
    if (envelope.chan !== 'mailbox') throw new RelayError('invalid_channel');
    this.authority.assertCanSend(p,envelope);
    const payload = encodeEnvelope(envelope);
    const bytes = Buffer.byteLength(payload);
    const digest = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT seq,digest FROM mailbox_history WHERE space=? AND sender=? AND id=?')
        .get(p.space,p.device,envelope.id);
      if (old) {
        if (old.digest !== digest) throw new RelayError('id_conflict');
        return {seq: Number(old.seq),duplicate:true};
      }
      this.now();
      const global = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM mailbox_messages').get()!;
      const local = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM mailbox_messages WHERE space=? AND recipient=?')
        .get(p.space,envelope.to)!;
      if (Number(global.count) >= this.limits.maxMessages || Number(local.count) >= this.limits.maxMessagesPerDevice ||
          Number(global.bytes) + bytes > this.limits.maxBytes || Number(local.bytes) + bytes > this.limits.maxBytesPerDevice) {
        throw new RelayError('capacity_exceeded');
      }
      const history = this.db.prepare('SELECT count(*) AS count FROM mailbox_history').get()!;
      const localHistory = this.db.prepare('SELECT count(*) AS count FROM mailbox_history WHERE space=? AND recipient=?').get(p.space,envelope.to)!;
      if (Number(history.count) >= this.limits.maxHistory || Number(localHistory.count) >= this.limits.maxHistoryPerDevice) {
        throw new RelayError('history_capacity_exceeded');
      }
      this.db.prepare('INSERT OR IGNORE INTO mailbox_devices(space,device) VALUES (?,?)').run(p.space,envelope.to);
      const seq = this.state({...p,device:envelope.to}).last + 1;
      if (!Number.isSafeInteger(seq)) throw new RelayError('sequence_exhausted');
      this.db.prepare('UPDATE mailbox_devices SET last=? WHERE space=? AND device=?').run(seq,p.space,envelope.to);
      this.db.prepare('INSERT INTO mailbox_messages VALUES (?,?,?,?,?,?)').run(p.space,envelope.to,seq,payload,bytes,envelope.expiresAt);
      this.db.prepare('INSERT INTO mailbox_history VALUES (?,?,?,?,?,?)').run(p.space,p.device,envelope.id,envelope.to,seq,digest);
      return {seq,duplicate:false};
    });
  }
  read(p: RelayPrincipal, options: {after?: number; limit?: number; maxBytes?: number} = {}): MailboxPage {
    this.active(p);
    const limit = options.limit ?? this.limits.maxPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxPageSize) throw new RelayError('invalid_limit');
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RelayError('invalid_limit');
    return this.transaction(() => {
      const state = this.state(p);
      const after = options.after ?? state.ack;
      this.cursor(after);
      if (after < state.floor) throw new RelayError('cursor_expired');
      if (after > Math.max(state.delivered,state.floor)) throw new RelayError('cursor_not_delivered');
      const rows = this.db.prepare('SELECT seq,payload,expires FROM mailbox_messages WHERE space=? AND recipient=? AND seq>? ORDER BY seq LIMIT ?')
        .iterate(p.space,p.device,after,limit);
      const now = this.now();
      const messages: MailboxPage['messages'] = [];
      let bytes = 0;let nextCursor=after;
      for (const row of rows) {
        // Pre-upgrade mailboxes may contain sender-controlled deadlines. Expired legacy
        // rows are non-deliverable, but must not poison the recipient's entire cursor.
        if (row.expires !== null && Number(row.expires) <= now) {nextCursor=Number(row.seq);continue;}
        const message = {seq:Number(row.seq),envelope:JSON.parse(String(row.payload)) as RelayEnvelope};
        const entryBytes = Buffer.byteLength(JSON.stringify(message)) + (messages.length ? 1 : 0);
        if (bytes + entryBytes > maxBytes) {
          if (!messages.length) throw new RelayError('page_too_small');
          break;
        }
        bytes += entryBytes;messages.push(message);nextCursor=message.seq;
      }
      // Keep legacy rows until normal pruning so a lost ACK/restart can traverse the gap again.
      // An explicit post-snapshot read at the retained floor delivers that cursor even
      // when the page is empty, allowing recovery to be durably acknowledged.
      if (nextCursor > state.delivered) this.db.prepare('UPDATE mailbox_devices SET delivered=max(delivered,?) WHERE space=? AND device=?').run(nextCursor,p.space,p.device);
      return {messages,nextCursor,ackCursor:state.ack,hasMore:nextCursor < state.last};
    });
  }
  acknowledge(p: RelayPrincipal, cursor: number): number {
    this.active(p);this.cursor(cursor);
    return this.transaction(() => {
      const state = this.state(p);
      if (cursor > state.delivered) throw new RelayError('cursor_not_delivered');
      const ack = Math.max(state.ack,cursor);
      this.db.prepare('UPDATE mailbox_devices SET ack=? WHERE space=? AND device=?').run(ack,p.space,p.device);
      return ack;
    });
  }
  /** Deliberate prefix loss: subsequent reads below throughCursor fail cursor_expired.
   * After coordinating snapshot recovery, query status(p) and resume with
   * read(p, {after: status.retainedAfter}). A stale concurrent floor still fails explicitly.
   */
  prune(p: RelayPrincipal, throughCursor: number): void {
    this.active(p);this.cursor(throughCursor);
    this.transaction(() => {
      const state = this.state(p);
      if (throughCursor > state.last) throw new RelayError('invalid_cursor');
      this.db.prepare('DELETE FROM mailbox_messages WHERE space=? AND recipient=? AND seq<=?').run(p.space,p.device,throughCursor);
      this.db.prepare('UPDATE mailbox_devices SET floor=max(floor,?) WHERE space=? AND device=?').run(throughCursor,p.space,p.device);
    });
  }
  /** Recipient-scoped recovery metadata; querying does not advance delivery or ACK. */
  status(p: RelayPrincipal): MailboxStatus {
    this.active(p);
    const state = this.state(p);
    return {lastCursor:state.last,ackCursor:state.ack,deliveredCursor:state.delivered,retainedAfter:state.floor};
  }
  close(): void {this.db.close();}
}
