import type {Suggestion} from '../core/suggestions.js'
import type {WakeReason} from '../core/slots.js'
import type {BridgeService} from '../desktop/desktop-session.js'
import {z} from 'zod'
import {randomUUID} from 'node:crypto'
export const conversationMessageSchema=z.object({id:z.string().min(1).max(128),conversation_id:z.string().min(1).max(128),role:z.enum(['user','assistant']),delivery:z.enum(['completed','interrupted','generated']).optional(),generation_status:z.enum(['pending','completed','failed','interrupted']).optional(),read:z.boolean().optional(),text:z.string().max(16000),created_at:z.string().datetime(),reply_to:z.string().max(128).optional(),request_id:z.string().max(128).optional(),turn_id:z.string().max(512).optional()}).strict()
export const codingTargetSchema=z.object({workspace_id:z.string().min(1).max(128),session_id:z.string().min(1).max(128).nullable(),project:z.string().min(1).max(120),title:z.string().max(120),executor:z.literal('codex')}).strict()
export const conversationSchema=z.object({coding_target:codingTargetSchema.nullable().default(null),id:z.string().min(1).max(128),kind:z.enum(['chat','topic','proactive']),title:z.string().min(1).max(120),subject_key:z.string().max(512).nullable(),created_at:z.string().datetime(),updated_at:z.string().datetime(),generation:z.number().int().nonnegative(),messages:z.array(conversationMessageSchema).max(512),feed_ids:z.array(z.string().max(128)).max(256),read_through_id:z.string().nullable().default(null),prepared:z.object({trust:z.literal('untrusted_external'),text:z.string().max(12000),evidence_refs:z.array(z.string().max(512)).max(32)}).strict().nullable()}).strict()
export type Conversation=z.infer<typeof conversationSchema>
export type ConversationMessage=z.infer<typeof conversationMessageSchema>
export const conversationsStateSchema=z.object({selected_id:z.string(),voice_id:z.string().nullable(),items:z.array(conversationSchema).min(2).max(128),work_owners:z.record(z.string(),z.string()),approval_owners:z.record(z.string(),z.string())}).strict()
export type ConversationsState=z.infer<typeof conversationsStateSchema>
export function createConversation(kind:Conversation['kind'],title:string,subject_key:string|null=null,id:string=randomUUID()):Conversation {const at=new Date().toISOString();return {id,kind,title,subject_key,coding_target:null,created_at:at,updated_at:at,generation:0,messages:[],feed_ids:[],read_through_id:null,prepared:null}}
export function nextConversationTitle(items:readonly Pick<Conversation,'title'>[]):string{const titles=new Set(items.map(item=>item.title));let number=1;while(titles.has(`新对话 ${number}`))number++;return `新对话 ${number}`}
export function initialConversations():ConversationsState{return {selected_id:'chat:main',voice_id:null,items:[createConversation('chat',nextConversationTitle([]),null,'chat:main'),createConversation('proactive','主动提醒',null,'chat:proactive')],work_owners:{},approval_owners:{}}}
export interface ConversationRuntime {
 runTurn(text:string,signal:AbortSignal):Promise<{assistant:string;turn_id?:string}>
 parkVoice?():Promise<void>
 canSwitch?():boolean
 deliverSuggestion?(suggestion:Suggestion,reason:WakeReason):void
 ownsWork?(id:string):boolean
 readonly bridgeService?:BridgeService
 sendAudio?(pcm:Uint8Array):Promise<void>
 close():Promise<void>
 approvalDecision?(approvalId:string,approved:boolean):Promise<void>
}
export type ConversationRuntimeFactory=(conversation:Readonly<Conversation>,emit:(frame:Record<string,unknown>)=>void,mode?:'text'|'voice',lifetime?:AbortSignal)=>Promise<ConversationRuntime>
/** The global host owns resources; this pool owns only each conversation's scoped turn graph. */
export class ConversationRuntimePool {
 readonly #modes=new Map<string,'text'|'voice'|'parked'>()
 readonly #lifetimes=new Map<string,AbortController>()
 readonly #ready=new Map<string,ConversationRuntime>()
 readonly #runtimes=new Map<string,Promise<ConversationRuntime>>()
 readonly #tails=new Map<string,Promise<unknown>>()
 readonly #busy=new Map<string,number>()
 readonly #controllers=new Map<string,AbortController>()
 #closed=false
 constructor(readonly create:ConversationRuntimeFactory,readonly emit:(frame:Record<string,unknown>)=>void){}
 run(conversation:Conversation,text:string):Promise<{assistant:string;turn_id?:string}>{
  if(this.#closed)return Promise.reject(Error('conversation_runtime_closed'))
  if(!this.acceptsText(conversation.id))return Promise.reject(Error('conversation_busy'))
  this.#busy.set(conversation.id,(this.#busy.get(conversation.id)??0)+1)
  const id=conversation.id,controller=this.#controllers.get(id)??new AbortController();this.#controllers.set(id,controller)
  const operation=(this.#tails.get(id)??Promise.resolve()).then(async()=>{
   if(controller.signal.aborted)throw Error('conversation_cleared')
   if(this.#modes.get(id)==='parked'){this.#lifetimes.get(id)?.abort();this.#lifetimes.delete(id);const previous=this.#ready.get(id);this.#ready.delete(id);this.#runtimes.delete(id);this.#modes.delete(id);await previous?.close()}
   let runtime=this.#runtimes.get(id)
   if(!runtime){this.#modes.set(id,'text');const lifetime=new AbortController();this.#lifetimes.set(id,lifetime);runtime=this.create(structuredClone(conversation),frame=>{if(!lifetime.signal.aborted&&this.#lifetimes.get(id)===lifetime)this.emit({...frame,conversation_id:id})},'text',lifetime.signal);this.#runtimes.set(id,runtime);void runtime.catch(()=>{lifetime.abort();if(this.#runtimes.get(id)===runtime){this.#runtimes.delete(id);this.#lifetimes.delete(id);this.#modes.delete(id)}})}
   const ready=await runtime;this.#ready.set(id,ready);return ready.runTurn(text,controller.signal)
  })
  this.#tails.set(id,operation.catch(()=>{ /* the next turn may retry after an explicit failure */ }))
  return operation.finally(()=>{const count=(this.#busy.get(id)??1)-1;if(count)this.#busy.set(id,count);else this.#busy.delete(id)})
 }
 canChangeTarget(id:string):boolean{return !this.#busy.has(id)&&this.#ready.get(id)?.canSwitch?.()!==false}
 hasVoice(id:string):boolean{return this.#modes.get(id)==='voice'}
 acceptsText(id:string):boolean{return this.#modes.get(id)!=='voice'&&(this.#modes.get(id)!=='parked'||this.#ready.get(id)?.canSwitch?.()!==false)}
 async stopVoice(id:string):Promise<void>{const runtime=this.#ready.get(id);await runtime?.parkVoice?.();this.#modes.set(id,'parked')}
 async clear(id:string):Promise<void>{this.#modes.delete(id);this.#lifetimes.get(id)?.abort();this.#lifetimes.delete(id);this.#controllers.get(id)?.abort();await this.#tails.get(id);const runtime=this.#runtimes.get(id);this.#runtimes.delete(id);this.#ready.delete(id);this.#controllers.delete(id);this.#tails.delete(id);if(runtime)await (await runtime).close()}
 async startVoice(conversation:Conversation):Promise<void>{if(this.#busy.has(conversation.id)||this.#ready.get(conversation.id)?.canSwitch?.()===false)throw Error('conversation_busy');await this.clear(conversation.id);this.#modes.set(conversation.id,'voice');const lifetime=new AbortController();this.#lifetimes.set(conversation.id,lifetime);const runtime=this.create(structuredClone(conversation),frame=>{if(!lifetime.signal.aborted&&this.#lifetimes.get(conversation.id)===lifetime)this.emit({...frame,conversation_id:conversation.id})},'voice',lifetime.signal);this.#runtimes.set(conversation.id,runtime);try{this.#ready.set(conversation.id,await runtime)}catch(error){lifetime.abort();if(this.#runtimes.get(conversation.id)===runtime){this.#runtimes.delete(conversation.id);this.#lifetimes.delete(conversation.id);this.#modes.delete(conversation.id)}throw error}}
 deliverSuggestion(id:string,suggestion:Suggestion,reason:WakeReason):void{this.#ready.get(id)?.deliverSuggestion?.(suggestion,reason)}
 workConversation(id:string):string|undefined{for(const [conversation,runtime] of this.#ready)if(runtime.ownsWork?.(id))return conversation;return undefined}
 service(id:string):BridgeService|undefined{return this.#ready.get(id)?.bridgeService}
 async sendAudio(id:string,pcm:Uint8Array):Promise<void>{const runtime=await this.#runtimes.get(id);if(!runtime?.sendAudio)throw Error('voice_unavailable');await runtime.sendAudio(pcm)}
 async approve(id:string,approvalId:string,approved:boolean):Promise<void>{const runtime=await this.#runtimes.get(id);if(!runtime?.approvalDecision)throw Error('approval_unavailable');await runtime.approvalDecision(approvalId,approved)}
 async close():Promise<void>{this.#closed=true;await Promise.all([...new Set([...this.#controllers.keys(),...this.#runtimes.keys()])].map(id=>this.clear(id)))}
}

/** Acknowledgements cover only messages actually visible, never later arrivals. */
export function markConversationRead(conversation:Conversation,throughId:string):void {
 const index=conversation.messages.findIndex(message=>message.id===throughId)
 if(index<0)throw Error('message_not_found')
 for(const message of conversation.messages.slice(0,index+1))message.read=true
 conversation.read_through_id=throughId
}
export function conversationUnreadCount(conversation:Readonly<Conversation>):number {
 return conversation.kind==='proactive'?conversation.messages.filter(message=>message.role==='assistant'&&message.read!==true).length:0
}
