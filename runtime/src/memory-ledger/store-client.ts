import type {MemoryOperation} from '../memory-substrate/store.js'
import {AsyncLocalStorage} from 'node:async_hooks'
import { Worker, type WorkerOptions } from 'node:worker_threads'

import type {MemoryLedgerStoreErrorCode} from './store.js'
import {hasOnlyKeys, isRecord} from '../core/guards.js'

export interface MemoryLedgerWorker {
  postMessage(value: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

export interface MemoryLedgerClientOptions {
  readonly memoryLockWaitMs?: number
  readonly workerFactory?: (url: URL, options: WorkerOptions) => MemoryLedgerWorker
}

export type MemoryLedgerClientErrorCode =
  | MemoryLedgerStoreErrorCode
  | 'CLIENT_CLOSED'
  | 'WORKER_ERROR'
  | 'WORKER_EXITED'
  | 'WORKER_PROTOCOL_FAILURE'
  /** A stuck in-flight read was abandoned and the worker was replaced. */
  | 'WORKER_RECYCLED'
  /** The caller's signal aborted this request. */
  | 'REQUEST_ABORTED'

const clientErrorMessages: Readonly<Record<MemoryLedgerClientErrorCode, string>> = {
  CLIENT_CLOSED: 'memory ledger store client is closed',
  WORKER_ERROR: 'memory ledger worker failed',
  WORKER_EXITED: 'memory ledger worker exited',
  WORKER_PROTOCOL_FAILURE: 'memory ledger worker protocol failure',
  WORKER_RECYCLED: 'memory ledger worker was replaced after a stuck request',
  REQUEST_ABORTED: 'memory ledger request was aborted',
  STORE_ALREADY_OPEN: 'memory ledger store is already open',
  STORE_CLOSED: 'memory ledger store is closed',
  STORE_IDEMPOTENCY_CONFLICT: 'memory ledger observation replay conflict',
  STORE_INVALID_CARD: 'invalid memory ledger card',
  STORE_INVALID_OBSERVATION: 'invalid memory ledger observation',
  STORE_INVALID_RELATION: 'invalid memory ledger relation',
  STORE_MIGRATION_FAILED: 'memory ledger schema migration failed',
  STORE_NOT_FOUND: 'memory ledger record was not found',
  STORE_INVALID_OPERATION: 'memory ledger operation is invalid',
  STORE_PURGED_ID: 'memory identifier was permanently purged',
  STORE_STATED_EVIDENCE_REQUIRED: 'stated memory requires trusted user evidence',
  STORE_OPERATION_CONFLICT: 'memory ledger operation replay conflict',
  STORE_READ_FAILED: 'memory ledger read failed',
  STORE_SCHEMA_UNSUPPORTED: 'memory ledger schema version is unsupported',
  STORE_SENSITIVE_CONTENT_REJECTED: 'memory ledger sensitive content was rejected',
  STORE_SENSITIVE_PATH_DENIED: 'memory ledger sensitive path was denied',
  STORE_STALE_REVISION: 'memory ledger revision is stale',
  STORE_MEMORY_CONFLICT: 'memory documents conflict; user edits were preserved',
  STORE_WRITE_FAILED: 'memory ledger write failed',
}

export class MemoryLedgerClientError extends Error {
  readonly code: MemoryLedgerClientErrorCode

  constructor(code: MemoryLedgerClientErrorCode) {
    super(clientErrorMessages[code])
    this.name = 'MemoryLedgerClientError'
    this.code = code
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: MemoryLedgerClientError) => void
  readonly validateResult: RpcResultValidator<unknown>
}

type RpcResultValidator<Result> = (value: unknown) => Result

interface WorkerSuccess {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: true
  readonly result: unknown
}

interface WorkerFailure {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: false
  readonly error_code: MemoryLedgerStoreErrorCode
}

type WorkerResponse = WorkerSuccess | WorkerFailure

const nullResult: RpcResultValidator<void> = value => {
  if (value !== null) throw new TypeError('invalid null RPC result')
}

/**
 * The worker serves one synchronous request at a time, so whatever reaches it first is served first.
 * Requests are held here instead and the most urgent waiting request is sent next: a conversation read
 * with a hard budget waits for at most the request already in service, never for a backlog of indexing.
 */
export type MemoryRequestPriority = 'interactive' | 'background'
const priorityRank = {interactive: 0, normal: 1, background: 2, close: 3} as const
const backgroundContext = new AsyncLocalStorage<true>()

/** Memory requests issued anywhere inside `work`, including after awaits, yield to everything else. */
export function runInMemoryBackground<T>(work: () => T): T {
  return backgroundContext.run(true, work)
}

interface QueuedRequest {
  readonly requestId: number
  readonly rank: number
  readonly message: Readonly<Record<string, unknown>>
}

/** A synchronous worker op cannot be cancelled; after this grace the worker is replaced instead. */
const STUCK_GRACE_MS = 30_000
const CLOSE_TIMEOUT_MS = 5_000

export class MemoryLedgerClient {
  readonly #workerFactory: (url: URL, options: WorkerOptions) => MemoryLedgerWorker
  readonly #workerUrl = new URL('./store-worker.js', import.meta.url)
  readonly #workerData: {
    readonly path: string
    readonly memoryLockWaitMs?: number
  }
  #worker: MemoryLedgerWorker
  readonly #pending = new Map<number, PendingRequest>()
  readonly #queue: QueuedRequest[] = []
  #inService: number | null = null
  readonly #dropped = new Set<number>()
  #abandonedInService: number | null = null
  #recycleTimer: ReturnType<typeof setTimeout> | null = null
  #reopenTimer: ReturnType<typeof setTimeout> | null = null
  #recycleFailures = 0
  #nextRequestId = 1
  #failed = false
  #closed = false
  #expectedExit = false
  #closing: Promise<void> | null = null
  #opening: Promise<void> | null = null

  constructor(path: string, options: MemoryLedgerClientOptions = {}) {
    this.#workerData = {
      path,
      ...(options.memoryLockWaitMs === undefined ? {} : {memoryLockWaitMs: options.memoryLockWaitMs}),
    }
    this.#workerFactory = options.workerFactory
      ?? ((url: URL, configured: WorkerOptions) => new Worker(url, configured))
    this.#worker = this.#spawnWorker()
  }

