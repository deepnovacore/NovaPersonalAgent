import {lifeEvidenceMatches} from './life.js'
import {withUsageContext} from '../usage/context.js'
import {inspectProject,inspectProjectDiff} from './project-history.js'
import {basename,relative} from 'node:path'
import {emptyUnderstanding,understandingSourceTags,type UnderstandingSnapshot,type UnderstandingProducts,type ProductGenerationContext} from './understanding-products.js'
import type {WorkbenchContext} from './workbench-context.js'
import {canonicalJson} from '../text/canonical-json.js'
import {sourceAgentArguments} from '../core/source-processing-tools.js'
import {profileSourceInput} from '../memory-substrate/profile-source-input.js'
import type {EvidenceRecord} from '../memory-substrate/store.js'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {processingRefSchema,type ProcessingBatch,type ProcessingRequest,type ProcessingObservation} from '../memory-substrate/source-processing.js'
import type {PersonalAgentHost} from './host.js'
import type {ScheduledRunGrant} from './scheduled-run-authority.js'
import type {ScheduleRun} from './scheduled-tasks.js'
import type {TaskRecord} from './tasks.js'
import type {TaskDecision} from './task-loop.js'
import type {ProfileInput,ProfileDraft,ProfileObservation} from './profile-warmup.js'

const batchResult=z.object({batch:z.custom<ProcessingBatch>(),valid:z.boolean(),observed:z.boolean().optional(),published:z.boolean().optional()})
const originalSchema=z.object({items:z.array(processingRefSchema.and(z.object({source_key:z.string(),text:z.string(),version:z.string(),source_kind:z.string(),observed_at:z.string(),locator:z.string(),source_metadata:z.record(z.string(),z.unknown()).nullable()})))})

