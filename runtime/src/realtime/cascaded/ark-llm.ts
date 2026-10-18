import {committedConversationPairsSchema,type CommittedConversationPair} from '../history.js'
import type {PromptLanguage} from '../prompt-language.js'
import {cascadedNarrationInstructions} from './llm.js'
import {originalImageUrl, MAX_CASCADED_LLM_HISTORY_ITEMS, MAX_CASCADED_LLM_HISTORY_CODEPOINTS} from './llm.js'
import { jsonValueSchema, type JsonValue } from '../../core/events.js'
import { codePointLengthLikePython, stripLikePython } from '../../text/python-text.js'
import { MAX_REALTIME_TEXT, type JsonObject } from '../protocol.js'
import {
  ArkResponsesFailure,
  createFetchArkResponsesGateway,
  type ArkResponsesFailureCode,
  type ArkResponsesGateway,
  type FetchArkResponsesGatewayOptions,
} from '../volcengine/ark.js'
import type {
  CascadedLlmEvent,
  CascadedLlmFactory,
  CascadedLlmInput,
  CascadedLlmSession,
  CascadedLlmTool,
} from './llm.js'

export type ArkCascadedLlmFailureCode = ArkResponsesFailureCode

export class ArkCascadedLlmFailure extends Error {
  constructor(readonly code: ArkCascadedLlmFailureCode, readonly statusCode: number | null = null) {
    super(`Ark cascaded LLM ${code} failure`)
    this.name = 'ArkCascadedLlmFailure'
  }
}

export type ArkCascadedLlmFactoryOptions = FetchArkResponsesGatewayOptions

function fail(code: ArkCascadedLlmFailureCode, statusCode: number | null = null): ArkCascadedLlmFailure {
  return new ArkCascadedLlmFailure(code, statusCode)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && stripLikePython(value) !== ''
    && codePointLengthLikePython(value) <= MAX_REALTIME_TEXT
}

function jsonObject(value: unknown): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    && jsonValueSchema.safeParse(value).success
}

/** Translates the legacy OpenAI function shape at the semantic adapter boundary. */
export function responsesToolSchema(schema: JsonObject): JsonObject {
  const functionObject = schema.function
  if (schema.type !== 'function' || functionObject === null || Array.isArray(functionObject)
    || typeof functionObject !== 'object') {
    throw fail('protocol')
  }
  const candidate = functionObject as Readonly<Record<string, JsonValue>>
  const name = candidate.name
  const parameters = candidate.parameters
  if (!validIdentifier(name) || !jsonObject(parameters)) throw fail('protocol')
  const description = candidate.description
  if (description !== undefined && typeof description !== 'string') throw fail('protocol')
  return {
    type: 'function', name,
    ...(description !== undefined && stripLikePython(description) !== '' ? {description} : {}),
    parameters: structuredClone(parameters),
  }
}

function inputItem(input: CascadedLlmInput): JsonObject {
  if (input.kind === 'tool_result') {
    return {type: 'function_call_output', call_id: input.call_id, output: JSON.stringify(input.output)}
  }
  return {role: input.kind === 'user_text' || input.kind === 'host_activation' || input.kind === 'host_task' ? 'user' : 'system', content: input.kind === 'user_text' ? (input.image ? [{type: 'input_text', text: input.text}, {type: 'input_image', image_url: originalImageUrl(input.image)}] : input.text) : input.kind === 'host_activation' ? JSON.stringify({text_to_say: input.content}) : input.kind === 'host_task' ? JSON.stringify({host_scheduled_task:input.content,authority:'host_schedule_run_not_a_user_message'}) : input.content}
}

function toolSchema(tool: CascadedLlmTool): JsonObject {
  return responsesToolSchema({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : {description: tool.description}),
      parameters: structuredClone(tool.parameters),
    },
  })
}

class Session implements CascadedLlmSession {
  readonly #gateway: ArkResponsesGateway
  #started=false
  #seeded=false
  #previousResponseId: string | null = null
  #pendingToolContinuation = false
  #closed = false
  #visualHistory = false
  #pendingCallId: string | null = null
  readonly #stateless: boolean
  #history: JsonObject[][] = []
  #turnItems: JsonObject[] = []

  constructor(gateway: ArkResponsesGateway,history?:readonly CommittedConversationPair[],stateless=false) {
    this.#stateless=stateless
    this.#gateway = gateway
    if(history!==undefined)this.#seed(history)
  }

