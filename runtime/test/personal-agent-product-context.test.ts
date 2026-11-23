import type {MemoryEntry} from '../src/memory/entry.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {emptyLifeState} from '../src/personal-agent/life.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {createConversation,type ConversationRuntime} from '../src/personal-agent/conversations.js'
import {PersonalStore} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {HostContextItem} from '../src/realtime/protocol.js'
import type {CascadedLlmSession} from '../src/realtime/cascaded/llm.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import {createMem0PersonalMemory} from '../src/mem0/resource.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {provider,eventually,turn} from './helpers/mem0-fixture.js'
// Quiet hours (default 22:00-08:00) follow the machine's zone unless a test sets one. These fixtures use fixed clocks
// (or the real clock) and expect delivery, so pin the zone instead of depending on where and when the suite runs.
process.env.TZ = 'UTC'

const report='Synthetic orchid prior report'
const taskText='Synthetic orchid generated task answer'
const settings=(destination='a')=>settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',cascade_llm_model:'test-'+destination,dashscope_api_key:'test'})
const gateway:ModelGateway={complete:input=>{
 const data=JSON.parse(input.prompt) as {evidence:{ref:string;kind:string}[]}
 const refs=data.evidence.filter(row=>row.kind==='delivery').map(row=>row.ref)
 return Promise.resolve({text:JSON.stringify({kind:'complete',evidence_refs:refs,criteria:[{index:0,evidence_refs:refs}]})})
},async *stream(){await Promise.resolve();throw Error('unexpected stream')}}
const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
type CreateProvider=NonNullable<Parameters<typeof conversationRuntimeFactory>[0]['createTextProvider']>

/** Capture the actual adapter's LLM requests, history restoration and provider context injection. */
function captureProvider(stream:CascadedLlmSession['stream'],histories:string[]=[],injected:HostContextItem[]=[]):CreateProvider{
 return options=>{
  const value=buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({stream,restoreHistory:history=>{histories.push(JSON.stringify(history));return Promise.resolve()},abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()})})}})
  const inject=value.injectHostItem.bind(value)
  value.injectHostItem=(item,options)=>{injected.push(item);return inject(item,options)}
  return value
 }
}

async function fixture(backend:'none'|'mem0'|'ledger'){
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-product-context-')),path=join(directory,'personal.json'),endpoint=await provider(false,taskText)
 const memory:PersonalMemoryResource|undefined=backend==='none'?undefined:backend==='mem0'?createMem0PersonalMemory({path:join(directory,'memory.sqlite'),userId:'test',conversationProviders:['task-consumer'],embedding:{baseUrl:endpoint.baseUrl,apiKey:'test',model:'embedding',dimensions:2},extractionModel:'extract'}):new SubstrateMemoryResource({client:new MemoryLedgerClient(join(directory,'ledger.sqlite')),userId:'test',model:'extract',inputConsent:true,consolidation:{enabled:false},gateway})
 await memory?.open()
 const pool=new SuggestionPool(),make=()=>new PersonalAgentHost({path,userScope:'test',memory:()=>memory,pool,evidence:()=>null,now:()=>new Date('2026-11-02T12:00:00Z')})
 const host=make();await host.open();await host.scheduledTaskTick()
 return {path,memory,pool,host,make,async close(){await memory?.close();await endpoint.close();await rm(directory,{recursive:true,force:true})}}
}

for(const backend of ['none','mem0','ledger'] as const)test(`scheduled product context reaches real model inputs only when eligible (${backend})`,{timeout:30000},async()=>{
 const f=await fixture(backend),host=f.host,eligible=backend!=='mem0'
 const followUps:string[]=[],scheduledInputs:string[]=[],histories:string[]=[]
 try{
  const schedule=await host.schedules.create('create',{title:'Review',goal:'Review current todos',acceptance:['Report'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context},{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context})
  const run=await host.schedules.runNow('first',schedule.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
  await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
  await host.readAppContext('todos',null,host.scheduledRunGrant(run.run_id,new AbortController().signal,null))
  await host.tasks.recordDelivery(fence,'prior-answer',report)
  await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:prior-answer'],criteria:[{index:0,evidence_refs:['task-delivery:prior-answer']}]})
  await host.publishScheduledResult(run.run_id)
  const feed=host.snapshot().feed.find(item=>item.schedule_ref?.run_id===run.run_id)!
  assert.equal(feed.memory_origin,eligible?undefined:'non_product')
  assert.ok(feed.evidence_refs.every(ref=>ref.startsWith('app:')))
  assert.equal(await host.scheduledResultAuthorized(run.run_id),eligible,'no-memory app-only references resolve independently')
  let scheduledResponses=0
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings(),searchTransport:{search:()=>Promise.reject(Error('unexpected search'))},createTextProvider:options=>captureProvider(async function*(input){
   await Promise.resolve()
   const id=options.scheduledTask?'scheduled-'+(++scheduledResponses):'follow-up'
   if(options.scheduledTask)scheduledInputs.push(JSON.stringify(input.inputs));else followUps.push(JSON.stringify(input))
   yield {kind:'response_started',response_id:id}
   if(options.scheduledTask&&scheduledResponses===1)yield {kind:'tool_call',item_id:'context',call_id:'context',name:'app__context',arguments:{section:'todos',cursor:null}}
   else yield {kind:'text_delta',text:'Current report'}
   yield {kind:'response_completed',response_id:id}
  },histories)(options)}),()=>{/* local renderer */})
  await host.submitConversationText('chat:main','Explain the prior report','follow-up');await host.waitConversation('chat:main')
  assert.equal(followUps.length,1,'capture actual cascaded LLM request, not factory arguments')
  assert.equal(followUps.some(input=>input.includes(report)),eligible,'scheduled follow-up adaptation respects provenance')
  assert.ok(host.conversationSnapshot().messages.some(message=>message.text.includes(report)),'local scheduled bubble remains visible')
  const next=await host.schedules.runNow('second',schedule.id,1);await host.scheduledTaskTick()
  const deadline=Date.now()+10000
  while(Date.now()<deadline&&!host.schedules.getRun(next.run_id).terminal_summary?.published)await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(host.schedules.getRun(next.run_id).terminal_summary?.published,true,JSON.stringify({stage:host.schedules.getRun(next.run_id).stage,tasks:host.tasks.list().map(task=>({phase:task.phase,waiting_reason:task.waiting_reason})),requests:scheduledInputs.length}))
  assert.ok(scheduledInputs.length>0)
  assert.equal(scheduledInputs.some(input=>input.includes(report)),eligible,'later scheduled execution receives only eligible recent summaries')
  assert.ok(histories.every(input=>!input.includes(report)),'scheduled reports are not ordinary paired dialogue')
 }finally{await host.close();await f.close()}
})

