import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import type {TaskDispatchContext} from '../core/task-tools.js'
import {canonicalJson} from '../text/canonical-json.js'

export type TaskPhase='queued'|'running'|'verifying'|'waiting'|'completed'|'cancelled'
export type TaskActor={kind:'nova'}|{kind:'user';client_id:string}
export interface TaskFence{task_id:string;control_revision:number;goal_revision:number}
export interface TaskInput{conversation_generation?:number|undefined;conversation_id:string;goal:string;acceptance:string[];origin_ref:string;todo_ref?:{id:string;version:number}}
export interface TaskRecord extends TaskInput{id:string;phase:TaskPhase;controller:TaskActor;control_revision:number;goal_revision:number;corrections:number;work_ids:string[];session_ids:string[];evidence_refs:string[];artifact_refs:string[];waiting_reason:string|null;todo_sync:'none'|'pending'|'synced'|'conflict'}

export interface TaskEvent {seq:number;task_id:string;work_id?:string;session_id?:string;thread_id?:string;turn_id?:string;item_id?:string;stage?:'started'|'completed';kind:'message'|'tool'|'artifact'|'control'|'verification'|'status';sender?:'nova'|'user-to-executor'|'executor';text:string;refs:string[];text_truncated?:boolean}
const eventSchema=z.object({thread_id:z.string().min(1).max(512).optional(),turn_id:z.string().min(1).max(512).optional(),item_id:z.string().min(1).max(512).optional(),stage:z.enum(['started','completed']).optional(),seq:z.number().int().positive(),task_id:z.string().min(1).max(512),work_id:z.string().min(1).max(512).optional(),session_id:z.string().min(1).max(512).optional(),kind:z.enum(['message','tool','artifact','control','verification','status']),sender:z.enum(['nova','user-to-executor','executor']).optional(),text:z.string().max(16000),refs:z.array(z.string().min(1).max(512)).max(128),text_truncated:z.boolean().optional()}).strict().refine(event=>event.kind!=='message'||event.sender!==undefined,'message_sender_required')
const id=z.string().trim().min(1).max(512)
export const taskInputSchema=z.object({conversation_generation:z.number().int().nonnegative().optional(),conversation_id:id,goal:z.string().trim().min(1).max(16000),acceptance:z.array(z.string().trim().min(1).max(2000)).max(64),origin_ref:id,todo_ref:z.object({id,version:z.number().int().nonnegative()}).strict().optional()}).strict()
const actorSchema=z.union([z.object({kind:z.literal('nova')}).strict(),z.object({kind:z.literal('user'),client_id:id}).strict()])
export const taskFenceSchema=z.object({task_id:id,control_revision:z.number().int().nonnegative(),goal_revision:z.number().int().nonnegative()}).strict()
const goalSchema=taskInputSchema.pick({goal:true,acceptance:true})
const controlChangeSchema=z.object({fence:taskFenceSchema,actor:actorSchema,nextActor:actorSchema}).strict()
const goalChangeSchema=z.object({fence:taskFenceSchema,actor:actorSchema,goal:goalSchema.shape.goal,acceptance:goalSchema.shape.acceptance}).strict()
const recordSchema=taskInputSchema.extend({id,phase:z.enum(['queued','running','verifying','waiting','completed','cancelled']),controller:actorSchema,control_revision:z.number().int().nonnegative(),goal_revision:z.number().int().nonnegative(),corrections:z.number().int().nonnegative(),work_ids:z.array(id),session_ids:z.array(id),evidence_refs:z.array(id),artifact_refs:z.array(id).default([]),waiting_reason:z.string().trim().min(1).max(4000).nullable(),todo_sync:z.enum(['none','pending','synced','conflict'])}).strict()
type StoredTask=z.infer<typeof recordSchema>
const stateSchema=z.object({events:z.array(eventSchema).default([]),event_keys:z.record(z.string(),z.object({seq:z.number().int().positive(),hash:z.string()})).default({}),event_seq:z.number().int().nonnegative().default(0),truncated:z.record(z.string(),z.number().int().nonnegative()).default({}),effects:z.record(z.string(),z.object({hash:z.string(),status:z.enum(['accepted','failed','unknown']),task_id:id.optional(),session_id:id.optional(),fence:taskFenceSchema.optional(),actor:actorSchema.optional(),text:z.string().max(16000).optional()}).strict()).default({}),tasks:z.array(recordSchema),receipts:z.record(z.string(),z.object({hash:z.string(),task_id:id,result:recordSchema.optional()}).strict()),handbacks:z.record(z.string(),z.object({hash:z.string(),command:z.string().max(16384).optional(),result:z.array(recordSchema).optional()}).strict()).default({})}).strict()
type TaskState=z.infer<typeof stateSchema>
const empty=():TaskState=>({events:[],event_keys:{},event_seq:0,truncated:{},tasks:[],receipts:{},handbacks:{},effects:{}})
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex')

