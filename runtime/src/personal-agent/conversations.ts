import {scheduleReferenceSchema} from './schedule-reference.js'
import type {Suggestion} from '../core/suggestions.js'
import type {WakeReason} from '../core/slots.js'
import type {BridgeService} from '../desktop/desktop-session.js'
import {z} from 'zod'
import {discussionReferenceSchema,type DiscussionReference,type PreparedContent} from './contracts.js'
import {randomUUID} from 'node:crypto'
import type {ScheduledRunGrant} from './scheduled-run-authority.js'
import type {CascadedLlmTool} from '../realtime/cascaded/llm.js'
import type {JsonValue} from '../core/events.js'
import type {TaskDispatchContext} from '../core/task-tools.js'
import {computerUseStateSchema} from './computer-use/contract.js'
import {buildStatusSchema} from './workbench-store.js'
export const planReferenceSchema=z.object({id:z.string(),version:z.number().int().positive(),title:z.string().max(120)}).strict()
export const localBuildSchema=z.object({computer_use:computerUseStateSchema.optional(),project:z.string(),plan_id:z.string(),plan_version:z.number().int().positive(),source_conversation_id:z.string(),status:buildStatusSchema,reason:z.string().nullable().default(null),log_revision:z.number().int().nonnegative().default(0),approval:z.object({id:z.string(),call_id:z.string(),name:z.string(),preview:z.string().max(1800)}).strict().nullable().default(null)}).strict()
export const sourceTodoSchema=z.object({id:z.string().min(1).max(512),version:z.number().int().nonnegative()}).strict()
export interface ConversationTurnContext {user_message_id?:string;local_desktop?:boolean;resume?:boolean;source_todo?:z.infer<typeof sourceTodoSchema>; prepared?:PreparedContent; references?:DiscussionReference[]; refresh?:()=>Promise<ConversationTurnContext>}
export const conversationMessageSchema=z.object({id:z.string().min(1).max(128),conversation_id:z.string().min(1).max(128),role:z.enum(['user','assistant']),schedule_ref:scheduleReferenceSchema.optional(),references:z.array(discussionReferenceSchema).max(2).optional(),source_todo:sourceTodoSchema.optional(),delivery:z.enum(['completed','interrupted','generated']).optional(),generation_status:z.enum(['pending','completed','failed','interrupted']).optional(),read:z.boolean().optional(),text:z.string().max(16000),full_text_ref:z.boolean().optional(),created_at:z.string().datetime(),reply_to:z.string().max(128).optional(),request_id:z.string().max(128).optional(),turn_id:z.string().max(512).optional()}).strict()
export const codingTargetSchema=z.object({workspace_id:z.string().min(1).max(128),session_id:z.string().min(1).max(128).nullable(),project:z.string().min(1).max(120),title:z.string().max(120),executor:z.literal('codex')}).strict()
export const conversationSchema=z.object({mode:z.enum(['chat','plan']).optional(),plan:planReferenceSchema.optional(),build:localBuildSchema.optional(),scheduled_result_focus:z.string().min(1).max(128).optional(),coding_target:codingTargetSchema.nullable().default(null),id:z.string().min(1).max(128),kind:z.enum(['chat','topic','proactive','schedule','build']),title:z.string().min(1).max(120),subject_key:z.string().max(512).nullable(),created_at:z.string().datetime(),updated_at:z.string().datetime(),generation:z.number().int().nonnegative(),messages:z.array(conversationMessageSchema).max(512),feed_ids:z.array(z.string().max(128)).max(256),read_through_id:z.string().nullable().default(null),prepared:z.object({trust:z.literal('untrusted_external'),text:z.string().max(12000),evidence_refs:z.array(z.string().max(512)).max(32)}).strict().nullable()}).strict()
export type Conversation=z.infer<typeof conversationSchema>
export const conversationsStateSchema=z.object({selected_id:z.string(),voice_id:z.string().nullable(),items:z.array(conversationSchema).min(2).max(192),work_owners:z.record(z.string(),z.string()),approval_owners:z.record(z.string(),z.string())}).strict().refine(state=>state.items.filter(item=>item.kind!=='schedule').length<=128&&state.items.filter(item=>item.kind==='schedule').length<=64&&!state.items.some(item=>item.kind==='schedule'&&(item.id===state.selected_id||item.id===state.voice_id)),'invalid_conversation_ownership')
export type ConversationsState=z.infer<typeof conversationsStateSchema>
export function createConversation(kind:Conversation['kind'],title:string,subject_key:string|null=null,id:string=randomUUID()):Conversation {const at=new Date().toISOString();return {id,kind,title,subject_key,coding_target:null,created_at:at,updated_at:at,generation:0,messages:[],feed_ids:[],read_through_id:null,prepared:null}}
export function nextConversationTitle(items:readonly Pick<Conversation,'title'>[]):string{const titles=new Set(items.map(item=>item.title));let number=1;while(titles.has(`新对话 ${number}`))number++;return `新对话 ${number}`}
export function initialConversations():ConversationsState{return {selected_id:'chat:main',voice_id:null,items:[createConversation('chat',nextConversationTitle([]),null,'chat:main'),createConversation('proactive','主动提醒',null,'chat:proactive')],work_owners:{},approval_owners:{}}}
export interface ConversationRuntime {
 toolBridge?:{computerRun?:(text:string,call:{id:string;name:string;arguments:Record<string,JsonValue>},signal:AbortSignal)=>Promise<JsonValue>;readonly tools:readonly CascadedLlmTool[];readonly readonlyNames:readonly string[];origin:(text:string)=>Promise<string>;invoke:(text:string,call:{id:string;name:string;arguments:Record<string,JsonValue>},signal:AbortSignal,task?:TaskDispatchContext)=>Promise<JsonValue>}
 stopBuild?():Promise<void>
 localApproval?(id:string,approved:boolean):Promise<void>
 retainTasks?():boolean
 runTurn(text:string,signal:AbortSignal,context?:ConversationTurnContext):Promise<{assistant:string;turn_id?:string}>
 parkVoice?():Promise<void>
 canSwitch?():boolean
 deliverSuggestion?(suggestion:Suggestion,reason:WakeReason):void
 ownsWork?(id:string):boolean
 readonly bridgeService?:BridgeService
 sendAudio?(pcm:Uint8Array):Promise<void>
 close():Promise<void>
 approvalDecision?(approvalId:string,approved:boolean):Promise<void>
 confirmationDecision?(proposalId:string,confirmed:boolean):Promise<void>
}
export type ConversationRuntimeFactory=(conversation:Readonly<Conversation>,emit:(frame:Record<string,unknown>)=>void,mode?:'text'|'voice',lifetime?:AbortSignal,recovery?:boolean,execution?:ScheduledRunGrant)=>Promise<ConversationRuntime>
/** The global host owns resources; this pool owns only each conversation's scoped turn graph. */
export class ConversationRuntimePool {
 readonly #modes=new Map<string,'text'|'voice'|'parked'>()
 readonly #lifetimes=new Map<string,AbortController>()
 readonly #retired=new Map<string,Set<ConversationRuntime>>()
 readonly #ready=new Map<string,ConversationRuntime>()
 readonly #runtimes=new Map<string,Promise<ConversationRuntime>>()
 readonly #tails=new Map<string,Promise<unknown>>()
 readonly #busy=new Map<string,number>()
 readonly #controllers=new Map<string,AbortController>()
 #closed=false
 readonly #executions=new Map<string,string>()
 constructor(readonly create:ConversationRuntimeFactory,readonly emit:(frame:Record<string,unknown>)=>void){}
 async prepare(conversation:Conversation,execution?:ScheduledRunGrant):Promise<ConversationRuntime>{return this.#prepare(conversation,false,execution)}
 async restore(conversation:Conversation,execution?:ScheduledRunGrant):Promise<ConversationRuntime>{return this.#prepare(conversation,true,execution)}
 async #prepare(conversation:Conversation,recovery:boolean,execution?:ScheduledRunGrant):Promise<ConversationRuntime>{
  if(this.#closed)throw Error('conversation_runtime_closed')
  if(conversation.kind==='schedule'&&!execution)throw Error('scheduled_execution_required')
  if(execution&&conversation.kind!=='schedule')throw Error('invalid_scheduled_conversation')
  if(this.#executions.get(conversation.id)!==execution?.namespace&&this.#runtimes.has(conversation.id))throw Error('schedule_run_busy')
  if(execution)this.#executions.set(conversation.id,execution.namespace)
  const id=conversation.id,existing=this.#runtimes.get(id);if(existing)return existing
  const lifetime=new AbortController();this.#lifetimes.set(id,lifetime);this.#modes.set(id,'text')
  const promise=this.create(structuredClone(conversation),frame=>{if(!lifetime.signal.aborted&&this.#lifetimes.get(id)===lifetime)this.emit({...frame,conversation_id:id})},'text',lifetime.signal,recovery,execution);this.#runtimes.set(id,promise)
  try{const runtime=await promise;if(this.#closed||this.#lifetimes.get(id)!==lifetime){await runtime.close();throw Error('conversation_runtime_closed')}this.#ready.set(id,runtime);return runtime}catch(error){lifetime.abort();this.#runtimes.delete(id);this.#lifetimes.delete(id);this.#modes.delete(id);throw error}
 }
 run(conversation:Conversation,text:string,context?:ConversationTurnContext):Promise<{assistant:string;turn_id?:string}>{
  if(conversation.kind==='schedule')return Promise.reject(Error('hidden_conversation'))
  if(this.#closed)return Promise.reject(Error('conversation_runtime_closed'))
  if(!this.acceptsText(conversation.id))return Promise.reject(Error('conversation_busy'))
  this.#busy.set(conversation.id,(this.#busy.get(conversation.id)??0)+1)
  const id=conversation.id,controller=this.#controllers.get(id)??new AbortController();this.#controllers.set(id,controller)
  const operation=(this.#tails.get(id)??Promise.resolve()).then(async()=>{
   if(controller.signal.aborted)throw Error('conversation_cleared')
   if(this.#modes.get(id)==='parked'){this.#lifetimes.get(id)?.abort();this.#lifetimes.delete(id);const previous=this.#ready.get(id);this.#ready.delete(id);this.#runtimes.delete(id);this.#modes.delete(id);await previous?.close()}
   let runtime=this.#runtimes.get(id)
   if(!runtime){this.#modes.set(id,'text');const lifetime=new AbortController();this.#lifetimes.set(id,lifetime);runtime=this.create(structuredClone(conversation),frame=>{if(!lifetime.signal.aborted&&this.#lifetimes.get(id)===lifetime)this.emit({...frame,conversation_id:id})},'text',lifetime.signal);this.#runtimes.set(id,runtime);void runtime.catch(()=>{lifetime.abort();if(this.#runtimes.get(id)===runtime){this.#runtimes.delete(id);this.#lifetimes.delete(id);this.#modes.delete(id)}})}
   const ready=await runtime;this.#ready.set(id,ready);const current=context?.refresh?await context.refresh():context;controller.signal.throwIfAborted();return ready.runTurn(text,controller.signal,current)
  })
  this.#tails.set(id,operation.catch(()=>{ /* the next turn may retry after an explicit failure */ }))
  return operation.finally(()=>{const count=(this.#busy.get(id)??1)-1;if(count)this.#busy.set(id,count);else this.#busy.delete(id)})
 }
 canChangeTarget(id:string):boolean{return !this.#busy.has(id)&&this.#ready.get(id)?.canSwitch?.()!==false}
 hasVoice(id:string):boolean{return this.#modes.get(id)==='voice'}
 acceptsText(id:string):boolean{return this.#modes.get(id)!=='voice'&&(this.#modes.get(id)!=='parked'||this.#ready.get(id)?.canSwitch?.()!==false)}
 async stopVoice(id:string):Promise<void>{const runtime=this.#ready.get(id);await runtime?.parkVoice?.();this.#modes.set(id,'parked')}
 async stopBuild(id:string):Promise<void>{const controller=this.#controllers.get(id);controller?.abort();const runtime=await this.#runtimes.get(id);await runtime?.stopBuild?.();await this.#tails.get(id);if(this.#controllers.get(id)===controller)this.#controllers.delete(id)}
 async localApproval(id:string,approvalId:string,approved:boolean):Promise<void>{const runtime=await this.#runtimes.get(id);if(!runtime?.localApproval)throw Error('local_approval_unavailable');await runtime.localApproval(approvalId,approved)}
 async clear(id:string):Promise<void>{this.#modes.delete(id);this.#lifetimes.get(id)?.abort();this.#lifetimes.delete(id);this.#controllers.get(id)?.abort();await this.#tails.get(id);const runtime=this.#runtimes.get(id);this.#runtimes.delete(id);this.#ready.delete(id);this.#controllers.delete(id);this.#tails.delete(id);if(runtime){const ready=await runtime;if(!this.#closed&&ready.retainTasks?.()){await ready.parkVoice?.();const retained=this.#retired.get(id)??new Set<ConversationRuntime>();retained.add(ready);this.#retired.set(id,retained)}else await ready.close()}}
 async startVoice(conversation:Conversation):Promise<void>{if(conversation.kind==='schedule')throw Error('hidden_conversation');if(this.#closed)throw Error('conversation_runtime_closed');if(this.#busy.has(conversation.id)||this.#ready.get(conversation.id)?.canSwitch?.()===false)throw Error('conversation_busy');await this.clear(conversation.id);if(this.#closed)throw Error('conversation_runtime_closed');this.#modes.set(conversation.id,'voice');const lifetime=new AbortController();this.#lifetimes.set(conversation.id,lifetime);const runtime=this.create(structuredClone(conversation),frame=>{if(!lifetime.signal.aborted&&this.#lifetimes.get(conversation.id)===lifetime)this.emit({...frame,conversation_id:conversation.id})},'voice',lifetime.signal);this.#runtimes.set(conversation.id,runtime);let ready:ConversationRuntime;try{ready=await runtime}catch(error){lifetime.abort();if(this.#runtimes.get(conversation.id)===runtime){this.#runtimes.delete(conversation.id);this.#lifetimes.delete(conversation.id);this.#modes.delete(conversation.id)}throw error}if(this.#closed||this.#lifetimes.get(conversation.id)!==lifetime)throw Error('conversation_runtime_closed');this.#ready.set(conversation.id,ready)}
 deliverSuggestion(id:string,suggestion:Suggestion,reason:WakeReason):void{this.#ready.get(id)?.deliverSuggestion?.(suggestion,reason)}
 workConversation(id:string):string|undefined{for(const [conversation,runtime] of this.#ready)if(runtime.ownsWork?.(id))return conversation;for(const [conversation,runtimes] of this.#retired)for(const runtime of runtimes)if(runtime.ownsWork?.(id))return conversation;return undefined}
 service(id:string):BridgeService|undefined{return this.#ready.get(id)?.bridgeService}
 async sendAudio(id:string,pcm:Uint8Array):Promise<void>{const runtime=await this.#runtimes.get(id);if(!runtime?.sendAudio)throw Error('voice_unavailable');await runtime.sendAudio(pcm)}
 async confirm(id:string,proposalId:string,confirmed:boolean):Promise<void>{const runtime=await this.#runtimes.get(id);if(!runtime?.confirmationDecision)throw Error('confirmation_unavailable');await runtime.confirmationDecision(proposalId,confirmed)}
 async approve(id:string,approvalId:string,approved:boolean):Promise<void>{const candidates=[await this.#runtimes.get(id),...(this.#retired.get(id)??[])];for(const runtime of candidates){if(!runtime?.approvalDecision)continue;try{await runtime.approvalDecision(approvalId,approved);return}catch{}}throw Error('approval_unavailable')}
 async close():Promise<void>{this.#closed=true;await Promise.all([...new Set([...this.#controllers.keys(),...this.#runtimes.keys()])].map(id=>this.clear(id)));await Promise.all([...this.#retired.values()].flatMap(items=>[...items].map(runtime=>runtime.close())));this.#retired.clear()}
}

/** Acknowledgements cover only messages actually visible, never later arrivals. */
export function markConversationRead(conversation:Conversation,throughId:string):void {
 const index=conversation.messages.findIndex(message=>message.id===throughId)
 if(index<0)throw Error('message_not_found')
 for(const message of conversation.messages.slice(0,index+1))message.read=true
 conversation.read_through_id=throughId
}
export function conversationUnreadCount(conversation:Readonly<Conversation>):number {
 return conversation.messages.filter(message=>message.role==='assistant'&&message.read!==true&&(conversation.kind==='proactive'||message.schedule_ref?.run_id!==undefined)).length
}