for(const backend of ['none','mem0','ledger'] as const)test(`generated task provenance survives restart and destination change at real voice handoff (${backend})`,{timeout:30000},async()=>{
 const f=await fixture(backend),eligible=backend!=='mem0'
 let host=f.host,sequence=0
 const generated:Record<string,unknown>[]=[],handoffs:HostContextItem[]=[],voiceInputs:string[]=[],historyInputs:string[]=[]
 const voice=captureProvider(async function*(input){await Promise.resolve();voiceInputs.push(JSON.stringify(input));yield {kind:'response_started',response_id:'announcement'};yield {kind:'text_delta',text:'Announced'};yield {kind:'response_completed',response_id:'announcement'}},[],handoffs)
 try{
  if(backend==='mem0'){
   await f.memory!.remember!(turn('task-source',taskText));await eventually(async()=>(await f.memory!.list!()).entries.length===1)
   const recalled=await new UnifiedRetrieval({memory:()=>f.memory}).recall('orchid',{consumer:'task-consumer'})
   assert.ok(recalled.entries.some(entry=>entry.text===taskText),'the producing task can recall non-product memory')
  }
  const factory=conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings(),createTextProvider:captureProvider(async function*(input){
   await Promise.resolve();const id='response-'+(++sequence);yield {kind:'response_started',response_id:id};yield {kind:'text_delta',text:JSON.stringify(input.inputs).includes('continue_authorized_task')?taskText:'Warm reply'};yield {kind:'response_completed',response_id:id}
  })})
  // Exercise the real task action graph, as used by isolated delegated execution.
  host.setConversationRuntime((conversation,emit,mode,lifetime,recovery,execution)=>factory(conversation,emit,mode,lifetime,recovery,execution,{chat:false}),frame=>{generated.push(frame)})
  await host.submitConversationText('chat:main','Warm up','warm');await host.waitConversation('chat:main')
  const task=await host.tasks.delegate('task',{conversation_id:'chat:main',conversation_generation:0,goal:'Produce report',acceptance:['Report'],origin_ref:'conversation:task',execution_route:'nova'})
  await host.wakeTask(task.id)
  await eventually(()=>host.tasks.get(task.id).phase==='completed'&&host.snapshot().feed.some(feed=>feed.task_id===task.id))
  await eventually(()=>host.conversationSnapshot().messages.some(message=>message.task_ids?.includes(task.id)&&message.text===taskText))
  const bubble=host.conversationSnapshot().messages.find(message=>message.task_ids?.includes(task.id)&&message.text===taskText)!
  assert.equal(bubble.memory_origin,eligible?undefined:'non_product')
  assert.ok(bubble.turn_id&&!bubble.turn_id.startsWith('task:'),'production caption turn id is not a task-shaped identifier')
  assert.ok(generated.some(frame=>frame.type==='conversation.completed'&&Array.isArray(frame.task_ids)&&frame.task_ids.includes(task.id)))
  const feed=host.snapshot().feed.find(feed=>feed.task_id===task.id)!
  assert.equal(feed.memory_origin,eligible?undefined:'non_product')
  await host.command({type:'personal.command',request_id:'orb',method:'presentation.set',params:{mode:'orb'}})
  assert.equal(f.pool.all().some(suggestion=>suggestion.content.personal_feed_id===feed.id),eligible,'no-memory tasks still reach suggestion selection')
  await host.close()
  if(backend==='mem0'){
   const saved=await new PersonalStore(f.path).read(),message=saved.conversations.items[0]!.messages.find(message=>message.task_ids?.includes(task.id))!
   assert.equal(message.memory_origin,'non_product','message provenance survives strict store round trip')
   // Identity must also bind the bubble to its marked feed, without guessing caption IDs.
   delete message.memory_origin;await new PersonalStore(f.path).write(saved)
  }
  host=f.make();await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings('b'),createVoiceProvider:voice,createTextProvider:captureProvider(async function*(input){await Promise.resolve();historyInputs.push(JSON.stringify(input));yield {kind:'response_started',response_id:'later'};yield {kind:'text_delta',text:'Later reply'};yield {kind:'response_completed',response_id:'later'}},historyInputs)}),()=>{/* local renderer */})
  assert.ok(host.conversationSnapshot().messages.some(message=>message.text===taskText),'generated task bubble remains listed after restart')
  await host.submitConversationText('chat:main','Later question','later');await host.waitConversation('chat:main')
  assert.ok(historyInputs.length>0)
  const ack=await host.command({type:'personal.command',request_id:'voice',method:'conversations.voice',params:{id:'chat:main',enabled:true}}) as {ok:boolean}
  assert.equal(ack.ok,true)
  const handoff=handoffs.find(item=>item.content.includes('conversation_handoff'))
  assert.ok(handoff,'capture actual provider.injectHostItem handoff at destination B')
  assert.equal(handoff.content.includes(taskText),eligible)
  const suggestion=f.pool.add({origin:'surrogate',kind:'notify',content:{summary:taskText,personal_feed_id:feed.id}})
  voiceInputs.length=0
  host.routePersonalSuggestion(suggestion,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:suggestion.id})
  if(eligible)await eventually(()=>voiceInputs.some(input=>input.includes(taskText)))
  else for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(voiceInputs.some(input=>input.includes(taskText)),eligible,'memory-disabled voice delivery is unchanged')
 }finally{await host.close();await f.close()}
})

