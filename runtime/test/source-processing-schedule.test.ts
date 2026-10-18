import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ScheduleService} from '../src/personal-agent/scheduled-tasks.js'

test('built-in registration is durable, default on, and never claimed as an ordinary daily schedule',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-schedule-'));let now=new Date('2026-10-12T01:00:00Z')
 try{const service=new ScheduleService(join(dir,'schedules.json'),undefined,()=>now);await service.open()
 const first=await service.ensureSourceProcessing('test');assert.equal(first.enabled,true)
 assert.equal((await service.ensureSourceProcessing('test')).id,first.id)
 now=new Date('2026-10-13T01:00:00Z');assert.deepEqual(await service.claimDue(),[])
 const run=await service.claimSourceProcessing(first.id,'batch','recipe');assert.equal((await service.claimSourceProcessing(first.id,'batch','recipe')).run_id,run.run_id)
 await assert.rejects(service.runNow('fake',first.id,first.revision),/builtin_schedule/)
 await service.reserveSourceProcessingCall(run.run_id,'one');await service.reserveSourceProcessingCall(run.run_id,'one')
 assert.equal(service.getRun(run.run_id).processing?.calls.length,1)
 await service.close();const recovered=new ScheduleService(join(dir,'schedules.json'),undefined,()=>now);await recovered.open()
 assert.equal(recovered.activeRuns()[0]?.run_id,run.run_id)
 for(let i=2;i<=24;i++)await recovered.reserveSourceProcessingCall(run.run_id,String(i))
 await assert.rejects(recovered.reserveSourceProcessingCall(run.run_id,'overflow'),/processing_budget_exhausted/)
 await recovered.markFinished(run.run_id,{outcome:'failed',text:'failed',evidence_refs:[],published:true})
 assert.equal(recovered.get(first.id).processing?.failures,1)
 await assert.rejects(recovered.claimSourceProcessing(first.id,'retry','recipe'),/processing_backoff/)
 await recovered.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})

import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import {createHash} from 'node:crypto'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {ProcessingBatch,ProcessingRequest} from '../src/memory-substrate/source-processing.js'

for(const finishCall of [2,3,24])test(`source-change callback completes a real Task quietly including budget boundary ${finishCall}`, async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-agent-')),db=new DatabaseSync(join(dir,'ledger.sqlite'));initializeMemory(db)
 const baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1',model='qwen3-vl-plus',consumer=createHash('sha256').update(baseUrl+'|'+model).digest('hex'),prefix='personal:test:',source_id=prefix+'source'
 const op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider:consumer,...request}))
 const memory={sourceProcessing:op,sourceProcessingConsumer:()=>consumer,sourceProcessingLlm:()=>({baseUrl,model,apiKey:'fixture'})} as unknown as PersonalMemoryResource
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 let host=make(),responses=0
 const gateway={complete:()=>Promise.reject(Error('unexpected_verifier_model'))} as unknown as ModelGateway
 const wire=()=>host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>memory,gateway,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),blackboard:{path:join(dir,'blackboard.sqlite'),ownerId:'test'},searchTransport:{search:()=>Promise.reject(Error('unexpected_search'))},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(request){const n=++responses;if(finishCall===3&&n===3)assert.match(JSON.stringify(request.inputs),/current batch read refs/);const r='source:'+n;yield {kind:'response_started',response_id:r};if(finishCall===3&&n===2){const status=await op({action:'status'}) as {active_batch:ProcessingBatch};yield {kind:'tool_call',item_id:'bad',call_id:'bad',name:'source__process',arguments:{action:'finish',topics:[{title:'bad',summary:'bad',refs:status.active_batch.items.map(ref=>({...ref,evidence_id:'not-current-batch'}))}]}}}else if(n<finishCall)yield {kind:'tool_call',item_id:'read:'+n,call_id:'read:'+n,name:'source__process',arguments:{action:'read'}};else if(n===finishCall){const status=await op({action:'status'}) as {active_batch:ProcessingBatch};yield {kind:'tool_call',item_id:'finish',call_id:'finish',name:'source__process',arguments:{action:'finish',topics:[{title:'合成主题',summary:'合成摘要',refs:status.active_batch.items}]}}}else yield {kind:'text_delta',text:'资料批次整理完成。'};yield {kind:'response_completed',response_id:r}},restoreHistory:()=>Promise.resolve(),abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()})})}})}),()=>undefined)
 try{
  wire();await host.open();assert.equal(responses,0);assert.equal(host.tasks.list().length,0)
  const at=new Date().toISOString();memoryOperation(db,'append_evidence',{id:prefix+'e:one',source_id,source_kind:'im',locator:'one',raw_text:'合成资料',hash:'v1',observed_at:at,recorded_at:at,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'test'}})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:consumer,embedding_provider:null,conversation_providers:[]}})
  await host.sourceChanged({revision:1,phase:'ready'})
  const end=Date.now()+15000;while(Date.now()<end&&!host.schedules.terminalRuns().length)await new Promise(r=>setTimeout(r,10))
  if(!responses)await host.prepareScheduledRun(host.schedules.activeRuns()[0]!.run_id)
  assert.equal(host.tasks.list().length,1);assert.equal(host.tasks.list()[0]!.phase,'completed',JSON.stringify({responses,tasks:host.tasks.list(),runs:host.schedules.activeRuns()}));assert.equal(responses,finishCall+1);assert.equal(host.schedules.terminalRuns()[0]!.processing!.calls.length,finishCall);assert.equal(host.snapshot().feed.length,0)
  assert.equal((await op({action:'status'}) as {completed_batches:number}).completed_batches,1)
  await host.close();host=make();wire();await host.open();await host.scheduledTaskTick();assert.equal(responses,finishCall+1);assert.equal(host.tasks.list().length,1)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})

