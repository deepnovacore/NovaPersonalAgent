import {canonicalJson} from '../text/canonical-json.js'
import {sourceAgentArguments} from '../core/source-processing-tools.js'
import {profileSourceInput} from '../memory-substrate/profile-source-input.js'
import type {EvidenceRecord} from '../memory-substrate/store.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {processingRefSchema,type ProcessingBatch,type ProcessingRequest} from '../memory-substrate/source-processing.js'
import type {PersonalAgentHost} from './host.js'
import type {ScheduledRunGrant} from './scheduled-run-authority.js'
import type {ScheduleRun} from './scheduled-tasks.js'
import type {TaskRecord} from './tasks.js'
import type {TaskDecision} from './task-loop.js'
import type {ProfileInput} from './profile-warmup.js'

const batchResult=z.object({batch:z.custom<ProcessingBatch>(),valid:z.boolean()})
const originalSchema=z.object({items:z.array(processingRefSchema.and(z.object({text:z.string(),version:z.string(),source_kind:z.string(),observed_at:z.string(),locator:z.string(),source_metadata:z.record(z.string(),z.unknown()).nullable()})))})

/** Uses the existing ScheduleRun/Task ledgers and scheduler wake; owns no timer. */
export class SourceProcessingAgent{
 constructor(readonly host:PersonalAgentHost){}
 async operation(request:ProcessingRequest){const memory=this.host.options.memory();if(!memory?.sourceProcessing)throw Error('source_processing_unavailable');return memory.sourceProcessing(request)}
 async tick(){
  const memory=this.host.options.memory();if(!memory?.sourceProcessing||!memory.sourceProcessingConsumer)return
  const schedule=await this.host.schedules.ensureSourceProcessing(this.host.options.userScope)
  for(const run of this.host.schedules.activeRuns().filter(run=>run.processing)){
   if(!run.task_id)continue
   const task=this.host.tasks.get(run.task_id)
   // An unknown effect or pending delivery is not evidence of failure. Leave it to normal recovery.
   if(task.phase==='waiting'&&!task.pending_delivery&&!this.host.tasks.hasUnresolvedExecution(task.id)&&!this.host.tasks.pendingEffect(task.id)){
    const fence={task_id:task.id,goal_revision:task.goal_revision,control_revision:task.control_revision}
    await this.host.cancelTask('processing-failed:'+run.run_id,fence,{kind:'nova'})
   }
  }
  if(this.host.schedules.activeRuns().some(run=>run.processing)||this.host.sourceProcessingForegroundBusy()||Date.parse(schedule.processing!.next_attempt)>this.host.sourceProcessingNow())return
  const status=await this.operation({action:'status'}) as {active_batch:ProcessingBatch|null;reconciliation_required:boolean}
  const active=status.active_batch
  if(active){
   const run=active.run_id?this.host.schedules.getRun(active.run_id):this.host.schedules.activeRuns().find(run=>run.processing?.batch_id===active.id)
   if(run&&run.stage!=='terminal')return
   if(active.task_id){const task=this.host.tasks.get(active.task_id);if(!['completed','cancelled'].includes(task.phase)||task.pending_delivery||this.host.tasks.hasUnresolvedExecution(task.id))return}
   if(status.reconciliation_required||active.task_id)await this.operation({action:'retire',batch_id:active.id,task_id:active.task_id,run_id:active.run_id,reason:active.task_id?'task_terminal':'no_task_dispatched'})
  }
  const batch=await this.operation({action:'claim'}) as ProcessingBatch|null
  if(batch)await this.host.schedules.claimSourceProcessing(schedule.id,batch.id,batch.provider)
 }
 async bind(run:ScheduleRun,task:TaskRecord){if(run.processing&&!['completed','cancelled'].includes(task.phase)){const status=await this.operation({action:'status'}) as {active_batch:ProcessingBatch|null;recipe:string};if(status.recipe!==run.processing.recipe){await this.host.tasks.recoveryWait(task.id,'processing_recipe_changed');return}if(status.active_batch?.task_id===task.id)return;await this.operation({action:'bind',batch_id:run.processing.batch_id,task_id:task.id,run_id:run.run_id})}}
 async valid(run:ScheduleRun,consumer?:string|null){
  if(!run.processing)return false
  if(consumer!==undefined&&(!consumer||consumer!==this.host.options.memory()?.sourceProcessingConsumer?.()))return false
  try{const result=batchResult.parse(await this.operation({action:'batch',batch_id:run.processing.batch_id}));return result.valid&&result.batch.provider===run.processing.recipe&&result.batch.run_id===run.run_id&&result.batch.task_id===run.task_id&&['bound','completed'].includes(result.batch.status)}catch{return false}
 }
 async validate(grant:ScheduledRunGrant){return !this.host.sourceProcessingForegroundBusy()&&await this.valid(this.host.schedules.getRun(grant.run_id),grant.consumer)}
 async call(grant:ScheduledRunGrant,callId:string,value:unknown){
  this.host.scheduledAuthority.assert(grant,grant.fence)
  if(!await this.validate(grant))throw Error('processing_context_unavailable')
  const args=sourceAgentArguments.parse(value),key=args.action+':'+createHash('sha256').update(callId).digest('hex')
  if(args.action==='compose'&&this.host.schedules.getRun(grant.run_id).processing?.calls.some(key=>key.startsWith('compose:')))throw Error('profile_attempt_already_recorded')
  let run:ScheduleRun
  try{run=await this.host.schedules.reserveSourceProcessingCall(grant.run_id,key)}catch(error){if(error instanceof Error&&error.message==='processing_budget_exhausted')await this.host.schedules.exhaustSourceProcessing(grant.run_id);throw error}
  const owner={batch_id:run.processing!.batch_id,task_id:grant.task_id,run_id:grant.run_id}
  if(args.action==='read')return this.operation({action:'read',batch_id:owner.batch_id})
  if(args.action==='topics')return this.operation({...args,limit:8,batch_id:owner.batch_id})
  if(args.action==='profile')return this.operation({action:'profile',batch_id:owner.batch_id})
  if(args.action==='evidence')return this.operation({...args,...owner})
  if(args.action==='compose'){
   const memory=this.host.options.memory(),generate=memory?.sourceProcessingProfile?.bind(memory);if(!generate)throw Error('profile_generation_unavailable')
   const original=originalSchema.parse(await this.operation({action:'evidence',refs:args.refs,...owner}))
   const previous=await this.operation({action:'profile'}) as {revision:number}
   const entries:ProfileInput[]=original.items.map(item=>item.source_kind==='file'?{id:item.evidence_id,version:item.version,content:item.text,origin:'inferred',observed_at:item.observed_at,source:{project:'资料',document:item.locator}}:profileSourceInput({id:item.evidence_id,hash:item.version,raw_text:item.text,observed_at:item.observed_at,source_kind:item.source_kind as 'im'|'mail',source_id:item.locator,source_metadata:item.source_metadata as EvidenceRecord['source_metadata']},4000))
   const draft=await generate(entries,AbortSignal.any([this.host.scheduledAuthority.signal(grant),AbortSignal.timeout(180000)]),async()=>{this.host.scheduledAuthority.assert(grant,grant.fence);if(!await this.validate(grant))throw Error('processing_context_unavailable')})
   this.host.scheduledAuthority.assert(grant,grant.fence)
   if(!await this.validate(grant))throw Error('processing_context_unavailable')
   return this.operation({action:'publish',...owner,expected_revision:previous.revision,draft,refs:args.refs})
  }
  const current=batchResult.parse(await this.operation({action:'batch',batch_id:owner.batch_id}))
  const available=new Set(current.batch.items.map(ref=>canonicalJson(ref)))
  if(args.topics.some(topic=>topic.refs.some(ref=>!available.has(canonicalJson(ref)))))throw Error('finish topic refs must exactly match current batch read refs; historical refs are for compose only')
  const result=await this.operation({action:'commit',...owner,topics:args.topics}) as {applied:boolean}
  if(!result.applied)throw Error('processing_context_unavailable')
  // The task verifier needs a durable receipt, never a copy of private originals.
  await this.host.tasks.recordContextEvidence(grant.fence,callId,JSON.stringify({consumer:grant.consumer,processing_batch:owner.batch_id,applied:true}),[])
  return result
 }
 async decision(task:TaskRecord):Promise<TaskDecision>{
  const run=this.host.schedules.getRun(task.trigger!.run_id)
  const data=batchResult.parse(await this.operation({action:'batch',batch_id:run.processing!.batch_id}))
  if(!data.valid)return {kind:'wait',reason:'processing_context_unavailable',evidence_refs:[]}
  const refs=this.host.tasks.evidence(task.id).filter(row=>row.kind==='context'&&row.content.includes(run.processing!.batch_id)).map(row=>row.ref)
  if(data.batch.status==='completed'&&refs.length)return {kind:'complete',evidence_refs:refs,criteria:task.acceptance.map((_,index)=>({index,evidence_refs:refs}))}
  if(task.corrections<2)return {kind:'correct',instruction:'The batch is not finished. This built-in task already authorizes the available source__process maintenance calls; do not ask permission. Continue choosing relevant original evidence, compose once if useful, then call finish with topics citing only exact current-batch refs returned by read. Historical refs are for compose only; prior topics are already preserved. Do not answer with a plan.',evidence_refs:this.host.tasks.evidence(task.id).filter(row=>row.kind==='delivery').map(row=>row.ref)}
  // Bounded corrections only; later attempts use durable failure backoff.
  return {kind:'wait',reason:'processing_incomplete',evidence_refs:[]}
 }
 async finished(run:ScheduleRun){
  if(!run.processing||!run.task_id)return
  const task=this.host.tasks.get(run.task_id)
  if(!['completed','cancelled'].includes(task.phase)||task.pending_delivery||this.host.tasks.hasUnresolvedExecution(task.id))throw Error('scheduled_result_not_ready')
  if(!run.terminal_summary){
   const valid=task.phase==='completed'&&await this.valid(run)
   await this.host.schedules.markFinished(run.run_id,{outcome:valid?'completed':'failed',text:task.phase==='completed'?'Source batch processed':'Source batch deferred',evidence_refs:[],published:true})
  }else await this.host.schedules.markPublished(run.run_id)
  const status=await this.operation({action:'status'}) as {active_batch:ProcessingBatch|null}
  if(status.active_batch?.id===run.processing.batch_id){const batch=status.active_batch;await this.operation({action:'retire',batch_id:batch.id,task_id:batch.task_id,run_id:batch.run_id,reason:batch.task_id?'task_terminal':'no_task_dispatched'})}
 }
}
