import {scheduleHash,type ScheduleRun,ScheduleService} from './scheduled-tasks.js'
import {TaskService,type TaskRecord,type TaskFence} from './tasks.js'
export interface ScheduledRunGrant {readonly run_id:string;readonly task_id:string;readonly definition_hash:string;readonly namespace:string;readonly consumer:string|null;readonly fence:Readonly<TaskFence>}
export class ScheduledRunAuthority{
 readonly #grants=new WeakMap<object,{lifetime:AbortSignal;run:ScheduleRun}>()
 constructor(readonly schedules:ScheduleService,readonly tasks:TaskService){}
 issue(run:ScheduleRun,task:TaskRecord,lifetime:AbortSignal,consumer:string|null=null):ScheduledRunGrant{
  this.#binding(run,task)
  const grant=Object.freeze({run_id:run.run_id,task_id:task.id,definition_hash:run.definition_hash,namespace:'schedule-run:'+run.run_id,consumer,fence:Object.freeze({task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision})})
  this.#grants.set(grant,{lifetime,run:structuredClone(run)})
  if(lifetime.aborted)throw Error('scheduled_run_closed')
  this.tasks.assertWritable(grant.fence,{kind:'nova'});return grant
 }
 assert(grant:ScheduledRunGrant,fence:TaskFence):void{
  this.validate(grant)
  if(scheduleHash(fence)!==scheduleHash(grant.fence))throw Error('invalid_scheduled_fence')
  this.tasks.assertExecutionAllowed(grant.task_id,{kind:'nova'})
 }
 validate(grant:ScheduledRunGrant):void{
  const registered=this.#grants.get(grant);if(!registered)throw Error('invalid_scheduled_grant')
  if(registered.lifetime.aborted)throw Error('scheduled_run_closed')
  const run=this.schedules.getRun(grant.run_id),task=this.tasks.get(grant.task_id)
  this.#binding(run,task)
  if(run.definition_hash!==registered.run.definition_hash)throw Error('invalid_schedule_binding')
  this.tasks.assertWritable(grant.fence,{kind:'nova'})
 }
 #binding(run:ScheduleRun,task:TaskRecord){
  if(run.stage==='terminal'||!run.task_id||run.task_id!==task.id||scheduleHash(run.definition)!==run.definition_hash||task.trigger?.run_id!==run.run_id||task.trigger.schedule_id!==run.schedule_id||task.trigger.definition_revision!==run.definition_revision||task.trigger.definition_hash!==run.definition_hash||task.conversation_id!==run.input.conversation_id||task.conversation_generation!==0||task.origin_ref!=='schedule-run:'+run.run_id||(task.original_goal??task.goal)!==run.input.goal||(run.prepared_namespace!==null&&run.prepared_namespace!=='schedule-run:'+run.run_id))throw Error('invalid_schedule_binding')
 }
}