  memory(operation: MemoryOperation, input: unknown, options: {readonly priority?: MemoryRequestPriority; readonly signal?: AbortSignal} = {}): Promise<unknown> {
    const priority = options.priority ?? (backgroundContext.getStore() ? 'background' : 'normal')
    return this.#request('memory', {memoryOperation: operation, input}, value => value, priorityRank[priority], options.signal)
  }

  async open(): Promise<void> {
    if (this.#closed || this.#failed) throw new MemoryLedgerClientError('CLIENT_CLOSED')
    this.#opening ??= this.#request('open', {}, nullResult).catch((error: unknown) => {
      // A transient open failure must not memoize a dead client; the next admission retries.
      this.#opening = null
      throw error
    })
    await this.#opening
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing
    if (this.#closed) return Promise.resolve()
    const operation = this.#closeFresh()
    this.#closing = operation
    return operation
  }

  async #closeFresh(): Promise<void> {
    this.#closed = true
    if (this.#recycleTimer !== null) {
      clearTimeout(this.#recycleTimer)
      this.#recycleTimer = null
    }
    if (this.#reopenTimer !== null) {
      clearTimeout(this.#reopenTimer)
      this.#reopenTimer = null
    }
    // An abandoned in-service op will never free its slot; do not wait for a close RPC behind it.
    const abandonedInService = this.#inService !== null && this.#dropped.has(this.#inService)
    this.#abandonedInService = null
    if (!this.#failed && !abandonedInService) {
      // Drain queued work and its lock cleanup before termination; bound a stuck worker.
      await Promise.race([
        this.#requestWhileClosing('close', {}, nullResult).catch(() => undefined),
        new Promise<void>(resolve => { const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); timer.unref?.() }),
      ])
    }
    this.#dropped.clear()
    this.#expectedExit = true
    try {
      await this.#worker.terminate()
    } catch {
      // A worker that already exited is closed for client lifecycle purposes.
    }
    this.#rejectAll(new MemoryLedgerClientError('CLIENT_CLOSED'))
  }

