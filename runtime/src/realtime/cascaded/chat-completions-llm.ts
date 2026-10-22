import {selfHostedEndpoint} from '../../config/self-hosted.js'
import {committedConversationPairsSchema,type CommittedConversationPair} from '../history.js'
import {translateSystemPrompt, type PromptLanguage} from '../prompt-language.js'
import {cascadedNarrationInstructions} from './llm.js'
import {originalImageUrl, toolObservations, trimToolImages, isToolObservation, imageFreeMessage} from './llm.js'
import {beginModelUsage,mergeModelUsage} from '../../usage/model-call.js'
import type {UsageReporter} from '../usage.js'
import type { Clock } from '../../core/clock.js'
import type { JsonObject } from '../protocol.js'
import { codePointLengthLikePython } from '../../text/python-text.js'
import type { JsonValue } from '../../core/events.js'
import {llmStreamLimits,llmToolCallLimit,type LlmStreamLimits,type LlmTransportOptions} from './llm-stream-limits.js'
import {
  MAX_CASCADED_LLM_HISTORY_CODEPOINTS,
  MAX_CASCADED_LLM_HISTORY_ITEMS,
  type CascadedLlmEvent,
  type CascadedLlmFactory,
  type CascadedLlmInput,
  type CascadedLlmSession,
  type CascadedLlmTool,
} from './llm.js'

export {MAX_CASCADED_LLM_HISTORY_CODEPOINTS, MAX_CASCADED_LLM_HISTORY_ITEMS} from './llm.js'
const MAX_EVENT_BYTES = 512 * 1024

export type ChatCompletionsLlmFailureCode = 'configuration' | 'aborted' | 'timeout' | 'protocol' | 'overflow' | 'closed' | 'network' | 'http'
export class ChatCompletionsLlmFailure extends Error {
  constructor(readonly code: ChatCompletionsLlmFailureCode, readonly statusCode: number | null = null, readonly detail:string|null=null) {
    super(`Chat Completions LLM ${code} failure`)
    this.name = 'ChatCompletionsLlmFailure'
  }
}

export interface ChatCompletionsLlmFactoryOptions extends LlmTransportOptions {
  readonly provider: 'qwen' | 'deepseek' | 'openai' | 'gemini' | 'self-hosted' | 'openai-compatible'
  readonly baseUrl: string; readonly apiKey: string; readonly model: string; readonly instructions: string
  readonly fetchImpl?: typeof globalThis.fetch; readonly idFactory?: () => string; readonly clock?: Clock
  readonly onUsage?: UsageReporter
  readonly closeTimeoutMs?: number
}
interface Call { readonly id: string; readonly type: 'function'; readonly extra_content?: JsonObject; readonly function: {readonly name: string; readonly arguments: string} }
interface Message { readonly role: 'system' | 'user' | 'assistant' | 'tool'; readonly content: string | readonly JsonObject[] | null; readonly tool_calls?: readonly Call[]; readonly tool_call_id?: string }
interface Fragment { extra_content?: JsonObject; id: string | null; name: string; arguments: string }
interface Active { completion: Promise<void> | null; usageDeadline: number | null; readonly controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null; failureCode: ChatCompletionsLlmFailureCode | null }