for(const [backend,count] of [['none',1],['mem0',1],['mem0',2]] as const)test(`foreground declare/tool continuation retains all task fences (${backend}, ${count})`,{timeout:30000},async()=>{
 const f=await fixture(backend),eligible=backend==='none',histories:string[]=[],requests:string[]=[],injected:HostContextItem[]=[]
 let host=f.host,responses=0
 try{
  // This test owns the foreground declaration chain, not the background worker loop.
  host.wakeTask=()=>Promise.resolve()
  const factory=conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings(),createTextProvider:captureProvider(async function*(){
   await Promise.resolve();const n=++responses,id='declare-'+n
   yield {kind:'response_started',response_id:id}
   if(n<=count)yield {kind:'tool_call',item_id:'task-'+n,call_id:'task-'+n,name:'task',arguments:{operation:'declare',goal:'Report '+n,acceptance:[],source_refs:[],origin_ref:'conversation:1'}}
   else yield {kind:'text_delta',text:taskText}
   yield {kind:'response_completed',response_id:id}
  })})
  host.setConversationRuntime((conversation,emit,mode,lifetime,recovery,execution)=>factory(conversation,emit,mode,lifetime,recovery,execution,{chat:false}),()=>{/* local renderer */})
  await host.submitConversationText('chat:main','Produce reports','declare');await host.waitConversation('chat:main')
  const tasks=host.tasks.list(),bubble=host.conversationSnapshot().messages.find(message=>message.text===taskText)!
  assert.equal(tasks.length,count)
  assert.deepEqual(new Set(bubble.task_ids),new Set(tasks.map(task=>task.id)))
  assert.equal(bubble.memory_origin,eligible?undefined:'non_product')
  await eventually(()=>host.tasks.evidence(tasks[0]!.id).some(row=>row.kind==='delivery'))
  const first=tasks[0]!,fence={task_id:first.id,control_revision:first.control_revision,goal_revision:first.goal_revision},delivery=host.tasks.evidence(first.id).find(row=>row.kind==='delivery')!
  const verified=await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:[delivery.ref]})
  await host.taskResult('verified:'+first.id+':0','First task',verified)
  await host.close()
  const saved=await new PersonalStore(f.path).read(),persisted=saved.conversations.items[0]!.messages.find(message=>message.text===taskText)!
  assert.equal(persisted.memory_origin,eligible?undefined:'non_product')
  // With two fences only the first feed is excluded; the whole shared reply must be excluded.
  assert.equal(saved.feed.length,1)
  delete persisted.memory_origin;await new PersonalStore(f.path).write(saved)
  host=f.make();await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings('b'),createVoiceProvider:captureProvider(async function*(){await Promise.resolve();yield {kind:'response_started',response_id:'unused'};yield {kind:'response_completed',response_id:'unused'}},[],injected),createTextProvider:captureProvider(async function*(input){await Promise.resolve();requests.push(JSON.stringify(input));yield {kind:'response_started',response_id:'later'};yield {kind:'text_delta',text:'Later'};yield {kind:'response_completed',response_id:'later'}},histories)}),()=>{/* local renderer */})
  await host.submitConversationText('chat:main','Later question','later');await host.waitConversation('chat:main')
  assert.equal(host.conversationSnapshot().messages.find(message=>message.request_id==='later')?.generation_status,'completed','filtered task history must not abort the ordinary new question')
  const later=host.conversationSnapshot().messages.find(message=>message.role==='assistant'&&message.text==='Later')
  assert.ok(later,'ordinary reply is generated and persisted after restart')
  assert.equal(requests.length,1,'capture the actual new model request, not just a history callback')
  if(!eligible){assert.ok(requests.every(input=>!input.includes(taskText)));assert.deepEqual(later.context_dependencies,{state:'tracked',items:[]},'already-excluded reports do not taint the unrelated answer')}
  assert.ok(histories.length>0)
  assert.equal(histories.some(input=>input.includes(taskText)),eligible,'real paired history honors task identity while no-memory history stays eligible')
  const ack=await host.command({type:'personal.command',request_id:'voice',method:'conversations.voice',params:{id:'chat:main',enabled:true}}) as {ok:boolean}
  assert.equal(ack.ok,true)
  assert.equal(injected.find(item=>item.content.includes('conversation_handoff'))?.content.includes(taskText),eligible)
  assert.ok(host.conversationSnapshot().messages.some(message=>message.text===taskText),'shared foreground bubble remains visible locally')
 }finally{await host.close();await f.close()}
})

test('scheduled feed mixing app and memory dependencies fails closed without a product substrate',async()=>{
 const f=await fixture('none')
 try{
  const state=await new PersonalStore(f.path).read(),at=new Date().toISOString()
  state.feed.push({id:'scheduled-result:mixed',kind:'task_result',title:report,why_now:'Ready',evidence_refs:['app:todos:current'],memory_refs:[{entry_id:'memory-entry',version:1}],schedule_ref:{schedule_id:'schedule',revision:1,run_id:'mixed',task_id:'task'},task_ref:{work_id:'task'},source:{type:'task',ref:'task'},suggestion_id:null,subject_key:'mixed',priority:40,created_at:at,updated_at:at,expires_at:null,user_state:'new',snooze_until:null,lifecycle:'resolved',delivery:{presented_at:at,notified_at:null,spoken_at:null}})
  await f.host.close();await new PersonalStore(f.path).write(state)
  const host=f.make();await host.open()
  try{assert.equal((await host.discoverySnapshot()).recent_delivery.some(feed=>feed.title===report),false)}finally{await host.close()}
 }finally{await f.host.close();await f.close()}
})

