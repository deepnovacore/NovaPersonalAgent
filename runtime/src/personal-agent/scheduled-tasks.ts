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
const authoritySchema=z.object({user_scope:id,source:z.enum(['ui','user_turn']),origin_ref:id,source_refs:z.array(id).max(128),allowed_context:scheduleContextSchema}).strict()
export type ScheduleCreateAuthority=z.infer<typeof authoritySchema>
const slotSchema=z.object({scheduled_at:instant,local_date:z.string(),local_time:z.string(),slot_key:id}).strict()
const definitionSchema=scheduleInputSchema.extend({id,revision:z.number().int().positive(),enabled:z.boolean(),archived:z.boolean(),authority:authoritySchema,cursor:instant,next_slot:slotSchema.nullable(),missed_count:z.number().int().nonnegative(),dst_gap_count:z.number().int().nonnegative()}).strict()
export type Schedule=z.infer<typeof definitionSchema>
const summarySchema=z.object({outcome:z.enum(['completed','cancelled','missed','skipped','failed']),text:z.string().max(16000),evidence_refs:z.array(id).max(128),consumer:id.nullable().optional(),published:z.boolean()}).strict()
const runSchema=z.object({run_id:id,schedule_id:id,definition_revision:z.number().int().positive(),definition_hash:id,definition:scheduleInputSchema,authority:authoritySchema,slot:slotSchema.nullable(),trigger:z.enum(['scheduled','manual']),claimed_at:instant,input:internalTaskInputSchema,stage:z.enum(['claimed','bound','prepared','terminal']),task_id:id.nullable(),prepared_namespace:id.nullable(),terminal_summary:summarySchema.nullable()}).strict()
export type ScheduleRun=z.infer<typeof runSchema>
const adoptionResultSchema=z.object({id,version:z.number().int().positive()}).strict()
const stateSchema=z.object({items:z.array(definitionSchema).max(4096),runs:z.array(runSchema).max(4096),receipts:z.record(z.string(),z.object({hash:id,kind:z.enum(['schedule','run']),id}).strict()),adoptions:z.record(z.string(),z.object({hash:id,run_id:id,result:adoptionResultSchema.nullable()}).strict()).default({})}).strict()
type State=z.infer<typeof stateSchema>
const empty=():State=>({items:[],runs:[],receipts:{},adoptions:{}})
export const scheduleHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex')
const definition=(item:Schedule):ScheduleInput=>({title:item.title,goal:item.goal,acceptance:item.acceptance,rule:item.rule,context:item.context})

