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
 const run=await service.claimSourceProcessing(first.id,'private-batch-sentinel','private-recipe-sentinel');assert.doesNotMatch(run.input.goal,/private-batch-sentinel|private-recipe-sentinel/);assert.match(run.input.goal,/exactly \{"action":"read"\}/);assert.equal(run.processing?.batch_id,'private-batch-sentinel');assert.equal(run.processing?.recipe,'private-recipe-sentinel');assert.equal((await service.claimSourceProcessing(first.id,'private-batch-sentinel','private-recipe-sentinel')).run_id,run.run_id)
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

for(const finishCall of [2,3,4,24])test(`source-change callback completes a real Task quietly including budget boundary ${finishCall}`, async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-agent-')),db=new DatabaseSync(join(dir,'ledger.sqlite'));initializeMemory(db)
 const baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1',model='qwen3-vl-plus',consumer=createHash('sha256').update(baseUrl+'|'+model).digest('hex'),prefix='personal:test:',source_id=prefix+'source'
 const op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider:consumer,...request}))
 const memory={sourceProcessing:op,sourceProcessingConsumer:()=>consumer,sourceProcessingLlm:()=>({baseUrl,model,apiKey:'fixture'})} as unknown as PersonalMemoryResource
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 let host=make(),responses=0
 const gateway={complete:()=>Promise.reject(Error('unexpected_verifier_model'))} as unknown as ModelGateway
 const wire=()=>host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>memory,gateway,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),blackboard:{path:join(dir,'blackboard.sqlite'),ownerId:'test'},searchTransport:{search:()=>Promise.reject(Error('unexpected_search'))},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(request){const n=responses++%(finishCall+1)+1;if(finishCall===3&&n===3)assert.match(JSON.stringify(request.inputs),/current batch read refs/);if(finishCall===4&&n===2){const receipt=JSON.stringify(request.inputs);assert.match(receipt,/invalid_params/);assert.match(receipt,/Correct the arguments and retry/);assert.doesNotMatch(receipt,/forged-batch-sentinel/)}const r='source:'+responses;yield {kind:'response_started',response_id:r};if(finishCall===4&&n===1){yield {kind:'tool_call',item_id:'invalid:'+responses,call_id:'invalid:'+responses,name:'source__process',arguments:{action:'read',batch_id:'forged-batch-sentinel'}}}else if(finishCall===3&&n===2){const status=await op({action:'status'}) as {active_batch:ProcessingBatch};yield {kind:'tool_call',item_id:'bad:'+responses,call_id:'bad:'+responses,name:'source__process',arguments:{action:'finish',topics:[{title:'bad',summary:'bad',refs:status.active_batch.items.map(ref=>({...ref,evidence_id:'not-current-batch'}))}]}}}else if(n<finishCall)yield {kind:'tool_call',item_id:'read:'+responses,call_id:'read:'+responses,name:'source__process',arguments:{action:'read'}};else if(n===finishCall){const status=await op({action:'status'}) as {active_batch:ProcessingBatch};yield {kind:'tool_call',item_id:'finish:'+responses,call_id:'finish:'+responses,name:'source__process',arguments:{action:'finish',topics:[{title:'合成主题',summary:'合成摘要',refs:status.active_batch.items}]}}}else yield {kind:'text_delta',text:'资料批次整理完成。'};yield {kind:'response_completed',response_id:r}},restoreHistory:()=>Promise.resolve(),abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()})})}})}),()=>undefined)
 try{
  wire();await host.open();assert.equal(responses,0);assert.equal(host.tasks.list().length,0)
  const at=new Date().toISOString();for(let i=0;i<(finishCall===4?4:1);i++)memoryOperation(db,'append_evidence',{id:prefix+'e:one:'+i,source_id,source_kind:'im',locator:'one:'+i,raw_text:finishCall===4?'资料'.repeat(2000):'合成资料',hash:'v1',observed_at:at,recorded_at:at,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'test'}})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:consumer,embedding_provider:null,conversation_providers:[]}})
  await host.sourceChanged({revision:1,phase:'ready'})
  const end=Date.now()+15000;while(Date.now()<end&&!host.schedules.terminalRuns().length)await new Promise(r=>setTimeout(r,10))
  if(!responses)await host.prepareScheduledRun(host.schedules.activeRuns()[0]!.run_id)
  assert.equal(host.tasks.list().length,1);assert.equal(host.tasks.list()[0]!.phase,'completed',JSON.stringify({responses,tasks:host.tasks.list(),runs:host.schedules.activeRuns()}));assert.equal(responses,finishCall+1);assert.equal(host.schedules.terminalRuns()[0]!.processing!.calls.length,finishCall===4?finishCall-1:finishCall);assert.equal(host.snapshot().feed.length,0)
  assert.equal((await op({action:'status'}) as {completed_batches:number}).completed_batches,1)
  // A second batch in the SAME host must not inherit the first run's runtime/grant.
  memoryOperation(db,'append_evidence',{id:prefix+'e:two',source_id,source_kind:'im',locator:'two',raw_text:'第二批合成资料',hash:'v2',observed_at:at,recorded_at:at,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'test'}})
  await host.sourceChanged({revision:2,phase:'ready'})
  const secondEnd=Date.now()+15000;while(Date.now()<secondEnd&&host.schedules.terminalRuns().length<2)await new Promise(r=>setTimeout(r,10))
  assert.equal(host.schedules.terminalRuns().length,2,JSON.stringify({reason:'next source batch must complete without restarting or a failed disposable run',responses,runs:host.schedules.activeRuns(),tasks:host.tasks.list().map(task=>({phase:task.phase,waiting:task.waiting_reason}))}))
  assert.equal(host.tasks.list().filter(task=>task.phase==='completed').length,2)
  assert.equal(responses,2*(finishCall+1))
  await host.close();host=make();wire();await host.open();await host.scheduledTaskTick();assert.equal(responses,2*(finishCall+1));assert.equal(host.tasks.list().length,2)
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

