import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'

export type TaskPhase='queued'|'running'|'verifying'|'waiting'|'completed'|'cancelled'
export type TaskActor={kind:'nova'}|{kind:'user';client_id:string}
export interface TaskFence{task_id:string;control_revision:number;goal_revision:number}
export interface TaskInput{conversation_id:string;goal:string;acceptance:string[];origin_ref:string;todo_ref?:{id:string;version:number}}
export interface TaskRecord extends TaskInput{id:string;phase:TaskPhase;controller:TaskActor;control_revision:number;goal_revision:number;corrections:number;work_ids:string[];session_ids:string[];evidence_refs:string[];waiting_reason:string|null;todo_sync:'none'|'pending'|'synced'|'conflict'}

const id=z.string().trim().min(1).max(512)
const inputSchema=z.object({conversation_id:id,goal:z.string().trim().min(1).max(16000),acceptance:z.array(z.string().trim().min(1).max(2000)).max(64),origin_ref:id,todo_ref:z.object({id,version:z.number().int().nonnegative()}).strict().optional()}).strict()
const actorSchema=z.union([z.object({kind:z.literal('nova')}).strict(),z.object({kind:z.literal('user'),client_id:id}).strict()])
const fenceSchema=z.object({task_id:id,control_revision:z.number().int().nonnegative(),goal_revision:z.number().int().nonnegative()}).strict()
const recordSchema=inputSchema.extend({id,phase:z.enum(['queued','running','verifying','waiting','completed','cancelled']),controller:actorSchema,control_revision:z.number().int().nonnegative(),goal_revision:z.number().int().nonnegative(),corrections:z.number().int().nonnegative(),work_ids:z.array(id),session_ids:z.array(id),evidence_refs:z.array(id),waiting_reason:z.string().max(4000).nullable(),todo_sync:z.enum(['none','pending','synced','conflict'])}).strict()
type StoredTask=z.infer<typeof recordSchema>
const stateSchema=z.object({tasks:z.array(recordSchema),receipts:z.record(z.string(),z.object({hash:z.string(),task_id:id,result:recordSchema.optional()}).strict())}).strict()
type TaskState=z.infer<typeof stateSchema>
const empty=():TaskState=>({tasks:[],receipts:{}})
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class TaskService{
 #store:BoundedJsonStore<TaskState>;#state:TaskState=empty();#tail:Promise<unknown>=Promise.resolve()
 constructor(readonly path:string){this.#store=new BoundedJsonStore(path,stateSchema,16*1024*1024)}
 async open():Promise<void>{try{this.#state=await this.#store.read(empty())}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
 async close():Promise<void>{await this.#tail}
 get(taskId:string):TaskRecord{const task=this.#state.tasks.find(item=>item.id===id.parse(taskId));if(!task)throw Error('task_not_found');return structuredClone(task) as TaskRecord}
 list():TaskRecord[]{return structuredClone(this.#state.tasks) as TaskRecord[]}
 delegate(requestId:string,input:TaskInput):Promise<TaskRecord>{const request=id.parse(requestId),parsed=inputSchema.parse(input),payload=hash(parsed);return this.#mutate<TaskRecord>(next=>{
  const prior=next.receipts[request];if(prior){if(prior.hash!==payload)throw Error('request_conflict');const task=next.tasks.find(item=>item.id===prior.task_id);if(!task)throw Error('task_not_found');return structuredClone(task) as TaskRecord}
  const task:TaskRecord={conversation_id:parsed.conversation_id,goal:parsed.goal,acceptance:parsed.acceptance,origin_ref:parsed.origin_ref,...(parsed.todo_ref?{todo_ref:parsed.todo_ref}:{}),id:randomUUID(),phase:'queued',controller:{kind:'nova'},control_revision:0,goal_revision:0,corrections:0,work_ids:[],session_ids:[],evidence_refs:[],waiting_reason:null,todo_sync:'none'}
  next.tasks.push(task);next.receipts[request]={hash:payload,task_id:task.id,result:task};return structuredClone(task)
 })}
 control(requestId:string,fence:TaskFence,actor:TaskActor,nextActor:TaskActor):Promise<TaskRecord>{return this.#change(requestId,{fence,actor,nextActor},task=>{task.controller=actorSchema.parse(nextActor);task.control_revision++})}
 assertCurrent(fence:TaskFence,actor:TaskActor):void{const parsed=fenceSchema.parse(fence),task=this.#state.tasks.find(item=>item.id===parsed.task_id);if(!task)throw Error('task_not_found');this.#assert(task,parsed,actorSchema.parse(actor))}
 bindWork(fence:TaskFence,workId:string,sessionId?:string):Promise<void>{const parsed=fenceSchema.parse(fence),work=id.parse(workId),session=sessionId===undefined?undefined:id.parse(sessionId);return this.#mutate(next=>{
  const task=next.tasks.find(item=>item.id===parsed.task_id);if(!task)throw Error('task_not_found');this.#assertFence(task,parsed)
  const active=(item:StoredTask)=>item.phase!=='completed'&&item.phase!=='cancelled'
  if(next.tasks.some(item=>item.id!==task.id&&active(item)&&item.work_ids.includes(work)))throw Error('work_active')
  if(session&&next.tasks.some(item=>item.id!==task.id&&active(item)&&item.session_ids.includes(session)))throw Error('session_active')
  if(!task.work_ids.includes(work))task.work_ids.push(work);if(session&&!task.session_ids.includes(session))task.session_ids.push(session)
 })}
 reviseGoal(requestId:string,fence:TaskFence,actor:TaskActor,goal:string,acceptance:string[]):Promise<TaskRecord>{const parsed=inputSchema.pick({goal:true,acceptance:true}).parse({goal,acceptance});return this.#change(requestId,{fence,actor,...parsed},task=>{task.goal=parsed.goal;task.acceptance=parsed.acceptance;task.goal_revision++})}
 #change(requestId:string,payload:unknown,change:(task:StoredTask)=>void):Promise<TaskRecord>{const request=id.parse(requestId),body=hash(payload),parsed=z.object({fence:fenceSchema,actor:actorSchema}).passthrough().parse(payload);return this.#mutate(next=>{
  const prior=next.receipts[request];if(prior){if(prior.hash!==body)throw Error('request_conflict');if(!prior.result)throw Error('receipt_invalid');return structuredClone(prior.result) as TaskRecord}
  const task=next.tasks.find(item=>item.id===parsed.fence.task_id);if(!task)throw Error('task_not_found');this.#assert(task,parsed.fence,parsed.actor);change(task);const result=structuredClone(task);next.receipts[request]={hash:body,task_id:task.id,result};return result as TaskRecord
 })}
 #assert(task:StoredTask,fence:TaskFence,actor:TaskActor):void{this.#assertFence(task,fence);if(JSON.stringify(task.controller)!==JSON.stringify(actor))throw Error('not_controller')}
 #assertFence(task:StoredTask,fence:TaskFence):void{if(task.control_revision!==fence.control_revision||task.goal_revision!==fence.goal_revision)throw Error('stale_task')}
 #mutate<T>(change:(next:TaskState)=>Promise<T>|T):Promise<T>{const run=this.#tail.then(async()=>{const next=structuredClone(this.#state),result=await change(next);await this.#store.write(next);this.#state=next;return result});this.#tail=run.catch(()=>{/* keep mutation queue available */});return run}
}