export class ScheduleService{
 #state:State=empty()
 #tail:Promise<unknown>=Promise.resolve()
 #store:BoundedJsonStore<State>
 constructor(readonly path:string,readonly changed:()=>void=()=>{/* no observer */},readonly now:()=>Date=()=>new Date()){this.#store=new BoundedJsonStore(path,stateSchema,16*1024*1024)}
 async open(){try{this.#state=await this.#store.read(empty())}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
 async close(){await this.#tail}
 list(){return structuredClone(this.#state.items.filter(item=>!item.archived))}
 get(scheduleId:string):Schedule{const item=this.#state.items.find(item=>item.id===id.parse(scheduleId));if(!item)throw Error('schedule_not_found');return structuredClone(item)}
 getRun(runId:string):ScheduleRun{const run=this.#state.runs.find(run=>run.run_id===id.parse(runId));if(!run)throw Error('schedule_run_not_found');return structuredClone(run)}
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
 async create(requestId:string,value:ScheduleInput,source:ScheduleCreateAuthority):Promise<Schedule>{
  const input=scheduleInputSchema.parse(value),authority=authoritySchema.parse(source)
  this.#context(input.context,authority)
  return this.#mutate(next=>this.#request(next,authority.user_scope,requestId,{operation:'create',input,authority},'schedule',()=>{
   const now=this.now(),next_slot=nextOccurrence(input.rule,now)
   if(!next_slot)throw Error('schedule_in_past')
   const occupied=next.items.filter(item=>!item.archived||next.runs.some(run=>run.schedule_id===item.id&&run.stage!=='terminal')).length
   if(occupied>=64||next.items.length>=4096)throw Error('schedule_capacity')
   const item:Schedule={...input,id:randomUUID(),revision:1,enabled:true,archived:false,authority,cursor:now.toISOString(),next_slot,missed_count:0,dst_gap_count:0}
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
  return this.#mutate(next=>this.#request(next,item.authority.user_scope,requestId,{operation:'run_now',scheduleId,expectedRevision},'run',()=>{
   const current=this.#current(next,scheduleId,expectedRevision)
   if(next.runs.some(run=>run.schedule_id===scheduleId&&run.stage!=='terminal'))throw Error('schedule_running')
   const run=this.#run(current,null,'manual',scheduleHash([scheduleId,'manual',current.authority.user_scope,requestId]))
   next.runs.push(run);return run
  })) as Promise<ScheduleRun>
 }
 claimDue():Promise<ScheduleRun[]>{
  return this.#mutate(next=>{
   const now=this.now(),claimed:ScheduleRun[]=[]
   for(const item of next.items){
    if(!item.enabled||item.archived||+now<=Date.parse(item.cursor))continue
    const due=collectDueOccurrences(item.rule,new Date(item.cursor),now)
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
 bindTask(runId:string,taskId:string){return this.#changeRun(runId,run=>{if(run.task_id&&run.task_id!==taskId)throw Error('run_task_conflict');if(run.stage==='terminal')throw Error('run_terminal');run.task_id=id.parse(taskId);if(run.stage==='claimed')run.stage='bound'})}
 markPrepared(runId:string,namespace:string){return this.#changeRun(runId,run=>{if(!run.task_id||namespace!=='schedule-run:'+run.run_id)throw Error('invalid_run_namespace');if(run.stage==='terminal')throw Error('run_terminal');run.prepared_namespace=namespace;run.stage='prepared'})}
 markFinished(runId:string,summary:ScheduleRun['terminal_summary']){
  const parsed=summarySchema.parse(summary)
  return this.#changeRun(runId,run=>{if(run.terminal_summary){if(scheduleHash({...run.terminal_summary,published:false})!==scheduleHash({...parsed,published:false}))throw Error('run_result_conflict');return}run.stage='terminal';run.terminal_summary=parsed})
 }
 markPublished(runId:string){return this.#changeRun(runId,run=>{if(!run.terminal_summary)throw Error('run_not_terminal');run.terminal_summary.published=true})}
 #run(item:Schedule,slot:ScheduleSlot|null,trigger:ScheduleRun['trigger'],run_id:string):ScheduleRun{
  const frozen=definition(item),definition_hash=scheduleHash(frozen)
  const input:TaskInput={execution_route:'nova',conversation_id:'schedule:'+item.id,conversation_generation:0,goal:item.goal,acceptance:item.acceptance,origin_ref:'schedule-run:'+run_id,trigger:{kind:'schedule',schedule_id:item.id,run_id,definition_revision:item.revision,definition_hash}}
  return {run_id,schedule_id:item.id,definition_revision:item.revision,definition_hash,definition:frozen,authority:structuredClone(item.authority),slot,trigger,claimed_at:this.now().toISOString(),input,stage:'claimed',task_id:null,prepared_namespace:null,terminal_summary:null}
 }
 #context(context:ScheduleContext,authority:ScheduleCreateAuthority){for(const key of Object.keys(context) as (keyof ScheduleContext)[])if(context[key]&&!authority.allowed_context[key])throw Error('context_not_authorized')}
 #current(next:State,scheduleId:string,revision:number){z.number().int().positive().parse(revision);const item=next.items.find(item=>item.id===id.parse(scheduleId));if(!item||item.archived)throw Error('schedule_not_found');if(item.revision!==revision)throw Error('stale_schedule');return item}
 #edit(requestId:string,scheduleId:string,revision:number,operation:string,input:unknown,change:(item:Schedule)=>void):Promise<Schedule>{
  const scope=this.get(scheduleId).authority.user_scope
  return this.#mutate(next=>this.#request(next,scope,requestId,{operation,scheduleId,revision,input},'schedule',()=>{const item=this.#current(next,scheduleId,revision);change(item);item.revision++;return item})) as Promise<Schedule>
 }
 #request(next:State,scope:string,requestId:string,body:unknown,kind:'schedule'|'run',create:()=>Schedule|ScheduleRun){
  const key=scheduleHash([scope,id.parse(requestId)]),payload=scheduleHash(body),receipt=next.receipts[key]
  if(receipt){if(receipt.hash!==payload)throw Error('request_conflict');const result=receipt.kind==='schedule'?next.items.find(item=>item.id===receipt.id):next.runs.find(run=>run.run_id===receipt.id);if(!result)throw Error('schedule_request_retired');return structuredClone(result)}
  if(Object.keys(next.receipts).length>=20000)throw Error('schedule_capacity')
  const result=create();next.receipts[key]={hash:payload,kind,id:kind==='schedule'?(result as Schedule).id:(result as ScheduleRun).run_id}
  return structuredClone(result)
 }
 #changeRun(runId:string,change:(run:ScheduleRun)=>void){return this.#mutate(next=>{const run=next.runs.find(run=>run.run_id===id.parse(runId));if(!run)throw Error('schedule_run_not_found');change(run);return structuredClone(run)})}
 #mutate<T>(change:(next:State)=>T):Promise<T>{
  const pending=this.#tail.then(async()=>{
   const next=structuredClone(this.#state),result=change(next)
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