  restoreHistory(history:readonly CommittedConversationPair[],signal:AbortSignal):Promise<void> {
    try {signal.throwIfAborted();if(this.#closed||this.#started||this.#seeded)throw fail('protocol');this.#seed(history);return Promise.resolve()}
    catch(error){return Promise.reject(error instanceof Error?error:fail('protocol'))}
  }
  #seed(history:readonly CommittedConversationPair[]):void {
    this.#history=committedConversationPairsSchema.parse(history).map(pair=>[{role:'user',content:pair.user},{role:'assistant',content:pair.assistant}])
    this.#visualHistory=true
    this.#seeded=true
  }
  async *stream(input: {
    readonly language?: PromptLanguage
    readonly inputs: readonly CascadedLlmInput[]
    readonly tools: readonly CascadedLlmTool[]
    readonly workspaceContext?: string | null
    readonly responseAdaptation?: string | null
    readonly signal: AbortSignal
  }): AsyncIterable<CascadedLlmEvent> {
    if (this.#closed) throw fail('closed')
    if (input.signal.aborted) throw fail('aborted')
    this.#started=true
    if(this.#stateless) {
      const results=input.inputs.filter(item=>item.kind==='tool_result')
      if(this.#pendingCallId!==null ? results.length!==1 || results[0]!.call_id!==this.#pendingCallId || input.inputs.length!==1 : results.length>0)throw fail('protocol')
    }
    const current = input.inputs.map(inputItem)
    const factOnly = input.inputs.some(item => item.kind === 'host_activation')
    if (input.inputs.some(item => item.kind === 'user_text' && item.image)) this.#visualHistory = true
    const continuing = this.#pendingToolContinuation
    const localHistory = this.#stateless || (this.#visualHistory || (this.#previousResponseId === null && this.#history.length > 0)) && !continuing
    if (!continuing) this.#turnItems = []
    this.#turnItems.push(...input.inputs.map(item => item.kind === 'user_text' ? {role: 'user', content: item.text} : inputItem(item)))
    if(this.#stateless && (this.#turnItems.length>MAX_CASCADED_LLM_HISTORY_ITEMS || codePointLengthLikePython(JSON.stringify(this.#turnItems))>MAX_CASCADED_LLM_HISTORY_CODEPOINTS))throw fail('overflow')
    let outputText = ''
    let responseId: string | null = null
    let terminal = false
    let textSeen = false
    let pendingTool: Extract<CascadedLlmEvent, {kind: 'tool_call'}> | null = null
    try {
      for await (const event of this.#gateway.stream({
        ...(input.language === undefined ? {} : {language: input.language}),
        inputItems: factOnly ? input.inputs.filter(item => item.kind === 'host_activation' || item.kind === 'tool_result').map(inputItem)
          : localHistory ? [...this.#history.flat(), ...(this.#stateless && continuing ? this.#turnItems : current)] : current,
        tools: input.tools.map(toolSchema),
        previousResponseId: localHistory || (factOnly && !continuing) ? null : this.#previousResponseId,
        workspaceContext: factOnly ? null : input.workspaceContext ?? null,
        responseAdaptation: factOnly ? cascadedNarrationInstructions(input.language) : input.responseAdaptation ?? null,
        signal: input.signal,
      })) {
        if (event.kind === 'response_started') {
          if (responseId !== null) throw fail('protocol')
          responseId = event.response_id
          yield event
        } else if (event.kind === 'text_delta') {
          if (responseId === null) throw fail('protocol')
          if (pendingTool !== null && !this.#stateless) throw fail('protocol')
          textSeen = true
          outputText += event.text
          yield event
        } else if (event.kind === 'tool_call') {
          if (responseId === null || (textSeen && !this.#stateless) || pendingTool !== null) throw fail('protocol')
          pendingTool = structuredClone(event)
        } else if (event.kind === 'response_completed') {
          if (responseId === null || event.response_id !== responseId) throw fail('protocol')
          terminal = true
          if(this.#stateless && event.outputItems) this.#turnItems.push(...structuredClone(event.outputItems))
          if (pendingTool !== null) {
            if(!this.#stateless) this.#turnItems.push({type: 'function_call', call_id: pendingTool.call_id, name: pendingTool.name, arguments: JSON.stringify(pendingTool.arguments)})
            yield pendingTool
          }
          if (pendingTool === null) {
            this.#history.push(this.#stateless ? [...this.#turnItems] : [...this.#turnItems, {role: 'assistant', content: outputText}])
            this.#turnItems = []
            while (this.#history.length && (this.#history.flat().length > MAX_CASCADED_LLM_HISTORY_ITEMS || codePointLengthLikePython(JSON.stringify(this.#history)) > MAX_CASCADED_LLM_HISTORY_CODEPOINTS)) this.#history.shift()
          }
          this.#previousResponseId = factOnly && pendingTool === null ? null : event.response_id
          this.#pendingToolContinuation = pendingTool !== null
          this.#pendingCallId=pendingTool?.call_id??null
          yield {kind:'response_completed',response_id:event.response_id}
          return
        } else {
          if (responseId !== null && event.response_id !== responseId) throw fail('protocol')
          this.#previousResponseId = null
          this.#pendingToolContinuation = false
          this.#pendingCallId = null
          terminal = true
          yield event
          return
        }
      }
      throw fail('protocol')
    } catch (error) {
      const stable = error instanceof ArkCascadedLlmFailure
        ? error
        : error instanceof ArkResponsesFailure
          ? fail(error.code, error.statusCode)
          : fail(this.#closed ? 'closed' : input.signal.aborted ? 'aborted' : 'network')
      this.#previousResponseId = null
      this.#pendingToolContinuation = false
      this.#pendingCallId = null
      if (responseId !== null && !terminal) {
        yield {kind: 'response_failed', response_id: responseId, code: stable.code}
        return
      }
      throw stable
    }
  }

  abandonPendingResponse(): Promise<void> {
    if (this.#closed) return Promise.reject(fail('closed'))
    if (this.#pendingToolContinuation) this.#previousResponseId = null
    this.#pendingToolContinuation = false
    this.#pendingCallId = null
    return Promise.resolve()
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#history = []; this.#turnItems = []
    this.#previousResponseId = null
    this.#pendingToolContinuation = false
    this.#pendingCallId = null
    await this.#gateway.close()
  }
}

export function createArkCascadedLlmSession(
  gateway: ArkResponsesGateway,
): CascadedLlmSession {
  return new Session(gateway)
}

export function createArkCascadedLlmFactory(
  options: ArkCascadedLlmFactoryOptions,
): CascadedLlmFactory {
  return {open: input => new Session(createFetchArkResponsesGateway(options),input?.history,options.protocol==='openai-compatible')}
}