/** Uses the existing ScheduleRun/Task ledgers and scheduler wake; owns no timer. */
export class SourceProcessingAgent{
 constructor(readonly host:PersonalAgentHost){}
 #products=emptyUnderstanding();#revision=0;#error=false;#lastGitCheck=0;#gitOffset=0
 get enabled(){return !!this.host.options.memory()?.sourceProcessing}
 #source(item:UnderstandingProducts['suggestions'][number]){const anchor=item.anchor,ref=anchor&&item.refs.find(ref=>ref.entry_id===anchor.entry_id);return anchor?.quote&&ref?{candidate_id:item.id,refs:[{...ref,version:String(ref.version),quote:anchor.quote}]}:undefined}
 #captured(item:UnderstandingProducts['suggestions'][number]){
  const life=this.host.life.snapshot(),rows=item.kind==='goal'?life.goals:item.kind==='idea'?life.ideas:life.todos,source=this.#source(item)
  return rows.find(row=>row.source_suggestion_id===item.id||(!item.todo_id&&source&&lifeEvidenceMatches(source.refs,[...(row.workbench_source?.refs??[]),...(row.suggestion_source?.refs??[])])))
 }
 snapshot(){const products=structuredClone(this.#products);products.suggestions=products.suggestions.filter(item=>!this.#captured(item));return products}
 async reload(){
  if(!this.enabled)return
  const revision=++this.#revision
  try{const products=await this.operation({action:'products'}) as UnderstandingSnapshot;if(revision!==this.#revision)return;this.#products=products;this.#error=false
   if(products.news_cleanup_pending)try{await this.host.news.clearSeededInterests();await this.operation({action:'confirm_cleanup'});this.#products.news_cleanup_pending=false}catch{/* Durable marker survives a failed write; retry on the next wake. */}}
  catch{if(revision!==this.#revision)return;this.#products=emptyUnderstanding();this.#error=true}
 }
 profileSnapshot(){const latest=this.host.schedules.terminalRuns().filter(run=>run.processing).sort((a,b)=>b.claimed_at.localeCompare(a.claimed_at))[0];return {status:this.host.schedules.activeRuns().some(run=>run.processing)?'working':this.#error||latest?.terminal_summary?.outcome==='failed'?'failed':this.#products.profile_pending?'working':this.#products.draft?'ready':'idle',draft:this.#products.draft,needs_update:this.#products.profile_needs_update===true,sources:this.#products.sources,processing:[...this.host.schedules.activeRuns(),...this.host.schedules.terminalRuns()].filter(run=>run.processing).sort((a,b)=>b.claimed_at.localeCompare(a.claimed_at)).slice(0,5).map(run=>({started_at:run.claimed_at,status:run.terminal_summary?.outcome??'running',model_calls:run.processing?.model_calls??0,tool_calls:run.processing?.calls.length??0}))}}
 contextSnapshot():ReturnType<WorkbenchContext['snapshot']>{
  const p=this.snapshot(),status=this.profileSnapshot().status
  const cards=p.suggestions.map(item=>({id:item.id,candidate_id:item.id,tab:item.kind==='goal'?'goals' as const:item.kind==='idea'?'ideas' as const:'todos' as const,title:item.title,body:item.body,why:null,next:item.kind==='action'?item.title:null,refs:item.refs.map(ref=>({...ref,label:p.sources.find(source=>source.id===ref.entry_id)?.label??'来源'})),sources:understandingSourceTags(item.refs,p.sources)}))
  return {status,candidate_count:cards.length,recap:{text:null,projects:p.projects.filter(item=>item.relation==='participating'&&item.status==='current').map(item=>({name:item.name,line:item.summary}))},empty_reason:cards.length?null:'no_eligible_sources',empty_reasons:{todos:cards.length?null:'no_eligible_sources',ideas:'no_eligible_sources',goals:'no_eligible_sources'},cards}
 }
 async adopt(id:string){
  await this.host.life.refresh()
  const receipt=this.host.life.receipt('understanding-adopt:'+id);if(receipt)return receipt
  const life=this.host.life.snapshot(),prior=[...life.todos,...life.ideas,...life.goals].find(todo=>todo.source_suggestion_id===id)
  if(prior)return {id:prior.id,version:prior.version}
  await this.reload();const item=this.#products.suggestions.find(item=>item.id===id);if(!item)throw Error('card_not_found')
  const captured=this.#captured(item);if(captured){await this.operation({action:'dismiss',id});await this.reload();return {id:captured.id,version:captured.version}}
  const sources=understandingSourceTags(item.refs,this.#products.sources),source=this.#source(item)
  const guard=()=>{if(!this.#products.suggestions.some(current=>current.id===id&&canonicalJson(current)===canonicalJson(item)))throw Error('candidate_stale_source')}
  const result=await this.host.life.mutate({op:'from_suggestion',...(source?{source}:{}),suggestion_id:id,title:item.title,note:item.body,kind:item.kind==='goal'?'goal':item.kind==='idea'?'idea':'todo',due:item.due,sources,provenance_refs:item.refs.map(ref=>ref.entry_id),todo_id:item.todo_id},'understanding-adopt:'+id,guard)
  await this.operation({action:'dismiss',id});await this.reload();return result
 }
 async refresh(){await this.refreshProjectState(true);await this.operation({action:'refresh'});await this.host.scheduledTaskTick();await this.reload();this.host.connectionChanged()}

 async projects(refs:readonly {evidence_id:string}[]){
  const roots=this.host.sourceProjectRoots(refs.map(ref=>ref.evidence_id)),groups=new Map<string,Awaited<ReturnType<typeof inspectProject>>&{evidence_ids:string[]}>()
  for(const root of [...new Set(roots.map(row=>row.root))].slice(0,8)){
   const project=await inspectProject(root),existing=groups.get(project.id),evidence_ids=roots.filter(row=>row.root===root).map(row=>row.evidence_id)
   groups.set(project.id,existing?{...existing,evidence_ids:[...new Set([...existing.evidence_ids,...evidence_ids])],commits:[...new Map([...existing.commits,...project.commits].map(c=>[c.id,c])).values()].slice(0,30),unmerged:[...new Map([...existing.unmerged,...project.unmerged].map(c=>[c.id,c])).values()].slice(0,30)}:{...project,evidence_ids})
  }
  return [...groups.values()]
 }
 async operation(request:ProcessingRequest){const memory=this.host.options.memory();if(!memory?.sourceProcessing)throw Error('source_processing_unavailable');return memory.sourceProcessing(request)}
 async refreshProjectState(force=false){
  if(!force&&this.host.sourceProcessingNow()-this.#lastGitCheck<60000)return
  this.#lastGitCheck=this.host.sourceProcessingNow()
  const rows=this.host.sourceProjectRoots(),roots=[...new Set(rows.map(row=>row.root))]
  if(this.#gitOffset>=roots.length)this.#gitOffset=0
  for(const root of roots.slice(this.#gitOffset,this.#gitOffset+8)){
   const project=await inspectProject(root),fingerprint=createHash('sha256').update(canonicalJson(project)).digest('hex'),ids=rows.filter(row=>row.root===root).map(row=>row.evidence_id)
   for(let n=0;n<ids.length;n+=512)await this.operation({action:'project_state',ids:ids.slice(n,n+512),fingerprint})
  }
  this.#gitOffset+=8
 }
 async tick(){
  const memory=this.host.options.memory();if(!memory?.sourceProcessing||!memory.sourceProcessingConsumer)return
  if(!this.host.sourceProcessingForegroundBusy())await this.refreshProjectState()
  await this.reload()
  const schedule=await this.host.schedules.ensureSourceProcessing(this.host.options.userScope)
  for(const run of this.host.schedules.activeRuns().filter(run=>run.processing)){
   if(!run.task_id)continue
   const task=this.host.tasks.get(run.task_id)
   // A lost built-in reply can be cancelled: its only effects are fenced, idempotent derived writes.
   // Live deliveries and any unknown external execution still require normal recovery.
   const lostReply=task.waiting_reason==='task_delivery_uncertain'&&!!task.pending_delivery&&this.host.tasks.needsReconcile(task.id)&&!task.work_ids.length&&!this.host.tasks.pendingEffect(task.id)&&!this.host.tasks.inputReceipts(task.id).some(receipt=>receipt.status==='unknown')
   if(task.phase==='waiting'&&(lostReply||!task.pending_delivery&&!this.host.tasks.hasUnresolvedExecution(task.id)&&!this.host.tasks.pendingEffect(task.id))){
    const fence={task_id:task.id,goal_revision:task.goal_revision,control_revision:task.control_revision}
    await this.host.cancelTask('processing-failed:'+run.run_id,fence,{kind:'nova'})
   }
  }
  if(this.host.schedules.activeRuns().some(run=>run.processing)||this.host.sourceProcessingForegroundBusy()||Date.parse(schedule.processing!.next_attempt)>this.host.sourceProcessingNow())return
  try{await memory.syncSharedContext?.()}catch{return /* Offline or a secondary PC cannot start shared synthesis. */}
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
  if(args.action==='projects'||args.action==='project_diff'){
   await this.operation({action:'evidence',refs:args.refs,...owner})
   const projects=await this.projects(args.refs)
   this.host.scheduledAuthority.assert(grant,grant.fence);if(!await this.validate(grant))throw Error('processing_context_unavailable')
   if(args.action==='projects')return {projects}
   const project=projects.find(p=>p.id===args.project_id);if(!project)throw Error('project_not_authorized')
   const roots=this.host.sourceProjectRoots(project.evidence_ids)
   const root=roots[0]?.root;if(!root)throw Error('project_not_authorized')
   const result=await inspectProjectDiff(root,args.commit,roots.filter(r=>r.root===root).map(r=>relative(root,r.file)))
   this.host.scheduledAuthority.assert(grant,grant.fence);if(!await this.validate(grant))throw Error('processing_context_unavailable');return result
  }
  if(args.action==='read')return this.operation({action:'read',batch_id:owner.batch_id})
  if(args.action==='topics')return this.operation({...args,limit:8,batch_id:owner.batch_id})
  if(args.action==='profile')return this.operation({action:'profile',batch_id:owner.batch_id})
  if(args.action==='evidence')return this.operation({...args,...owner})
  if(args.action==='compose'){
   return withUsageContext({feature:'profile',runId:grant.run_id,taskId:grant.fence.task_id,trigger:'scheduled'},async()=>{
   const memory=this.host.options.memory(),generate=memory?.sourceProcessingProfile?.bind(memory);if(!generate)throw Error('profile_generation_unavailable')
   const batch=memory?.sourceProcessingObserve?batchResult.parse(await this.operation({action:'batch',batch_id:owner.batch_id})).batch:undefined
   const processingRefs=batch?.items??args.refs
   const original=originalSchema.parse(await this.operation({action:'evidence',refs:processingRefs,...owner}))
   const previous=await this.operation({action:'profile',batch_id:owner.batch_id}) as {revision:number;draft:ProfileDraft|null}
   const inputs=(items:z.infer<typeof originalSchema>['items']):ProfileInput[]=>items.map(item=>item.source_kind==='conversation'||item.source_kind==='user_correction'?{id:item.evidence_id,version:item.version,content:item.text,origin:item.source_kind==='user_correction'?'stated':'inferred',observed_at:item.observed_at,source:{project:'Conversation',document:item.locator}}:item.source_kind==='file'?{id:item.evidence_id,version:item.version,content:item.text,origin:'inferred',source:{project:'资料',document:item.locator}}:profileSourceInput({id:item.evidence_id,hash:item.version,raw_text:item.text,observed_at:item.observed_at,source_kind:item.source_kind as 'im'|'mail',source_id:item.locator,source_metadata:item.source_metadata as EvidenceRecord['source_metadata']},4000))
   const entries=inputs(original.items)
   const signal=AbortSignal.any([this.host.scheduledAuthority.signal(grant),AbortSignal.timeout(600000)]),authorize=async()=>{this.host.scheduledAuthority.assert(grant,grant.fence);if(!await this.validate(grant))throw Error('processing_context_unavailable')}
   const projects=await this.projects(processingRefs),projectStamp=canonicalJson(projects),todoContext=await memory?.sourceProcessingTodoContext?.()
   const authorizeWithProjects=async()=>{await authorize();await todoContext?.authorize();if(canonicalJson(await this.projects(processingRefs))!==projectStamp)throw Error('project_context_changed')}
   for(const entry of entries){const project=projects.find(p=>p.evidence_ids.includes(entry.id));if(project&&entry.source){entry.source.project=project.name;entry.source.document=basename(entry.source.document)}}
   await this.reload()
   const modelCall=async(maxTokens:number)=>{await this.host.schedules.reserveSourceProcessingModelCall(grant.run_id,maxTokens)}
   original.items.forEach((item,index)=>{entries[index]!.identity_key=item.source_key})
   const identities=(await this.operation({action:'identities',...owner,refs:processingRefs}) as {items:ProductGenerationContext['identities']}).items
   const previousProducts=await this.operation({action:'products',include_dismissed:true}) as UnderstandingSnapshot
   const products=!batch?.profile_only&&memory?.sourceProcessingProducts?await memory.sourceProcessingProducts(entries,{projects,identities:identities??[],previous:previousProducts,corrections:this.#products.corrections,timezone:this.host.snapshot().settings.timezone??'UTC',todos:todoContext?.todos??[]},signal,authorizeWithProjects,modelCall):undefined
   let profileEntries=entries,observations:ProfileObservation[]|undefined,profileContextKey:string|undefined,profileRefs=processingRefs,deferProfile=false,unchangedProfile=false
   if(memory?.sourceProcessingObserve){
    if(!batch?.profile_only){
    const observed=await memory.sourceProcessingObserve(entries,signal,authorizeWithProjects,modelCall)
    const indexed:ProcessingObservation[]=observed.map(item=>({...item,refs:[...new Map(item.refs.flatMap(ref=>processingRefs.filter(original=>original.evidence_id===ref.entry_id)).map(ref=>[canonicalJson(ref),ref])).values()]}))
    await authorizeWithProjects()
    await this.operation({action:'observe',...owner,refs:processingRefs,observations:indexed})
    }
    const context=await this.operation({action:'profile_context',...owner}) as z.infer<typeof originalSchema>&{observations:ProcessingObservation[];refs:typeof processingRefs;key:string;ready:boolean;unchanged:boolean}
    const grouped=new Map<string,ProfileInput>();for(const entry of inputs(context.items)){const existing=grouped.get(entry.id);grouped.set(entry.id,existing?{...existing,content:existing.content+'\n\n'+entry.content}:entry)}
    profileEntries=[...grouped.values()];profileRefs=[...new Map([...processingRefs,...context.refs].map(ref=>[canonicalJson(ref),ref])).values()];profileContextKey=context.key;deferProfile=!context.ready;unchangedProfile=context.unchanged
    // Rehydrate current original slices; cached observations are never used as factual text.
    observations=context.observations.map(item=>({...item,refs:item.refs.map(ref=>({entry_id:ref.evidence_id,version:context.items.find(original=>original.evidence_id===ref.evidence_id)!.version}))}))
   }
   const draft=deferProfile||unchangedProfile?(previous.draft??{about:null,work:[],interests:[]}):await generate(profileEntries,signal,authorizeWithProjects,modelCall,observations)

   await authorizeWithProjects()
   this.host.scheduledAuthority.assert(grant,grant.fence)
   if(!await this.validate(grant))throw Error('processing_context_unavailable')
   const result=await this.operation({action:'publish',...owner,expected_revision:previous.revision,draft,refs:profileRefs,product_refs:processingRefs,...(profileContextKey?{profile_context_key:profileContextKey,...(deferProfile?{defer_profile:true}:{})}:{}),...(products?{products}:{})});await this.reload();this.host.understandingProductsChanged();return result
   })
  }
  const current=batchResult.parse(await this.operation({action:'batch',batch_id:owner.batch_id}))
  if(this.host.options.memory()?.sourceProcessingObserve&&!current.published)throw Error('Call compose for the current batch before finish; a successful durable publication is required')
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
  if(this.host.options.memory()?.sourceProcessingObserve&&!data.published&&run.processing!.calls.some(call=>call.startsWith('compose:')))return {kind:'wait',reason:'processing_incomplete',evidence_refs:[]}
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