/** Provider account codes the user can act on; the rest of an error body is never kept. */
const ACCOUNT_CODES: Readonly<Record<string, 'auth' | 'quota'>> = {Arrearage: 'quota', insufficient_quota: 'quota', InvalidApiKey: 'auth', invalid_api_key: 'auth'}
const MAX_ERROR_BODY_BYTES = 4096
function fail(code: ChatCompletionsLlmFailureCode, statusCode: number | null = null): ChatCompletionsLlmFailure { return new ChatCompletionsLlmFailure(code, statusCode) }
function protocol(detail:string):ChatCompletionsLlmFailure{return new ChatCompletionsLlmFailure('protocol',null,detail)}
function object(value: unknown): value is Record<string, unknown> { return value !== null && !Array.isArray(value) && typeof value === 'object' }
function jsonObject(value: unknown): value is JsonObject { return object(value) }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function copy(value: JsonValue): JsonValue { return structuredClone(value) }
function endpoint(baseUrl: string): string { try { const url = new URL(baseUrl); url.pathname = `${url.pathname.replace(/\/+$/u, '')}/chat/completions`; return url.toString() } catch { throw fail('configuration') } }
function message(input: CascadedLlmInput): Message { return input.kind === 'tool_result' ? {role: 'tool', content: JSON.stringify(copy(input.output)), tool_call_id: input.call_id} : {role: input.kind === 'user_text' || input.kind === 'host_activation' || input.kind === 'host_task' ? 'user' : 'system', content: input.kind === 'user_text' ? (input.image ? [{type: 'text', text: input.text}, {type: 'image_url', image_url: {url: originalImageUrl(input.image)}}] : input.text) : input.kind === 'host_activation' ? JSON.stringify({text_to_say: input.content}) : input.kind === 'host_task' ? JSON.stringify({host_scheduled_task:input.content,authority:'host_schedule_run_not_a_user_message'}) : input.content} }
function schema(tool: CascadedLlmTool): JsonObject { return {type: 'function', function: {name: tool.name, ...(tool.description === undefined ? {} : {description: tool.description}), parameters: copy(tool.parameters)}} }
function size(units: readonly (readonly Message[])[]): {items: number; codepoints: number} { const all = units.flat(); return {items: all.length, codepoints: all.reduce((sum, item) => sum + codePointLengthLikePython(JSON.stringify(withoutImage(item))), 0)} }

