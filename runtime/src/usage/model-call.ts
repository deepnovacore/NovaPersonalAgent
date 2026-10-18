import {randomUUID} from 'node:crypto'
import {reportUsage,usageReporterForEndpoint,type UsageReport,type UsageReporter,type UsageService} from '../realtime/usage.js'
import {currentUsageContext} from './context.js'

export function endpointProvider(endpoint:string):UsageReport['provider'] {
 try{
  const url=new URL(endpoint)
  if(url.username||url.password||(url.port&&url.port!=='443')||!['https:','wss:'].includes(url.protocol))return 'custom'
  const host=url.hostname
  if(['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com'].includes(host))return 'qwen'
  if(host==='openrouter.ai')return 'openrouter'
  if(host==='api.openai.com')return 'openai'
  if(host==='api.deepseek.com')return 'deepseek'
  if(host==='generativelanguage.googleapis.com')return 'gemini'
  if(host==='ark.cn-beijing.volces.com')return 'ark'
  if(host==='api.stepfun.com')return 'stepfun'
 }catch{/* Custom endpoints have no inferred list price. */}
 return 'custom'
}
const object=(value:unknown):Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{}
/** SSE usage frames are cumulative but may only contain a subset of meters. */
export function mergeModelUsage(previous:unknown,next:unknown):Record<string,unknown> {
 const result={...object(previous)}
 for(const [key,value] of Object.entries(object(next))){
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0)result[key]=value
  else if(value&&typeof value==='object')result[key]=mergeModelUsage(result[key],value)
 }
 return result
}
/** Captured at dispatch, not when an asynchronous stream tail eventually finishes. */
export function beginModelUsage(reporter:UsageReporter|undefined,endpoint:string,model:string,service:UsageService='llm',providerHint?:UsageReport['provider'],reasoningMode?:UsageReport['reasoningMode']) {
 const id=randomUUID(),started=performance.now(),timestamp=new Date().toISOString(),context=currentUsageContext()
 const publish=usageReporterForEndpoint(reporter,endpoint),provider=endpointProvider(endpoint)==='custom'?providerHint??'custom':endpointProvider(endpoint)
 let finished=false
 return (raw:unknown,outcome:UsageReport['outcome'],requestId?:string|null)=>{
  if(finished)return;finished=true
  const usage=object(raw),input=object(usage.prompt_tokens_details),output=object(usage.completion_tokens_details)
  const meter=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined
  const inputTokens=meter(usage.prompt_tokens??usage.input_tokens??(service==='embedding'?usage.total_tokens:undefined)),outputTokens=meter(usage.completion_tokens??usage.output_tokens)
  const counts={inputTokens,outputTokens,cachedTokens:meter(usage.prompt_cache_hit_tokens??input.cached_tokens),reasoningTokens:meter(output.reasoning_tokens)}
  reportUsage(publish,{id,provider,service,model,timestamp,durationMs:Math.round(performance.now()-started),...context,
   feature:context.feature??(service==='embedding'?'embedding':'other'),outcome:outcome??'error',
   ...(reasoningMode?{reasoningMode}:{}),
   status:inputTokens!==undefined&&(service==='embedding'||outputTokens!==undefined)?'complete':'missing',
   ...Object.fromEntries(Object.entries(counts).filter(([,v])=>v!==undefined)),
   ...(requestId?{providerRequestId:requestId}:{}),
   ...(provider==='openrouter'&&typeof usage.cost==='number'?{reportedCostUsd:usage.cost}:{}),
  })
 }
}
