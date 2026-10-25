import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import {abortable} from '../core/camera-session.js'
import {realtimeCapabilities} from './capabilities.js'
import {Pcm16Resampler} from './integrated-wire-profile.js'
import {responseTranscriptFinalSchema, MAX_REALTIME_PCM_BYTES, RealtimeProtocolError, realtimeIdentifierSchema, type RealtimeProvider, type RealtimeProviderEvent, type JsonObject} from './protocol.js'
import {webSocketRealtimeConnector} from './qwen-transport.js'
import type {RealtimeConnector, RealtimeSocket} from './transport.js'

export type NativeDuplexModel = 'minicpm-o' | 'personaplex'
export interface SglangNativeOptions {
  readonly model: NativeDuplexModel
  readonly url: string
  readonly apiKey?: string
  readonly voice?: string
  readonly instructions?: string
  readonly connector?: RealtimeConnector
}
const frameSchema = z.object({type:z.string()}).catchall(z.unknown())
const responseSchema = z.object({id:realtimeIdentifierSchema, status:z.enum(['completed','cancelled','failed']).optional()})
const fail = () => new RealtimeProtocolError('invalid SGLang native duplex stream')

export function validateNativeRealtimeUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new RealtimeProtocolError('invalid native realtime URL') }
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    || url.username || url.password || url.hash || url.search) throw new RealtimeProtocolError('native realtime requires wss or a loopback ws tunnel, without URL credentials')
  return url.toString()
}

/** SGLang native session dialect only. No synthetic VAD turns, user transcript or tool authority. */
export class SglangNativeDuplexAdapter implements RealtimeProvider {
  readonly userResponseMode = 'automatic' as const
  readonly responseAdaptationMode = 'session_setup' as const
  readonly capabilities
  readonly #options: SglangNativeOptions
  readonly #resampler = new Pcm16Resampler(16000, 24000)
  #socket: RealtimeSocket | undefined
  #controller = new AbortController()
  #epoch = 0
  #seq = 0
  #ended = false
  #reading = false
  #connecting = false
  #response: string | undefined
  #sendTail: Promise<void> = Promise.resolve()

  constructor(options: SglangNativeOptions) {
    this.#options = {...options, url:validateNativeRealtimeUrl(options.url)}
    this.capabilities = realtimeCapabilities[options.model === 'personaplex' ? 'sglang-personaplex' : 'sglang-minicpm-o']
    if (options.model === 'minicpm-o' && options.voice) throw new RealtimeProtocolError('MiniCPM voice must be configured on the server')
  }

