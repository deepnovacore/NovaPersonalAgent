import {committedConversationPairsSchema,type CommittedConversationPair} from '../history.js'
import type {PromptLanguage} from '../prompt-language.js'
import {cascadedNarrationInstructions} from './llm.js'
import {originalImageUrl, toolObservations, trimToolImages, imageFreeMessage, MAX_CASCADED_LLM_HISTORY_ITEMS, MAX_CASCADED_LLM_HISTORY_CODEPOINTS} from './llm.js'
import {llmToolCallLimit} from './llm-stream-limits.js'
import { jsonValueSchema, type JsonValue } from '../../core/events.js'
import { codePointLengthLikePython, stripLikePython } from '../../text/python-text.js'
import {canonicalJson} from '../../text/canonical-json.js'
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
  #historyLimits={items:MAX_CASCADED_LLM_HISTORY_ITEMS,codepoints:MAX_CASCADED_LLM_HISTORY_CODEPOINTS}
  setHistoryLimits(limits:{items:number;codepoints:number}):void{if(this.#started||limits.items<1||limits.items>2048||limits.codepoints<1||limits.codepoints>32*1024*1024)throw fail('configuration');this.#historyLimits={...limits}}
  #portable=false
  checkpoint():JsonValue{
    this.#portable=true
    return structuredClone({protocol:'responses',history:this.#history,pending:this.#turnItems,pending_call_ids:this.#pendingCallIds})
  }
  restoreCheckpoint(checkpoint:JsonValue):void{
    if(this.#started||this.#seeded||this.#closed||!checkpoint||typeof checkpoint!=='object'||Array.isArray(checkpoint)||checkpoint.protocol!=='responses'||!Array.isArray(checkpoint.history)||!Array.isArray(checkpoint.pending))throw fail('protocol')
    // Read the earlier single-call journal format without discarding any tool result.
    const pendingIds=checkpoint.pending_call_ids??(checkpoint.pending_call_id===null?[]:[checkpoint.pending_call_id])
    if(!Array.isArray(pendingIds)||pendingIds.length>this.#toolCallLimit||!pendingIds.every(validIdentifier)||new Set(pendingIds).size!==pendingIds.length)throw fail('protocol')
    const objectItem=(item:unknown)=>!!item&&typeof item==='object'&&!Array.isArray(item)
    if(!checkpoint.history.every(unit=>Array.isArray(unit)&&unit.every(objectItem))||!checkpoint.pending.every(objectItem))throw fail('protocol')
    for(const unit of [...checkpoint.history,checkpoint.pending]){
      const outstanding=new Set<string>()
      for(const value of unit as JsonObject[]){
        if(value.type==='function_call'){
          if(!validIdentifier(value.call_id)||!validIdentifier(value.name)||typeof value.arguments!=='string'||outstanding.has(value.call_id)||outstanding.size>=this.#toolCallLimit)throw fail('protocol')
          outstanding.add(value.call_id)
        }else if(value.type==='function_call_output'&&(typeof value.call_id!=='string'||!outstanding.delete(value.call_id)||typeof value.output!=='string'))throw fail('protocol')
      }
      if(unit===checkpoint.pending){if(outstanding.size!==pendingIds.length||pendingIds.some(id=>!outstanding.has(id)))throw fail('protocol')}
      else if(outstanding.size)throw fail('protocol')
    }
    this.#history=structuredClone(checkpoint.history) as JsonObject[][];this.#turnItems=structuredClone(checkpoint.pending) as JsonObject[]
    this.#pendingCallIds=[...pendingIds];this.#pendingToolContinuation=this.#pendingCallIds.length>0;this.#previousResponseId=null;this.#portable=true;this.#seeded=true
    trimToolImages([...this.#history.flat(),...this.#turnItems])
  }
  readonly #gateway: ArkResponsesGateway
  #started=false
  #seeded=false
  #previousResponseId: string | null = null
  #pendingToolContinuation = false
  #closed = false
  #visualHistory = false
  #pendingCallIds:string[]=[]
  readonly #toolCallLimit:number
  readonly #stateless: boolean
  #history: JsonObject[][] = []
  #turnItems: JsonObject[] = []

  constructor(gateway: ArkResponsesGateway,history?:readonly CommittedConversationPair[],stateless=false,toolCallLimit=1) {
    this.#stateless=stateless
    this.#toolCallLimit=toolCallLimit
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
    if(this.#stateless||this.#portable) {
      const results=input.inputs.filter(item=>item.kind==='tool_result')
      const expected=[...this.#pendingCallIds].sort(),actual=results.map(result=>result.call_id).sort()
      if(expected.length!==actual.length||expected.some((id,index)=>id!==actual[index])||input.inputs.slice(0,actual.length).some(item=>item.kind!=='tool_result'))throw fail('protocol')
    }
    const current = inputItems(input.inputs)
    const factOnly = input.inputs.some(item => item.kind === 'host_activation')
    if (input.inputs.some(item => item.kind === 'user_text' && item.image)) this.#visualHistory = true
    // Local replay is required to actually evict old screenshots from provider context.
    const continuing = this.#pendingToolContinuation
    const localHistory = this.#stateless || this.#portable || (this.#visualHistory || (this.#previousResponseId === null && this.#history.length > 0)) && !continuing
    if (input.inputs.some(item=>item.kind==='tool_result' && item.images?.length)) this.#portable=true
    if (!continuing) this.#turnItems = []
    this.#turnItems.push(...inputItems(input.inputs.map(item=>item.kind==='user_text'?{kind:'user_text',text:item.text}:item)))
    trimToolImages([...this.#history.flat(),...this.#turnItems])
    trimToolImages([...this.#history.flat(),...current])
    if((this.#stateless||this.#portable) && (this.#turnItems.length>this.#historyLimits.items || codePointLengthLikePython(JSON.stringify(this.#turnItems.map(imageFreeMessage)))>this.#historyLimits.codepoints))throw fail('overflow')
    let outputText = ''
    let responseId: string | null = null
    let terminal = false
    let textSeen = false
    const pendingTools:Extract<CascadedLlmEvent,{kind:'tool_call'}>[]=[]
    try {
      for await (const event of this.#gateway.stream({
        ...(input.language === undefined ? {} : {language: input.language}),
        inputItems: factOnly ? inputItems(input.inputs.filter(item => item.kind === 'host_activation' || item.kind === 'tool_result'))
          : localHistory ? [...this.#history.flat(), ...((this.#stateless||this.#portable) && continuing ? this.#turnItems : current)] : current,
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
          if (pendingTools.length && !this.#stateless&&!this.#portable) throw fail('protocol')
          textSeen = true
          outputText += event.text
          yield event
        } else if (event.kind === 'tool_call') {
          if(responseId===null||(textSeen&&!this.#stateless&&!this.#portable)||pendingTools.length>=this.#toolCallLimit||pendingTools.some(call=>call.call_id===event.call_id))throw fail('protocol')
          pendingTools.push(structuredClone(event))
        } else if (event.kind === 'response_completed') {
          if (responseId === null || event.response_id !== responseId) throw fail('protocol')
          const portableOutput=(this.#stateless||this.#portable)&&event.outputItems!==undefined
          if(portableOutput&&pendingTools.length){
            const completed=event.outputItems.filter(item=>item.type==='function_call'),ordered:typeof pendingTools=[]
            for(const item of completed){
              const call=pendingTools.find(call=>call.call_id===item.call_id)
              if(!call||call.name!==item.name||typeof item.arguments!=='string'||ordered.includes(call))throw fail('protocol')
              let args:unknown;try{args=JSON.parse(item.arguments)}catch{throw fail('protocol')}
              if(!jsonObject(args)||canonicalJson(args)!==canonicalJson(call.arguments))throw fail('protocol')
              ordered.push(call)
            }
            if(ordered.length!==pendingTools.length)throw fail('protocol')
            pendingTools.splice(0,pendingTools.length,...ordered)
          }
          terminal = true
          if(portableOutput)this.#turnItems.push(...structuredClone(event.outputItems))
          for(const pendingTool of pendingTools) {
            if(!portableOutput) this.#turnItems.push({type: 'function_call', call_id: pendingTool.call_id, name: pendingTool.name, arguments: JSON.stringify(pendingTool.arguments)})
            yield pendingTool
          }
          if (!pendingTools.length) {
            this.#history.push(portableOutput ? [...this.#turnItems] : [...this.#turnItems, {role: 'assistant', content: outputText}])
            this.#turnItems = []
            while (this.#history.length && (this.#history.flat().length > this.#historyLimits.items || codePointLengthLikePython(JSON.stringify(this.#history.map(unit=>unit.map(imageFreeMessage)))) > this.#historyLimits.codepoints)) this.#history.shift()
          }
          this.#previousResponseId = factOnly && !pendingTools.length ? null : event.response_id
          this.#pendingToolContinuation = pendingTools.length>0
          this.#pendingCallIds=pendingTools.map(call=>call.call_id)
          yield {kind:'response_completed',response_id:event.response_id}
          return
        } else {
          if (responseId !== null && event.response_id !== responseId) throw fail('protocol')
          this.#previousResponseId = null
          this.#pendingToolContinuation = false
          this.#pendingCallIds = []
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
      this.#pendingCallIds = []
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
    this.#pendingCallIds = []
    return Promise.resolve()
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#history = []; this.#turnItems = []
    this.#previousResponseId = null
    this.#pendingToolContinuation = false
    this.#pendingCallIds = []
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
  return {open: input => new Session(createFetchArkResponsesGateway(options),input?.history,options.protocol==='openai-compatible',llmToolCallLimit(options))}
}

function inputItems(inputs: readonly CascadedLlmInput[]): JsonObject[] {
  if (!inputs.some(input=>input.kind==='tool_result'&&input.images?.length)) return inputs.map(inputItem)
  const results=inputs.filter(input=>input.kind==='tool_result'),other=inputs.filter(input=>input.kind!=='tool_result')
  return [...results.map(inputItem),...toolObservations(results,true),...other.map(inputItem)]
}
