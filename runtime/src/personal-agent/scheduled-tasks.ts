import {SOURCE_PROCESSING_GOAL} from '../core/source-processing-instructions.js'
import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {canonicalJson} from '../text/canonical-json.js'
import {internalTaskInputSchema,type TaskInput} from './tasks.js'
import {collectDueOccurrences,nextOccurrence,scheduleRuleSchema,type ScheduleSlot} from './scheduled-time.js'

const id=z.string().trim().min(1).max(512),instant=z.string().datetime()
export const scheduleContextSchema=z.object({todos:z.boolean(),goals:z.boolean(),tasks:z.boolean(),memory:z.boolean(),knowledge:z.boolean(),search:z.boolean()}).strict()
export type ScheduleContext=z.infer<typeof scheduleContextSchema>
export const scheduleInputSchema=z.object({title:z.string().trim().min(1).max(200),goal:z.string().trim().min(1).max(16000),acceptance:z.array(z.string().trim().min(1).max(2000)).min(1).max(64),rule:scheduleRuleSchema,context:scheduleContextSchema}).strict()
export type ScheduleInput=z.infer<typeof scheduleInputSchema>
const authoritySchema=z.object({user_scope:id,source:z.enum(['ui','user_turn','builtin']),origin_ref:id,source_refs:z.array(id).max(128),allowed_context:scheduleContextSchema}).strict()
export type ScheduleCreateAuthority=z.infer<typeof authoritySchema>
const slotSchema=z.object({scheduled_at:instant,local_date:z.string(),local_time:z.string(),slot_key:id}).strict()
const definitionSchema=scheduleInputSchema.extend({shared:z.object({owner_revision:z.number().int().nonnegative()}).optional(),processing:z.object({failures:z.number().int().nonnegative(),next_attempt:instant}).strict().optional(),id,revision:z.number().int().positive(),enabled:z.boolean(),archived:z.boolean(),authority:authoritySchema,cursor:instant,next_slot:slotSchema.nullable(),missed_count:z.number().int().nonnegative(),dst_gap_count:z.number().int().nonnegative()}).strict()
export type Schedule=z.infer<typeof definitionSchema>
const summarySchema=z.object({outcome:z.enum(['completed','cancelled','missed','skipped','failed']),text:z.string().max(16000),evidence_refs:z.array(id).max(128),consumer:id.nullable().optional(),published:z.boolean()}).strict()
const runSchema=z.object({processing:z.object({batch_id:id,recipe:id,exhausted:z.boolean().default(false),calls:z.array(id).max(24)}).strict().optional(),run_id:id,schedule_id:id,definition_revision:z.number().int().positive(),definition_hash:id,definition:scheduleInputSchema,authority:authoritySchema,slot:slotSchema.nullable(),trigger:z.enum(['scheduled','manual']),claimed_at:instant,input:internalTaskInputSchema,stage:z.enum(['claimed','bound','prepared','terminal']),task_id:id.nullable(),prepared_namespace:id.nullable(),terminal_summary:summarySchema.nullable()}).strict()
export type ScheduleRun=z.infer<typeof runSchema>
const adoptionResultSchema=z.object({id,version:z.number().int().positive()}).strict()
const stateSchema=z.object({items:z.array(definitionSchema).max(4096),runs:z.array(runSchema).max(4096),receipts:z.record(z.string(),z.object({hash:id,kind:z.enum(['schedule','run']),id}).strict()),adoptions:z.record(z.string(),z.object({hash:id,run_id:id,result:adoptionResultSchema.nullable()}).strict()).default({})}).strict()
type State=z.infer<typeof stateSchema>
const empty=():State=>({items:[],runs:[],receipts:{},adoptions:{}})
export const scheduleHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex')
const definition=(item:Schedule):ScheduleInput=>({title:item.title,goal:item.goal,acceptance:item.acceptance,rule:item.rule,context:item.context})

