import type * as LocalInference from '@livekit/local-inference'
import type {LiveKitExecutor} from './endpointing-capability.js'

// The native package owns a process-wide model singleton and runs predict on
// libuv's worker pool. Standalone Nova hosts do not have a LiveKit JobContext.
// Keep loading lazy so unsupported hosts can still use silence endpointing.
let native: Promise<typeof LocalInference> | undefined

export const localEotExecutor: LiveKitExecutor = {
  async doInference(method: string, data: unknown): Promise<unknown> {
    if (method !== 'lk_eot_audio' || typeof data !== 'object' || data === null
      || !('pcm' in data) || typeof data.pcm !== 'string') {
      throw new TypeError('invalid local EOT request')
    }
    const bytes = Buffer.from(data.pcm, 'base64')
    if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.length > 19_200 * 2) {
      throw new RangeError('invalid local EOT audio length')
    }
    const pcm = new Int16Array(bytes.length / 2)
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = bytes.readInt16LE(index * 2)
    try {
      native ??= import('@livekit/local-inference')
      const model = await native
      const started = performance.now()
      const probability = await model.predict(pcm)
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error('invalid local EOT probability')
      }
      return {probability, inferenceDurationMs: performance.now() - started}
    } catch (cause) {
      throw Object.assign(new Error('local EOT model unavailable', {cause}), {code: 'model_unavailable'})
    }
  },
}
