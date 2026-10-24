/** Effective capabilities of a model served through one specific adapter. */
export interface RealtimeCapabilities {
  readonly model: {
    readonly functionCalling: boolean
    readonly audioInput: boolean
    readonly textInput: boolean
    readonly audioOutput: boolean
    readonly textOutput: boolean
    readonly nativeFullDuplex: boolean
  }
  readonly protocol: {
    readonly conversationItems: boolean
    readonly clientResponses: boolean
    readonly mutableSession: boolean
    readonly restoreConversationContext: boolean
    readonly cancelResponse: boolean
    readonly inputTranscription: boolean
    readonly responseBoundary: 'turn' | 'session'
  }
}

const agent: RealtimeCapabilities = Object.freeze({
  model: Object.freeze({functionCalling:true, audioInput:true, textInput:true, audioOutput:true, textOutput:true, nativeFullDuplex:false}),
  protocol: Object.freeze({conversationItems:true, clientResponses:true, mutableSession:true, restoreConversationContext:true, cancelResponse:true, inputTranscription:true, responseBoundary:'turn'}),
})
const native: RealtimeCapabilities = Object.freeze({
  model: Object.freeze({functionCalling:false, audioInput:true, textInput:false, audioOutput:true, textOutput:true, nativeFullDuplex:true}),
  protocol: Object.freeze({conversationItems:false, clientResponses:false, mutableSession:false, restoreConversationContext:false, cancelResponse:false, inputTranscription:false, responseBoundary:'session'}),
})

/** Service dialect is explicit: these native profiles describe SGLang, not every model deployment. */
export const realtimeCapabilities = Object.freeze({
  qwen: agent,
  stepfun: agent,
  openai: agent,
  gemini: {...agent, protocol: {...agent.protocol, mutableSession:false}},
  cascaded: agent,
  'sglang-minicpm-o': {...native, protocol: {...native.protocol, responseBoundary:'turn'}},
  'sglang-personaplex': native,
}) satisfies Readonly<Record<string, RealtimeCapabilities>>