for(const [backend,section] of [['none','todos'],['none','goals'],['none','tasks'],['ledger','todos'],['mem0','todos']] as const)test(`live app references fence actual destination-B inputs and retained voice context (${backend}, ${section})`,{timeout:backend==='none'?30000:90000},async()=>{
 const f=await fixture(backend),requests:string[]=[],histories:string[]=[],injected:HostContextItem[]=[]
 let host=f.host
 const appTitle='Synthetic orchid app report title'
 const scope={...context,todos:section==='todos',goals:section==='goals',tasks:section==='tasks'}
 const createProvider=captureProvider(async function*(input){await Promise.resolve();requests.push(JSON.stringify(input));yield {kind:'response_started',response_id:'current'};yield {kind:'text_delta',text:'Current answer'};yield {kind:'response_completed',response_id:'current'}},histories,injected)
 try{
  if(section!=='tasks')await host.life.mutate({op:'create',kind:section==='todos'?'todo':'goal',title:'App record'},'record')
  const schedule=await host.schedules.create('create',{title:appTitle,goal:'Review app records',acceptance:['Report'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context:scope},{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:scope})
  const run=await host.schedules.runNow('run',schedule.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
  await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
  const page=await host.readAppContext(section,null,host.scheduledRunGrant(run.run_id,new AbortController().signal,null))
  await host.tasks.recordDelivery(fence,'app-report',report)
  await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:app-report'],criteria:[{index:0,evidence_refs:['task-delivery:app-report']}]})
  if(backend==='mem0')await host.schedules.markFinished(run.run_id,{outcome:'completed',text:report,evidence_refs:page.evidence_refs,consumer:null,published:false}) // Legacy unmarked app-only report.
  await host.publishScheduledResult(run.run_id)
  assert.equal(await host.scheduledResultAuthorized(run.run_id),true)
  if(section==='tasks')assert.equal(await host.appContext.validateRefs(page.evidence_refs,null,'receiving-conversation'),false,'app task hashes must exclude the producing task, not the receiving conversation')
  await host.close()
  const store=new PersonalStore(f.path),saved=await store.read(),feed=saved.feed.find(item=>item.schedule_ref?.run_id===run.run_id)!,at='2026-11-02T12:00:00Z'
  feed.delivery.presented_at=at
  const topic=createConversation('topic','Review',feed.subject_key,'topic:report')
  topic.feed_ids=[feed.id];topic.prepared=feed.prepared!
  topic.messages=[{id:'prior-user',conversation_id:topic.id,role:'user',text:'Earlier question',created_at:at},{id:'task-caption',conversation_id:topic.id,role:'assistant',task_ids:[task.id],text:report,reply_to:'prior-user',delivery:'completed',created_at:at}]
  saved.conversations.items.push(topic);await store.write(saved)
  host=f.make();await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings('b'),createTextProvider:createProvider,createVoiceProvider:createProvider}),()=>{/* local renderer */})
  assert.ok((await host.discoverySnapshot()).recent_delivery.some(item=>item.id===feed.id),'valid app-only discovery is backend-independent')
  assert.ok((await host.dailyBriefSnapshot()).recent_delivery.some(item=>item.id===feed.id),'valid app-only brief remains eligible')
  await host.submitConversationText(topic.id,'Before change','before');await host.waitConversation(topic.id)
  assert.ok(histories.some(input=>input.includes(report)),'real restored task-caption history is a positive control')
  await host.command({type:'personal.command',request_id:'voice-before',method:'conversations.voice',params:{id:topic.id,enabled:true}})
  assert.ok(injected.some(item=>item.content.includes('conversation_handoff')&&item.content.includes(report)))
  if(section==='tasks')await host.tasks.delegate('changed-app-task',{conversation_id:'chat:main',goal:'New task',acceptance:[],origin_ref:'conversation:new'})
  else{
   const row=host.life.snapshot()[section][0]!
   await host.life.mutate(section==='goals'?{op:'delete',kind:'goal',id:row.id,expected_version:row.version}:{op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Revised app record'},'revoke')
  }
  assert.equal(await host.scheduledResultAuthorized(run.run_id),false)
  assert.ok(!(await host.discoverySnapshot()).recent_delivery.some(item=>item.id===feed.id))
  assert.ok(!(await host.dailyBriefSnapshot()).recent_delivery.some(item=>item.id===feed.id))
  await assert.rejects(host.sendConversationAudio(topic.id,new Uint8Array(320)),/context_authorization_changed/,'already-created voice runtime cannot reuse revoked handoff')
  await host.command({type:'personal.command',request_id:'voice-off',method:'conversations.voice',params:{id:topic.id,enabled:false}})
  requests.length=0;histories.length=0;injected.length=0
  await host.submitConversationText(topic.id,'After change','after');await host.waitConversation(topic.id)
  await host.submitConversationText('chat:main','Explain previous report','follow-up-after');await host.waitConversation('chat:main')
  assert.equal(requests.length,2,'actual destination-B requests still run after revocation')
  assert.ok([...requests,...histories].every(input=>!input.includes(report)&&!input.includes(appTitle)),'prepared, restored/task bubbles and follow-up requests exclude stale app text')
  await host.command({type:'personal.command',request_id:'voice-after',method:'conversations.voice',params:{id:topic.id,enabled:true}})
  assert.ok(injected.some(item=>item.content.includes('conversation_handoff')))
  assert.ok(injected.every(item=>!item.content.includes(report)&&!item.content.includes(appTitle)))
  assert.ok(host.snapshot().feed.some(item=>item.prepared?.text===report),'local report remains visible')
 }finally{await host.close();await f.close()}
})

for(const backend of ['none','ledger'] as const)test(`derived app answer chains survive restart but never revocation (${backend})`,{timeout:30000},async()=>{
 const f=await fixture(backend),secret='Synthetic app fact: orchid project code L-917',histories:string[]=[],requests:string[]=[],injected:HostContextItem[]=[]
 let host=f.host,revoked=false,reply=0
 const create=captureProvider(async function*(input){await Promise.resolve();requests.push(JSON.stringify(input));yield {kind:'response_started',response_id:'chain-'+(++reply)};yield {kind:'text_delta',text:revoked?'Safe current answer':secret};yield {kind:'response_completed',response_id:'chain-'+reply}},histories,injected)
 const bind=()=>host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings('b'),createTextProvider:create,createVoiceProvider:create}),()=>{/* local */})
 try{
  await host.life.mutate({op:'create',kind:'todo',title:'Orchid',note:secret},'app-record')
  const row=host.life.snapshot().todos[0]!
  assert.equal(await host.contextDependenciesAuthorized({state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},'destination-b'),true)
  assert.equal(await host.contextAuthorizationRevision(),await host.contextAuthorizationRevision(),'unchanged source authority token is stable')
  bind()
  const selected=await host.discussionContext([{kind:'todo',id:row.id,version:row.version}])
  await host.submitConversationText('chat:main','Explain selected Todo','first',undefined,selected);await host.waitConversation('chat:main')
  await host.submitConversationText('chat:main','Explain your previous answer','second');await host.waitConversation('chat:main')
  const before=await new PersonalStore(f.path).read(),answers=before.conversations.items[0]!.messages.filter(message=>message.role==='assistant')
  assert.equal(answers.length,2,JSON.stringify(before.conversations.items[0]!.messages))
  for(const answer of answers){assert.equal(answer.text,secret);assert.deepEqual(answer.context_dependencies,{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]})}
  assert.equal(before.conversations.items[0]!.messages.find(message=>message.request_id==='second')?.references,undefined,'transitive dependency is not a latest-user-reference shortcut')
  await host.close();host=f.make();await host.open();bind()
  await host.submitConversationText('chat:main','Continue the answer chain','third');await host.waitConversation('chat:main')
  assert.ok(histories.some(history=>history.includes(secret)),'authorized chain is restored after restart')
  await host.command({type:'personal.command',request_id:'standalone',method:'conversations.create',params:{title:'Unrelated standalone'}})
  const standalone=host.conversationSnapshot().selected_id
  revoked=true
  await host.submitConversationText(standalone,'Independent question','unrelated');await host.waitConversation(standalone)
  const unrelated=host.conversationSnapshot().messages.find(message=>message.role==='assistant')!
  assert.deepEqual(unrelated.context_dependencies,{state:'tracked',items:[]})
  await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,note:'Revoked old app fact'},'revocation')
  await host.close();host=f.make();await host.open();bind();histories.length=0;requests.length=0;injected.length=0
  await host.submitConversationText('chat:main','What can you say now?','after');await host.waitConversation('chat:main')
  assert.ok([...histories,...requests].every(value=>!value.includes(secret)),'all three derived assistant generations are excluded from actual restored/provider inputs')
  await host.command({type:'personal.command',request_id:'voice-chain',method:'conversations.voice',params:{id:'chat:main',enabled:true}})
  assert.ok(injected.some(item=>item.content.includes('conversation_handoff')))
  assert.ok(injected.every(item=>!item.content.includes(secret)))
  const saved=await new PersonalStore(f.path).read(),standaloneConversation=saved.conversations.items.find(item=>item.id===standalone)!
  assert.ok((await host.productConversation(standaloneConversation,'destination-b')).messages.some(message=>message.id===unrelated.id),'truly unrelated standalone chat remains usable')
 }finally{await host.close();await f.close()}
})