test('host projects shared profile and suggestions while legacy generators stay idle',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'shared-profile-')),db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:test:',provider='provider',op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider,...request}))
 const at=new Date().toISOString(),evidence=prefix+'e';memoryOperation(db,'append_evidence',{id:evidence,source_id:prefix+'s',source_kind:'file',locator:'plan.md',raw_text:'Review the interface.',hash:'v1',observed_at:at,recorded_at:at,trust:'untrusted_external'});memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
 const batch=await op({action:'claim'}) as ProcessingBatch,owner={batch_id:batch.id,task_id:'fixture',run_id:'fixture'};await op({action:'bind',...owner});await op({action:'read',batch_id:batch.id})
 const refs=[{entry_id:evidence,version:'v1'}]
 await op({action:'publish',...owner,expected_revision:0,draft:{about:{text:'Shared profile',refs},work:[],interests:[]},refs:batch.items,products:{projects:[],suggestions:[{id:'review',kind:'idea',title:'Review interface',body:'Review the interface.',project_id:null,todo_id:null,due:null,refs},{id:'act',kind:'action',title:'Send the report',body:'Send it.',project_id:null,todo_id:null,due:null,refs}]}})
 await op({action:'commit',...owner,topics:[]})
 let legacy=0
 const memory={sourceProcessing:op,sourceProcessingConsumer:()=>provider} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,generateProfile:()=>{legacy++;return Promise.resolve({about:null,work:[],interests:[]})}})
 try{await host.open();await host.refreshMemory();assert.equal(host.snapshot().profile_preparation.draft?.about?.text,'Shared profile');assert.deepEqual(host.snapshot().derived_understanding.suggestions.map(item=>item.id),['review'],'an action suggestion is no longer surfaced as a todo');await host.profileWarmup.refresh(true);assert.equal(legacy,0)
 const adopt=await host.command({type:'personal.command',request_id:'adopt-one',method:'understanding.adopt',params:{id:'review'}}) as {ok:boolean};assert.equal(adopt.ok,true);assert.equal(host.snapshot().life.ideas.length,1);assert.deepEqual(host.snapshot().life.ideas[0]?.provenance_refs,[evidence]);assert.equal(host.snapshot().derived_understanding.suggestions.length,0)
 await host.command({type:'personal.command',request_id:'adopt-two',method:'understanding.adopt',params:{id:'review'}});assert.equal(host.snapshot().life.ideas.length,1)
 const action=await host.command({type:'personal.command',request_id:'adopt-action',method:'understanding.adopt',params:{id:'act'}}) as {ok:boolean};assert.equal(action.ok,false);assert.equal(host.snapshot().life.todos.length,0)}finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})


