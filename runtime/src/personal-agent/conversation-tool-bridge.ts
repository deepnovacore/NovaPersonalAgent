import {randomUUID} from 'node:crypto'
import type {Assembly} from '../composition/assembly.js'
import type {RealtimeAssembly} from '../composition/realtime-assembly.js'
import type {ConversationRuntime} from './conversations.js'
import type {JsonValue} from '../core/events.js'
import type {CascadedLlmTool} from '../realtime/cascaded/llm.js'
import {chatToolAllowed} from './conversation-tool-policy.js'

export interface ConversationToolEvent {
  readonly name: string
  readonly state: 'running' | 'ok' | 'error'
  readonly summary: string
}

interface ConversationToolBridgeOptions {
  /** True only for the text Chat mode; Plan/Build keep their own tool sets. */
  readonly chat?: boolean
  readonly onTool?: (event: ConversationToolEvent) => void
}

function summarizeToolResult(result: JsonValue): string {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return ''
  const record = result as Record<string, JsonValue>
  const inner = record.result
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    const value = inner as Record<string, JsonValue>
    if (Array.isArray(value.items)) return `${value.items.length} 条`
    if (Array.isArray(value.results)) return `${value.results.length} 条`
  }
  if (typeof record.code === 'string' && /^[a-z_]{1,64}$/u.test(record.code)) return record.code
  return ''
}

/** Existing admission, controllers, approvals and executor implementations remain the authority. */
export function conversationToolBridge(core:Assembly,graph:RealtimeAssembly,options:ConversationToolBridgeOptions={}):NonNullable<ConversationRuntime['toolBridge']>{
 const tools=core.tools.schemas.flatMap(schema=>{
  const fn=schema.function as {name?:string;description?:string;parameters?:Record<string,JsonValue>}|undefined
  return fn?.name&&fn.parameters&&!core.tools.hidden.has(fn.name)&&!['task','confirm'].includes(fn.name)?[{name:fn.name,...(fn.description?{description:fn.description}:{}),parameters:fn.parameters} satisfies CascadedLlmTool]:[]
 })
 const readonlyNames=new Set(tools.filter(tool=>{const binding=core.tools.bindings.get(tool.name);return binding?.kind==='query'||binding?.executor&&core.runtime.executors.get(binding.executor)?.manifest.ops.some(op=>op.name===binding.op&&op.readonly)}).map(tool=>tool.name))
 const chatTools=options.chat===true?tools.filter(tool=>chatToolAllowed(tool.name,core.tools.bindings.get(tool.name),readonlyNames)):[]
 const allowed=options.chat===true?new Set(chatTools.map(tool=>tool.name)):new Set(tools.map(tool=>tool.name))
 type Invoke=NonNullable<ConversationRuntime['toolBridge']>['invoke']
 const invoke=async(text:Parameters<Invoke>[0],call:Parameters<Invoke>[1],signal:AbortSignal,task?:Parameters<Invoke>[3]):Promise<JsonValue>=>{
  if(!allowed.has(call.name))return {code:options.chat===true?'chat_tool_forbidden':'unknown_tool',state:'refused',message:options.chat===true?'请切换到 Plan 或 Build 后执行':'unknown tool'}
  signal.throwIfAborted()
  const origin=await graph.bridge.acceptUserTranscript(text),epoch=graph.service.session.sessionEpoch
  const terminals=new Map<string,JsonValue>(),listeners=new Set<()=>void>()
  const unsubscribe=core.runtime.observe(event=>{if(event.kind==='handoff'||event.kind==='deadline'){const id=event.payload.delegate_id;if(typeof id==='string'){terminals.set(id,event.kind==='handoff'?{...event.payload}: {status:'timed_out',outcome:'unknown'});for(const listener of listeners)listener()}}})
  try{
   options.onTool?.({name:call.name,state:'running',summary:''})
   const acceptance=await graph.service.invokeConversationTool({kind:'tool_call_ready',session_epoch:epoch,response_id:null,item_id:randomUUID(),call_id:call.id,name:call.name,arguments:call.arguments},{user:{text,epoch,origin_ref:origin},authority:{originRef:origin,sessionEpoch:epoch,acceptedUserInputRevision:0,stillWanted:()=>!signal.aborted},signal,...(task?{task}:{})})
   signal.throwIfAborted()
   if(acceptance.sync_result&&acceptance.delegate_id){
    const id=acceptance.delegate_id
    return await new Promise<JsonValue>(resolve=>{
     const cleanup=()=>{listeners.delete(check);signal.removeEventListener('abort',abort)},check=()=>{const result=terminals.get(id);if(result){cleanup();resolve(result)}},abort=()=>{core.runtime.cancelWork(id);cleanup();resolve({status:'outcome_unknown',delegate_id:id,message:'Inspect executor state before retrying.'})}
     listeners.add(check);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();check()
    })
   }
   let result:JsonValue;try{result=JSON.parse(acceptance.host_item.content) as JsonValue}catch{result={message:acceptance.host_item.content}}
   options.onTool?.({name:call.name,state:'ok',summary:summarizeToolResult(result)})
   return {accepted:acceptance.accepted,code:acceptance.code,delegate_id:acceptance.delegate_id,result}
  }catch(error){
   options.onTool?.({name:call.name,state:'error',summary:error instanceof Error?error.message.slice(0,80):''})
   throw error
  }finally{unsubscribe()}
 }
 return {tools,readonlyNames:[...readonlyNames],chatTools,origin:text=>graph.bridge.acceptUserTranscript(text),invoke}
}
