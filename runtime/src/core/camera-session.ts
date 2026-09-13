import {validateOriginalImage} from '../realtime/cascaded/llm.js'
import type {MediaStore} from './media-store.js'
import type {Frame, FrameSource} from '../executors/watcher.js'

/** An abort wins immediately even when an OS/provider operation completes late. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled')) }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'))
    signal.addEventListener('abort', abort, {once: true})
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
  })
}

export async function captureConversationFrame(source: FrameSource, signal: AbortSignal, mediaStore?: MediaStore): Promise<Frame> {
  if (!source.openSession) throw new Error('camera sessions unavailable')
  const session = await source.openSession('', signal, 'conversation')
  try {
    await abortable(session.start(), signal)
    if (session.admitObservation && await abortable(session.admitObservation(), signal) !== 'granted') throw new Error('camera permission denied')
    const frame = await abortable(session.snapshot(signal), signal)
    if (!frame) throw new Error('camera frame unavailable')
    validateOriginalImage(frame)
    return mediaStore?.put(frame.payload, {mediaType:frame.media_type,width:frame.width,height:frame.height,capturedAt:frame.captured_at}) ?? frame
  } finally { await session.stop() }
}