test('built-in processing waits stay in source details instead of main notifications',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-hidden-wait-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const schedule=await host.schedules.ensureSourceProcessing('test'),run=await host.schedules.claimSourceProcessing(schedule.id,'batch','recipe'),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input);await host.schedules.bindTask(run.run_id,task.id);await host.tasks.recoveryWait(task.id,'task_runtime_unavailable')
 const message={event_key:'task_waiting:'+task.id,revision:'v1',occurrence:'initial',kind:'attention_required' as const,title:'需要你处理',body:'internal wait',source:{type:'task_waiting',id:task.id},created_at:Date.now(),expires_at:null,not_before:0,priority:60,coalesce_key:'task:'+task.id,feedback:[]}
 assert.equal(await host.notificationValidity(message),'invalid');await host.flushNotifications();assert.ok(!JSON.stringify(host.conversationSnapshot()).includes('internal wait'));assert.equal(host.snapshot().tasks.length,0);assert.equal(host.sourceProcessingAgent.profileSnapshot().processing.length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('host startup does not wait for optional background maintenance',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-startup-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let release!:()=>void,started=false;const blocked=new Promise<void>(resolve=>{release=resolve})
 host.scheduledTaskTick=async()=>{started=true;await blocked}
 const opening=host.open();let timer:ReturnType<typeof setTimeout>|undefined
 try{assert.equal(await Promise.race([opening.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),10000)})]),true);assert.equal(started,true)}
 finally{clearTimeout(timer);release();await opening;await host.close();await rm(dir,{recursive:true,force:true})}
})

test('interrupted built-in delivery retires after restart but a live delivery is preserved',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-interrupted-')),db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:test:',provider='provider';let memory:PersonalMemoryResource|undefined
 const op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider,...request}))
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{
  await host.open();await host.scheduledTaskTick()
  const at=new Date().toISOString();memoryOperation(db,'append_evidence',{id:prefix+'e',source_id:prefix+'s',source_kind:'conversation',locator:'x',raw_text:'Review the plan',hash:'x',observed_at:at,recorded_at:at,trust:'trusted_user'});memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const schedule=await host.schedules.ensureSourceProcessing('test'),batch=await op({action:'claim'}) as ProcessingBatch,run=await host.schedules.claimSourceProcessing(schedule.id,batch.id,batch.provider),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
  await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id);await op({action:'bind',batch_id:batch.id,task_id:task.id,run_id:run.run_id});await host.tasks.beginDelivery({task_id:task.id,goal_revision:0,control_revision:0},'interrupted');await host.tasks.recoveryWait(task.id,'task_delivery_uncertain')
  memory={sourceProcessing:op,sourceProcessingConsumer:()=>provider} as unknown as PersonalMemoryResource
  await host.scheduledTaskTick();assert.equal(host.tasks.get(task.id).pending_delivery,'interrupted');assert.notEqual(host.tasks.get(task.id).phase,'cancelled')
  await host.close();host=make();await host.open();await host.scheduledTaskTick()
  assert.equal(host.tasks.get(task.id).phase,'cancelled');assert.equal(host.tasks.get(task.id).pending_delivery,undefined);assert.equal(host.schedules.getRun(run.run_id).stage,'terminal')
  assert.equal((await op({action:'status'}) as {active_batch:unknown}).active_batch,null)
  const retry=await op({action:'claim'}) as ProcessingBatch;assert.deepEqual(retry.items,batch.items)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})