class Session implements CascadedLlmSession {
  #historyLimits={items:MAX_CASCADED_LLM_HISTORY_ITEMS,codepoints:MAX_CASCADED_LLM_HISTORY_CODEPOINTS}
  setHistoryLimits(limits:{items:number;codepoints:number}):void{if(this.#started||limits.items<1||limits.items>2048||limits.codepoints<1||limits.codepoints>32*1024*1024)throw fail('configuration');this.#historyLimits={...limits}}
  checkpoint():JsonValue{return structuredClone({protocol:'chat-completions',history:this.#history,pending:this.#unresolved}) as unknown as JsonValue}
  restoreCheckpoint(checkpoint:JsonValue):void{
    if(this.#started||this.#closed||this.#seeded||!object(checkpoint)||checkpoint.protocol!=='chat-completions'||!Array.isArray(checkpoint.history)||!(checkpoint.pending===null||Array.isArray(checkpoint.pending)))throw fail('protocol')
    const units=[...checkpoint.history,...(checkpoint.pending===null?[]:[checkpoint.pending])]
    for(const unit of units){
      if(!Array.isArray(unit))throw fail('protocol')
      const outstanding=new Set<string>()
      for(const msg of unit){
        if(!object(msg)||typeof msg.role!=='string'||!['system','user','assistant','tool'].includes(msg.role)||!(typeof msg.content==='string'||msg.content===null||isToolObservation(msg)&&Array.isArray(msg.content)&&msg.content.every(part=>object(part)&&(part.type==='text'&&typeof part.text==='string'||part.type==='image_url'&&object(part.image_url)&&typeof part.image_url.url==='string'&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/u.test(part.image_url.url)))))throw fail('protocol')
        if(Array.isArray(msg.tool_calls))for(const call of msg.tool_calls){if(!object(call)||!id(call.id)||!object(call.function)||!id(call.function.name)||typeof call.function.arguments!=='string'||outstanding.has(call.id))throw fail('protocol');outstanding.add(call.id)}
        if(msg.role==='tool'&&(typeof msg.tool_call_id!=='string'||!outstanding.delete(msg.tool_call_id)))throw fail('protocol')
      }
      if(unit!==checkpoint.pending&&outstanding.size)throw fail('protocol')
    }
    this.#history=structuredClone(checkpoint.history) as unknown as Message[][];this.#unresolved=structuredClone(checkpoint.pending) as unknown as Message[]|null;this.#seeded=true
    trimToolImages([...this.#history.flat(),...(this.#unresolved??[])])
  }
  readonly #provider: 'qwen' | 'deepseek' | 'openai' | 'gemini' | 'self-hosted' | 'openai-compatible'
  readonly #onUsage: UsageReporter | undefined
  readonly #endpoint: string; readonly #apiKey: string; readonly #model: string; readonly #instructions: string; readonly #fetch: typeof fetch
  readonly #idleTimeoutMs: number; readonly #closeTimeoutMs: number; readonly #active = new Set<Active>()
  readonly #streamLimits:LlmStreamLimits
  readonly #toolCallLimit:number
  #started = false; #seeded = false
  #history: Message[][] = []; #unresolved: Message[] | null = null; #closed = false; #closePromise: Promise<void> | null = null
  constructor(options: ChatCompletionsLlmFactoryOptions,history?:readonly CommittedConversationPair[]) {
    this.#provider = options.provider
    try{this.#streamLimits=llmStreamLimits(options);this.#toolCallLimit=llmToolCallLimit(options)}catch{throw fail('configuration')}
    this.#onUsage = options.onUsage
    if ((!options.apiKey && options.provider !== 'self-hosted') || !options.model || !options.instructions) throw fail('configuration')
    this.#endpoint = endpoint(['self-hosted','openai-compatible'].includes(options.provider) ? selfHostedEndpoint(options.baseUrl, 'http', options.provider === 'self-hosted' ? 'SELF_HOSTED_LLM_BASE_URL' : 'OPENAI_COMPATIBLE_BASE_URL') : options.baseUrl); this.#apiKey = options.apiKey; this.#model = options.model; this.#instructions = options.instructions; this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 30_000; this.#closeTimeoutMs = options.closeTimeoutMs ?? 1_000
    if(history!==undefined)this.#seed(history)
    if (!Number.isFinite(this.#idleTimeoutMs) || this.#idleTimeoutMs <= 0 || !Number.isFinite(this.#closeTimeoutMs) || this.#closeTimeoutMs <= 0) throw fail('configuration')
  }
  async *stream(input: {readonly language?: PromptLanguage; readonly inputs: readonly CascadedLlmInput[]; readonly tools: readonly CascadedLlmTool[]; readonly workspaceContext?: string | null; readonly responseAdaptation?: string | null; readonly signal: AbortSignal}): AsyncIterable<CascadedLlmEvent> {
    if (this.#closed) throw fail('closed'); if (input.signal.aborted) throw fail('aborted')
    this.#started = true
    const current = wireMessages(input.inputs), unresolved = this.#unresolved
    trimToolImages([...this.#history.flat(), ...(unresolved ?? []), ...current])
    if (unresolved === null && input.inputs.some(item => item.kind === 'tool_result')) throw fail('protocol')
    if (unresolved !== null) this.#checkResults(input.inputs, unresolved)
    this.#trim(unresolved ?? [])
    const factOnly = input.inputs.some(item => item.kind === 'host_activation')
    const systemContent = [factOnly ? cascadedNarrationInstructions(input.language) : translateSystemPrompt(this.#instructions, input.language),
      factOnly ? null : input.workspaceContext, input.responseAdaptation]
      .filter((item): item is string => item !== null && item !== undefined)
      .join('\n\n')
    // Narration reads its own fact, not an unfinished question from a prior conversation turn.
    // Tool-call/result pairs stay intact; the full turn is still recorded for the next user turn.
    const context = factOnly
      ? [...(unresolved?.slice(-1) ?? []),
        ...wireMessages(input.inputs.filter(item => item.kind === 'host_activation' || item.kind === 'tool_result'))]
      : [...this.#history.flat(), ...(unresolved ?? []), ...current]
    // Self-hosted Qwen chat templates accept system messages only at the beginning.
    const messages = this.#provider === 'self-hosted'
      ? [{role:'system' as const,content:[systemContent,...context.filter(item=>item.role==='system').map(item=>typeof item.content === 'string' ? item.content : '')].join('\n\n')},...context.filter(item=>item.role!=='system')]
      : [{role: 'system' as const, content: systemContent}, ...context]
    const body: Record<string, JsonValue> = {model: this.#model, messages: messages as unknown as JsonValue, stream: true, stream_options: {include_usage: true}}
    if (this.#provider === 'deepseek') body.thinking = {type: 'disabled'}
    else if (this.#provider === 'qwen') body.enable_thinking = false
    else if (this.#provider === 'openai') body.reasoning_effort = 'none'
    if (input.tools.length > 0) { body.tools = input.tools.map(schema); if (this.#provider !== 'gemini') body.parallel_tool_calls = this.#toolCallLimit>1 }
    const active: Active = {completion: null, usageDeadline: null, controller: new AbortController(), reader: null, failureCode: null}
    const stop = (): void => { active.failureCode ??= 'aborted'; active.controller.abort(); void this.#cancel(active.reader) }
    input.signal.addEventListener('abort', stop, {once: true}); this.#active.add(active)
    let responseId: string | null = null, terminal = false
    const finishUsage=beginModelUsage(this.#onUsage,this.#endpoint,this.#model,'llm',this.#provider==='self-hosted'||this.#provider==='openai-compatible'?'custom':this.#provider,this.#provider==='qwen'?'disabled':undefined)
    let usage: Record<string, unknown> | undefined
    let events: AsyncIterator<Record<string, unknown>> | undefined
    const toolIndexes=new Set<number>()
    const captureUsage = (event: Record<string, unknown>): void => {
      if (object(event.usage)) usage = mergeModelUsage(usage,event.usage)
    }
    try {
      let response: Response
      try { response = await this.#timed(this.#fetch(this.#endpoint, {method: 'POST', redirect: ['self-hosted','openai-compatible'].includes(this.#provider) ? 'error' : 'follow', headers: {...(this.#apiKey ? {authorization: `Bearer ${this.#apiKey}`} : {}), 'content-type': 'application/json', accept: 'text/event-stream'}, body: JSON.stringify(body), signal: active.controller.signal}), active) }
      catch (error) { if (error instanceof ChatCompletionsLlmFailure) throw error; throw fail(input.signal.aborted ? 'aborted' : this.#closed ? 'closed' : 'network') }
      if (!response.ok) throw new ChatCompletionsLlmFailure('http', response.status, await this.#accountFailure(response, active))
      if (response.body === null || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) { await this.#cancel(response.body?.getReader() ?? null); throw fail('protocol') }
      active.reader = response.body.getReader()
      let started = false, text = '', sawText = false
      const fragments = new Map<number, Fragment>()
      events = this.#events(active)[Symbol.asyncIterator]()
      while (true) {
        const next = await events.next()
        if (next.done) break
        const event = next.value
        captureUsage(event)
        if (event.id !== undefined) {
          if (!id(event.id) || (responseId !== null && responseId !== event.id)) throw protocol('response_id')
          responseId ??= event.id
        }
        if (!Array.isArray(event.choices)) continue
        for (const choice of event.choices) {
          if (!object(choice) || !object(choice.delta)) throw protocol('choice_delta')
          const content = choice.delta.content, calls = choice.delta.tool_calls
          if (content !== undefined && content !== null && typeof content !== 'string') throw protocol('content_shape'); if (calls !== undefined && !Array.isArray(calls)) throw protocol('tool_calls_shape')
          if (!started && ((input.tools.length === 0 && typeof content === 'string' && content !== '') || (choice.finish_reason !== undefined && choice.finish_reason !== null))) { if (responseId === null) throw fail('protocol'); started = true; yield {kind: 'response_started', response_id: responseId} }
          if (typeof content === 'string' && content !== '') sawText = true
          if (typeof content === 'string' && content !== '') { text += content; if (input.tools.length === 0) yield {kind: 'text_delta', text: content} }
          for (const call of calls ?? []) {if(object(call)&&typeof call.index==='number'&&Number.isSafeInteger(call.index))toolIndexes.add(call.index);this.#fragment(fragments,call)}
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (typeof choice.finish_reason !== 'string' || responseId === null) throw fail('protocol')
            if (choice.finish_reason === 'stop') {
              if (fragments.size > 0) throw protocol('tool_finish_reason')
              // With tools enabled, wait for the response kind before publishing speech.
              if (input.tools.length > 0 && text !== '') yield {kind: 'text_delta', text}
              this.#history.push([...(unresolved ?? []), ...current, {role: 'assistant' as const, content: text}].map(item => isToolObservation(item) ? item : withoutImage(item)))
              this.#unresolved = null; terminal = true
              yield {kind: 'response_completed', response_id: responseId}; return
            } else if (choice.finish_reason === 'tool_calls') {
              if ((sawText && input.tools.length === 0) || fragments.size === 0) throw fail('protocol'); const callsOut = this.#calls(fragments)
              for (const call of callsOut) yield {kind: 'tool_call', item_id: call.id, call_id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) as JsonObject}
              this.#unresolved = [...(unresolved ?? []), ...current, {role: 'assistant', content: null, tool_calls: callsOut}]
              terminal = true; yield {kind: 'response_completed', response_id: responseId}; return
            } else throw protocol(choice.finish_reason==='length'?'output_limit':'finish_reason')
          }
        }
      }
      if (!terminal) {if(!active.failureCode&&!this.#closed&&!input.signal.aborted)throw protocol('incomplete_stream');throw fail(active.failureCode ?? (this.#closed ? 'closed' : 'aborted'))}
    } catch (error) {
      if (terminal) return
      const stable = error instanceof ChatCompletionsLlmFailure
        ? error : fail(active.failureCode ?? (this.#closed ? 'closed' : input.signal.aborted ? 'aborted' : 'network'))
      if (responseId !== null && !terminal) {
        yield {kind: 'response_failed', response_id: responseId, code: stable.code,...(stable.detail?{detail:stable.detail}:{}),...(stable.code==='protocol'&&this.#toolCallLimit>1?{tool_call_count:toolIndexes.size}:{})}
        return
      }
      throw stable
    } finally {
      // Receipt of a matching tool result survives interruption of its narration.
      // Preserve the resolved pair; the next user turn must not owe that result again.
      if (!terminal && unresolved !== null) {
        this.#history.push([...unresolved, ...current].map(item => isToolObservation(item) ? item : withoutImage(item)))
        this.#unresolved = null
      }
      const finish = async (): Promise<void> => {
        // Metering outlives semantic ownership; the next voice turn must not wait for this tail.
        if (terminal && this.#onUsage !== undefined && events !== undefined && !active.controller.signal.aborted) {
          active.usageDeadline = Date.now() + Math.min(this.#closeTimeoutMs, 1000)
          try { while (true) { const next = await events.next(); if (next.done) break; captureUsage(next.value) } } catch { /* Metering cannot change a completed response. */ }
        }
        finishUsage(usage,terminal?'success':input.signal.aborted?'cancelled':'error',responseId)
        input.signal.removeEventListener('abort', stop); await this.#cancel(active.reader); this.#active.delete(active)
      }
      if (terminal && this.#onUsage !== undefined) active.completion = finish()
      else await finish()
    }
  }
  restoreHistory(history:readonly CommittedConversationPair[],signal:AbortSignal):Promise<void> {
    try {signal.throwIfAborted();if(this.#closed||this.#started||this.#seeded)throw fail('protocol');this.#seed(history);return Promise.resolve()}
    catch(error){return Promise.reject(error instanceof Error?error:fail('protocol'))}
  }
  #seed(history:readonly CommittedConversationPair[]):void {
    const pairs=committedConversationPairsSchema.parse(history)
    this.#history=pairs.map(pair=>[{role:'user',content:pair.user},{role:'assistant',content:pair.assistant}])
    this.#seeded=true
    this.#trim([])
  }
  #fragment(fragments: Map<number, Fragment>, value: unknown): void {
    if (!object(value) || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index<0) throw protocol('tool_index')
    if(value.index>=this.#toolCallLimit)throw protocol('tool_call_limit')
    if(value.function!==undefined&&!object(value.function))throw protocol('tool_function_shape')
    const index = value.index
    const found = fragments.get(index) ?? {id: null, name: '', arguments: ''}
    // A null id on a later DashScope delta contributes no new identity; final validation still requires an id.
    if (value.id !== undefined && value.id !== null && value.id !== '') { if (!id(value.id) || (found.id !== null && found.id !== value.id)) throw protocol('tool_identity'); found.id = value.id }
    // DashScope may append arguments:null after complete JSON; that delta contributes no bytes.
    const fn = value.function
    if (object(fn)) { if (fn.name !== undefined) { if (typeof fn.name !== 'string') throw protocol('tool_name'); found.name += fn.name }; if (fn.arguments !== undefined && fn.arguments !== null) { if (typeof fn.arguments !== 'string') throw protocol('tool_arguments_shape'); found.arguments += fn.arguments } }
    if (this.#provider === 'gemini' && value.extra_content !== undefined) {
      if (!jsonObject(value.extra_content) || JSON.stringify(value.extra_content).length > MAX_EVENT_BYTES) throw fail('protocol')
      if (found.extra_content && JSON.stringify(found.extra_content) !== JSON.stringify(value.extra_content)) throw fail('protocol')
      found.extra_content = structuredClone(value.extra_content)
    }
    fragments.set(index, found)
  }
  #calls(fragments: ReadonlyMap<number, Fragment>): Call[] {
    const ids=new Set<string>()
    return [...fragments.entries()].sort(([a],[b])=>a-b).map(([index,part],position)=>{
      if(index!==position)throw protocol('tool_index')
      if(!id(part.id)||!id(part.name)||ids.has(part.id))throw protocol('tool_identity')
      ids.add(part.id)
      let args:unknown;try{args=JSON.parse(part.arguments)}catch{throw protocol('tool_arguments_json')}
      if(!jsonObject(args))throw protocol('tool_arguments_object')
      return {id:part.id,type:'function',...(part.extra_content?{extra_content:part.extra_content}:{}),function:{name:part.name,arguments:JSON.stringify(copy(args))}}
    })
  }
  #checkResults(inputs: readonly CascadedLlmInput[], unresolved: readonly Message[]): void {
    const calls = (unresolved.at(-1)?.tool_calls ?? []).map(item => item.id).sort(), results = inputs.filter((item): item is Extract<CascadedLlmInput, {kind: 'tool_result'}> => item.kind === 'tool_result').map(item => item.call_id).sort()
    if (calls.length === 0 || calls.length !== results.length || calls.some((call, index) => call !== results[index]) || inputs.slice(0, results.length).some(item => item.kind !== 'tool_result')) throw fail('protocol')
  }
  abandonPendingResponse(): Promise<void> {
    if (this.#closed) return Promise.reject(fail('closed'))
    this.#unresolved = null
    return Promise.resolve()
  }
  #trim(unresolved: readonly Message[]): void { while (true) { const measured = size([...this.#history, unresolved]); if (measured.items <= this.#historyLimits.items && measured.codepoints <= this.#historyLimits.codepoints) return; if (this.#history.length === 0) throw fail('overflow'); this.#history.shift() } }
  async *#events(active: Active): AsyncIterable<Record<string, unknown>> {
    const reader = active.reader!, decoder = new TextDecoder('utf-8', {fatal: true}); let buffered = new Uint8Array(), total = 0, parts: string[] = [], partBytes = 0, count = 0
    const line = (raw: Uint8Array): Record<string, unknown> | 'done' | null => { let bytes = raw; if (bytes.at(-1) === 13) bytes = bytes.subarray(0, bytes.length - 1); if (bytes.length > this.#streamLimits.lineBytes) throw fail('overflow'); let text: string; try { text = decoder.decode(bytes) } catch { throw fail('protocol') }; if (text !== '') { if (text.startsWith(':') || !text.startsWith('data:')) return null; const part = text.slice(5).replace(/^ /u, ''); partBytes += new TextEncoder().encode(part).length + (parts.length === 0 ? 0 : 1); if (partBytes > this.#streamLimits.eventBytes) throw fail('overflow'); parts.push(part); return null }; if (parts.length === 0) return null; count += 1; if (count > this.#streamLimits.events) throw fail('overflow'); const joined = parts.join('\n'); parts = []; partBytes = 0; if (joined === '[DONE]') return 'done'; let parsed: unknown; try { parsed = JSON.parse(joined) } catch { throw fail('protocol') }; if (!object(parsed)) throw fail('protocol'); return parsed }
    while (true) {
      let read: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>; try { read = await this.#timed(reader.read(), active) } catch (error) { if (error instanceof ChatCompletionsLlmFailure) throw error; throw fail(active.controller.signal.aborted ? this.#closed ? 'closed' : 'aborted' : 'network') }
      if (read.done) { if (buffered.length > 0) { const event = line(buffered); if (event !== null && event !== 'done') yield event }; const event = line(new Uint8Array()); if (event !== null && event !== 'done') yield event; return }
      if (!(read.value instanceof Uint8Array)) throw fail('protocol'); total += read.value.length; if (total > this.#streamLimits.responseBytes) throw fail('overflow'); const next = new Uint8Array(buffered.length + read.value.length); next.set(buffered); next.set(read.value, buffered.length); buffered = next
      let newline = buffered.indexOf(10); while (newline >= 0) { const event = line(buffered.subarray(0, newline)); buffered = buffered.slice(newline + 1); if (event === 'done') return; if (event !== null) yield event; newline = buffered.indexOf(10) }; if (buffered.length > this.#streamLimits.lineBytes) throw fail('overflow')
    }
  }
  /** Reads at most a small error body for an allowlisted account code, then the status. */
  async #accountFailure(response: Response, active: Active): Promise<'auth' | 'quota' | 'rate_limited' | null> {
    const reader = response.body?.getReader() ?? null
    let code: unknown
    try {
      const chunks: Uint8Array[] = []
      let size = 0
      while (reader !== null && size <= MAX_ERROR_BODY_BYTES) {
        const {done, value} = await this.#timed(reader.read(), active)
        if (done) break
        chunks.push(value); size += value.byteLength
      }
      if (size <= MAX_ERROR_BODY_BYTES) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {code?: unknown; error?: {code?: unknown}}
        code = body.error?.code ?? body.code
      }
    } catch {
      // A missing or malformed body leaves only the status to classify.
    } finally {
      await this.#cancel(reader)
    }
    if (typeof code === 'string' && Object.hasOwn(ACCOUNT_CODES, code)) return ACCOUNT_CODES[code]!
    if (response.status === 401 || response.status === 403) return 'auth'
    if (response.status === 402) return 'quota'
    if (response.status === 429) return 'rate_limited'
    return null
  }

  async #cancel(reader: ReadableStreamDefaultReader<Uint8Array> | null): Promise<void> {
    if (reader === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        reader.cancel().catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.#closeTimeoutMs) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  async #timed<T>(promise: Promise<T>, active: Active): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => { active.failureCode ??= 'timeout'; active.controller.abort(); void this.#cancel(active.reader); reject(fail('timeout')) }, active.usageDeadline === null ? this.#idleTimeoutMs : Math.max(1, Math.min(this.#idleTimeoutMs, active.usageDeadline - Date.now()))) })]) } finally { if (timer !== undefined) clearTimeout(timer) } }
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise
    this.#closed = true
    const cancellations = [...this.#active].map(async active => {
      active.failureCode ??= 'closed'
      active.controller.abort()
      await this.#cancel(active.reader)
      await active.completion
    })
    this.#closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled(cancellations),
          new Promise<void>(resolve => { timer = setTimeout(resolve, this.#closeTimeoutMs) }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    return this.#closePromise
  }
}
export function createChatCompletionsLlmFactory(options: ChatCompletionsLlmFactoryOptions): CascadedLlmFactory { return {open: input => new Session(options,input?.history)} }

function withoutImage(message: Message): Message { return imageFreeMessage(message) }
function wireMessages(inputs: readonly CascadedLlmInput[]): Message[] {
  if (!inputs.some(input=>input.kind==='tool_result'&&input.images?.length)) return inputs.map(message)
  const results=inputs.filter(input=>input.kind==='tool_result'),other=inputs.filter(input=>input.kind!=='tool_result')
  return [...results.map(message),...toolObservations(results) as unknown as Message[],...other.map(message)]
}
