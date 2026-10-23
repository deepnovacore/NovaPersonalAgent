/** Internal delivery contract. This is not the public, cryptographically reviewed wire protocol. */
export interface RelayPrincipal {
  readonly space: string;
  readonly device: string;
  readonly epoch: number;
}

export interface RelayEnvelope {
  readonly v: 1;
  readonly space: string;
  readonly id: string;
  readonly from: string;
  /** Concrete device ID; encrypted fan-out is performed by the sender. */
  readonly to: string;
  readonly chan: 'mailbox' | 'stream';
  readonly epoch: number;
  readonly expiresAt: number | null;
  /** Canonical base64 opaque ciphertext, never decoded as business data. */
  readonly body: string;
  readonly sig: string;
}

/** Mandatory trusted adapter; never populate principals from unverified request fields.
 * assertActive checks current membership/epoch, including on reads and ACKs.
 * assertCanSend additionally verifies the entire envelope's signature and recipient membership.
 * Pairing, keys and signature suite are deliberately outside this delivery-only package.
 */
export interface RelayAuthority {
  assertActive(principal: RelayPrincipal): void;
  assertCanSend(principal: RelayPrincipal, envelope: RelayEnvelope): void;
}

export class RelayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RelayError';
  }
}

export function assertId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new RelayError('invalid_id');
  }
}

export function assertPrincipal(principal: RelayPrincipal): void {
  assertId(principal.space);
  assertId(principal.device);
  if (!Number.isSafeInteger(principal.epoch) || principal.epoch < 1) throw new RelayError('invalid_epoch');
}

export function validateEnvelope(envelope: RelayEnvelope, principal: RelayPrincipal, maxBytes: number): number {
  assertPrincipal(principal);
  for (const value of [envelope.space, envelope.id, envelope.from, envelope.to]) assertId(value);
  if (envelope.v !== 1 || !['mailbox', 'stream'].includes(envelope.chan)) throw new RelayError('invalid_envelope');
  if (envelope.space !== principal.space || envelope.from !== principal.device || envelope.epoch !== principal.epoch) {
    throw new RelayError('sender_mismatch');
  }
  if (envelope.expiresAt !== null && (!Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt < 0)) {
    throw new RelayError('invalid_deadline');
  }
  if (envelope.chan === 'stream' && envelope.expiresAt === null) throw new RelayError('deadline_required');
  for (const value of [envelope.body, envelope.sig]) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxBytes * 2 ||
        Buffer.from(value, 'base64').toString('base64') !== value) throw new RelayError('invalid_encoding');
  }
  const bytes = Buffer.byteLength(JSON.stringify(envelope));
  if (bytes > maxBytes) throw new RelayError('message_too_large');
  return bytes;
}

/** Stable field order also prevents extra caller properties from entering relay storage. */
export function encodeEnvelope(value: RelayEnvelope): string {
  return JSON.stringify({v: value.v, space: value.space, id: value.id, from: value.from, to: value.to,
    chan: value.chan, epoch: value.epoch, expiresAt: value.expiresAt, body: value.body, sig: value.sig});
}