const grants=new WeakMap<object,{tasks:TaskService;actor:TaskActor}>()
export function taskGrantService(context:TaskDispatchContext):TaskService{const grant=grants.get(context);if(!grant)throw Error('invalid_continuation');grant.tasks.assertWritable(context.fence,grant.actor);if(grant.tasks.get(context.fence.task_id).origin_ref!==context.origin_ref)throw Error('invalid_origin_ref');return grant.tasks}
export class TaskService{
 #grants=new WeakSet<object>()
 continuationContext(fence:TaskFence):TaskDispatchContext{return this.instructionContext(fence,{kind:'nova'})}
 instructionContext(fence:TaskFence,actor:TaskActor):TaskDispatchContext{fence=Object.freeze(taskFenceSchema.parse(fence));actor=Object.freeze(actorSchema.parse(actor));this.assertWritable(fence,actor);const context=Object.freeze({fence,origin_ref:this.get(fence.task_id).origin_ref,stillWanted:()=>{try{this.assertWritable(fence,actor);return true}catch{return false}}});this.#grants.add(context);grants.set(context,{tasks:this,actor:structuredClone(actor)});return context}
 validateContinuation(context:TaskDispatchContext):void{if(!this.#grants.has(context))throw Error('invalid_continuation');this.assertWritable(context.fence,{kind:'nova'});if(context.origin_ref!==this.get(context.fence.task_id).origin_ref)throw Error('invalid_origin_ref')}
 assertWritable(fence:TaskFence,actor:TaskActor):void{this.assertCurrent(fence,actor);const task=this.get(fence.task_id);if(task.phase==='completed'||task.phase==='cancelled')throw Error('task_terminal')}

 #store:BoundedJsonStore<TaskState>;#state:TaskState=empty();#tail:Promise<unknown>=Promise.resolve()
 constructor(readonly path:string,readonly changed:()=>void=()=>{ /* optional projection observer */ }){this.#store=new BoundedJsonStore(path,stateSchema,16*1024*1024)}
 async open():Promise<void>{try{this.#state=await this.#store.read(empty())}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
 cancel(requestId:string,fence:TaskFence,actor:TaskActor):Promise<TaskRecord>{return this.#change(requestId,{fence:taskFenceSchema.parse(fence),actor:actorSchema.parse(actor),operation:'cancel'},task=>{task.phase='cancelled';task.waiting_reason=null})}
 async input(requestId:string,fence:TaskFence,actor:TaskActor,sessionId:string,text:string,send:(grant:TaskDispatchContext)=>Promise<'accepted'|'failed'|'unknown'>):Promise<'accepted'|'failed'|'unknown'>{
  const request=id.parse(requestId),session=id.parse(sessionId),instruction=z.string().trim().min(1).max(16000).parse(text),body=hash({fence,actor,session,instruction})
  const prior=await this.#mutate(next=>{
    const receipt=next.effects[request];if(receipt){if(receipt.hash!==body)throw Error('request_conflict');return receipt.status}
    this.assertWritable(fence,actor);if(!this.get(fence.task_id).session_ids.includes(session))throw Error('session_not_found')
    next.effects[request]={hash:body,status:'unknown',task_id:fence.task_id,session_id:session,fence:{...fence},actor:{...actor},text:instruction};next.events.push({seq:++next.event_seq,task_id:fence.task_id,session_id:session,kind:'message',sender:actor.kind==='user'?'user-to-executor':'nova',text:instruction,refs:[]});return null
  })
  if(prior)return prior
  let status:'accepted'|'failed'|'unknown'='unknown'
  let grant:TaskDispatchContext|undefined
  try{grant=this.instructionContext(fence,actor)}catch{status='failed'}
  if(grant)try{status=await send(grant)}catch{status='unknown'}
  await this.#mutate(next=>{next.effects[request]={...next.effects[request]!,hash:body,status};next.events.push({seq:++next.event_seq,task_id:fence.task_id,session_id:session,kind:'control',text:'Input delivery: '+status,refs:[]})})
  return status
 }
 async close():Promise<void>{await this.#tail}
 get(taskId:string):TaskRecord{const task=this.#state.tasks.find(item=>item.id===id.parse(taskId));if(!task)throw Error('task_not_found');return structuredClone(task) as TaskRecord}
 appendEvent(event:Omit<TaskEvent,'seq'>,sourceKey:string):Promise<TaskEvent>{
  const key=hash({task:event.task_id,source:z.string().min(1).max(2048).parse(sourceKey)}),text=event.text.slice(0,16000)
  const parsed=eventSchema.parse({...event,text,...(event.text.length>16000?{text_truncated:true}:{}),seq:1})
  return this.#mutate(next=>{
   const task=next.tasks.find(task=>task.id===parsed.task_id);if(!task)throw Error('task_not_found')
   if(parsed.work_id&&!task.work_ids.includes(parsed.work_id))throw Error('work_not_found')
   if(parsed.session_id&&!task.session_ids.includes(parsed.session_id))throw Error('session_not_found')
   const body=hash(parsed),prior=next.event_keys[key]
   if(prior){if(prior.hash!==body)throw Error('event_conflict');return {...parsed,seq:prior.seq} as TaskEvent}
   const item={...parsed,seq:++next.event_seq};next.events.push(item);next.event_keys[key]={seq:item.seq,hash:body}
   for(const ref of item.refs)if(!task.artifact_refs.includes(ref))task.artifact_refs.push(ref)
   return structuredClone(item) as TaskEvent
  })
 }
 events(taskId:string,after:number):{items:TaskEvent[];next:number;truncated:boolean}{
  this.get(taskId);z.number().int().nonnegative().parse(after)
  const items=this.#state.events.filter(event=>event.task_id===taskId&&event.seq>after).slice(0,100)
  return {items:structuredClone(items) as TaskEvent[],next:items.at(-1)?.seq??after,truncated:(this.#state.truncated[taskId]??0)>after}
 }
 inputReceipts(taskId:string){return Object.entries(this.#state.effects).filter(([,receipt])=>receipt.task_id===taskId).map(([request_id,receipt])=>({request_id,...structuredClone(receipt)}))}
 list():TaskRecord[]{return structuredClone(this.#state.tasks) as TaskRecord[]}
 delegate(requestId:string,input:TaskInput):Promise<TaskRecord>{const request=id.parse(requestId),parsed=taskInputSchema.parse(input),payload=hash(parsed);return this.#mutate<TaskRecord>(next=>{
  const prior=next.receipts[request];if(prior){if(prior.hash!==payload)throw Error('request_conflict');if(!prior.result)throw Error('receipt_invalid');return structuredClone(prior.result) as TaskRecord}
  const task:TaskRecord={...(parsed.conversation_generation===undefined?{}:{conversation_generation:parsed.conversation_generation}),conversation_id:parsed.conversation_id,goal:parsed.goal,acceptance:parsed.acceptance,origin_ref:parsed.origin_ref,...(parsed.todo_ref?{todo_ref:parsed.todo_ref}:{}),id:randomUUID(),phase:'queued',controller:{kind:'nova'},control_revision:0,goal_revision:0,corrections:0,work_ids:[],session_ids:[],evidence_refs:[],artifact_refs:[],waiting_reason:null,todo_sync:'none'}
  next.tasks.push(task);next.receipts[request]={hash:payload,task_id:task.id,result:structuredClone(task)};return structuredClone(task)
 })}
 control(requestId:string,fence:TaskFence,actor:TaskActor,nextActor:TaskActor):Promise<TaskRecord>{const parsed=controlChangeSchema.parse({fence,actor,nextActor});return this.#change(requestId,parsed,task=>{task.controller=parsed.nextActor;task.control_revision++})}
 returnFromUserOrigin(requestId:string,fence:TaskFence,provenance:{conversation_id:string;conversation_generation:number;origin_ref:string},stillWanted:()=>boolean):Promise<TaskRecord>{
  const request=id.parse(requestId),parsed={fence:taskFenceSchema.parse(fence),provenance:z.object({conversation_id:id,conversation_generation:z.number().int().nonnegative(),origin_ref:id}).strict().parse(provenance),operation:'user_origin_return'},body=hash(parsed)
  return this.#mutate(next=>{
   const prior=next.receipts[request];if(prior){if(prior.hash!==body)throw Error('request_conflict');return structuredClone(prior.result) as TaskRecord}
   if(!stillWanted())throw Error('superseded')
   const task=next.tasks.find(task=>task.id===parsed.fence.task_id);if(!task)throw Error('task_not_found')
   this.#assertFence(task,parsed.fence);if(task.conversation_id!==parsed.provenance.conversation_id)throw Error('task_not_owned')
   task.controller={kind:'nova'};task.control_revision++;next.events.push({seq:++next.event_seq,task_id:task.id,kind:'control',text:'Control returned to Nova',refs:[]})
   const result=structuredClone(task);next.receipts[request]={hash:body,task_id:task.id,result};return result as TaskRecord
  })
 }
 reservePresentationRequest(requestId:string,clientId:string,command:string):Promise<void>{const request=id.parse(requestId),body=hash({client:id.parse(clientId)}),identity=z.string().min(1).max(16384).parse(command);return this.#mutate(next=>{
  const prior=next.handbacks[request];if(prior){if(prior.hash!==body||prior.command!==identity)throw Error('request_conflict');return}
  next.handbacks[request]={hash:body,command:identity}
 })}
 returnClientTasks(requestId:string,clientId:string):Promise<TaskRecord[]>{const request=id.parse(requestId),client=id.parse(clientId),body=hash({client});return this.#mutate(next=>{
  const prior=next.handbacks[request];if(prior){if(prior.hash!==body)throw Error('request_conflict');if(prior.result)return structuredClone(prior.result) as TaskRecord[]}
  const result=next.tasks.filter(task=>task.controller.kind==='user'&&task.controller.client_id===client)
  for(const task of result){task.controller={kind:'nova'};task.control_revision++;next.events.push({seq:++next.event_seq,task_id:task.id,kind:'control',text:'Control returned to Nova',refs:[]})}
  next.handbacks[request]={...prior,hash:body,result:structuredClone(result)};return structuredClone(result) as TaskRecord[]
 })}
 controlClient(requestId:string,fence:TaskFence,clientId:string,action:'takeover'|'return'):Promise<TaskRecord>{
  const parsed={fence:taskFenceSchema.parse(fence),actor:actorSchema.parse({kind:'user',client_id:clientId}),action:z.enum(['takeover','return']).parse(action)}
  return this.#change(requestId,parsed,task=>{task.controller=parsed.action==='takeover'?parsed.actor:{kind:'nova'};task.control_revision++},task=>{
   this.#assertFence(task,parsed.fence)
   if(parsed.action==='takeover'&&task.controller.kind==='user'&&task.controller.client_id!==clientId)throw Error('not_controller')
  })
 }
 assertCurrent(fence:TaskFence,actor:TaskActor):void{const parsed=taskFenceSchema.parse(fence),task=this.#state.tasks.find(item=>item.id===parsed.task_id);if(!task)throw Error('task_not_found');this.#assert(task,parsed,actorSchema.parse(actor))}
 bindWork(fence:TaskFence,workId:string,sessionId?:string):Promise<void>{const parsed=taskFenceSchema.parse(fence),work=id.parse(workId),session=sessionId===undefined?undefined:id.parse(sessionId);return this.#mutate(next=>{
  const task=next.tasks.find(item=>item.id===parsed.task_id);if(!task)throw Error('task_not_found');this.#assertFence(task,parsed);if(task.phase==='completed'||task.phase==='cancelled')throw Error('task_terminal')
  const active=(item:StoredTask)=>item.phase!=='completed'&&item.phase!=='cancelled'
  if(next.tasks.some(item=>item.id!==task.id&&active(item)&&item.work_ids.includes(work)))throw Error('work_active')
  if(session&&next.tasks.some(item=>item.id!==task.id&&active(item)&&item.session_ids.includes(session)))throw Error('session_active')
  if(task.phase==='queued'||task.phase==='waiting'){task.phase='running';task.waiting_reason=null}
  if(!task.work_ids.includes(work))task.work_ids.push(work);if(session&&!task.session_ids.includes(session))task.session_ids.push(session)
 })}
 reviseGoal(requestId:string,fence:TaskFence,actor:TaskActor,goal:string,acceptance:string[]):Promise<TaskRecord>{const parsed=goalChangeSchema.parse({fence,actor,goal,acceptance});return this.#change(requestId,parsed,task=>{task.goal=parsed.goal;task.acceptance=parsed.acceptance;task.goal_revision++})}
 #change(requestId:string,parsed:{fence:TaskFence;actor:TaskActor}&Record<string,unknown>,change:(task:StoredTask)=>void,authorize?:(task:StoredTask)=>void):Promise<TaskRecord>{const request=id.parse(requestId),body=hash(parsed);return this.#mutate(next=>{
  const prior=next.receipts[request];if(prior){if(prior.hash!==body)throw Error('request_conflict');if(!prior.result)throw Error('receipt_invalid');return structuredClone(prior.result) as TaskRecord}
  const task=next.tasks.find(item=>item.id===parsed.fence.task_id);if(!task)throw Error('task_not_found');if(authorize)authorize(task);else this.#assert(task,parsed.fence,parsed.actor);change(task);next.events.push({seq:++next.event_seq,task_id:task.id,kind:'control',text:JSON.stringify({operation:parsed.operation??parsed.action??('nextActor' in parsed?'controller_changed':'goal_revised'),controller:task.controller,control_revision:task.control_revision,goal_revision:task.goal_revision}),refs:[]});const result=structuredClone(task);next.receipts[request]={hash:body,task_id:task.id,result};return result as TaskRecord
 })}
 #assert(task:StoredTask,fence:TaskFence,actor:TaskActor):void{this.#assertFence(task,fence);if(JSON.stringify(task.controller)!==JSON.stringify(actor))throw Error('not_controller')}
 #assertFence(task:StoredTask,fence:TaskFence):void{if(task.control_revision!==fence.control_revision||task.goal_revision!==fence.goal_revision)throw Error('stale_task')}
 #pruneDisplay(next:TaskState):void{
  // ponytail: bounded linear retention; move display history to indexed storage if task volume grows.
  const counts=new Map<string,number>(),bytes=new Map<string,number>();let total=0
  const eligible=(event:TaskState['events'][number])=>event.kind!=='control'&&event.kind!=='verification'
  for(const event of next.events)if(eligible(event)){const size=Buffer.byteLength(JSON.stringify(event));counts.set(event.task_id,(counts.get(event.task_id)??0)+1);bytes.set(event.task_id,(bytes.get(event.task_id)??0)+size);total+=size}
  const budget=Math.max(0,Math.min(4*1024*1024,16*1024*1024-Buffer.byteLength(JSON.stringify(next))+total-4096))
  next.events=next.events.filter(event=>{
   if(!eligible(event)||((counts.get(event.task_id)??0)<=1000&&(bytes.get(event.task_id)??0)<=1024*1024&&total<=budget))return true
   const size=Buffer.byteLength(JSON.stringify(event));counts.set(event.task_id,counts.get(event.task_id)!-1);bytes.set(event.task_id,bytes.get(event.task_id)!-size);total-=size;next.truncated[event.task_id]=Math.max(next.truncated[event.task_id]??0,event.seq);return false
  })
 }
 #mutate<T>(change:(next:TaskState)=>Promise<T>|T):Promise<T>{const run=this.#tail.then(async()=>{const next=structuredClone(this.#state),result=await change(next);this.#pruneDisplay(next);await this.#store.write(next);this.#state=next;this.changed();return result});this.#tail=run.catch(()=>{/* keep mutation queue available */});return run}
}
