import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {CausalRuntime} from '../src/core/causal-runtime.js'
import {RealClock} from '../src/core/clock.js'
import {MonotonicIdFactory} from '../src/core/ids.js'
import {compileContextView} from '../src/core/context-view.js'
import {GatewayProactivity} from '../src/model/proactivity.js'
import {runProactiveSelection} from '../src/core/calls.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import {eventually} from './helpers/mem0-fixture.js'
const title='Private orchid report title',body='Private orchid report body',unrelated='Unrelated public suggestion'
const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
async function publish(host:PersonalAgentHost,legacy=false,consumer:string|null=null){
 const schedule=await host.schedules.create('create',{title,goal:'Review app records',acceptance:['Report'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context},{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context})
 const run=await host.schedules.runNow('run',schedule.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
 await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
 const page=await host.readAppContext('todos',null,host.scheduledRunGrant(run.run_id,new AbortController().signal,consumer))
 await host.tasks.recordDelivery(fence,'answer',body);await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:answer'],criteria:[{index:0,evidence_refs:['task-delivery:answer']}]})
 if(legacy)await host.schedules.markFinished(run.run_id,{outcome:'completed',text:body,evidence_refs:page.evidence_refs,consumer,published:false})
 await host.publishScheduledResult(run.run_id)
 return {run,feed:host.snapshot().feed.find(item=>item.schedule_ref?.run_id===run.run_id)!}
}

for(const slot of ['surrogate.watch','fast'] as const)test(`dispatch-time personal feed authorization fences stale queued ${slot} snapshots without a blackboard`,async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-model-context-')),requests:string[]=[]
 const gateway:ModelGateway={complete:input=>{requests.push(input.prompt);return Promise.resolve({text:JSON.stringify({speak:false,suggestion_id:null,progress_class:null,reason:'silent'})})},async *stream(){await Promise.resolve();throw Error('unexpected stream')}}
 const selector=new GatewayProactivity({gateway,model:'destination-b',proactivityPreset:'balanced'})
 const port={complete:async(call:Parameters<CausalRuntime['core']['refreshModelCall']>[0],signal:AbortSignal)=>{
  const record=await runProactiveSelection(selector,{view:call.context_view!,reason:call.reason,signal})
  return slot==='fast'?{speak:{act:'none'},action:{act:'none'}}:record.output
 }}
 const runtime=new CausalRuntime({clock:new RealClock(),ids:new MonotonicIdFactory(),models:{[slot]:port}}),pool=runtime.core.suggestions
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>undefined,pool,evidence:()=>null,context:()=>compileContextView(runtime.memory,'idle',runtime.clock.now(),{suggestions:pool.all()})})
 const stop=new AbortController(),serving=runtime.serve(stop.signal)
 let unbind=()=>{/* replaced below */}
 const wake=()=>runtime.core.slots.wake(slot,{kind:'personal-context-test',priority:40,routing_class:'ambient',origin:null,selected_suggestion:null})
 try{
  await host.open();await host.scheduledTaskTick();const {feed}=await publish(host)
  let suggestion=pool.add({origin:'surrogate',kind:'notify',content:{summary:title,why_now:body,personal_feed_id:feed.id}})
  pool.add({origin:'surrogate',kind:'notify',content:{summary:unrelated}})
  unbind=runtime.bindModelContextAuthorizer((view,_,signal)=>host.authorizeModelContext(view,'destination-b',signal))
  wake();await eventually(()=>requests.length===1);await eventually(()=>!runtime.core.slots.inflight[slot])
  assert.ok(requests[0]!.includes(title)&&requests[0]!.includes(body),'valid no-memory app-only details reach the actual selector gateway')
  assert.ok(requests[0]!.includes(unrelated))
  let authorized=false,releaseWithdrawal=()=>{/* assigned by promise */}
  const withdrawalGate=new Promise<void>(resolve=>{releaseWithdrawal=resolve})
  unbind();unbind=runtime.bindModelContextAuthorizer(async(view,_,signal)=>{
   const checked=await host.authorizeModelContext(view,'destination-b',signal)
   authorized=true;await withdrawalGate;return checked
  })
  wake();await eventually(()=>authorized)
  pool.withdraw(suggestion.id);releaseWithdrawal()
  await eventually(()=>requests.length===2);await eventually(()=>!runtime.core.slots.inflight[slot])
  assert.ok(!requests[1]!.includes(title)&&!requests[1]!.includes(body)&&!requests[1]!.includes(suggestion.id),'withdrawal after authorization cannot resurrect the queued affordance')
  assert.ok(requests[1]!.includes(unrelated))
  suggestion=pool.add({origin:'surrogate',kind:'notify',content:{summary:title,why_now:body,personal_feed_id:feed.id}})
  let started=false,release=()=>{/* assigned by promise */}
  const gate=new Promise<void>(resolve=>{release=resolve})
  unbind();unbind=runtime.bindModelContextAuthorizer(async(view,_,signal)=>{started=true;await gate;return host.authorizeModelContext(view,'destination-b',signal)})
  wake();await eventually(()=>started)
  await host.life.mutate({op:'create',kind:'todo',title:'Changed app state'},'change');release()
  await eventually(()=>requests.length===3);await eventually(()=>!runtime.core.slots.inflight[slot])
  assert.ok(!requests[2]!.includes(title)&&!requests[2]!.includes(body)&&!requests[2]!.includes(suggestion.id),'queued original content and affordance reference are gone at dispatch')
  assert.ok(requests[2]!.includes(unrelated),'nonpersonal suggestions are unaffected')
  const snapshot=await host.discoverySnapshot()
  assert.ok(!JSON.stringify(snapshot.context).includes(title)&&!JSON.stringify(snapshot.context).includes(body),'discovery ContextView is also filtered, not just recent_delivery')
  assert.ok(JSON.stringify(snapshot.context).includes(unrelated))
  unbind();unbind=runtime.bindModelContextAuthorizer(()=>Promise.reject(Error('authorization unavailable')))
  wake();await eventually(()=>requests.length===4)
  assert.ok(!requests[3]!.includes(title)&&!requests[3]!.includes(body)&&requests[3]!.includes(unrelated),'authorization failure closes only personal affordances')
 }finally{unbind();stop.abort();await serving;await host.close();await rm(directory,{recursive:true,force:true})}
})