for(const mode of ['text','voice'] as const)for(const action of ['revoke','cancel'] as const)test(`startup identity await cannot publish revoked app history or prepared context (${mode}, ${action})`,{timeout:30000},async()=>{
 const f=await fixture('none'),host=f.host,histories:string[]=[],injected:HostContextItem[]=[]
 let release=()=>{/* assigned below */},entered=()=>{/* assigned below */}
 const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 const create=captureProvider(async function*(){await Promise.resolve();throw Error('startup must not request a response')},histories,injected)
 const original=host.synchronizePreferredName.bind(host)
 try{
  await host.life.mutate({op:'create',kind:'todo',title:'Startup secret',note:report},'record')
  const row=host.life.snapshot().todos[0]!,conversation=createConversation('chat','Startup secret',null,'startup')
  conversation.messages=[{id:'u',conversation_id:conversation.id,role:'user',text:'Earlier question',created_at:new Date().toISOString()},{id:'a',conversation_id:conversation.id,role:'assistant',text:report,reply_to:'u',context_dependencies:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},created_at:new Date().toISOString()}]
  host.synchronizePreferredName=async()=>{entered();await gate;return original()}
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,gateway,settings:settings('b'),createTextProvider:create,createVoiceProvider:create})
  const lifetime=new AbortController()
  const starting=factory(conversation,()=>{/* local */},mode,lifetime.signal),rejected=assert.rejects(starting,action==='revoke'?/context_authorization_changed/:/cancelled_startup/)
  await started
  if(action==='revoke')await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed startup source'},'change')
  else lifetime.abort(Error('cancelled_startup'))
  release();await rejected
  assert.ok(histories.every(history=>!history.includes(report)),'provider never receives initial history during connect')
  assert.ok(injected.every(item=>!item.content.includes(report)&&!item.content.includes('Startup secret')),'post-start identity gap cannot leak handoff/context')
 }finally{release();host.synchronizePreferredName=original;await host.close();await f.close()}
})

