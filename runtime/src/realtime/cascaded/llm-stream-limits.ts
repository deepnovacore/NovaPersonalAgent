export interface LlmStreamLimits {
 readonly events:number
 readonly responseBytes:number
 readonly eventBytes:number
 readonly lineBytes:number
}
export interface LlmTransportOptions {
 readonly idleTimeoutMs?:number
 readonly streamLimits?:Partial<LlmStreamLimits>
 readonly maxToolCallsPerResponse?:number
}

export const DEFAULT_LLM_STREAM_LIMITS:Readonly<LlmStreamLimits>=Object.freeze({events:4096,responseBytes:8*1024*1024,eventBytes:512*1024,lineBytes:256*1024})
// Local builds can produce large file arguments and many small streaming deltas.
// This bounds each model request; the complete agent loop has no wall-clock limit.
export const PLAN_LLM_TRANSPORT:Readonly<LlmTransportOptions>=Object.freeze({maxToolCallsPerResponse:24})
export const BUILD_LLM_TRANSPORT:Readonly<LlmTransportOptions>=Object.freeze({...PLAN_LLM_TRANSPORT,maxToolCallsPerResponse:64,idleTimeoutMs:10*60*1000,streamLimits:Object.freeze({events:65536,responseBytes:32*1024*1024,eventBytes:8*1024*1024,lineBytes:8*1024*1024})})
export function llmToolCallLimit(options:LlmTransportOptions):number {
 const limit=options.maxToolCallsPerResponse??1
 if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw Error('invalid_llm_tool_call_limit')
 return limit
}
export function llmStreamLimits(options:LlmTransportOptions):LlmStreamLimits {
 const limits={...DEFAULT_LLM_STREAM_LIMITS,...options.streamLimits}
 if(Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<=0))throw Error('invalid_llm_stream_limits')
 return limits
}