test('legacy app-only authorization uses the current receiving consumer, not only the saved producer',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-app-recipient-'))
 let allowed=true,consumer='destination-a'
 const requests:string[]=[]
 const discovery=new GatewayProactivity({model:'destination-b',proactivityPreset:'balanced',gateway:{complete:input=>{requests.push(input.prompt);return Promise.resolve({text:'{"proposals":[]}'})},async *stream(){await Promise.resolve();throw Error('unexpected stream')}}})
 const memory={open:()=>Promise.resolve(),close:()=>Promise.resolve(),canReadConversationEvidence:(_ref:string,to:string)=>Promise.resolve(allowed&&to==='destination-a')} as unknown as PersonalMemoryResource
 const pool=new SuggestionPool()
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>memory,pool,evidence:()=>null,discoveryMemoryConsumer:()=>consumer})
 try{
  await host.open();await host.scheduledTaskTick()
  await host.life.mutate({op:'from_suggestion',kind:'todo',suggestion_id:'source-todo',title:'Source-derived Todo',note:'Source detail',due:null,todo_id:null,sources:[],provenance_refs:['source:allowed']},'source-todo')
  const {run,feed}=await publish(host,true,'destination-a')
  await host.action({id:feed.id,action:'presented'})
  assert.equal(await host.scheduledResultAuthorized(run.run_id,'destination-a'),true)
  assert.ok((await host.discoverySnapshot()).recent_delivery.some(item=>item.id===feed.id),'legacy app-only mem0 positive control')
  await discovery.discover(await host.discoverySnapshot(),new AbortController().signal)
  assert.ok(requests[0]!.includes(title)&&requests[0]!.includes(body),'valid legacy app-only report reaches the actual discovery gateway')
  consumer='destination-b'
  assert.equal(await host.scheduledResultAuthorized(run.run_id,consumer),false)
  assert.ok(!(await host.discoverySnapshot()).recent_delivery.some(item=>item.id===feed.id),'recipient projection omits source-derived todos without its grant')
  assert.ok(!(await host.dailyBriefSnapshot()).recent_delivery.some(item=>item.id===feed.id))
  await discovery.discover(await host.discoverySnapshot(),new AbortController().signal)
  assert.ok(!requests[1]!.includes(title)&&!requests[1]!.includes(body),'destination-B model prompt excludes the unauthorized app report')
  consumer='destination-a';allowed=false
  assert.equal(await host.scheduledResultAuthorized(run.run_id,consumer),false,'revoked producer grant invalidates legacy app hash too')
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})