for(const backend of ['none','ledger'] as const)test(`unchanged PCM chunks reuse compact authorization and app mutation fences the next frame (${backend})`,{timeout:30000},async t=>{
 const f=await fixture(backend),host=f.host
 let frames=0
 const voiceNotices:string[]=[]
 let other:SubstrateMemoryResource|undefined
 const create=captureProvider(async function*(){await Promise.resolve();throw Error('no response expected')})
 try{
  await host.life.mutate({op:'create',kind:'todo',title:'PCM source'},'source')
  const row=host.life.snapshot().todos[0]!
  await host.close()
  const store=new PersonalStore(f.path),state=await store.read()
  state.conversations.items[0]!.messages=[{id:'user',conversation_id:'chat:main',role:'user',text:'Earlier question',created_at:new Date().toISOString()},{id:'answer',conversation_id:'chat:main',role:'assistant',text:report,reply_to:'user',context_dependencies:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},created_at:new Date().toISOString()}]
  await store.write(state);await host.open()
  const originalAuthorize=host.contextDependenciesAuthorized.bind(host)
  const historyPass=t.mock.method(host,'productConversation',host.productConversation.bind(host)),dependencyPass=t.mock.method(host,'contextDependenciesAuthorized',originalAuthorize)
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings('b'),createVoiceProvider:options=>{const value=create(options);value.sendAudio=()=>{frames++;return Promise.resolve()};return value}}),frame=>{if(frame.type==='conversation.notice')voiceNotices.push(String(frame.code))})
  const ack=await host.command({type:'personal.command',request_id:'voice',method:'conversations.voice',params:{id:'chat:main',enabled:true}}) as {ok:boolean}
  assert.equal(ack.ok,true)
  await host.sendConversationAudio('chat:main',new Uint8Array(320))
  const historyCount=historyPass.mock.callCount(),dependencyCount=dependencyPass.mock.callCount(),before=frames
  await host.life.refresh();await host.sourceProcessingAgent.reload()
  host.recordConfirmation('unrelated-ui',{pending_confirmation:false,pending_confirmation_busy:false,workspace_display_name:null,session_title:null})
  for(let i=0;i<20;i++)await host.sendConversationAudio('chat:main',new Uint8Array(320))
  assert.equal(frames,before+20)
  assert.equal(historyPass.mock.callCount(),historyCount,'PCM never reconstructs/serializes conversation history or unrelated feeds')
  assert.equal(dependencyPass.mock.callCount(),dependencyCount,'unchanged local authority does not re-read app collections per chunk')
  if(backend==='ledger'){
   other=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(dirname(f.path),'ledger.sqlite')),userId:'test',model:'extract',inputConsent:true,consolidation:{enabled:false},gateway})
   await other.open();const remote=other.lifeBackend(),current=await remote.load(emptyLifeState())
   await remote.mutate({input:{op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Source changed from another client'},requestId:'remote-change',expectedRevision:current.revision})
  }else{
   let changed=false
   dependencyPass.mock.mockImplementation(async(dependencies,consumer)=>{
    const allowed=await originalAuthorize(dependencies,consumer)
    if(!changed){changed=true;await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Source changed during authorization'},'change')}
    return allowed
   })
   host.connectionChanged()
  }
  await assert.rejects(host.sendConversationAudio('chat:main',new Uint8Array(320)),/context_authorization_changed/)
  assert.equal(frames,before+20,'not one frame is forwarded after cross-client or mid-check source revocation')
  assert.deepEqual(voiceNotices,['voice_provider_failed'],'source refusal must not silently discard microphone frames')
  await assert.rejects(host.sendConversationAudio('chat:main',new Uint8Array(320)),/context_authorization_changed/)
  assert.deepEqual(voiceNotices,['voice_provider_failed'],'one notice per failed voice runtime')
 }finally{await other?.close();await host.close();await f.close()}
})

for(const revokeDuringChurn of [false,true])test(`revision churn defers audio without losing voice ownership (revocation: ${revokeDuringChurn})`,{timeout:30000},async t=>{
 const f=await fixture('none'),host=f.host
 let frames=0
 const voiceNotices:string[]=[]
 const create=captureProvider(async function*(){await Promise.resolve();throw Error('no response expected')})
 try{
  await host.life.mutate({op:'create',kind:'todo',title:'Churn source'},'source')
  const row=host.life.snapshot().todos[0]!
  await host.close()
  const store=new PersonalStore(f.path),state=await store.read()
  state.conversations.items[0]!.messages=[{id:'user',conversation_id:'chat:main',role:'user',text:'Earlier question',created_at:new Date().toISOString()},{id:'answer',conversation_id:'chat:main',role:'assistant',text:'Earlier answer',reply_to:'user',context_dependencies:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},created_at:new Date().toISOString()}]
  await store.write(state);await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings('b'),createVoiceProvider:options=>{const value=create(options);value.sendAudio=()=>{frames++;return Promise.resolve()};return value}}),frame=>{if(frame.type==='conversation.notice')voiceNotices.push(String(frame.code))})
  const ack=await host.command({type:'personal.command',request_id:'voice',method:'conversations.voice',params:{id:'chat:main',enabled:true}}) as {ok:boolean}
  assert.equal(ack.ok,true)
  await host.sendConversationAudio('chat:main',new Uint8Array(320))
  const before=frames
  let revision=0
  const reads=t.mock.method(host,'contextAuthorizationRevision',async()=>{
   revision++
   if(revokeDuringChurn&&revision===4)await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Revoked at final revision read'},'change')
   return `churn-${revision}`
  })
  if(revokeDuringChurn){
   await host.sendConversationAudio('chat:main',new Uint8Array(320))
   assert.equal(frames,before,'the mismatched authorization result cannot forward PCM after revocation')
   await assert.rejects(host.sendConversationAudio('chat:main',new Uint8Array(320)),/context_authorization_changed/)
   assert.deepEqual(voiceNotices,['voice_provider_failed'])
  }else{
   for(let i=0;i<5;i++)await host.sendConversationAudio('chat:main',new Uint8Array(320))
   assert.equal(frames,before,'unstable authority defers only the current audio chunks')
   assert.deepEqual(voiceNotices,[],'revision churn alone does not stop voice')
   reads.mock.restore()
   await host.sendConversationAudio('chat:main',new Uint8Array(320))
   assert.equal(frames,before+1,'audio resumes when authorization stabilizes')
   await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed source'},'change')
   await assert.rejects(host.sendConversationAudio('chat:main',new Uint8Array(320)),/context_authorization_changed/)
   assert.equal(frames,before+1)
   assert.deepEqual(voiceNotices,['voice_provider_failed'])
  }
 }finally{await host.close();await f.close()}
})

