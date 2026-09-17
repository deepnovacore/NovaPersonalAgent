import {randomUUID} from 'node:crypto'
import {abortable} from '../core/camera-session.js'
import type {Clock} from '../core/clock.js'
import {
  CAMERA_HEIGHT,
  CAMERA_WIDTH,
  MAX_CAMERA_POSITION_MS,
} from '../desktop/desktop-camera.js'
import {
  DesktopCameraError,
  type CameraCaptureRequest,
  type CameraCaptureTransport,
  type CapturedCameraFrame,
} from '../desktop.js'
import {CameraError} from './camera.js'
import type {Frame, FrameSource, ObservationAdmission} from './watcher.js'

export type ChromiumCameraSource = 'local' | 'file'

export interface ChromiumFrameSourceOptions {
  readonly source: ChromiumCameraSource
  readonly transport: CameraCaptureTransport
  readonly clock: Clock
  readonly sessionId?: string
  readonly deviceId?: string
}

interface FileBackedChromiumFrameSource extends ChromiumFrameSource {
  readonly isFileBackedFrameSource: true
}

type SourceState = 'new' | 'started' | 'stopped'

const CAPTURE_UNAVAILABLE_MESSAGE = 'camera capture is unavailable'
const SOURCE_UNAVAILABLE_MESSAGE = 'camera source is unavailable'

/**
 * Pull-shaped Chromium capture with one serialized lifecycle/playhead boundary.
 *
 * The source is restartable after stop, matching Python's non-terminal frame-source lifecycle.
 * Its start is deliberately lazy: the authenticated transport is touched only by snapshot.
 */
export class ChromiumFrameSource implements FrameSource {
  readonly #source: ChromiumCameraSource
  readonly #transport: CameraCaptureTransport
  readonly #clock: Clock
  readonly #sessionId: string | undefined
  readonly #deviceId: string
  #children = new Set<ChromiumFrameSource>()
  #parent: ChromiumFrameSource | undefined
  #controller = new AbortController()
  #state: SourceState = 'new'
  #epoch: number | undefined
  #operationTail: Promise<void> = Promise.resolve()

  constructor(options: ChromiumFrameSourceOptions) {
    if (options.source !== 'local' && options.source !== 'file') {
      throw new CameraError(SOURCE_UNAVAILABLE_MESSAGE)
    }
    this.#source = options.source
    this.#transport = options.transport
    this.#clock = options.clock
    this.#sessionId = options.sessionId
    this.#deviceId = options.deviceId ?? ''
  }

  get isFileBackedFrameSource(): boolean {
    return this.#source === 'file'
  }

  start(): Promise<void> {
    return this.#serialize(() => {
      if (this.#state === 'started') return
      this.#controller = new AbortController()
      this.#state = 'started'
      this.#epoch = undefined
    })
  }

  stop(): Promise<void> {
    this.#controller.abort()
    const children = [...this.#children].map(child => child.stop())
    return this.#serialize(async () => {
      await Promise.all(children)
      if (this.#parent) this.#parent.#children.delete(this)
      if (this.#state !== 'started') return
      if (this.#sessionId) await this.#transport.releaseCamera?.(this.#sessionId)
      this.#state = 'stopped'
      this.#epoch = undefined
    })
  }

  openSession(deviceId: string, signal: AbortSignal, purpose: 'conversation' | 'monitor' = 'monitor'): Promise<FrameSource> {
    signal.throwIfAborted()
    const session = new ChromiumFrameSource({source: this.#source, transport: this.#transport, clock: this.#clock,
      sessionId: `${purpose}-${randomUUID()}`, deviceId})
    session.#parent = this
    this.#children.add(session)
    return Promise.resolve(session)
  }

  snapshot(signal?: AbortSignal): Promise<Frame> {
    return this.#serialize(async () => {
      this.#requireStarted()
      signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal
      signal.throwIfAborted()
      const request = this.#captureRequest()
      let captured: CapturedCameraFrame
      try {
        captured = await (signal ? abortable(this.#transport.captureCamera(request), signal) : this.#transport.captureCamera(request))
      } catch (error) {
        if (error instanceof DesktopCameraError) {
          throw new CameraError(CAPTURE_UNAVAILABLE_MESSAGE)
        }
        throw error
      }
      const payload = validateCapturedFrame(captured)
      const capturedAt = readClock(this.#clock)
      return {
        payload,
        media_type: 'image/jpeg',
        width: CAMERA_WIDTH,
        height: CAMERA_HEIGHT,
        captured_at: capturedAt,
      }
    })
  }

  restart(): Promise<void> {
    return this.#serialize(() => {
      this.#requireStarted()
      if (this.#source === 'local') return
      this.#epoch = readClock(this.#clock)
    })
  }

  /** Admit a user-requested monitoring task before Watch/Guard publishes `armed`. */
  async admitObservation(): Promise<ObservationAdmission> {
    if (this.#source === 'file') return 'granted'
    if (this.#transport.requestCameraPermission === undefined) return 'unavailable'
    try {
      const status = await this.#transport.requestCameraPermission()
      if (
        status === 'granted'
        || status === 'denied'
        || status === 'restricted'
        || status === 'unavailable'
      ) return status
    } catch {
      // The authenticated desktop owner may disconnect while the OS prompt is open.
    }
    return 'unavailable'
  }

  #captureRequest(): CameraCaptureRequest {
    if (this.#source === 'local') return {source: 'local', ...(this.#sessionId ? {sessionId: this.#sessionId, deviceId: this.#deviceId} : {})}
    if (this.#epoch === undefined) {
      if (this.#sessionId) this.#epoch = readClock(this.#clock)
      return {source: 'file', positionMs: 0}
    }
    // Convert both timestamps before subtraction. This preserves the specified decimal
    // millisecond boundary (10.999 seconds -> 10_999) despite binary-float cancellation.
    const elapsedMs = Math.floor((readClock(this.#clock) * 1000) - (this.#epoch * 1000))
    const positionMs = Math.min(MAX_CAMERA_POSITION_MS, Math.max(0, elapsedMs))
    if (!Number.isInteger(positionMs)) {
      throw new TypeError('camera file position invariant is invalid')
    }
    return {source: 'file', positionMs}
  }

  #requireStarted(): void {
    if (this.#state !== 'started') throw new CameraError(SOURCE_UNAVAILABLE_MESSAGE)
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

export function isFileBackedChromiumFrameSource(
  source: ChromiumFrameSource,
): source is FileBackedChromiumFrameSource {
  return source.isFileBackedFrameSource === true
}

function validateCapturedFrame(frame: CapturedCameraFrame): Uint8Array {
  if (typeof frame !== 'object'
    || frame === null
    || !(frame.payload instanceof Uint8Array)
    || frame.media_type !== 'image/jpeg'
    || frame.width !== CAMERA_WIDTH
    || frame.height !== CAMERA_HEIGHT) {
    throw new TypeError('camera transport returned an invalid frame')
  }
  return new Uint8Array(frame.payload)
}

function readClock(clock: Clock): number {
  const value = clock.now()
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('camera clock must return a finite number')
  }
  return value
}
