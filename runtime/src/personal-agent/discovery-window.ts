/** Many-to-one pooling for source evidence: arrivals gather until the stream goes quiet or the cap passes. */
export class DiscoveryWindow {
  readonly #quietMs: number
  readonly #maxMs: number
  readonly #fire: () => void | Promise<void>
  #timer: NodeJS.Timeout | undefined
  #openedAt = 0

  constructor(options: {readonly quietMs: number; readonly maxMs: number; readonly fire: () => void | Promise<void>}) {
    this.#quietMs = options.quietMs
    this.#maxMs = options.maxMs
    this.#fire = options.fire
  }

  get pending(): boolean { return this.#timer !== undefined }

  /** New evidence arrived: fire after `quietMs` of silence, but never later than `maxMs` after the first arrival. */
  touch(): void | Promise<void> {
    // No pooling: the caller owns the outcome, so a discovery failure reaches it as before.
    if (this.#quietMs <= 0) return this.#fire()
    const now = Date.now()
    if (this.#timer === undefined) this.#openedAt = now
    else clearTimeout(this.#timer)
    const wait = Math.max(0, Math.min(this.#quietMs, this.#openedAt + this.#maxMs - now))
    this.#timer = setTimeout(() => { this.#timer = undefined; void Promise.resolve(this.#fire()).catch(() => { /* optional; nobody awaits a timer */ }) }, wait)
    this.#timer.unref()
  }

  cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