export interface SharedScheduleCoordinator {
 sync():Promise<void>
 claim(item:Schedule,run:ScheduleRun):Promise<boolean>
 bind(item:Schedule,run:ScheduleRun,taskId:string):Promise<void>
 finish(item:Schedule,run:ScheduleRun):Promise<void>
}
export class ScheduleService{
 coordinator:SharedScheduleCoordinator|undefined
 async syncShared(){await this.coordinator?.sync()}
 async createShared(requestId:string,input:ScheduleInput,authority:ScheduleCreateAuthority):Promise<Schedule>{
  if(!this.coordinator)throw Error('shared_schedules_unavailable')
  const item=await this.create(requestId,input,authority,true)
  await this.syncShared();return this.get(item.id)
 }
 acceptShared(value:{id:string;definition:ScheduleInput;frontier:string;owner_revision:number;enabled:boolean},scope:string):Promise<void>{
  return this.#mutate(next=>{
   const existing=next.items.find(item=>item.id===value.id)
   if(existing){
    if(!existing.shared)throw Error('shared_schedule_conflict')
    if(value.owner_revision<existing.shared.owner_revision)throw Error('stale_schedule_owner')
    existing.shared.owner_revision=value.owner_revision;existing.enabled=value.enabled
    existing.cursor=new Date(Math.max(Date.parse(existing.cursor),Date.parse(value.frontier))).toISOString()
    return
   }
   const input=scheduleInputSchema.parse(value.definition),cursor=value.frontier
   next.items.push({...input,id:value.id,revision:1,shared:{owner_revision:value.owner_revision},enabled:value.enabled,archived:false,
    authority:{user_scope:scope,source:'ui',origin_ref:'shared-schedule:'+value.id,source_refs:[],allowed_context:input.context},
    cursor,next_slot:nextOccurrence(input.rule,new Date(cursor)),missed_count:0,dst_gap_count:0})
  })
 }
 recoverSharedReservation(scheduleId:string,claim:{run_id:string;slot_key:string;scheduled_at:string}):Promise<void>{
  return this.#mutate(next=>{
   if(next.runs.some(run=>run.run_id===claim.run_id))return
   const item=next.items.find(item=>item.id===scheduleId);if(!item?.shared)throw Error('shared_schedule_missing')
   const parts=/:([0-9]{4}-[0-9]{2}-[0-9]{2}):([0-9]{2}:[0-9]{2})$/.exec(claim.slot_key)
   if(!parts||claim.run_id!==scheduleHash([item.id,claim.slot_key]))throw Error('occurrence_conflict')
   const slot={scheduled_at:claim.scheduled_at,slot_key:claim.slot_key,local_date:parts[1]!,local_time:parts[2]!}
   next.runs.push(this.#run(item,slot,'scheduled',claim.run_id))
  })
 }

 #state:State=empty()
 #tail:Promise<unknown>=Promise.resolve()
 #store:BoundedJsonStore<State>
 constructor(readonly path:string,readonly changed:()=>void=()=>{/* no observer */},readonly now:()=>Date=()=>new Date()){this.#store=new BoundedJsonStore(path,stateSchema,16*1024*1024)}
 async open(){try{this.#state=await this.#store.read(empty())}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
 async close(){await this.#tail}
 list(){return structuredClone(this.#state.items.filter(item=>!item.archived))}
 get(scheduleId:string):Schedule{const item=this.#state.items.find(item=>item.id===id.parse(scheduleId));if(!item)throw Error('schedule_not_found');return structuredClone(item)}
 findRun(runId:string):ScheduleRun|null{const run=this.#state.runs.find(run=>run.run_id===id.parse(runId));return run?structuredClone(run):null}
 getRun(runId:string):ScheduleRun{const run=this.findRun(runId);if(!run)throw Error('schedule_run_not_found');return run}
 runForTask(taskId:string):ScheduleRun|null{const run=this.#state.runs.find(run=>run.task_id===taskId);return run?structuredClone(run):null}
 activeRuns(){return structuredClone(this.#state.runs.filter(run=>run.stage!=='terminal'))}
 terminalRuns(){return structuredClone(this.#state.runs.filter(run=>run.stage==='terminal'))}
 reserveAdoption(requestId:string,runId:string,input:unknown){
  const run=this.getRun(runId),key=scheduleHash([run.authority.user_scope,id.parse(requestId)]),payload=scheduleHash({runId,input})
  return this.#mutate(next=>{const prior=next.adoptions[key];if(prior){if(prior.hash!==payload)throw Error('request_conflict');return {key,result:structuredClone(prior.result)}}if(Object.keys(next.adoptions).length>=20000)throw Error('schedule_capacity');next.adoptions[key]={hash:payload,run_id:runId,result:null};return {key,result:null}})
 }
 finishAdoption(key:string,result:{id:string;version:number}){
  const parsed=adoptionResultSchema.parse(result)
  return this.#mutate(next=>{const prior=next.adoptions[id.parse(key)];if(!prior)throw Error('adoption_not_reserved');if(prior.result&&scheduleHash(prior.result)!==scheduleHash(parsed))throw Error('adoption_conflict');prior.result=parsed;return structuredClone(parsed)})
 }
 history(scheduleId:string,cursor:string|null=null,limit=20){
  this.get(scheduleId);z.number().int().min(1).max(100).parse(limit)
  const runs=this.#state.runs.filter(run=>run.schedule_id===scheduleId).reverse(),offset=cursor?runs.findIndex(run=>run.run_id===cursor)+1:0
  if(cursor&&offset===0)throw Error('history_cursor_expired')
  const items=structuredClone(runs.slice(offset,offset+limit))
  return {items,next_cursor:offset+limit<runs.length?items.at(-1)!.run_id:null}
 }
 /** Host-only default registration; public schedule input cannot set processing metadata. */
 ensureSourceProcessing(scope:string):Promise<Schedule>{
  const key='builtin-source-'+scheduleHash(scope).slice(0,24),prior=this.#state.items.find(item=>item.id===key)
  if(prior?.goal===SOURCE_PROCESSING_GOAL)return Promise.resolve(structuredClone(prior))
  return this.#mutate(next=>{
   const existing=next.items.find(item=>item.id===key)
   if(existing){existing.goal=SOURCE_PROCESSING_GOAL;existing.revision++;return structuredClone(existing)}
   const context={todos:false,goals:false,tasks:false,memory:false,knowledge:false,search:false}
   const item:Schedule={id:key,revision:1,enabled:true,archived:false,title:'资料增量整理',goal:SOURCE_PROCESSING_GOAL,acceptance:['The batch was durably processed through source__process finish, with current authorization and grounded topic references.'],rule:{kind:'daily',timezone:'UTC',time:'00:00'},context,authority:{user_scope:id.parse(scope),source:'builtin',origin_ref:'builtin:source-processing',source_refs:[],allowed_context:context},cursor:this.now().toISOString(),next_slot:null,missed_count:0,dst_gap_count:0,processing:{failures:0,next_attempt:this.now().toISOString()}}
   next.items.push(item);return structuredClone(item)
  })
 }
 claimSourceProcessing(scheduleId:string,batchId:string,recipe:string):Promise<ScheduleRun>{
  return this.#mutate(next=>{
   const item=next.items.find(item=>item.id===scheduleId)
   if(!item?.processing||!item.enabled||item.archived)throw Error('builtin_schedule')
   const runId=scheduleHash([item.id,id.parse(batchId),id.parse(recipe)]),prior=next.runs.find(run=>run.run_id===runId)
   if(prior)return structuredClone(prior)
   if(Date.parse(item.processing.next_attempt)>+this.now())throw Error('processing_backoff')
   if(next.runs.some(run=>run.schedule_id===item.id&&run.stage!=='terminal'))throw Error('schedule_running')
   const run=this.#run({...item,goal:item.goal+' Batch: '+batchId+'; recipe: '+recipe},null,'scheduled',runId);run.processing={batch_id:batchId,recipe,exhausted:false,calls:[]};next.runs.push(run);return structuredClone(run)
  })
 }
 exhaustSourceProcessing(runId:string){return this.#changeRun(runId,run=>{if(run.processing)run.processing.exhausted=true})}
 reserveSourceProcessingCall(runId:string,callId:string){return this.#changeRun(runId,run=>{
  if(!run.processing||run.stage==='terminal')throw Error('builtin_schedule')
  if(run.processing.calls.includes(id.parse(callId)))return
  if(run.processing.calls.length>=24)throw Error('processing_budget_exhausted')
  run.processing.calls.push(callId)
 })}
 async create(requestId:string,value:ScheduleInput,source:ScheduleCreateAuthority,shared=false):Promise<Schedule>{
  const input=scheduleInputSchema.parse(value),authority=authoritySchema.parse(source)
  this.#context(input.context,authority)
  return this.#mutate(next=>this.#request(next,authority.user_scope,requestId,{operation:'create',input,authority,...(shared?{shared:true}:{})},'schedule',()=>{
   const now=this.now(),next_slot=nextOccurrence(input.rule,now)
   if(!next_slot)throw Error('schedule_in_past')
   const occupied=next.items.filter(item=>!item.archived||next.runs.some(run=>run.schedule_id===item.id&&run.stage!=='terminal')).length
   if(occupied>=64||next.items.length>=4096)throw Error('schedule_capacity')
   const item:Schedule={...input,...(shared?{shared:{owner_revision:0}}:{}),id:randomUUID(),revision:1,enabled:true,archived:false,authority,cursor:now.toISOString(),next_slot,missed_count:0,dst_gap_count:0}
   next.items.push(item);return item
  })) as Promise<Schedule>
 }
 async update(requestId:string,scheduleId:string,expectedRevision:number,value:ScheduleInput,source?:ScheduleCreateAuthority):Promise<Schedule>{
  const input=scheduleInputSchema.parse(value)
  const authority=source?authoritySchema.parse(source):undefined
  return this.#edit(requestId,scheduleId,expectedRevision,'update',authority?{input,authority}:input,item=>{
   if(authority){if(authority.user_scope!==item.authority.user_scope)throw Error('schedule_not_owned');item.authority=authority}
   this.#context(input.context,item.authority)
   const next_slot=nextOccurrence(input.rule,new Date(Math.max(this.now().getTime(),Date.parse(item.cursor))));if(!next_slot)throw Error('schedule_in_past')
   Object.assign(item,input,{next_slot})
   // A changed calendar starts in the future; editing content alone preserves pending time slots.
   if(scheduleHash(input.rule)!==scheduleHash(this.get(scheduleId).rule))item.cursor=new Date(Math.max(this.now().getTime(),Date.parse(item.cursor))).toISOString()
  })
 }
 pause(requestId:string,scheduleId:string,revision:number){return this.#edit(requestId,scheduleId,revision,'pause',null,item=>{item.enabled=false;item.next_slot=null})}
 resume(requestId:string,scheduleId:string,revision:number){return this.#edit(requestId,scheduleId,revision,'resume',null,item=>{item.enabled=true;item.cursor=new Date(Math.max(this.now().getTime(),Date.parse(item.cursor))).toISOString();item.next_slot=nextOccurrence(item.rule,new Date(item.cursor));if(!item.next_slot)throw Error('schedule_in_past')})}
 delete(requestId:string,scheduleId:string,revision:number){return this.#edit(requestId,scheduleId,revision,'delete',null,item=>{item.archived=true;item.enabled=false;item.next_slot=null})}
 async runNow(requestId:string,scheduleId:string,expectedRevision:number):Promise<ScheduleRun>{
  const item=this.get(scheduleId)
  if(item.shared)throw Error('shared_schedule_manual_disabled')
  if(item.processing)throw Error('builtin_schedule')
  return this.#mutate(next=>this.#request(next,item.authority.user_scope,requestId,{operation:'run_now',scheduleId,expectedRevision},'run',()=>{
   const current=this.#current(next,scheduleId,expectedRevision)
   if(next.runs.some(run=>run.schedule_id===scheduleId&&run.stage!=='terminal'))throw Error('schedule_running')
   const run=this.#run(current,null,'manual',scheduleHash([scheduleId,'manual',current.authority.user_scope,requestId]))
   next.runs.push(run);return run
  })) as Promise<ScheduleRun>
 }
 claimDue():Promise<ScheduleRun[]>{
  return this.#mutate(async next=>{
   const now=this.now(),claimed:ScheduleRun[]=[]
   for(const item of next.items){
    if(item.processing||!item.enabled||item.archived||+now<=Date.parse(item.cursor))continue
    const due=collectDueOccurrences(item.rule,new Date(item.cursor),now)
    if(item.shared){
     if(!this.coordinator||!due.latest)continue
     const candidate=this.#run(item,due.latest,'scheduled',scheduleHash([item.id,due.latest.slot_key]))
     try{if(!await this.coordinator.claim(item,candidate))continue}catch{continue}
    }
    item.cursor=now.toISOString();item.next_slot=nextOccurrence(item.rule,now);item.missed_count+=due.missed_count;item.dst_gap_count+=due.dst_gaps.length
    if(!due.latest)continue
    const runId=scheduleHash([item.id,due.latest.slot_key])
    if(next.runs.some(run=>run.run_id===runId))continue
    const run=this.#run(item,due.latest,'scheduled',runId)
    if(next.runs.some(run=>run.schedule_id===item.id&&run.stage!=='terminal')){
     run.stage='terminal';run.terminal_summary={outcome:'skipped',text:'Previous run remains unresolved',evidence_refs:[],published:false}
    }else claimed.push(run)
    next.runs.push(run)
   }
   return claimed
  })
 }
 bindTask(runId:string,taskId:string){return this.#changeRun(runId,async run=>{const item=this.get(run.schedule_id);if(item.shared){if(!this.coordinator)throw Error('shared_schedules_unavailable');await this.coordinator.bind(item,run,taskId);}if(run.task_id&&run.task_id!==taskId)throw Error('run_task_conflict');if(run.stage==='terminal')throw Error('run_terminal');run.task_id=id.parse(taskId);if(run.stage==='claimed')run.stage='bound'})}
 markPrepared(runId:string,namespace:string){return this.#changeRun(runId,run=>{if(!run.task_id||namespace!=='schedule-run:'+run.run_id)throw Error('invalid_run_namespace');if(run.stage==='terminal')throw Error('run_terminal');run.prepared_namespace=namespace;run.stage='prepared'})}
 markFinished(runId:string,summary:ScheduleRun['terminal_summary']){
  const parsed=summarySchema.parse(summary)
  return this.#changeRun(runId,async(run,next)=>{const item=this.get(run.schedule_id);if(item.shared){if(!this.coordinator)throw Error('shared_schedules_unavailable');await this.coordinator.finish(item,run);}if(run.terminal_summary){if(scheduleHash({...run.terminal_summary,published:false})!==scheduleHash({...parsed,published:false}))throw Error('run_result_conflict');return}run.stage='terminal';run.terminal_summary=parsed;const current=next.items.find(item=>item.id===run.schedule_id);if(current?.processing){current.processing.failures=parsed.outcome==='completed'?0:current.processing.failures+1;current.processing.next_attempt=new Date(this.now().getTime()+(parsed.outcome==='completed'?0:Math.min(3600000,60000*2**Math.min(current.processing.failures-1,6)))).toISOString()}})
 }
 markWithheld(runId:string){return this.#changeRun(runId,run=>{if(run.terminal_summary?.published)return;run.stage='terminal';run.terminal_summary={outcome:'failed',text:'相关资料已变化，本次结果未发送。请重新运行以读取最新资料。',evidence_refs:[],published:true}})}
 markPublished(runId:string){return this.#changeRun(runId,run=>{if(!run.terminal_summary)throw Error('run_not_terminal');run.terminal_summary.published=true})}
 #run(item:Schedule,slot:ScheduleSlot|null,trigger:ScheduleRun['trigger'],run_id:string):ScheduleRun{
  const frozen=definition(item),definition_hash=scheduleHash(frozen)
  const input:TaskInput={execution_route:'nova',conversation_id:'schedule:'+item.id,conversation_generation:0,goal:item.goal,acceptance:item.acceptance,origin_ref:'schedule-run:'+run_id,trigger:{kind:'schedule',schedule_id:item.id,run_id,definition_revision:item.revision,definition_hash}}
  return {run_id,schedule_id:item.id,definition_revision:item.revision,definition_hash,definition:frozen,authority:structuredClone(item.authority),slot,trigger,claimed_at:this.now().toISOString(),input,stage:'claimed',task_id:null,prepared_namespace:null,terminal_summary:null}
 }
 #context(context:ScheduleContext,authority:ScheduleCreateAuthority){for(const key of Object.keys(context) as (keyof ScheduleContext)[])if(context[key]&&!authority.allowed_context[key])throw Error('context_not_authorized')}
 #current(next:State,scheduleId:string,revision:number){z.number().int().positive().parse(revision);const item=next.items.find(item=>item.id===id.parse(scheduleId));if(!item||item.archived)throw Error('schedule_not_found');if(item.revision!==revision)throw Error('stale_schedule');return item}
 #edit(requestId:string,scheduleId:string,revision:number,operation:string,input:unknown,change:(item:Schedule)=>void):Promise<Schedule>{
  const existing=this.get(scheduleId);if(existing.shared)throw Error('shared_schedule_edit_requires_hub');if(existing.processing)throw Error('builtin_schedule');const scope=existing.authority.user_scope
  return this.#mutate(next=>this.#request(next,scope,requestId,{operation,scheduleId,revision,input},'schedule',()=>{const item=this.#current(next,scheduleId,revision);change(item);item.revision++;return item})) as Promise<Schedule>
 }
 #request(next:State,scope:string,requestId:string,body:unknown,kind:'schedule'|'run',create:()=>Schedule|ScheduleRun){
  const key=scheduleHash([scope,id.parse(requestId)]),payload=scheduleHash(body),receipt=next.receipts[key]
  if(receipt){if(receipt.hash!==payload)throw Error('request_conflict');const result=receipt.kind==='schedule'?next.items.find(item=>item.id===receipt.id):next.runs.find(run=>run.run_id===receipt.id);if(!result)throw Error('schedule_request_retired');return structuredClone(result)}
  if(Object.keys(next.receipts).length>=20000)throw Error('schedule_capacity')
  const result=create();next.receipts[key]={hash:payload,kind,id:kind==='schedule'?(result as Schedule).id:(result as ScheduleRun).run_id}
  return structuredClone(result)
 }
 #changeRun(runId:string,change:(run:ScheduleRun,next:State)=>void|Promise<void>){return this.#mutate(async next=>{const run=next.runs.find(run=>run.run_id===id.parse(runId));if(!run)throw Error('schedule_run_not_found');await change(run,next);return structuredClone(run)})}
 #mutate<T>(change:(next:State)=>T|Promise<T>):Promise<T>{
  const pending=this.#tail.then(async()=>{
   const next=structuredClone(this.#state),result=await change(next)
   const terminal=next.runs.filter(run=>run.stage==='terminal'&&run.terminal_summary?.published),retire=new Set(terminal.slice(0,Math.max(0,terminal.length-2000)).map(run=>run.run_id))
   next.runs=next.runs.filter(run=>!retire.has(run.run_id))
   if(next.runs.length>4096)throw Error('schedule_capacity')
   await this.#store.write(next);this.#state=next
   try{this.changed()}catch{/* persistence already committed */}
   return result
  })
  this.#tail=pending.catch(()=>{/* no observer */});return pending
 }
}