  async connect(options: {tools:readonly JsonObject[]; signal:AbortSignal}) {
    if (this.#socket || this.#connecting || options.tools.length) throw new RealtimeProtocolError('native duplex accepts no tools or overlapping connections')
    this.#connecting = true
    this.#controller = new AbortController()
    this.#seq = 0; this.#ended = false; this.#response = undefined; this.#sendTail = Promise.resolve(); this.#resampler.reset()
    const signal = AbortSignal.any([options.signal, this.#controller.signal, AbortSignal.timeout(15000)])
    try {
      this.#socket = await (this.#options.connector ?? webSocketRealtimeConnector)({
        endpoint:this.#options.url,
        headers:this.#options.apiKey ? {Authorization:`Bearer ${this.#options.apiKey}`} : {},
        openTimeout:15, signal,
      })
      const created = await this.#receive(signal)
      if (created.type !== 'session.created') throw fail()
      const session = z.object({id:realtimeIdentifierSchema}).parse(created.session)
      await this.#send({type:'session.update', session:{
        output_modalities:['audio'],
        ...(this.#options.instructions ? {instructions:this.#options.instructions} : {}),
        ...(this.#options.voice ? {sglang:{voice:this.#options.voice}} : {}),
      }}, signal)
      if ((await this.#receive(signal)).type !== 'session.updated') throw fail()
      return {epoch:++this.#epoch, provider_session_id:session.id}
    } catch {
      await this.close()
      throw new RealtimeProtocolError('SGLang native duplex handshake failed')
    } finally { this.#connecting = false }
  }

  sendAudio(pcm: Uint8Array, signal: AbortSignal): Promise<void> {
    if (!pcm.length || pcm.length % 2 || pcm.length > MAX_REALTIME_PCM_BYTES) return Promise.reject(fail())
    const owned = pcm.slice()
    return this.#serial(async () => {
      signal.throwIfAborted()
      if (this.#ended) throw new RealtimeProtocolError('native input already ended')
      const audio = this.#options.model === 'personaplex' ? this.#resampler.convert(owned) : owned
      await this.#send({type:'input_audio_buffer.append', audio:Buffer.from(audio).toString('base64'), sglang:{seq:this.#seq++}}, signal)
    })
  }

  /** End the continuous input timeline; events drains through response.done before session.close. */
  endInput(signal: AbortSignal): Promise<void> {
    return this.#serial(async () => {
      if (this.#ended) throw new RealtimeProtocolError('native input already ended')
      this.#ended = true
      await this.#send({type:'sglang.input_audio.end'}, signal)
    })
  }

  async *events(signal: AbortSignal): AsyncGenerator<RealtimeProviderEvent> {
    if (this.#reading || !this.#socket) throw fail()
    this.#reading = true
    const owner = this.#controller
    const readSignal = AbortSignal.any([signal, owner.signal])
    const epoch = this.#epoch
    try {
      while (!readSignal.aborted) {
        const frame = await this.#receive(readSignal)
        if (frame.type === 'response.created') {
          if (this.#response) throw fail()
          this.#response = z.object({id:realtimeIdentifierSchema}).parse(frame.response).id
          yield {kind:'response_started', session_epoch:epoch, response_id:this.#response, origin:{kind:'unknown'}}
        } else if (frame.type === 'response.output_audio.delta' || frame.type === 'response.output_audio_transcript.delta') {
          const id = realtimeIdentifierSchema.parse(frame.response_id)
          if (id !== this.#response) throw fail()
          if (frame.type === 'response.output_audio.delta') {
            const data = z.string().min(4).max(4*1024*1024).parse(frame.delta)
            const pcm = Buffer.from(data, 'base64')
            if (!pcm.length || pcm.length % 2 || pcm.toString('base64') !== data) throw fail()
            yield {kind:'response_audio_delta', session_epoch:epoch, response_id:id, pcm}
          } else {
            const text = z.string().min(1).max(4000).parse(frame.delta)
            yield {kind:'response_transcript_delta', session_epoch:epoch, response_id:id, text}
          }
        } else if (frame.type === 'response.output_audio_transcript.done') {
          const id = realtimeIdentifierSchema.parse(frame.response_id)
          if (id !== this.#response) throw fail()
          const {text} = responseTranscriptFinalSchema.parse({kind:'response_transcript_final',session_epoch:epoch,response_id:id,text:frame.transcript})
          if (text) yield {kind:'response_transcript_final', session_epoch:epoch, response_id:id, text}
        } else if (frame.type === 'response.done') {
          const response = responseSchema.parse(frame.response)
          if (response.id !== this.#response || !response.status) throw fail()
          yield {kind:'response_terminal', session_epoch:epoch, response_id:response.id, status:response.status, reason:'native_response_done'}
          this.#response = undefined
        } else if (frame.type === 'sglang.input_audio.drained') {
          if (!this.#ended || this.#response) throw fail()
          await this.#send({type:'session.close'}, readSignal)
          return
        } else if (frame.type === 'error' || frame.type.includes('function_call')) {
          throw fail()
        }
      }
    } catch {
      if (!readSignal.aborted) yield {kind:'provider_error', session_epoch:epoch, code:'native_stream_failed', recoverable:false}
    } finally {
      this.#reading = false
      if (this.#controller === owner) await this.close()
    }
  }

  injectHostItem(): Promise<never> { return Promise.reject(new RealtimeProtocolError('native conversation items unavailable')) }
  createResponse(): Promise<never> { return Promise.reject(new RealtimeProtocolError('native client responses unavailable')) }
  cancelResponse(): Promise<never> { return Promise.reject(new RealtimeProtocolError('native response cancellation unavailable; close the session to stop')) }
  async close(): Promise<void> {
    this.#controller.abort()
    const socket = this.#socket; this.#socket = undefined
    if (socket) await abortable(socket.close(), AbortSignal.timeout(3000)).catch(() => undefined)
  }
  #serial(operation: () => Promise<void>): Promise<void> {
    const owner = this.#controller
    const pending = this.#sendTail.then(() => {
      if (owner !== this.#controller || owner.signal.aborted) throw new RealtimeProtocolError('stale native session operation')
      return operation()
    })
    this.#sendTail = pending.catch(() => undefined)
    return pending
  }
  async #send(frame: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.#socket) throw fail()
    try {
      await abortable(this.#socket.send(JSON.stringify({event_id:randomUUID(), ...frame})), AbortSignal.any([signal,this.#controller.signal,AbortSignal.timeout(10000)]))
    } catch { await this.close(); throw new RealtimeProtocolError('native audio delivery failed; session closed') }
  }
  async #receive(signal: AbortSignal) {
    if (!this.#socket) throw fail()
    const raw = await abortable(this.#socket.receive(), signal)
    if (raw.length > 6*1024*1024) throw fail()
    return frameSchema.parse(JSON.parse(raw))
  }
}