for(const revoked of [false,true])test(`scoped queued personal suggestion reauthorizes at actual provider injection (${revoked?'revoked':'valid'})`,{timeout:10000},async()=>{
 const f=await fixture('none'),host=f.host,injected:HostContextItem[]=[],requests:string[]=[]
 let runtime:ConversationRuntime|undefined
 try{
  const schedule=await host.schedules.create('queued-rule',{title:'Queued private app title',goal:'Review',acceptance:['Report'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context},{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context})
  const run=await host.schedules.runNow('queued-run',schedule.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
  await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
  await host.readAppContext('todos',null,host.scheduledRunGrant(run.run_id,new AbortController().signal,null))
  await host.tasks.recordDelivery(fence,'queued-report',report);await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:queued-report'],criteria:[{index:0,evidence_refs:['task-delivery:queued-report']}]});await host.publishScheduledResult(run.run_id)
  const feed=host.snapshot().feed.find(item=>item.schedule_ref?.run_id===run.run_id)!
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,gateway,settings:settings('b'),createVoiceProvider:captureProvider(async function*(input){await Promise.resolve();requests.push(JSON.stringify(input));yield {kind:'response_started',response_id:'queued'};yield {kind:'text_delta',text:'Queued announcement'};yield {kind:'response_completed',response_id:'queued'}},[],injected)})
  runtime=await factory(createConversation('chat','Voice',null,'chat:main'),()=>{/* local */},'voice')
  const {RealtimeService}=await import('../src/realtime/service.js'),service=runtime.bridgeService
  assert.ok(service instanceof RealtimeService)
  await service.session.accept({kind:'user_speech_started',session_epoch:1,speech_id:'busy',provider_item_id:'held'})
  const suggestion=host.options.pool.add({origin:'surrogate',kind:'notify',content:{summary:feed.title,personal_feed_id:feed.id}})
  runtime.deliverSuggestion!(suggestion,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:suggestion.id})
  await eventually(()=>service.pendingHostItemCount===1)
  assert.ok(injected.every(item=>!item.content.includes(feed.title)))
  if(revoked)await host.life.mutate({op:'create',kind:'todo',title:'Changed after scoped queue admission'},'change')
  await service.session.accept({kind:'user_speech_ended',session_epoch:1,speech_id:'busy',provider_item_id:'held'})
  await service.session.accept({kind:'user_transcript_failed',session_epoch:1,item_id:'held'})
  await service.flushHostItems()
  if(!revoked)await eventually(()=>requests.length===1)
  else for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(injected.some(item=>item.content.includes(feed.title)),!revoked)
  assert.equal(requests.some(item=>item.includes(feed.title)),!revoked)
 }finally{await runtime?.close();await host.close();await f.close()}
})

test('revoked retained Plan association does not block an independent Chat model turn',async()=>{
 const f=await fixture('none'),host=f.host,secret='Synthetic revoked plan source L-917',title='Private retained plan title',body='Private retained plan body',requests:string[]=[],histories:string[]=[],injected:HostContextItem[]=[]
 try{
  const row=await host.life.mutate({op:'create',kind:'todo',title:secret},'source')
  const dependencies={state:'tracked' as const,items:[{kind:'app_record' as const,section:'todos' as const,id:row.id,version:row.version}]}
  await host.close()
  const store=new PersonalStore(f.path),state=await store.read(),at=new Date().toISOString()
  state.conversations.items[0]!.messages=[{id:'source-answer',conversation_id:'chat:main',role:'assistant',text:secret,context_dependencies:dependencies,created_at:at}]
  await store.write(state);await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,gateway,settings:settings('b'),createTextProvider:captureProvider(async function*(input){await Promise.resolve();requests.push(JSON.stringify(input));yield {kind:'response_started',response_id:'independent'};yield {kind:'text_delta',text:'Independent Chat reply'};yield {kind:'response_completed',response_id:'independent'}},histories,injected)}),()=>{/* local */})
  for(const [method,params] of [['presentation.set',{mode:'workbench'}],['conversations.mode',{id:'chat:main',mode:'plan'}]] as const){const ack=await host.command({type:'personal.command',request_id:method,method,params},{client_id:'desktop:local'}) as {ok:boolean};assert.equal(ack.ok,true)}
  const plan=await host.publishPlan('chat:main',0,title,body,undefined,dependencies)
  await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed source'},'revoke')
  const ack=await host.command({type:'personal.command',request_id:'chat',method:'conversations.mode',params:{id:'chat:main',mode:'chat'}},{client_id:'desktop:local'}) as {ok:boolean};assert.equal(ack.ok,true)
  assert.equal(host.conversationSnapshot().items[0]!.plan!.id,plan.id,'local Plan association is retained')
  await host.submitConversationText('chat:main','Answer an independent arithmetic question','independent');await host.waitConversation('chat:main')
  assert.equal(requests.length,1,'actual Chat model request executes despite the unused revoked plan')
  const reply=host.conversationSnapshot().messages.at(-1)!
  assert.equal(reply.text,'Independent Chat reply');assert.equal(host.conversationSnapshot().messages.find(message=>message.request_id==='independent')?.generation_status,'completed');assert.deepEqual(reply.context_dependencies,{state:'tracked',items:[]})
  for(const input of [...requests,...histories,...injected.map(item=>item.content)])for(const excluded of [secret,title,body])assert.ok(!input.includes(excluded),'unused Plan content and revoked history never reach the model/provider')
  assert.ok(host.conversationSnapshot().messages.some(message=>message.text===secret),'source report remains locally visible')
  assert.equal((await host.workbench.plan(plan.id,plan.version)).content,body)
 }finally{await host.close();await f.close()}
})

