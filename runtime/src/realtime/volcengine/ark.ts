import {selfHostedEndpoint} from '../../config/self-hosted.js'
import {abortable} from '../../core/camera-session.js'
import {translateSystemPrompt, type PromptLanguage} from '../prompt-language.js'
import {randomUUID} from 'node:crypto'
import {reportUsage, type UsageReporter, type UsageReport} from '../usage.js'
import { jsonValueSchema, type JsonValue } from '../../core/events.js'
import { codePointLengthLikePython, stripLikePython } from '../../text/python-text.js'
import { MAX_REALTIME_TEXT, type JsonObject } from '../protocol.js'
import {llmStreamLimits,llmToolCallLimit,type LlmStreamLimits,type LlmTransportOptions} from '../cascaded/llm-stream-limits.js'

export const MAX_ARK_REQUEST_BYTES = 4 * 1_024 * 1_024
export const MAX_ARK_SSE_LINE_BYTES = 256 * 1_024
export const MAX_ARK_SSE_EVENT_BYTES = 512 * 1_024
export const MAX_ARK_RESPONSE_BYTES = 8 * 1_024 * 1_024
export const MAX_ARK_EVENTS = 4_096
export const DEFAULT_ARK_IDLE_TIMEOUT_MS = 30_000
export const DEFAULT_ARK_CLOSE_TIMEOUT_MS = 1_000

export type ArkResponsesFailureCode =
  | 'configuration'
  | 'aborted'
  | 'timeout'
  | 'protocol'
  | 'overflow'
  | 'closed'
  | 'network'
  | 'http'

export class ArkResponsesFailure extends Error {
  readonly code: ArkResponsesFailureCode
  readonly statusCode: number | null

  constructor(code: ArkResponsesFailureCode, statusCode: number | null = null) {
    super(`Ark Responses ${code} failure`)
    this.name = 'ArkResponsesFailure'
    this.code = code
    this.statusCode = statusCode
  }
}

export interface ArkResponseStarted {
  readonly kind: 'response_started'
  readonly response_id: string
}

export interface ArkTextDelta {
  readonly kind: 'text_delta'
  readonly text: string
}

export interface ArkToolCall {
  readonly kind: 'tool_call'
  readonly item_id: string
  readonly call_id: string
  readonly name: string
  readonly arguments: JsonObject
}

export interface ArkResponseCompleted {
  readonly outputItems?: readonly JsonObject[]
  readonly kind: 'response_completed'
  readonly response_id: string
}

export interface ArkResponseFailed {
  readonly kind: 'response_failed'
  readonly response_id: string
  readonly code: 'failed' | 'incomplete'
}

export type ArkEvent =
  | ArkResponseStarted
  | ArkTextDelta
  | ArkToolCall
  | ArkResponseCompleted
  | ArkResponseFailed

export interface ArkStreamInput {
  readonly language?: PromptLanguage
  readonly inputItems: readonly JsonObject[]
  readonly tools: readonly JsonObject[]
  readonly previousResponseId: string | null
  readonly workspaceContext?: string | null
  readonly responseAdaptation?: string | null
  readonly signal?: AbortSignal
  readonly textFormat?: JsonObject
  readonly maxOutputTokens?: number
}

export interface ArkResponsesGateway {
  stream(input: ArkStreamInput): AsyncIterable<ArkEvent>
  close(): Promise<void>
}

export interface FetchArkResponsesGatewayOptions extends LlmTransportOptions {
  readonly protocol?: 'ark' | 'openai-compatible'
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly instructions: string
  readonly onUsage?: UsageReporter
  readonly fetchImpl?: typeof globalThis.fetch
  readonly closeTimeoutMs?: number
}

interface ActiveStream {
  readonly controller: AbortController
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  failureCode: ArkResponsesFailureCode | null
  readonly done: Promise<void>
  readonly resolveDone: () => void
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && stripLikePython(value) !== ''
    && codePointLengthLikePython(value) <= MAX_REALTIME_TEXT
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    && jsonValueSchema.safeParse(value).success
}

function copyJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(copyJsonValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJsonValue(item)]))
  }
  return value
}

function copyJsonObject(value: JsonObject): JsonObject {
  return copyJsonValue(value) as JsonObject
}

function copyJsonObjects(values: readonly JsonObject[]): JsonObject[] {
  if (!Array.isArray(values)) throw new ArkResponsesFailure('protocol')
  return values.map(value => {
    if (!isJsonObject(value)) throw new ArkResponsesFailure('protocol')
    return copyJsonObject(value)
  })
}