for(const action of ['close','clear','normal'] as const)test(`initial host filtering is lifetime bounded before concrete factory (${action})`,{timeout:5000},async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-initial-filter-'))
 let concreteStarts=0,entered=()=>{/* assigned below */},release=()=>{/* assigned below */}
 const pending=new Promise<boolean>(resolve=>{release=()=>resolve(true)}),started=new Promise<void>(resolve=>{entered=resolve})
 let parked=false
 const memory={open:()=>Promise.resolve(),close:()=>Promise.resolve(),productSurfaces:true,canReadConversationEvidence:()=>{if(parked){entered();return pending}return Promise.resolve(true)}} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();await host.scheduledTaskTick()
  await host.life.mutate({op:'from_suggestion',kind:'todo',suggestion_id:'held-source',title:'Authorized source',note:'Synthetic held evidence',due:null,todo_id:null,sources:[],provenance_refs:['source:held']},'source')
  await publish(host,true,'producer')
  parked=action!=='normal'
  host.setConversationRuntime(()=>{concreteStarts++;return Promise.resolve({runTurn:()=>Promise.resolve({assistant:'Ordinary answer'}),close:()=>Promise.resolve()})},()=>{/* local */})
  await host.submitConversationText('chat:main','Unrelated new question','new')
  if(action!=='normal'){
   await started
   const {abortable}=await import('../src/core/camera-session.js')
   if(action==='close')await abortable(host.close(),AbortSignal.timeout(1000))
   else{const ack=await abortable(host.command({type:'personal.command',request_id:'clear',method:'conversations.clear',params:{id:'chat:main'}}),AbortSignal.timeout(1000)) as {ok:boolean};assert.equal(ack.ok,true);assert.equal(host.conversationSnapshot().messages.length,0)}
   release();for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))
   assert.equal(concreteStarts,0,'late authorization completion cannot create a runtime after shutdown')
  }else{
   await host.waitConversation('chat:main');assert.equal(concreteStarts,1)
   assert.equal(host.conversationSnapshot().messages.find(message=>message.request_id==='new')?.generation_status,'completed')
  }
 }finally{release();await host.close();await rm(directory,{recursive:true,force:true})}
})

test('direct initial filter obeys one caller deadline and cannot inject after late source completion',{timeout:5000},async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-initial-deadline-')),host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let release=()=>{/* assigned below */}
 const pending=new Promise<boolean>(resolve=>{release=()=>resolve(true)})
 try{
  await host.open();await host.scheduledTaskTick();await publish(host)
  host.appContext.validateRefs=()=>pending
  const {PersonalStore}=await import('../src/personal-agent/store.js'),conversation=(await new PersonalStore(join(directory,'personal.json')).read()).conversations.items[0]!
  const {conversationRuntimeFactory}=await import('../src/personal-agent/conversation-runtime.js'),{settingsSchema}=await import('../src/config/config.js')
  let providerStarts=0
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'fixture'}),createTextProvider:()=>{providerStarts++;throw Error('must not create a provider after timed-out authorization')}})
  const deadline=new AbortController()
  const timer=setTimeout(()=>deadline.abort(new DOMException('Authorization timed out','TimeoutError')),20)
  try{await assert.rejects(factory(conversation,()=>{/* local */},'text',new AbortController().signal,false,undefined,{},deadline.signal),{name:'TimeoutError'})}
  finally{clearTimeout(timer)}
  release();for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(providerStarts,0)
 }finally{release();await host.close();await rm(directory,{recursive:true,force:true})}
})

test('isolated runtime startup is aborted by pool shutdown while initial source authorization is parked',{timeout:5000},async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-isolated-initial-filter-')),path=join(directory,'personal.json'),host=new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let entered=()=>{/* assigned below */},release=()=>{/* assigned below */},providerStarts=0
 const pending=new Promise<boolean>(resolve=>{release=()=>resolve(true)}),started=new Promise<void>(resolve=>{entered=resolve})
 const {ConversationRuntimePool}=await import('../src/personal-agent/conversations.js'),{conversationRuntimeFactory}=await import('../src/personal-agent/conversation-runtime.js'),{settingsSchema}=await import('../src/config/config.js'),{PersonalStore}=await import('../src/personal-agent/store.js'),{abortable}=await import('../src/core/camera-session.js')
 let pool:InstanceType<typeof ConversationRuntimePool>|undefined
 try{
  await host.open();await host.scheduledTaskTick();await publish(host)
  host.appContext.validateRefs=()=>{entered();return pending}
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'fixture'}),createTextProvider:()=>{providerStarts++;throw Error('must not create a closed isolated provider')}})
  pool=new ConversationRuntimePool(factory,()=>{/* local */})
  const conversation=(await new PersonalStore(path).read()).conversations.items[0]!
  const operation=pool.isolated(conversation,()=>Promise.resolve()),rejected=assert.rejects(operation)
  await started;await abortable(pool.close(),AbortSignal.timeout(1000));await rejected
  release();for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(providerStarts,0)
 }finally{release();await pool?.close();await host.close();await rm(directory,{recursive:true,force:true})}
})
