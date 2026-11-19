import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {emptyContextDependencies} from '../src/personal-agent/context-dependencies.js'
import {emptyLifeState} from '../src/personal-agent/life.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import type {ScheduleRun} from '../src/personal-agent/scheduled-tasks.js'
import type {FeedItem} from '../src/personal-agent/contracts.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import {createMem0PersonalMemory} from '../src/mem0/resource.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {Memory} from '../src/core/memory.js'
import {compileContextView} from '../src/core/context-view.js'
import {runProactiveSelection} from '../src/core/calls.js'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import {GatewayProactivity} from '../src/model/proactivity.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import {provider,eventually,turn} from './helpers/mem0-fixture.js'

const privateText='Synthetic orchid report'
const now=new Date('2026-11-02T12:00:00Z')
const reason={kind:'suggestion_selected' as const,priority:40,routing_class:'ambient' as const,origin:null,selected_suggestion:null}

for(const backend of ['mem0','ledger'] as const)test(`host product memory: ${backend} discovery, persisted feed, selector and voice destinations`,{timeout:30000},async t=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-product-memory-')),path=join(directory,'host.json')
 const endpoint=await provider(false,privateText),ledger=backend==='ledger'
 const memory:PersonalMemoryResource=ledger?new SubstrateMemoryResource({client:new MemoryLedgerClient(join(directory,'ledger.sqlite')),userId:'test',model:'extract',inputConsent:true,conversationProviders:['support-a','voice-a'],consolidation:{enabled:false},gateway:{async *stream(){await Promise.resolve();throw Error('unexpected extraction')},complete:()=>Promise.reject(Error('unexpected extraction'))}}):createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'test',conversationProviders:['support-a','voice-a'],embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'})
 let host:PersonalAgentHost|undefined
 t.after(async()=>{await host?.close();await memory.close();await endpoint.close();await rm(directory,{recursive:true,force:true})})
 await memory.open()
 const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'UTC',quiet_start:'00:00',quiet_end:'00:00'}
 await new PersonalStore(path).write(state)
 if(ledger){const backend=memory.lifeBackend!(),initial=await backend.load(emptyLifeState());await backend.mutate({input:{op:'create',kind:'todo',title:privateText,due:'2026-11-02'},requestId:'seed',expectedRevision:initial.revision})}
 else {await memory.remember!(turn('private-source',privateText));await eventually(async()=>(await memory.list!()).entries.length===1)}
 const entry=(await memory.list!()).entries[0]!,evidence=entry.evidence_refs![0]!
 assert.equal(memory.productSurfaces===true,ledger)
 let activeMemory:PersonalMemoryResource|undefined=memory
 let support='support-a',voice='voice-a',pool=new SuggestionPool()
 const inputs:{destination:string;kind:string;text:string}[]=[]
 const proposal={kind:'question' as const,summary:privateText,why_now:privateText,evidence_refs:[],memory_refs:[{entry_id:entry.id,version:entry.version!}]}
 const gateway:ModelGateway={async *stream(){await Promise.resolve();throw Error('unexpected stream')},complete:request=>{
  const discovery=request.system.includes('discovery opportunity'),brief=request.system.includes('Prepare read-only material')
  inputs.push({destination:request.model,kind:discovery?'discovery':brief?'brief':'selector',text:request.prompt})
  if(brief)return Promise.resolve({text:'null'})
  return Promise.resolve({text:JSON.stringify(discovery?{proposals:[proposal]}:{speak:false,suggestion_id:null,progress_class:null,reason:'silent'})})
 }}
 const proactive=()=>new GatewayProactivity({gateway,model:support,proactivityPreset:'balanced'})
 const context=()=>compileContextView(new Memory(), 'idle', now.getTime()/1000,{suggestions:pool.all()})
 const make=()=>{
  const value=new PersonalAgentHost({path,userScope:'test',memory:()=>activeMemory,pool,now:()=>now,context,evidence:ref=>ref==='external'?{subject_key:'external',source:{type:'file',ref}}:null,evidenceRefs:()=>['external'],discoveryMemoryConsumer:()=>support,discover:(snapshot,signal)=>proactive().discover(snapshot,signal)})
  value.setRetrieval(new UnifiedRetrieval({memory:()=>activeMemory}))
  value.setConversationRuntime(conversation=>{
   const destination=voice
   inputs.push({destination,kind:'voice-history',text:JSON.stringify(conversation)})
   return Promise.resolve({runTurn:()=>Promise.resolve({assistant:''}),deliverSuggestion:suggestion=>{inputs.push({destination,kind:'voice',text:JSON.stringify(suggestion.content)})},close:()=>Promise.resolve()})
  },()=>{/* no renderer */})
  return value
 }
 host=make();await host.open()
 let requests=0
 const command=(method:string,params:Record<string,unknown>)=>host!.command({type:'personal.command',request_id:'request-'+(++requests),method,params}) as Promise<{ok:boolean;error?:string}>
 assert.equal((await command('discovery.configure',{discovery_enabled:true})).ok,true)
 inputs.length=0
 const reads=ledger?[]:(['list','get','getMany','readEvidence','recall'] as const).map(method=>t.mock.method(memory as Required<Pick<PersonalMemoryResource,'list'|'get'|'getMany'|'readEvidence'|'recall'>>,method))
 await host.discover()
 for(const read of reads){assert.equal(read.mock.callCount(),0,'discovery never reads a non-substrate resource');read.mock.restore()}
 const discovered=inputs.filter(input=>input.kind==='discovery')
 assert.ok(discovered.length>0,'capture the actual discovery gateway prompt')
 assert.equal(discovered.some(input=>input.text.includes(privateText)),ledger)
 assert.equal(host.snapshot().feed.length,ledger?1:0,'a non-substrate cannot admit a memory proposal, even from a misbehaving model')
 assert.ok(host.snapshot().memory.entries.some(row=>row.content===privateText),'Memory-page management still lists the resource')
 assert.equal((await host.dailyBriefSnapshot()).memory.some(row=>row.content===privateText),ledger)
 // A forged old snapshot must not restore product access.
 if(!ledger)assert.equal(await host.admit(proposal,{...await host.discoverySnapshot(),memory:[entry]}),'rejected')
 await host.close()
 const saved=await new PersonalStore(path).read();saved.settings.discovery_enabled=false;saved.feed=[]
 // Cover memory-only, evidence-only, and prepared-evidence dependencies retained by an older host.
 for(const kind of ['memory','evidence','prepared'] as const){
  const item:FeedItem={id:'old-'+kind,kind:'question',title:privateText,why_now:privateText,evidence_refs:kind==='evidence'?[evidence]:[],memory_refs:kind==='memory'?[{entry_id:entry.id,version:entry.version!}]:[],source:{type:'memory',ref:entry.id},subject_key:'old-'+kind,task_ref:null,suggestion_id:null,priority:100,created_at:now.toISOString(),updated_at:now.toISOString(),expires_at:null,user_state:'new',snooze_until:null,lifecycle:'active',delivery:{presented_at:now.toISOString(),notified_at:null,spoken_at:null},...(kind==='prepared'?{prepared:{trust:'untrusted_external',text:privateText,evidence_refs:[evidence]}}:{})}
  saved.feed.push(item)
  saved.conversations.items[0]!.messages.push({id:'feed:'+item.id,conversation_id:'chat:main',role:'assistant',origin:'proactive',text:privateText,created_at:now.toISOString()})
 }
 await new PersonalStore(path).write(saved)
 pool=new SuggestionPool();host=make();await host.open();await host.flushNotifications()
 assert.equal(host.snapshot().feed.filter(item=>item.lifecycle==='active').length,3,'restart retains the local feed')
 for(const destination of ['a','b']){
  support='support-'+destination;voice='voice-'+destination
  inputs.length=0
  assert.equal(pool.all().some(item=>item.status==='pending'&&JSON.stringify(item.content).includes(privateText)),ledger,'pool never acquires non-ledger feed text')
  await runProactiveSelection(proactive(),{view:context(),reason})
  await proactive().discover(await host.discoverySnapshot(),new AbortController().signal)
  assert.equal(inputs.some(input=>input.kind==='selector'&&input.text.includes(privateText)),ledger)
  assert.equal(inputs.some(input=>input.kind==='discovery'&&input.text.includes(privateText)),ledger)
  assert.equal((await host.dailyBriefSnapshot()).recent_delivery.length,ledger?3:0)
  assert.equal((await command('conversations.voice',{id:'chat:main',enabled:true})).ok,true)
  // Exercise the legacy voice route, then the orb route, without adding a forged suggestion to the shared pool.
  const manual=new SuggestionPool().add({origin:'surrogate',kind:'notify',content:{summary:privateText,personal_feed_id:'old-memory'}})
  host.routePersonalSuggestion(manual,{...reason,selected_suggestion:manual.id})
  assert.equal((await command('presentation.set',{mode:'orb'})).ok,true)
  for(const item of host.snapshot().feed){
   const suggestion=new SuggestionPool().add({origin:'surrogate',kind:'notify',content:{summary:item.title,personal_feed_id:item.id}})
   host.routePersonalSuggestion(suggestion,{...reason,selected_suggestion:suggestion.id})
  }
  if(ledger)await eventually(()=>inputs.filter(input=>input.kind==='voice').length>=(destination==='a'?4:3))
  else for(let i=0;i<20;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(inputs.some(input=>input.kind==='voice'&&input.text.includes(privateText)),ledger,'actual voice delivery sink is isolated regardless of destination')
  assert.equal(inputs.some(input=>input.kind==='voice-history'&&input.text.includes(privateText)),ledger,'persisted local feed bubbles do not enter voice handoff')
  assert.equal(inputs.filter(input=>input.destination===support||input.destination===voice).some(input=>input.text.includes(privateText)),ledger)
  assert.equal(host.snapshot().feed.length,3)
  if(host.voiceConversationId())assert.equal((await command('conversations.voice',{id:'chat:main',enabled:false})).ok,true)
  assert.equal((await command('presentation.set',{mode:'workbench'})).ok,true)
 }
 // Produce real verified task prose and a scheduled summary at destination A, then reload at B.
 support='support-a'
 const taskText=privateText+' verified task',scheduledText=privateText+' scheduled summary',legacyText=privateText+' legacy task'
 if(!ledger){
  const recalled=await new UnifiedRetrieval({memory:()=>memory}).recall('orchid',{consumer:support})
  assert.ok(recalled.entries.some(item=>item.text===privateText),'task can recall mem0 at destination A')
 }
 const task=await host.tasks.delegate('product-task',{conversation_id:'chat:main',goal:'Report',acceptance:['Report delivered'],origin_ref:'conversation:product-task'})
 const fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
 await host.tasks.recordDelivery(fence,'product-task-answer',taskText)
 const verified=await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:product-task-answer'],criteria:[{index:0,evidence_refs:['task-delivery:product-task-answer']}]})
 await host.taskResult(task.id,'Verified task',verified)
 const scope={todos:false,goals:false,tasks:false,memory:true,knowledge:false,search:false}
 const schedule=await host.schedules.create('product-schedule',{title:'Scheduled report',goal:'Report',acceptance:['Report delivered'],rule:{kind:'daily',timezone:'UTC',time:'10:00'},context:scope},{user_scope:'test',source:'ui',origin_ref:'ui:product-schedule',source_refs:[],allowed_context:scope})
 const run=await host.schedules.runNow('product-run',schedule.id,1),scheduled=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
 const scheduledFence={task_id:scheduled.id,control_revision:scheduled.control_revision,goal_revision:scheduled.goal_revision}
 await host.schedules.bindTask(run.run_id,scheduled.id)
 await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
 await host.tasks.recordContextEvidence(scheduledFence,'product-context',JSON.stringify({consumer:support}),[evidence])
 await host.tasks.recordDelivery(scheduledFence,'product-scheduled-answer',scheduledText)
 await host.tasks.applyDecision(scheduledFence,{kind:'complete',evidence_refs:['task-delivery:product-scheduled-answer'],criteria:[{index:0,evidence_refs:['task-delivery:product-scheduled-answer']}]})
 await host.publishScheduledResult(run.run_id)
 const taskFeed=host.snapshot().feed.find(item=>item.task_ref?.work_id===task.id)!,scheduledFeed=host.snapshot().feed.find(item=>item.id==='scheduled-result:'+run.run_id)!
 assert.equal(taskFeed.prepared?.text,taskText)
 assert.equal(taskFeed.memory_origin,ledger?undefined:'non_product')
 assert.deepEqual(scheduledFeed.evidence_refs,[evidence])
 assert.equal(scheduledFeed.memory_origin,ledger?undefined:'non_product')
 for(const feed of [taskFeed,scheduledFeed])await host.action({id:feed.id,action:'presented'})
 await host.close()
 const persisted=await new PersonalStore(path).read()
 // Resolved legacy evidence-only feeds survive revalidation, so their gate is tested directly.
 for(const feed of persisted.feed.filter(item=>item.id.startsWith('old-')))feed.lifecycle='resolved'
 // Old scheduled summaries and evidence-only feeds must also fail when memory is removed.
 delete persisted.feed.find(item=>item.id===scheduledFeed.id)!.memory_origin
 const legacySchedules=JSON.parse(await readFile(path+'.schedules.json','utf8')) as {runs:ScheduleRun[]}
 delete legacySchedules.runs.find(item=>item.run_id===run.run_id)!.terminal_summary!.memory_origin
 await writeFile(path+'.schedules.json',JSON.stringify(legacySchedules))
 persisted.feed.push({...structuredClone(taskFeed),id:'legacy-task',title:legacyText,prepared:{trust:'untrusted_external',text:legacyText,evidence_refs:[]},delivery:{presented_at:now.toISOString(),notified_at:null,spoken_at:null}})
 delete persisted.feed.at(-1)!.memory_origin
 // This verified task read no app/source context; unlike a legacy answer after the scheduled report, its provenance is known.
 assert.equal(host.tasks.evidence(task.id).some(item=>item.kind==='context'),false)
 persisted.conversations.items[0]!.messages.push({id:'feed:'+taskFeed.id,conversation_id:'chat:main',role:'assistant',origin:'proactive',text:taskText,context_dependencies:emptyContextDependencies(),created_at:now.toISOString()})
 await new PersonalStore(path).write(persisted)
 const control=ledger?memory:new SubstrateMemoryResource({client:new MemoryLedgerClient(join(directory,'restart-ledger.sqlite')),userId:'test',model:'extract',inputConsent:true,consolidation:{enabled:false},gateway:{async *stream(){await Promise.resolve();throw Error('unexpected extraction')},complete:()=>Promise.reject(Error('unexpected extraction'))}})
 if(!ledger){await control.open();t.after(()=>control.close())}
 for(const restart of ['same','none','ledger'] as const){
  activeMemory=restart==='none'?undefined:restart==='ledger'?control:memory
  const product=activeMemory?.productSurfaces===true
  support='support-b';voice='voice-b';pool=new SuggestionPool();host=make();await host.open()
  inputs.length=0
  await proactive().discover(await host.discoverySnapshot(),new AbortController().signal)
  const brief=await host.dailyBriefSnapshot()
  await new GatewayPersonalWriter({gateway,model:support}).prepareBrief(brief,{kind:'outlook',local_date:'2026-11-02',timezone:'UTC',scheduled_at:now.toISOString(),dedupe_key:'test-brief'},new AbortController().signal)
  for(const kind of ['discovery','brief']){
   const captured=inputs.filter(input=>input.kind===kind&&input.destination==='support-b')
   assert.ok(captured.length>0,'actual '+kind+' gateway input after '+restart+' restart')
   assert.equal(captured.some(input=>input.text.includes(taskText)),ledger,'marked task prose never becomes product context')
   assert.equal(captured.some(input=>input.text.includes(scheduledText)),product,'legacy scheduled evidence requires a product substrate')
   assert.equal(captured.some(input=>input.text.includes(legacyText)),true,'unmarked legacy task prose remains eligible')
   if(!activeMemory)assert.ok(captured.every(input=>!input.text.includes(scheduledText)),'removing memory must not allow retained evidence-only feeds')
  }
  assert.ok(host.snapshot().feed.some(item=>item.prepared?.text===taskText),'local task text survives restart')
  assert.ok(host.snapshot().feed.some(item=>item.prepared?.text===scheduledText),'local scheduled text survives restart')
  assert.ok(host.conversationSnapshot().messages.some(message=>message.text.includes(scheduledText)),'local scheduled history remains visible')
  assert.ok(!pool.all().some(item=>JSON.stringify(item.content).includes(taskText))||ledger)
  assert.equal((await command('conversations.voice',{id:'chat:main',enabled:true})).ok,true)
  const suggestion=new SuggestionPool().add({origin:'surrogate',kind:'notify',content:{summary:taskText,personal_feed_id:taskFeed.id}})
  host.routePersonalSuggestion(suggestion,{...reason,selected_suggestion:suggestion.id})
  if(ledger)await eventually(()=>inputs.some(input=>input.kind==='voice'&&input.text.includes(taskText)))
  assert.equal(inputs.some(input=>input.kind==='voice'&&input.text.includes(taskText)),ledger)
  assert.equal(inputs.some(input=>input.kind==='voice-history'&&input.text.includes(taskText)),ledger)
  await host.close()
 }

})
