import {z} from 'zod'
import {scheduleInputSchema,type Schedule,type ScheduleRun,type ScheduleCreateAuthority} from './scheduled-tasks.js'
import {nextOccurrence,scheduleRuleSchema} from './scheduled-time.js'
import {schedulePresets} from './schedule-presets.js'
import type {PersonalAgentHost} from './host.js'
const id=z.string().min(1).max(512),revision=z.number().int().positive()
const page=z.object({cursor:id.nullable().default(null),limit:z.number().int().min(1).max(50).default(20)}).strict()
export function scheduleView(item:Schedule){const {authority,cursor,...view}=item;void authority;void cursor;return view}
export function scheduleRunView(run:ScheduleRun){return {run_id:run.run_id,schedule_id:run.schedule_id,definition_revision:run.definition_revision,slot:run.slot,trigger:run.trigger,claimed_at:run.claimed_at,stage:run.stage,task_id:run.task_id,summary:run.terminal_summary?{outcome:run.terminal_summary.outcome,text:run.terminal_summary.text,published:run.terminal_summary.published}:null}}
/** Both frontends use this API after their own authority has been established. */
export async function executeScheduleCommand(host:PersonalAgentHost,method:string,params:unknown,requestId:string,source:Omit<ScheduleCreateAuthority,'allowed_context'>,allowedContext?:ScheduleCreateAuthority['allowed_context']):Promise<unknown>{
 const service=host.schedules
 if(method==='schedules.presets'){const q=z.object({timezone:z.string().optional()}).strict().parse(params);return {items:schedulePresets(q.timezone??host.snapshot().settings.timezone??'UTC')}}
 if(method==='schedules.preview'){const q=z.object({rule:scheduleRuleSchema}).strict().parse(params);return {next_slot:nextOccurrence(q.rule,host.options.now?.()??new Date())}}
 if(method==='schedules.list'){
  const q=page.parse(params),items=service.list(),offset=q.cursor?items.findIndex(item=>item.id===q.cursor)+1:0
  if(q.cursor&&offset===0)throw Error('schedule_cursor_expired')
  const rows=items.slice(offset,offset+q.limit).map(scheduleView)
  return {items:rows,next_cursor:offset+q.limit<items.length?rows.at(-1)!.id:null}
 }
 if(method==='schedules.get'){const q=z.object({id}).strict().parse(params);return scheduleView(service.get(q.id))}
 if(method==='schedules.history'){const q=page.extend({id}).strict().parse(params),result=service.history(q.id,q.cursor,q.limit);return {...result,items:result.items.map(scheduleRunView)}}
 if(method==='schedules.open_result'){const q=z.object({run_id:id}).strict().parse(params);return host.openScheduledResult(q.run_id)}
 if(method==='schedules.adopt_result')return host.adoptScheduledResult(requestId,params as Parameters<PersonalAgentHost['adoptScheduledResult']>[1])
 if(method==='schedules.create'||method==='schedules.update'){
  const q=method==='schedules.create'?{...z.object({input:scheduleInputSchema}).strict().parse(params),id:null,expected_revision:null}:z.object({id,expected_revision:revision,input:scheduleInputSchema}).strict().parse(params)
  const authority={...source,allowed_context:allowedContext??q.input.context}
  const result=q.id!==null?await service.update(requestId,q.id,q.expected_revision,q.input,authority):await service.create(requestId,q.input,authority)
  void host.scheduledTaskTick().catch(()=>{/* persisted definitions retry on the next tick */})
  return scheduleView(result)
 }
 const q=z.object({id,expected_revision:revision}).strict().parse(params)
 if(method==='schedules.run_now'){const run=await service.runNow(requestId,q.id,q.expected_revision);void host.scheduledTaskTick().catch(()=>{/* pending run remains recoverable */});return scheduleRunView(run)}
 const operation=method.slice('schedules.'.length)
 if(operation!=='pause'&&operation!=='resume'&&operation!=='delete')throw Error('unsupported')
 const result=await service[operation](requestId,q.id,q.expected_revision)
 void host.scheduledTaskTick().catch(()=>{/* persisted definitions retry on the next tick */})
 return scheduleView(result)
}