test('compose deduplicates restored references across slices of one long document',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-slices-')),db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:test:',provider='provider',op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider,...request}))
 let memory:PersonalMemoryResource|undefined
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();await host.scheduledTaskTick()
  const at=new Date().toISOString(),id=prefix+'long'
  memoryOperation(db,'append_evidence',{id,source_id:prefix+'s',source_kind:'file',locator:'project-notes.md',raw_text:'Long-term project research. '.repeat(550),hash:'v1',observed_at:at,recorded_at:at,trust:'untrusted_external'})
  memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const batch=await op({action:'claim'}) as ProcessingBatch
  assert.equal(batch.items.length,4)
  const schedule=await host.schedules.ensureSourceProcessing('test'),run=await host.schedules.claimSourceProcessing(schedule.id,batch.id,batch.provider),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
  await host.schedules.bindTask(run.run_id,task.id);await op({action:'bind',batch_id:batch.id,task_id:task.id,run_id:run.run_id})
  memory={sourceProcessing:op,sourceProcessingConsumer:()=>provider,
   sourceProcessingObserve:()=>Promise.resolve([{kind:'work',text:'Long-term project research',refs:Array.from({length:3},()=>({entry_id:id,version:'v1'}))}]),
   sourceProcessingProfile:()=>Promise.resolve({about:{text:'Long-term project research',refs:[{entry_id:id,version:'v1'}]},work:[],interests:[]})} as unknown as PersonalMemoryResource
  const grant=host.scheduledAuthority.issue(host.schedules.getRun(run.run_id),task,new AbortController().signal,provider)
  await host.sourceProcessingAgent.call(grant,'read',{action:'read'})
  await host.sourceProcessingAgent.call(grant,'compose',{action:'compose',refs:batch.items})
  const context=await op({action:'profile_context',batch_id:batch.id,task_id:task.id,run_id:run.run_id}) as {observations:{refs:unknown[]}[]}
  assert.equal(context.observations.length,1)
  assert.deepEqual(context.observations[0]!.refs,batch.items)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})

test('profile rule migration reuses observations and products without regenerating either',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-profile-rewrite-')),db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:test:',provider='provider',op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider,...request}))
 let memory:PersonalMemoryResource|undefined
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();await host.scheduledTaskTick()
  const at=new Date().toISOString(),id=prefix+'project',refs=[{entry_id:id,version:'v1'}]
  memoryOperation(db,'append_evidence',{id,source_id:prefix+'s',source_kind:'file',locator:'project.md',raw_text:'I lead Orchard. Review the prototype.',hash:'v1',observed_at:at,recorded_at:at,trust:'untrusted_external'})
  memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const initial=await op({action:'claim'}) as ProcessingBatch,owner={batch_id:initial.id,task_id:'fixture',run_id:'fixture'}
  await op({action:'bind',...owner});await op({action:'read',batch_id:initial.id});await op({action:'observe',...owner,refs:initial.items,observations:[{kind:'work',text:'Leads Orchard',refs:initial.items}]})
  const context=await op({action:'profile_context',...owner}) as {key:string;refs:ProcessingBatch['items']}
  const products={projects:[],suggestions:[{id:'prototype',kind:'action' as const,title:'Review prototype',body:'Review the prototype.',project_id:null,todo_id:null,due:null,refs}]}
  await op({action:'publish',...owner,expected_revision:0,profile_context_key:context.key,refs:context.refs,draft:{about:{text:'Old portrait',refs},work:[],interests:[]},products});await op({action:'commit',...owner,topics:[]})
  db.prepare("UPDATE processing_profiles SET payload_json=json_remove(payload_json,'$.generation_version')").run()
  const batch=await op({action:'claim'}) as ProcessingBatch,schedule=await host.schedules.ensureSourceProcessing('test'),run=await host.schedules.claimSourceProcessing(schedule.id,batch.id,batch.provider),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
  await host.schedules.bindTask(run.run_id,task.id);await op({action:'bind',batch_id:batch.id,task_id:task.id,run_id:run.run_id})
  let generated=0
  memory={sourceProcessing:op,sourceProcessingConsumer:()=>provider,
   sourceProcessingProducts:()=>{throw Error('unchanged products must not regenerate')},sourceProcessingObserve:()=>{throw Error('unchanged observations must not regenerate')},
   sourceProcessingProfile:(_entries:unknown,_signal:unknown,_authorize:unknown,_modelCall:unknown,observations:unknown[])=>{generated++;assert.equal(observations.length,1);return Promise.resolve({about:{text:'Rewritten portrait',refs},work:[],interests:[]})}} as unknown as PersonalMemoryResource
  const grant=host.scheduledAuthority.issue(host.schedules.getRun(run.run_id),task,new AbortController().signal,provider)
  await host.sourceProcessingAgent.call(grant,'read',{action:'read'})
  await assert.rejects(host.sourceProcessingAgent.call(grant,'premature-finish',{action:'finish',topics:[]}),/compose/)
  await host.sourceProcessingAgent.call(grant,'compose',{action:'compose',refs:batch.items})
  await host.sourceProcessingAgent.call(grant,'finish',{action:'finish',topics:[]})
  assert.equal(generated,1)
  const snapshot=await op({action:'products'}) as {draft:{about:{text:string}};suggestions:unknown[]}
  assert.equal(snapshot.draft.about.text,'Rewritten portrait');assert.deepEqual(snapshot.suggestions,products.suggestions)
  assert.equal(await op({action:'claim'}),null)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})


