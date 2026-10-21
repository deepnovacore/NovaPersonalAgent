import {randomUUID} from 'node:crypto'
import type {Assembly} from '../composition/assembly.js'
import type {RealtimeAssembly} from '../composition/realtime-assembly.js'
import type {ConversationRuntime} from './conversations.js'
import type {JsonValue} from '../core/events.js'
import type {CascadedLlmTool} from '../realtime/cascaded/llm.js'

/** Existing admission, controllers, approvals and executor implementations remain the authority. */
export function conversationToolBridge(core:Assembly,graph:RealtimeAssembly,onComputerRun?:(active:boolean)=>void):NonNullable<ConversationRuntime['toolBridge']>{
 const tools=core.tools.schemas.flatMap(schema=>{
  const fn=schema.function as {name?:string;description?:string;parameters?:Record<string,JsonValue>}|undefined
  return fn?.name&&fn.parameters&&!core.tools.hidden.has(fn.name)&&!['task','confirm'].includes(fn.name)?[{name:fn.name,...(fn.description?{description:fn.description}:{}),parameters:fn.parameters} satisfies CascadedLlmTool]:[]
 })
 const readonlyNames=tools.filter(tool=>{const binding=core.tools.bindings.get(tool.name);return binding?.kind==='query'||binding?.executor&&core.runtime.executors.get(binding.executor)?.manifest.ops.some(op=>op.name===binding.op&&op.readonly)}).map(tool=>tool.name)
 type Invoke=NonNullable<ConversationRuntime['toolBridge']>['invoke']
 const invoke=async(text:Parameters<Invoke>[0],call:Parameters<Invoke>[1],signal:AbortSignal,task?:Parameters<Invoke>[3],waitForComputer=false):Promise<JsonValue>=>{
  if(!tools.some(tool=>tool.name===call.name))return {code:'unknown_tool',state:'refused'}
  signal.throwIfAborted()
  const origin=await graph.bridge.acceptUserTranscript(text),epoch=graph.service.session.sessionEpoch
  const terminals=new Map<string,JsonValue>(),listeners=new Set<()=>void>()
  const unsubscribe=core.runtime.observe(event=>{if(event.kind==='handoff'||!waitForComputer&&event.kind==='deadline'){const id=event.payload.delegate_id;if(typeof id==='string'){terminals.set(id,event.kind==='handoff'?{...event.payload}: {status:'timed_out',outcome:'unknown'});for(const listener of listeners)listener()}}})
  try{
   const acceptance=await graph.service.invokeConversationTool({kind:'tool_call_ready',session_epoch:epoch,response_id:null,item_id:randomUUID(),call_id:call.id,name:call.name,arguments:call.arguments},{user:{text,epoch,origin_ref:origin},authority:{originRef:origin,sessionEpoch:epoch,acceptedUserInputRevision:0,stillWanted:()=>!signal.aborted},signal,...(task?{task}:{})})
   if(!waitForComputer)signal.throwIfAborted()
   if((acceptance.sync_result||waitForComputer)&&acceptance.delegate_id){
    const id=acceptance.delegate_id
    return await new Promise<JsonValue>(resolve=>{
     const cleanup=()=>{listeners.delete(check);signal.removeEventListener('abort',abort)},check=()=>{const result=terminals.get(id);if(result){cleanup();resolve(result)}},abort=()=>{core.runtime.cancelWork(id);if(!waitForComputer){cleanup();resolve({status:'outcome_unknown',delegate_id:id,message:'Inspect executor state before retrying.'})}}
     listeners.add(check);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();check()
    })
   }
   let result:JsonValue;try{result=JSON.parse(acceptance.host_item.content) as JsonValue}catch{result={message:acceptance.host_item.content}}
   return {accepted:acceptance.accepted,code:acceptance.code,delegate_id:acceptance.delegate_id,result}
  }finally{unsubscribe()}
 }
 return {tools,readonlyNames,origin:text=>graph.bridge.acceptUserTranscript(text),invoke,
  computerRun:async(text,call,signal)=>{
   onComputerRun?.(true)
   try{return await invoke(text,{id:call.id,name:'dispatch',arguments:{executor:'computer',instruction:call.arguments.instruction??''}},signal,undefined,true)}finally{onComputerRun?.(false)}
  },
 }
}
