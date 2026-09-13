import type {Clock} from './clock.js'

interface Pending<Kind, Payload> {
  readonly kind: Kind
  readonly payload: Payload
  readonly onExpire: (kind: Kind, payload: Payload) => void
  expiresAt: number
  held: boolean
  abort: AbortController
}

/** One active deadline. Domain controllers own FIFO selection, decisions and authorization. */
export class PendingDecision<Kind, Payload extends object> {
  #current: Pending<Kind, Payload> | null = null

  constructor(private readonly clock: Clock) {}

  offer(kind: Kind, payload: Payload, expiresAt: number, onExpire: (kind: Kind, payload: Payload) => void): Payload | null {
    const displaced = this.#current
    if (displaced !== null) this.consume(displaced.payload)
    const entry = {kind, payload, expiresAt, onExpire, held: false, abort: new AbortController()}
    this.#current = entry
    void this.#wait(entry, entry.abort.signal)
    return displaced?.payload ?? null
  }

  hold(payload: Payload): boolean {
    const entry = this.#current
    if (entry?.payload !== payload || entry.held) return false
    entry.held = true
    entry.abort.abort()
    return true
  }

  release(payload: Payload, expiresAt: number): boolean {
    const entry = this.#current
    if (entry?.payload !== payload || !entry.held) return false
    entry.held = false
    entry.expiresAt = expiresAt
    entry.abort = new AbortController()
    void this.#wait(entry, entry.abort.signal)
    return true
  }

  consume(payload: Payload): boolean {
    const entry = this.#current
    if (entry?.payload !== payload) return false
    this.#current = null
    entry.abort.abort()
    return true
  }

  expire(payload: Payload): boolean {
    const entry = this.#current
    if (entry?.payload !== payload || entry.held || this.clock.now() < entry.expiresAt) return false
    this.consume(payload)
    entry.onExpire(entry.kind, payload)
    return true
  }

  async #wait(entry: Pending<Kind, Payload>, signal: AbortSignal): Promise<void> {
    do {
      try { await this.clock.sleep(Math.max(0, entry.expiresAt - this.clock.now()), signal) }
      catch { return /* Replaced, held or consumed by its controller. */ }
      if (signal.aborted || this.#current !== entry || entry.held) return
    } while (!this.expire(entry.payload))
  }
}
