import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import {appContextArguments} from '../core/schedule-tools.js'
import type {CompiledTools,ToolBinding} from '../core/tool-schema.js'
import type {JsonValue} from '../core/events.js'
import {validParams,type ToolAcceptance,type ToolCallReady} from '../realtime/bridge.js'
import type {RealtimeSession} from '../realtime/session.js'
import type {UnifiedRetrieval} from '../memory/retrieval.js'
import type {PersonalAgentHost} from './host.js'
import type {ScheduledRunGrant} from './scheduled-run-authority.js'
import type {ScheduledResponseScope} from './scheduled-response-scope.js'
const recallSchema=z.object({query:z.string().trim().min(1).max(512),scope:z.enum(['recent','any']),source:z.literal('personal').optional()}).strict()
const evidenceSchema=z.object({evidence_id:z.string().min(1).max(512)}).strict()
export function scheduledToolResult(call:ToolCallReady,data:unknown,code='ok',accepted=true,maxBytes=32768):ToolAcceptance{
 const content=JSON.stringify(data)
 if(Buffer.byteLength(content)>maxBytes)throw Error('context_capacity')
 const item={kind:'tool_output' as const,context_read:true as const,host_item_id:randomUUID(),event_id:randomUUID(),call_id:call.call_id,content}
 return {accepted,code,host_item:item,response_intent:{kind:'tool_result',item,task_summary:null,origin_spoken:false},delegate_id:null,sync_result:false,executor:null,op:null,inline_fulfilled:accepted,telemetry:null}
}
export class ScheduledToolRuntime{
 constructor(readonly options:{host:PersonalAgentHost;grant:ScheduledRunGrant;scope:ScheduledResponseScope;tools:CompiledTools;retrieval:UnifiedRetrieval;session:()=>Pick<RealtimeSession,'sessionEpoch'|'activeProviderResponseId'|'providerTurnPhase'|'providerTurnWasFenced'>;readonlyOperation:(executor:string,op:string)=>boolean;dispatch:(binding:ToolBinding,args:Readonly<Record<string,JsonValue>>)=>Promise<{accepted:boolean;delegate_id:string|null}>}){}
 async validateContext():Promise<boolean>{
  const {host,grant}=this.options
  try{host.scheduledAuthority.assert(grant,grant.fence);if(host.schedules.getRun(grant.run_id).processing){if(!host.schedules.getRun(grant.run_id).processing!.exhausted&&await host.sourceProcessingAgent.validate(grant))return true;throw Error('processing_context_unavailable')}if(await host.appContext.validateTask(grant.task_id,grant.consumer))return true}catch{/* stale authority is never usable */}
  try{const task=host.tasks.get(grant.task_id);if(task.pending_delivery)await host.tasks.finishDelivery(task.id,task.pending_delivery);await host.tasks.wait(grant.fence,'context_authorization_changed')}catch{/* a newer owner or terminal state wins */}
  return false
 }
 async accept(call:ToolCallReady):Promise<ToolAcceptance>{
  const {host,grant,scope,tools,retrieval}=this.options,session=this.options.session(),responseId=call.response_id??session.activeProviderResponseId
  try{
   if(!responseId)throw Error('scheduled_response_unbound')
   scope.acceptCall(call.session_epoch,responseId,call.call_id,call.session_epoch===session.sessionEpoch&&session.activeProviderResponseId===responseId&&session.providerTurnPhase(responseId)==='active'&&!session.providerTurnWasFenced(responseId))
   if(!await this.validateContext())throw Error('context_authorization_changed')
   const run=host.schedules.getRun(grant.run_id),context=run.definition.context,binding=tools.bindings.get(call.name)
   if(run.processing){if(call.name!=='source__process')throw Error('scheduled_tool_readonly');return scheduledToolResult(call,await host.sourceProcessingAgent.call(grant,call.call_id,call.arguments),'ok',true,131072)}
   if(call.name==='app__context'){
    const args=appContextArguments.parse(call.arguments)
    return scheduledToolResult(call,await host.readAppContext(args.section,args.cursor,grant))
   }
   if(call.name==='memory__recall'||call.name==='memory__evidence'){
    if(!grant.consumer)throw Error('memory_consumer_unavailable')
    let result,refs:string[]
    if(call.name==='memory__recall'){
     if(!context.memory&&!context.knowledge)throw Error('context_not_authorized')
     const args=recallSchema.parse(call.arguments),found=await retrieval.recall(args.query,{scope:args.scope,consumer:grant.consumer,limit:8})
     result={...found,entries:context.memory?found.entries:[],snippets:context.knowledge?found.snippets:[]}
     refs=[...new Set([...result.entries.flatMap(entry=>entry.evidence_refs),...result.snippets.map(snippet=>snippet.evidence_id)])]
    }else{
     if(!context.knowledge)throw Error('context_not_authorized')
     const args=evidenceSchema.parse(call.arguments)
     result=await retrieval.evidence(args.evidence_id,{consumer:grant.consumer});refs=result.evidence?[result.evidence.evidence_id]:[]
    }
    host.scheduledAuthority.assert(grant,grant.fence)
    if(!await host.appContext.validateRefs(refs,grant.consumer,grant.task_id))throw Error('context_authorization_changed')
    await host.tasks.recordContextEvidence(grant.fence,call.call_id,JSON.stringify({consumer:grant.consumer,projection:result}),refs)
    if(!await this.validateContext())throw Error('context_authorization_changed')
    return scheduledToolResult(call,result)
   }
   if(binding?.kind==='delegate'&&binding.executor==='search'&&binding.op&&context.search&&this.options.readonlyOperation(binding.executor,binding.op)){
    const raw={...call.arguments};delete raw.origin_ref
    const schema=tools.schemas.find(schema=>(schema.function as Record<string,JsonValue>|undefined)?.name===call.name)?.function as {parameters?:Readonly<Record<string,JsonValue>>}|undefined
    const parameters:Record<string,JsonValue>=structuredClone(schema?.parameters??{}),properties=parameters.properties as Record<string,JsonValue>|undefined
    if(properties)delete properties.origin_ref
    if(Array.isArray(parameters.required))parameters.required=parameters.required.filter(key=>key!=='origin_ref')
    if(!validParams(raw,parameters))throw Error('invalid_params')
    const admitted=await this.options.dispatch(binding,raw)
    if(!admitted.accepted||!admitted.delegate_id)throw Error('runtime_rejected')
    return {...scheduledToolResult(call,{state:'pending'},'accepted'),delegate_id:admitted.delegate_id,sync_result:true,executor:binding.executor,op:binding.op,inline_fulfilled:false}
   }
   throw Error('scheduled_tool_readonly')
  }catch(error){const code=error instanceof z.ZodError?'invalid_params':error instanceof Error?error.message:'scheduled_tool_failed';return scheduledToolResult(call,{state:'refused',code},code,false)}
 }
}