for(const persistent of [false,true])test(`text turn waits for its own ingestion churn to settle (persistent: ${persistent})`,{timeout:30000},async t=>{
 const f=await fixture('none'),host=f.host,requests:string[]=[]
 try{
  const row=await host.life.mutate({op:'create',kind:'todo',title:'Churn source'},'source')
  await host.close()
  const store=new PersonalStore(f.path),state=await store.read()
  state.conversations.items[0]!.messages=[{id:'source-answer',conversation_id:'chat:main',role:'assistant',text:'Earlier answer',context_dependencies:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},created_at:new Date().toISOString()}]
  await store.write(state);await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,gateway,settings:settings('b'),createTextProvider:captureProvider(async function*(input){await Promise.resolve();requests.push(JSON.stringify(input));yield {kind:'response_started',response_id:'settled'};yield {kind:'text_delta',text:'Settled reply'};yield {kind:'response_completed',response_id:'settled'}})}),()=>{/* frames are not under test */})
  // Admitting the message moves the ledger revision for a few reads, exactly as live ingestion does.
  let reads=0
  const original=host.contextAuthorizationRevision.bind(host)
  t.mock.method(host,'contextAuthorizationRevision',async(signal?:AbortSignal)=>{reads++;return persistent||reads<=8?`churn-${reads}`:original(signal)})
  await host.submitConversationText('chat:main','hi','settle');await host.waitConversation('chat:main')
  const user=host.conversationSnapshot().messages.find(message=>message.request_id==='settle')!
  if(persistent){assert.equal(user.generation_status,'failed','unbounded churn still cannot prove authority');assert.equal(requests.length,0)}
  else{assert.equal(user.generation_status,'completed');assert.equal(requests.length,1);assert.equal(host.conversationSnapshot().messages.at(-1)!.text,'Settled reply')}
 }finally{await host.close();await f.close()}
})

for(const change of ['merge','changed_merge','forgotten','consent','correction'] as const)test(`unchanged PCM chunks after spoken memory reminder (${change})`,{timeout:30000},async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-memory-voice-'))
 let at='2026-11-02T12:00:00Z'
 let allowed=true,frames=0
 let runtime:ConversationRuntime|undefined
 const notices:string[]=[],injected:HostContextItem[]=[]
 const entry:MemoryEntry={id:'preference',version:1,kind:'preference',content:'Prefer declining politely',origin:'inferred',status:'active',source_refs:[{type:'conversation',ref:'conversation:1',observed_at:at}],evidence_refs:['conversation:1'],observed_at:at,recorded_at:at,topic:'reply',corrected_to:null,confidence_note:null}
 const memory:PersonalMemoryResource={productSurfaces:true,open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.resolve({source:'personal',state:'empty',scope:'recent',hits:[],degraded:false}),get:()=>Promise.resolve(entry),list:()=>Promise.resolve({entries:[entry],cursor:null}),canProcessEvidence:()=>Promise.resolve(allowed),canReadConversationEvidence:()=>Promise.resolve(allowed)}
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),now:()=>new Date(at),evidenceRefs:()=>['conversation:1'],evidence:ref=>allowed?{subject_key:ref,source:{type:'conversation',ref}}:null})
 const create=captureProvider(async function*(){await Promise.resolve();yield {kind:'response_started',response_id:'reminder'};yield {kind:'text_delta',text:'Reply to invitation?'};yield {kind:'response_completed',response_id:'reminder'}},[],injected)
 try{
  await host.open()
  assert.equal(await host.admit({kind:'question',summary:'Reply to invitation?',why_now:'Reply due',evidence_refs:['conversation:1'],memory_refs:[{entry_id:entry.id,version:1}]},await host.discoverySnapshot()),'admitted')
  const feed=host.snapshot().feed[0]!
  const factory=conversationRuntimeFactory({host,memory:()=>memory,gateway,settings:settings(),createVoiceProvider:options=>{const value=create(options);value.sendAudio=()=>{frames++;return Promise.resolve()};return value}})
  host.setConversationRuntime(async(...args)=>{runtime=await factory(...args);return runtime},frame=>{if(frame.type==='conversation.notice')notices.push(String(frame.code))})
  await host.command({type:'personal.command',request_id:'voice',method:'conversations.voice',params:{id:'chat:main',enabled:true}})
  assert.ok(runtime)
  const suggestion=host.options.pool.add({origin:'surrogate',kind:'notify',content:{summary:feed.title,personal_feed_id:feed.id}})
  runtime.deliverSuggestion!(suggestion,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:suggestion.id})
  await eventually(()=>injected.some(item=>item.content.includes(feed.title)))
  await host.spoken(suggestion.id)
  at='2026-11-02T12:00:01Z'
  entry.version=2
  entry.written_by=change==='correction'?'user_correction':'merge'
  if(change==='changed_merge')entry.content='Prefer accepting invitations'
  if(change==='forgotten')entry.status='forgotten'
  if(change==='consent')allowed=false
  await host.revalidate()
  if(change==='merge'){
   await host.sendConversationAudio('chat:main',new Uint8Array(320))
   await host.sendConversationAudio('chat:main',new Uint8Array(320))
   assert.equal(frames,2);assert.deepEqual(notices,[])
   assert.equal(host.snapshot().feed[0]!.lifecycle,'active')
  }else{
   await assert.rejects(host.sendConversationAudio('chat:main',new Uint8Array(320)),/context_authorization_changed/)
   assert.equal(frames,0);assert.deepEqual(notices,['voice_provider_failed'])
  }
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})
