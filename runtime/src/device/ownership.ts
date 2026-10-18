// Rejections throw OwnershipError with a device-contract glossary code; functions never mutate inputs.
export class OwnershipError extends Error {
  constructor(readonly code: 'request_conflict' | 'owner_mismatch' | 'dedup_capacity' | 'stale_fence') {
    super(code)
  }
}
export interface RequestIdentity { principal: string; device_id: string; request_id: string }
export interface Ownership { task_id: string; owner: string; lease_expired: boolean }
export interface SessionOwnership { id: string; owner: string; generation: number; context_version: number }
export interface Receipt { id: string; request_key: string; payload_digest: string; status: string }
export interface ReceiptState { capacity: number; receipts: Receipt[] }

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function int53(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }

export function encodeIdentity(identity: RequestIdentity): string {
  const values = [identity.principal, identity.device_id, identity.request_id]
  if (!values.every(nonempty)) throw new OwnershipError('request_conflict')
  return JSON.stringify(values)
}
export function decodeIdentity(key: string): RequestIdentity {
  let values: unknown
  try { values = JSON.parse(key) } catch { throw new OwnershipError('request_conflict') }
  if (!Array.isArray(values) || values.length !== 3 || !values.every(nonempty))
    throw new OwnershipError('request_conflict')
  const identity = {principal: values[0]!, device_id: values[1]!, request_id: values[2]!}
  if (encodeIdentity(identity) !== key) throw new OwnershipError('request_conflict')
  return identity
}

// Hash these canonical bytes at the host boundary; digests are supplied, not generated here.
export function canonicalPayload(value: unknown): string {
  const ancestors = new Set<object>()
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item)
    if (typeof item !== 'object' || item === null || ancestors.has(item))
      throw new OwnershipError('request_conflict')
    ancestors.add(item)
    try {
      if (Array.isArray(item)) return '[' + Array.from(item, encode).join(',') + ']'
      if (Object.getPrototypeOf(item) !== Object.prototype || Object.getOwnPropertySymbols(item).length)
        throw new OwnershipError('request_conflict')
      const record = item as Record<string, unknown>
      return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + encode(record[key])).join(',') + '}'
    } finally { ancestors.delete(item) }
  }
  try { return encode(value) } catch { throw new OwnershipError('request_conflict') }
}
export function expireLease(state: Ownership): Ownership { return {...state, lease_expired: true} }
export function requireOwner(state: Ownership, deviceId: string): void {
  if (!nonempty(deviceId) || state.owner !== deviceId) throw new OwnershipError('owner_mismatch')
}
export function processInput(state: SessionOwnership, deviceId: string, generation: number, contextVersion: number): SessionOwnership {
  if (!nonempty(deviceId) || state.owner !== deviceId) throw new OwnershipError('owner_mismatch')
  if (!int53(generation) || !int53(contextVersion) || state.generation !== generation
    || state.context_version !== contextVersion || contextVersion === Number.MAX_SAFE_INTEGER)
    throw new OwnershipError('stale_fence')
  return {...state, context_version: contextVersion + 1}
}
export function recordReceipt(state: ReceiptState, identity: RequestIdentity, payloadDigest: string, receipt: Pick<Receipt, 'id' | 'status'>): {state: ReceiptState; receipt: Receipt; replayed: boolean} {
  const key = encodeIdentity(identity)
  if (!int53(state.capacity)) throw new OwnershipError('dedup_capacity')
  if (!nonempty(payloadDigest) || !nonempty(receipt.id) || !nonempty(receipt.status)) throw new OwnershipError('request_conflict')
  const existing = state.receipts.find(item => item.request_key === key)
  if (existing) {
    if (existing.payload_digest !== payloadDigest) throw new OwnershipError('request_conflict')
    return {state, receipt: existing, replayed: true}
  }
  if (state.receipts.length >= state.capacity) throw new OwnershipError('dedup_capacity')
  const recorded = {...receipt, request_key: key, payload_digest: payloadDigest}
  return {state: {...state, receipts: [...state.receipts, recorded]}, receipt: recorded, replayed: false}
}