  #request<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
    rank: number = priorityRank.normal,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (this.#closed || this.#failed) {
      return Promise.reject(new MemoryLedgerClientError('CLIENT_CLOSED'))
    }
    return this.#send(operation, payload, validateResult, rank, signal)
  }

  #requestWhileClosing<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
  ): Promise<Result> {
    if (this.#failed) return Promise.reject(new MemoryLedgerClientError('CLIENT_CLOSED'))
    // Nothing is accepted once closing starts, so the lowest rank makes close the last request served.
    return this.#send(operation, payload, validateResult, priorityRank.close)
  }

  #send<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
    rank: number,
    signal?: AbortSignal,
  ): Promise<Result> {
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1
    const message = {kind: 'request', request_id: requestId, operation, ...payload} as const
    let detach = (): void => { /* nothing to detach without a caller signal */ }
    const promise = new Promise<Result>((resolve, reject) => {
      this.#pending.set(requestId, {resolve: value => resolve(value as Result), reject, validateResult})
      // Stable: equal ranks keep arrival order.
      const at = this.#queue.findIndex(queued => queued.rank > rank)
      this.#queue.splice(at < 0 ? this.#queue.length : at, 0, {requestId, rank, message})
      const onAbort = () => {
        if (!this.#pending.has(requestId)) return
        this.#pending.delete(requestId)
        reject(new MemoryLedgerClientError('REQUEST_ABORTED'))
        const queuedIndex = this.#queue.findIndex(queued => queued.requestId === requestId)
        if (queuedIndex >= 0) {
          this.#queue.splice(queuedIndex, 1)
          return
        }
        // The worker is synchronous: mark the response as dropped and replace the worker if it
        // still has not answered after the grace period, so the next read is not stuck behind it.
        if (this.#inService === requestId) {
          this.#dropped.add(requestId)
          this.#abandonedInService = requestId
          this.#armRecycleTimer()
        }
      }
      signal?.addEventListener('abort', onAbort, {once: true})
      detach = () => signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted === true) onAbort()
      this.#dispatch()
    })
    return signal === undefined ? promise : promise.finally(detach)
  }

  #armRecycleTimer(): void {
    if (this.#recycleTimer !== null) return
    this.#recycleTimer = setTimeout(() => {
      this.#recycleTimer = null
      if (this.#abandonedInService === null || this.#closed) return
      this.#recycleWorker('WORKER_RECYCLED')
    }, STUCK_GRACE_MS)
    this.#recycleTimer.unref?.()
  }

  /** Replace a worker stuck on a synchronous op; the next `open()` re-establishes the store. */
  #recycleWorker(code: 'WORKER_ERROR' | 'WORKER_EXITED' | 'WORKER_RECYCLED'): void {
    if (this.#closed || this.#expectedExit) return
    const previous = this.#worker
    this.#abandonedInService = null
    if (this.#recycleTimer !== null) {
      clearTimeout(this.#recycleTimer)
      this.#recycleTimer = null
    }
    try {
      this.#worker = this.#spawnWorker()
    } catch {
      this.#fail('WORKER_ERROR')
      return
    }
    this.#opening = null
    this.#dropped.clear()
    this.#rejectAll(new MemoryLedgerClientError(code))
    void previous.terminate().catch(() => undefined)
    // The resource is opened once at assembly, so a replaced worker must reopen itself; otherwise
    // every later read would stay STORE_CLOSED for the rest of the process. A transient lock/sync
    // failure is retried with bounded backoff instead of waiting for a caller that never opens.
    this.#scheduleReopen(250)
  }

  #scheduleReopen(delayMs: number): void {
    if (this.#closed || this.#failed || this.#reopenTimer !== null) return
    this.#reopenTimer = setTimeout(() => {
      this.#reopenTimer = null
      if (this.#closed || this.#failed) return
      this.open().catch(() => this.#scheduleReopen(Math.min(5_000, delayMs * 2)))
    }, delayMs)
    this.#reopenTimer.unref?.()
  }

  #dispatch(): void {
    while (this.#inService === null && !this.#failed) {
      const next = this.#queue.shift()
      if (next === undefined) return
      try {
        this.#worker.postMessage(next.message)
        this.#inService = next.requestId
      } catch {
        this.#pending.get(next.requestId)?.reject(new MemoryLedgerClientError('WORKER_PROTOCOL_FAILURE'))
        this.#pending.delete(next.requestId)
      }
    }
  }

  #rejectAll(error: MemoryLedgerClientError): void {
    this.#queue.length = 0
    this.#inService = null
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #handleMessage(worker: MemoryLedgerWorker, message: unknown): void {
    if (worker !== this.#worker) return
    const response = parseWorkerResponse(message)
    if (response === undefined) {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    this.#recycleFailures = 0
    if (this.#dropped.delete(response.request_id)) {
      // An abandoned read finished late; free its service slot without delivering a result.
      if (this.#inService === response.request_id) this.#inService = null
      if (this.#abandonedInService === response.request_id) this.#abandonedInService = null
      this.#dispatch()
      return
    }
    const pending = this.#pending.get(response.request_id)
    if (pending === undefined || response.request_id !== this.#inService) {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    if (!response.ok) {
      this.#pending.delete(response.request_id)
      this.#inService = null
      pending.reject(new MemoryLedgerClientError(response.error_code))
      this.#dispatch()
      return
    }
    let result: unknown
    try {
      result = pending.validateResult(response.result)
    } catch {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    this.#pending.delete(response.request_id)
    this.#inService = null
    pending.resolve(result)
    this.#dispatch()
  }

  #fail(code: Extract<MemoryLedgerClientErrorCode, `WORKER_${string}`>): void {
    if (this.#failed || this.#expectedExit) return
    this.#failed = true
    this.#rejectAll(new MemoryLedgerClientError(code))
  }

  #spawnWorker(): MemoryLedgerWorker {
    const worker = this.#workerFactory(this.#workerUrl, {workerData: this.#workerData})
    worker.on('message', message => this.#handleMessage(worker, message))
    worker.on('error', () => this.#handleWorkerFailure(worker, 'WORKER_ERROR'))
    worker.on('exit', () => {
      if (!this.#expectedExit) this.#handleWorkerFailure(worker, 'WORKER_EXITED')
    })
    return worker
  }

  #handleWorkerFailure(
    worker: MemoryLedgerWorker,
    code: 'WORKER_ERROR' | 'WORKER_EXITED',
  ): void {
    if (worker !== this.#worker || this.#failed || this.#expectedExit) return
    if (this.#closed) {
      this.#rejectAll(new MemoryLedgerClientError(code))
      return
    }
    // Bound a crash loop (bad module, thread exhaustion) instead of respawning forever.
    if (this.#recycleFailures >= 3) {
      this.#fail('WORKER_ERROR')
      return
    }
    this.#recycleFailures += 1
    this.#recycleWorker(code)
  }
}

function parseWorkerResponse(message: unknown): WorkerResponse | undefined {
  if (
    !isRecord(message)
    || message.kind !== 'response'
    || !Number.isSafeInteger(message.request_id)
    || (message.request_id as number) <= 0
  ) {
    return undefined
  }
  if (message.ok === true && 'result' in message) {
    if (!hasOnlyKeys(message, ['kind', 'request_id', 'ok', 'result'])) return undefined
    return {kind: 'response', request_id: message.request_id as number, ok: true, result: message.result}
  }
  if (message.ok === false && isStoreErrorCode(message.error_code)) {
    if (!hasOnlyKeys(message, ['kind', 'request_id', 'ok', 'error_code'])) return undefined
    return {
      kind: 'response',
      request_id: message.request_id as number,
      ok: false,
      error_code: message.error_code,
    }
  }
  return undefined
}

function isStoreErrorCode(value: unknown): value is MemoryLedgerStoreErrorCode {
  return typeof value === 'string' && value in clientErrorMessages && value.startsWith('STORE_')
}