import {profileSourceInput} from '../src/memory-substrate/profile-source-input.js'
test('shared source mapping preserves addressed author and reply context with a hashed account id',()=>{
 const input=profileSourceInput({id:'e',hash:'v',raw_text:'帮我验证接口',observed_at:new Date().toISOString(),source_kind:'im',source_id:'s',source_metadata:{sender_id:'colleague',sender_name:'陈宁',recipient_id:'my-open-id',account_id:'local-account-hash',mention:'direct',mention_ids:['my-open-id'],recipient_ids:['my-open-id'],thread_id:'thread',message_id:'message',parent_id:'parent'}})
 assert.equal(input.source?.relation,'addressed');assert.notEqual(input.source?.sender_id,'self');assert.equal(input.source?.sender_name,'陈宁');assert.deepEqual(input.source?.mention_ids,['self']);assert.deepEqual(input.source?.recipient_ids,['self']);assert.ok(input.source?.parent_id);assert.ok(input.source?.thread_id)
})

test('profile input tells the author, a direct request and another participant apart',()=>{
 const make=(sender:string,mention:'direct'|'none')=>profileSourceInput({id:'e'+sender,hash:'v',raw_text:'先把版本锁定',observed_at:new Date().toISOString(),source_kind:'im',source_id:'s',source_metadata:{sender_id:sender,sender_name:sender,recipient_id:'me',account_id:'acct',mention,mention_ids:mention==='direct'?['me']:[],thread_id:'t',message_id:'m'+sender}})
 const own=make('me','none'),direct=make('colleague','direct'),other=make('colleague','none')
 assert.deepEqual([own,direct,other].map(item=>item.source?.relation),['self','addressed','participant'])
 assert.equal(own.source?.sender_id,'self');assert.notEqual(other.source?.sender_id,'self');assert.equal(other.source?.document,'会话中他人的发言')
})

for(const bound of [true,false])test(`recipe change across restart retires its Task (batch bound=${bound})`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-recipe-')),db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:test:',provider='provider';let recipe='one',memory:PersonalMemoryResource|undefined
 const op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider,recipe,...request}))
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{
  const at=new Date().toISOString();memoryOperation(db,'append_evidence',{id:prefix+'e',source_id:prefix+'s',source_kind:'file',locator:'x',raw_text:'synthetic',hash:'x',observed_at:at,recorded_at:at,trust:'untrusted_external'});memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  await host.open();const schedule=await host.schedules.ensureSourceProcessing('test'),batch=await op({action:'claim'}) as ProcessingBatch,run=await host.schedules.claimSourceProcessing(schedule.id,batch.id,batch.provider),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
  await host.schedules.bindTask(run.run_id,task.id);if(bound)await op({action:'bind',batch_id:batch.id,task_id:task.id,run_id:run.run_id});await host.close()
  recipe='two';memory={sourceProcessing:op,sourceProcessingConsumer:()=>provider} as unknown as PersonalMemoryResource;host=make();await host.open();await host.scheduledTaskTick()
  assert.equal(host.tasks.get(task.id).phase,'cancelled');assert.equal(host.schedules.getRun(run.run_id).stage,'terminal');assert.equal((await op({action:'status'}) as {active_batch:unknown}).active_batch,null)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})

test('a completed Task with revoked sources finishes its Run as failed and does not block the scheduler',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-revoked-')),db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:test:',provider='provider';let memory:PersonalMemoryResource|undefined
 const op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider,...request}))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();const at=new Date().toISOString();memoryOperation(db,'append_evidence',{id:prefix+'e',source_id:prefix+'s',source_kind:'file',locator:'x',raw_text:'synthetic',hash:'x',observed_at:at,recorded_at:at,trust:'untrusted_external'});memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const schedule=await host.schedules.ensureSourceProcessing('test'),batch=await op({action:'claim'}) as ProcessingBatch,run=await host.schedules.claimSourceProcessing(schedule.id,batch.id,batch.provider),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await host.schedules.bindTask(run.run_id,task.id);await op({action:'bind',batch_id:batch.id,task_id:task.id,run_id:run.run_id});await op({action:'commit',batch_id:batch.id,task_id:task.id,run_id:run.run_id,topics:[]})
  await host.tasks.recordDelivery(fence,'done','done');await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:done'],criteria:[{index:0,evidence_refs:['task-delivery:done']}]})
  memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  memory={sourceProcessing:op,sourceProcessingConsumer:()=>provider} as unknown as PersonalMemoryResource
  await host.scheduledTaskTick();assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.outcome,'failed');await host.scheduledTaskTick();assert.equal(host.schedules.activeRuns().length,0)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})