test('saved observations cannot finish a batch whose Profile publication failed',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-publish-failed-')),db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:test:',provider='provider',op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider,...request}))
 let memory:PersonalMemoryResource|undefined
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();await host.scheduledTaskTick()
  const at=new Date().toISOString(),id=prefix+'project'
  memoryOperation(db,'append_evidence',{id,source_id:prefix+'s',source_kind:'conversation',locator:'project',raw_text:'I develop Orchard.',hash:'v1',observed_at:at,recorded_at:at,trust:'trusted_user'})
  memoryOperation(db,'source_grant',{source_id:prefix+'s',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
  const batch=await op({action:'claim'}) as ProcessingBatch,schedule=await host.schedules.ensureSourceProcessing('test'),run=await host.schedules.claimSourceProcessing(schedule.id,batch.id,batch.provider),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
  await host.schedules.bindTask(run.run_id,task.id);await op({action:'bind',batch_id:batch.id,task_id:task.id,run_id:run.run_id})
  memory={sourceProcessing:op,sourceProcessingConsumer:()=>provider,sourceProcessingObserve:()=>Promise.resolve([{kind:'work',text:'Develops Orchard',refs:[{entry_id:id,version:'v1'}]}]),sourceProcessingProfile:()=>{throw new DOMException('Model timed out','TimeoutError')}} as unknown as PersonalMemoryResource
  const grant=host.scheduledAuthority.issue(host.schedules.getRun(run.run_id),task,new AbortController().signal,provider)
  await host.sourceProcessingAgent.call(grant,'read',{action:'read'})
  await assert.rejects(host.sourceProcessingAgent.call(grant,'compose',{action:'compose',refs:batch.items}),/timed out/)
  await assert.rejects(host.sourceProcessingAgent.call(grant,'finish',{action:'finish',topics:[]}),/publication/)
  const state=await op({action:'batch',batch_id:batch.id}) as {observed:boolean;published?:boolean;batch:ProcessingBatch}
  assert.equal(state.observed,true);assert.equal(state.published,false);assert.equal(state.batch.status,'bound')
  assert.deepEqual(await host.sourceProcessingAgent.decision(host.tasks.get(task.id)),{kind:'wait',reason:'processing_incomplete',evidence_refs:[]})
  assert.equal((await op({action:'status'}) as {completed_batches:number}).completed_batches,0)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})
