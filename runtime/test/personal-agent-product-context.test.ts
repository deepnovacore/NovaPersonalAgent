import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
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
 const f=await fixture(backend),eligible=backend==='none',histories:string[]=[],injected:HostContextItem[]=[]
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
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>f.memory,gateway,settings:settings('b'),createVoiceProvider:captureProvider(async function*(){await Promise.resolve();yield {kind:'response_started',response_id:'unused'};yield {kind:'response_completed',response_id:'unused'}},[],injected),createTextProvider:captureProvider(async function*(){await Promise.resolve();yield {kind:'response_started',response_id:'later'};yield {kind:'text_delta',text:'Later'};yield {kind:'response_completed',response_id:'later'}},histories)}),()=>{/* local renderer */})
  await host.submitConversationText('chat:main','Later question','later');await host.waitConversation('chat:main')
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