function resolveResponsesEndpoint(baseUrl: string): string {
  try {
    const endpoint = new URL(baseUrl)
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/responses`
    return endpoint.toString()
  } catch {
    throw new ArkResponsesFailure('configuration')
  }
}

function abortActive(active: ActiveStream, code: ArkResponsesFailureCode): void {
  active.failureCode ??= code
  active.controller.abort()
  void active.reader?.cancel().catch(() => undefined)
}

async function boundedWait<T>(
  promise: Promise<T>,
  active: ActiveStream,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abortActive(active, 'timeout')
        reject(new ArkResponsesFailure('timeout'))
      }, timeoutMs)
    })
    const value = await abortable(Promise.race([promise, timed]), active.controller.signal)
    if (active.failureCode !== null) throw new ArkResponsesFailure(active.failureCode)
    return value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(left.byteLength + right.byteLength)
  combined.set(left)
  combined.set(right, left.byteLength)
  return combined
}

function copyReadableChunk(value: unknown): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) throw new ArkResponsesFailure('protocol')
  const copied = new Uint8Array(value.byteLength)
  copied.set(value)
  return copied
}

function normalizeProviderEvent(value: JsonObject): ArkEvent | null {
  const type = value.type
  if (typeof type !== 'string') throw new ArkResponsesFailure('protocol')

  if (type === 'response.output_text.delta') {
    const delta = value.delta
    if (typeof delta !== 'string' || codePointLengthLikePython(delta) > MAX_REALTIME_TEXT) {
      throw new ArkResponsesFailure('protocol')
    }
    return {kind: 'text_delta', text: delta}
  }

  if (type === 'response.output_item.done') {
    const item = value.item
    if (!isJsonObject(item)) throw new ArkResponsesFailure('protocol')
    if (item.type !== 'function_call') return null
    if (!validIdentifier(item.id) || !validIdentifier(item.call_id)
      || !validIdentifier(item.name) || typeof item.arguments !== 'string') {
      throw new ArkResponsesFailure('protocol')
    }
    let argumentsValue: unknown
    try {
      argumentsValue = JSON.parse(item.arguments)
    } catch {
      throw new ArkResponsesFailure('protocol')
    }
    if (!isJsonObject(argumentsValue)) throw new ArkResponsesFailure('protocol')
    return {
      kind: 'tool_call',
      item_id: item.id,
      call_id: item.call_id,
      name: item.name,
      arguments: copyJsonObject(argumentsValue),
    }
  }

  if (type === 'response.created' || type === 'response.completed'
    || type === 'response.failed' || type === 'response.incomplete') {
    const response = value.response
    if (!isJsonObject(response) || !validIdentifier(response.id)) {
      throw new ArkResponsesFailure('protocol')
    }
    if (type === 'response.created') {
      return {kind: 'response_started', response_id: response.id}
    }
    if (type === 'response.completed') {
      return {kind: 'response_completed', response_id: response.id}
    }
    return {
      kind: 'response_failed',
      response_id: response.id,
      code: type === 'response.failed' ? 'failed' : 'incomplete',
    }
  }
  return null
}

class FetchArkResponsesGateway implements ArkResponsesGateway {
  readonly #compatible: boolean
  readonly #onUsage: UsageReporter | undefined
  readonly #endpoint: string
  readonly #apiKey: string
  readonly #model: string
  readonly #instructions: string
  readonly #fetch: typeof globalThis.fetch
  readonly #idleTimeoutMs: number
  readonly #streamLimits:LlmStreamLimits
  readonly #toolCallLimit:number
  readonly #closeTimeoutMs: number
  readonly #active = new Set<ActiveStream>()
  #closed = false
  #closePromise: Promise<void> | null = null

  constructor(options: FetchArkResponsesGatewayOptions) {
    try{this.#streamLimits=llmStreamLimits(options);this.#toolCallLimit=llmToolCallLimit(options)}catch{throw new ArkResponsesFailure('configuration')}
    this.#compatible = options.protocol === 'openai-compatible'
    this.#onUsage = options.onUsage
    this.#endpoint = resolveResponsesEndpoint(this.#compatible ? selfHostedEndpoint(options.baseUrl,'http','OPENAI_COMPATIBLE_BASE_URL') : options.baseUrl)
    this.#apiKey = options.apiKey
    this.#model = options.model
    this.#instructions = options.instructions
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_ARK_IDLE_TIMEOUT_MS
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_ARK_CLOSE_TIMEOUT_MS
    if (!Number.isFinite(this.#idleTimeoutMs) || this.#idleTimeoutMs <= 0
      || !Number.isFinite(this.#closeTimeoutMs) || this.#closeTimeoutMs <= 0) {
      throw new ArkResponsesFailure('configuration')
    }
  }

  async *stream(input: ArkStreamInput): AsyncIterable<ArkEvent> {
    if (this.#closed) throw new ArkResponsesFailure('closed')
    if (input.signal?.aborted === true) throw new ArkResponsesFailure('aborted')
    const inputItems = copyJsonObjects(input.inputItems)
    const tools = copyJsonObjects(input.tools)
    if (input.previousResponseId !== null && !validIdentifier(input.previousResponseId)) {
      throw new ArkResponsesFailure('protocol')
    }
    const body = JSON.stringify({
      model: this.#model,
      instructions: [translateSystemPrompt(this.#instructions, input.language), input.workspaceContext, input.responseAdaptation]
        .filter((item): item is string => item !== null && item !== undefined)
        .join('\n\n'),
      input: inputItems,
      tools,
      parallel_tool_calls: this.#toolCallLimit>1,
      store: !this.#compatible,
      stream: true,
      ...(this.#compatible ? {include:['reasoning.encrypted_content']} : {thinking: {type:'disabled'}}),
      ...(input.textFormat ? {text:{format:input.textFormat}} : {}),
      ...(input.maxOutputTokens === undefined ? {} : {max_output_tokens:input.maxOutputTokens}),
      ...(this.#compatible || input.previousResponseId === null
        ? {}
        : {previous_response_id: input.previousResponseId}),
    })
    if (new TextEncoder().encode(body).byteLength > MAX_ARK_REQUEST_BYTES) {
      throw new ArkResponsesFailure('overflow')
    }

    let resolveDone: () => void = () => undefined
    const active: ActiveStream = {
      controller: new AbortController(),
      reader: null,
      failureCode: null,
      done: new Promise<void>(resolve => { resolveDone = resolve }),
      resolveDone: () => resolveDone(),
    }
    const onCallerAbort = (): void => abortActive(active, 'aborted')
    input.signal?.addEventListener('abort', onCallerAbort, {once: true})
    this.#active.add(active)

    const usageId = randomUUID()
    let usageReported = false
    try {
      let response: Response
      try {
        response = await boundedWait(this.#fetch(this.#endpoint, {
          method: 'POST',
          ...(this.#compatible ? {redirect:'error' as const} : {}),
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body,
          signal: active.controller.signal,
        }), active, this.#idleTimeoutMs)
      } catch (error) {
        if (error instanceof ArkResponsesFailure) throw error
        if (active.failureCode !== null) throw new ArkResponsesFailure(active.failureCode)
        throw new ArkResponsesFailure('network')
      }

      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined)
        throw new ArkResponsesFailure('http', response.status)
      }
      if (response.body === null
        || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        await response.body?.cancel().catch(() => undefined)
        throw new ArkResponsesFailure('protocol')
      }

      const reader = response.body.getReader()
      active.reader = reader
      let buffered = new Uint8Array(0)
      let aggregateBytes = 0
      let dataLines: string[] = []
      let dataBytes = 0
      let dispatchedEvents = 0
      let terminal = false
      const decoder = new TextDecoder('utf-8', {fatal: true})

      const handleLine = (bytes: Uint8Array): ArkEvent | null => {
        let lineBytes = bytes
        if (lineBytes.byteLength > 0 && lineBytes[lineBytes.byteLength - 1] === 13) {
          lineBytes = lineBytes.subarray(0, lineBytes.byteLength - 1)
        }
        if (lineBytes.byteLength > this.#streamLimits.lineBytes) {
          throw new ArkResponsesFailure('overflow')
        }
        let line: string
        try {
          line = decoder.decode(lineBytes)
        } catch {
          throw new ArkResponsesFailure('protocol')
        }
        if (line !== '') {
          if (line.startsWith(':')) return null
          const separator = line.indexOf(':')
          const field = separator < 0 ? line : line.slice(0, separator)
          let fieldValue = separator < 0 ? '' : line.slice(separator + 1)
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
          if (field === 'data') {
            const encoded = new TextEncoder().encode(fieldValue)
            dataBytes += encoded.byteLength + (dataLines.length === 0 ? 0 : 1)
            if (dataBytes > this.#streamLimits.eventBytes) {
              throw new ArkResponsesFailure('overflow')
            }
            dataLines.push(fieldValue)
          }
          return null
        }
        if (dataLines.length === 0) return null
        dispatchedEvents += 1
        if (dispatchedEvents > this.#streamLimits.events) throw new ArkResponsesFailure('overflow')
        const data = dataLines.join('\n')
        dataLines = []
        dataBytes = 0
        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          throw new ArkResponsesFailure('protocol')
        }
        if (!isJsonObject(parsed)) throw new ArkResponsesFailure('protocol')
        let event = normalizeProviderEvent(parsed)
        if(event?.kind==='response_completed') {
          const output=isJsonObject(parsed.response)?parsed.response.output:undefined
          if(Array.isArray(output)&&output.every(isJsonObject))event={...event,outputItems:copyJsonObjects(output)}
          else if(this.#compatible)throw new ArkResponsesFailure('protocol')
        }
        if (event?.kind === 'response_completed' || event?.kind === 'response_failed') {
          const response = isJsonObject(parsed.response) ? parsed.response : {}
          const usage = event.kind === 'response_completed' && isJsonObject(response.usage) ? response.usage : undefined
          const details = isJsonObject(usage?.input_tokens_details) ? usage.input_tokens_details : {}
          const outputDetails = isJsonObject(usage?.output_tokens_details) ? usage.output_tokens_details : {}
          reportUsage(this.#onUsage, {
            id: usageId, service: 'llm', provider: this.#compatible ? 'custom' : 'ark', model: this.#model,
            status: usage === undefined ? 'missing' : 'complete',
            ...(usage === undefined ? {} : {inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
              cachedTokens: details.cached_tokens, reasoningTokens: outputDetails.reasoning_tokens}),
          } as UsageReport)
          usageReported = true
        }
        return event
      }

      while (!terminal) {
        const result = await (async () => {
          try {
            return await boundedWait(reader.read(), active, this.#idleTimeoutMs)
          } catch (error) {
            if (error instanceof ArkResponsesFailure) throw error
            if (active.failureCode !== null) throw new ArkResponsesFailure(active.failureCode)
            throw new ArkResponsesFailure('network')
          }
        })()
        if (result.done) {
          if (buffered.byteLength > 0) {
            const event = handleLine(buffered)
            if (event !== null) {
              yield event
              terminal = event.kind === 'response_completed' || event.kind === 'response_failed'
            }
          }
          const finalEvent = handleLine(new Uint8Array(0))
          if (finalEvent !== null) {
            yield finalEvent
            terminal = finalEvent.kind === 'response_completed' || finalEvent.kind === 'response_failed'
          }
          if (!terminal) throw new ArkResponsesFailure('protocol')
          break
        }
        const chunk = copyReadableChunk(result.value)
        aggregateBytes += chunk.byteLength
        if (aggregateBytes > this.#streamLimits.responseBytes) throw new ArkResponsesFailure('overflow')
        buffered = concatBytes(buffered, chunk)
        let newline = buffered.indexOf(10)
        while (newline >= 0) {
          const event = handleLine(buffered.subarray(0, newline))
          buffered = buffered.slice(newline + 1)
          if (event !== null) {
            yield event
            terminal = event.kind === 'response_completed' || event.kind === 'response_failed'
            if (terminal) break
          }
          newline = buffered.indexOf(10)
        }
        if (buffered.byteLength > this.#streamLimits.lineBytes) {
          throw new ArkResponsesFailure('overflow')
        }
      }
    } catch (error) {
      if (error instanceof ArkResponsesFailure) throw error
      if (active.failureCode !== null) throw new ArkResponsesFailure(active.failureCode)
      throw new ArkResponsesFailure('protocol')
    } finally {
      if (!usageReported) reportUsage(this.#onUsage, {
        id: usageId, service: 'llm', provider: this.#compatible ? 'custom' : 'ark', model: this.#model, status: 'missing',
      })
      input.signal?.removeEventListener('abort', onCallerAbort)
      try {
        await active.reader?.cancel()
      } catch {
        // Reader cleanup is best effort; the stable operation result was already selected above.
      }
      this.#active.delete(active)
      active.resolveDone()
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const active = [...this.#active]
    for (const item of active) abortActive(item, 'closed')
    this.#closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(active.map(item => item.done)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.#closeTimeoutMs) }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      this.#active.clear()
    })()
    return this.#closePromise
  }
}

export function createFetchArkResponsesGateway(
  options: FetchArkResponsesGatewayOptions,
): ArkResponsesGateway {
  return new FetchArkResponsesGateway(options)
}
