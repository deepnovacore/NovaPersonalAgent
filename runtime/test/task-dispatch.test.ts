/* eslint-disable @typescript-eslint/require-await -- deterministic fake host ports use Promise contracts */
/* eslint-disable @typescript-eslint/no-empty-function -- inert fake callbacks and disabled providers */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {RealtimeService} from '../src/realtime/service.js'
import {TaskService} from '../src/personal-agent/tasks.js'
import {compileToolSchema} from '../src/core/tool-schema.js'

test('Nova-only task tools are advertised independently of executor agents',()=>{
 const tools=compileToolSchema([], {includeTasks:true})
 assert.equal(tools.bindings.get('task')?.kind,'host')
})
test('task mutations notify their host and terminal lifecycle fences writes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-dispatch-'))
 try{
  let changes=0
  const tasks=new (TaskService as unknown as new(path:string,changed:()=>void)=>TaskService)(join(dir,'tasks.json'),()=>changes++)
  await tasks.open()
  await tasks.delegate('declare',{conversation_id:'chat:main',goal:'deliver',acceptance:['content'],origin_ref:'user:original'})
  assert.equal(changes,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})

import {CodexAgentController} from '../src/executors/codex/controller.js'
import type {IntakeOptions,IntakeSession} from '../src/executors/coding/intake.js'
test('deferred task planning survives foreground clear but takeover fences every session',async()=>{
 for(const action of ['takeover','foreground_clear']){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-race-'))
 try{
  const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
  const task=await tasks.delegate('declare',{conversation_id:'chat:main',goal:'Fix login',acceptance:['Shows validation'],origin_ref:'conversation:original'})
  const fence={task_id:task.id,goal_revision:0,control_revision:0}
  await tasks.bindWork(fence,'work1','session1');await tasks.bindWork(fence,'work2','session2')
  const context=tasks.continuationContext(fence)
  let release!:()=>void,entered!:()=>void,writes=0,foregroundCurrent=true
  const planned=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const intake:IntakeOptions={idFactory:()=> 'intake',settings:{clarification_depth:'balanced',plan_readback:'silent'},models:{
   assess:async input=>({intake_id:input.intake_id,revision:input.revision,slots:{goal:{state:'stated',note:'Fix login'},scope:{state:'stated',note:'Login'},acceptance:{state:'stated',note:'Shows validation'},constraints:{state:'missing',note:''}},readiness:1,kind:'work',project:null,project_evidence:null,session:{mode:'latest'},intent_to_proceed:true,candidate_question:null,discovery:[],early_exit:false,abandon:false}),
   plan:async input=>{entered();await gate;return {intake_id:input.intake_id,revision:input.revision,work_order:{objective:'Fix login',scope_in:['Login'],acceptance:['Shows validation']}}},resolveCancelTarget:async()=>null},
   roster:()=>[],running:()=>[],activeProject:()=> 'Project',resolveTarget:async()=>({workspace:'/project',action:'reuse',workspace_display_name:'Project',workspace_id:'project',session_title:null,session_id:null}),prepare:()=>{throw Error('unexpected')},dispatch:()=>{writes++;return {accepted:true,delegate_id:'write'}},steer:()=>{writes++;return {accepted:true}},invalidateProposal:()=>{},fact:()=>{},record:()=>{},diagnostic:()=>{}}
  const controller=new CodexAgentController({intake,resolveCancelTarget:async()=>null})
  await controller.dispatch({taskContext:context,instruction:'Fix login',originalUserText:'Fix login',origin_ref:context.origin_ref,sessionEpoch:1,acceptedUserInputRevision:1,stillWanted:()=>foregroundCurrent})
  await planned
  const answer={taskContext:context,instruction:'Fix login with email',originalUserText:'Email login',origin_ref:context.origin_ref,input_origin_ref:'conversation:answer',sessionEpoch:1,acceptedUserInputRevision:2,stillWanted:()=>foregroundCurrent}
  await controller.dispatch(answer)
  assert.equal(controller.inspectIntakeForTest()?.revision,2)
  assert.equal(controller.inspectIntakeForTest()?.origin_ref,context.origin_ref)
  await controller.dispatch(answer)
  assert.equal(controller.inspectIntakeForTest()?.revision,2,'same current answer is deduplicated')
  if(action==='takeover')await tasks.controlClient('takeover',fence,'client','takeover');else foregroundCurrent=false
  release();await controller.settleIntakeForTest()
  assert.equal(writes,action==='takeover'?0:1)
  assert.equal(context.stillWanted(),action!=='takeover')
  assert.equal(controller.inspectIntakeForTest()?.origin_ref,'conversation:original')
  assert.deepEqual(tasks.get(task.id).session_ids,['session1','session2'])
 }finally{await rm(dir,{recursive:true,force:true})}
 }
})

import {dispatchTurn,realtimeServiceHarness} from './support/realtime-service-harness.js'
test('production task tool declares Nova-only work from final user input and validates selected sources',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-model-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks,conversation_id:'chat:main',conversation_generation:4}})
 try{
  await service.connect()
  const accepted=await dispatchTurn(service,'task',{operation:'declare',goal:'Write a plan',acceptance:['Three steps'],source_refs:[],origin_ref:'conversation:1'})
  assert.equal(accepted.accepted,true)
  assert.equal(tasks.list().length,1)
  assert.equal(tasks.list()[0]?.origin_ref,'conversation:1')
  assert.equal(tasks.list()[0]?.conversation_generation,4)
  assert.deepEqual(tasks.list()[0]?.session_ids,[])
  const other=realtimeServiceHarness('pipeline',{taskHost:{tasks,conversation_id:'chat:main'}}).service;await other.connect()
  const refused=await dispatchTurn(other,'task',{operation:'declare',goal:'Another plan',acceptance:[],source_refs:['fake:1'],origin_ref:'conversation:2'},'invalid')
  assert.equal(refused.accepted,false);await other.close()
  assert.equal(tasks.list().length,1)
 }finally{await service.close();await tasks.close();await rm(dir,{recursive:true,force:true})}
})
test('uncertain targeted input is durable and never blindly resent; delayed input loses authority on return',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-input-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const task=await tasks.delegate('delegate',{conversation_id:'c',goal:'Goal',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0},actor={kind:'user' as const,client_id:'client'}
  await tasks.bindWork(fence,'work','session');await tasks.controlClient('take',fence,'client','takeover');fence.control_revision=1
  let sends=0
  const send=async()=>{sends++;return 'unknown' as const}
  assert.equal(await tasks.input('message',fence,actor,'session','hello',send),'unknown')
  assert.equal(await tasks.input('message',fence,actor,'session','hello',send),'unknown')
  assert.equal(sends,1)
  await assert.rejects(tasks.input('forged',fence,actor,'other-session','hello',send),/session_not_found/)
  let release!:()=>void,entered!:()=>void,writes=0
  const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const pending=tasks.input('delayed',fence,actor,'session','later',async grant=>{entered();await gate;if(!grant.stillWanted())return 'failed';writes++;return 'accepted'})
  await waiting;await tasks.returnClientTasks('mode-exit','client');release()
  assert.equal(await pending,'failed');assert.equal(writes,0)
  await tasks.close();const restored=new TaskService(tasks.path);await restored.open()
  assert.equal(await restored.input('message',fence,actor,'session','hello',send),'unknown');assert.equal(sends,1)
  const current=restored.get(task.id);await restored.cancel('cancel',{...fence,control_revision:current.control_revision},{kind:'nova'})
  assert.throws(()=>restored.continuationContext({...fence,control_revision:current.control_revision}),/task_terminal/)
  await restored.close()
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {codingAgentControllerFactory,CODEX_AGENT_DESCRIPTOR} from '../src/executors/codex/controller.js'
import {hostCodexHomeValue} from '../src/executors/codex/process-owner.js'
import {fixture,COMPLETE,settleWithin,context,run} from './fixtures/codex/project-adapter-fixture.js'
import type {TransportOutcome} from '../src/executors/codex/app-server-transport.js'
import {setTimeout as delay} from 'node:timers/promises'
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await delay(10)}assert.fail('condition did not settle')}

test('real scoped task executor survives conversation clear, targeted input and cancel retain its original session',async()=>{
 const value=await fixture({preexistingSession:true})
 const host=new PersonalAgentHost({path:join(await realpath(value.root),'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let release!:(outcome:TransportOutcome)=>void
 let providerResponse=0
 let captured:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined,intakePort:IntakeOptions|undefined
 try{
  await host.open();await value.adapter.initialize()
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,
   settings:settingsSchema.parse({executors:['codex'],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
   codexResource:{mode:'project',adapter:value.adapter,agentDescriptor:CODEX_AGENT_DESCRIPTOR,agentControllerFactory:{create:context=>{intakePort=context.intake;return codingAgentControllerFactory.create(context)}},projectView:null,approvalController:null,start:async()=>{},close:async()=>{}},
   searchTransport:{search:async()=>{throw Error('unexpected search')}},
   gateway:{complete:async()=>{throw Error('unexpected model')},async *stream(){throw Error('unexpected stream')}},
   onDiagnostic:()=>{},
   createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({
    async *stream(){const responseId='response:'+ ++providerResponse;yield {kind:'response_started',response_id:responseId};yield {kind:'text_delta',text:'ready'};yield {kind:'response_completed',response_id:responseId}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{},
   })})}}),
  })
  host.setConversationRuntime(async(...args)=>{captured=await factory(...args);return captured},()=>{})
  await host.submitConversationText('chat:main','Work on the existing task')
  await until(()=>host.conversationSnapshot().messages.some(message=>message.role==='assistant'))
  const task=await host.tasks.delegate('declared',{conversation_id:'chat:main',conversation_generation:0,goal:'Complete the task',acceptance:['Verified result'],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0},workspace=await value.store.resolveWorkspace('alpha')
  const session=(await value.store.listSessions(workspace))[0]!
  await host.tasks.bindWork(fence,'prior-work',session.session_id)
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const admission=await host.continueTask(host.tasks.continuationContext(fence),'Execute task',session.session_id) as {accepted:boolean}
  assert.equal(admission.accepted,true)
  await until(()=>value.factory.transports[0]?.workOrders.length===1)
  assert.equal(value.factory.bindings[0]?.resumeThreadId,'thread-existing')
  const originalHome=hostCodexHomeValue(value.factory.bindings[0].codexHome).path
  assert.ok(intakePort)
  const legacy={origin_ref:task.origin_ref} as IntakeSession
  assert.equal((await intakePort.steer(legacy,'alpha','Nova addition'))?.accepted,true)
  await host.tasks.controlClient('take',fence,'client','takeover')
  assert.throws(()=>intakePort!.steer(legacy,'alpha','must not overwrite user'),/not_controller/)
  const resolveSession=value.adapter.taskPort.resolveSession
  value.adapter.taskPort.resolveSession=async()=>{throw Error('session_active')}
  const missing=await host.command({type:'personal.command',request_id:'unavailable',method:'tasks.input',params:{...fence,control_revision:1,session_id:session.session_id,text:'not deliverable'}},{client_id:'client'}) as {ok:boolean;error:string}
  assert.equal(missing.error,'task_input_failed')
  assert.equal(host.tasks.inputReceipts(task.id).find(receipt=>receipt.text==='not deliverable')?.status,'failed')
  value.adapter.taskPort.resolveSession=resolveSession
  const service=captured!.bridgeService as RealtimeService
  let detached=0;const detach=service.detachTaskConversation.bind(service)
  service.detachTaskConversation=()=>{detached++;detach()}
  const timedOut=new AbortController(),pendingTurn=captured!.runTurn('timeout',timedOut.signal)
  timedOut.abort(new DOMException('turn expired','TimeoutError'))
  await assert.rejects(pendingTurn,/turn expired/)
  assert.equal(detached,0,'a response timeout does not detach the task conversation')
  await delay(30)
  assert.equal((await settleWithin('response after timeout',captured!.runTurn('after timeout',new AbortController().signal))).assistant,'ready')
  const input=await settleWithin('direct steer',host.command({type:'personal.command',request_id:'direct',method:'tasks.input',params:{...fence,control_revision:1,session_id:session.session_id,text:'Use the revised detail'}},{client_id:'client'})) as {ok:boolean;data:{status:string}}
  assert.equal(input.ok,true);assert.equal(input.data.status,'accepted')
  release(COMPLETE);await until(()=>value.adapter.running().length===0)
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const resumed=await settleWithin('idle task input resumes existing session',host.command({type:'personal.command',request_id:'resume-input',method:'tasks.input',params:{...fence,control_revision:1,session_id:session.session_id,text:'Continue with the same scope'}},{client_id:'client'})) as {ok:boolean}
  assert.equal(resumed.ok,true)
  assert.equal(value.factory.bindings[1]?.resumeThreadId,'thread-existing')
  assert.equal(hostCodexHomeValue(value.factory.bindings[1].codexHome).path,originalHome)
  const cleared=await host.command({type:'personal.command',request_id:'clear',method:'conversations.clear',params:{id:'chat:main',expected_generation:0}}) as {ok:boolean}
  assert.equal(cleared.ok,true)
  assert.equal(value.adapter.running().length,1,'clear must not abort the real project adapter')
  assert.equal(value.factory.transports[1]?.closeCalls,0)
  let notifications=0;const unsubscribe=host.subscribe(()=>notifications++)
  value.factory.transports[1].observers[0]!.onActivity?.({thread_id:'thread-existing',turn_id:'turn:2',item_id:'message:2',stage:'completed',kind:'message',sender:'executor',text:'Retained worker update',refs:[]})
  await until(()=>host.tasks.events(task.id,0).items.some(event=>event.text==='Retained worker update'))
  const page=await host.command({type:'personal.command',request_id:'activity-page',method:'tasks.get',params:{task_id:task.id,after:0}},{client_id:'client'}) as {ok:boolean;data:{events:{items:{text:string;work_id:string;session_id:string;thread_id:string}[]};capabilities:{detail:string}}}
  const publicItem=page.data.events.items.find(event=>event.text==='Retained worker update')!
  assert.equal(publicItem.session_id,session.session_id);assert.equal(publicItem.thread_id,'thread-existing')
  assert.ok(host.tasks.get(task.id).work_ids.includes(publicItem.work_id));assert.equal(page.data.capabilities.detail,'public-events');assert.ok(notifications>0);unsubscribe()

  assert.equal(hostCodexHomeValue(value.factory.bindings[1].codexHome).path,originalHome)
  const cancelled=await host.command({type:'personal.command',request_id:'stop',method:'tasks.cancel',params:{...fence,control_revision:1}},{client_id:'client'}) as {ok:boolean}
  assert.equal(cancelled.ok,true)
  await until(()=>value.adapter.running().length===0)
  await delay(30)
  assert.equal(host.tasks.get(task.id).phase,'cancelled')
  assert.deepEqual(host.conversationSnapshot().messages,[],'late task results cannot restore a cleared transcript')
 }finally{release?.(COMPLETE);await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

import {CausalRuntime,type ExecutorDispatchContext} from '../src/core/causal-runtime.js'
import {RealClock} from '../src/core/clock.js'
import {MonotonicIdFactory} from '../src/core/ids.js'
import {fixtureSlowSimManifest} from '../eval/sim.js'
test('host grant admits aged original origin while forged grants fail closed',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-aged-origin-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 const runtime=new CausalRuntime({clock:new RealClock(),ids:new MonotonicIdFactory(),models:{},executors:[{manifest:fixtureSlowSimManifest,dispatch:async()=>({outcome:'ok',trust:'trusted_system',content:{}})}]})
 try{
  const item=runtime.memory.append('conversation',{ts:0,trust:'trusted_user',priority:100,content:{text:'Original delegation'}})
  const origin=item.channel+':'+item.seq
  for(let i=0;i<100;i++)runtime.memory.append('conversation',{ts:i+1,trust:'trusted_user',priority:100,content:{text:'Later conversation '+i}})
  const task=await tasks.delegate('declare',{conversation_id:'chat:main',conversation_generation:0,goal:'Original delegation',acceptance:[],origin_ref:origin})
  const grant=tasks.continuationContext({task_id:task.id,control_revision:0,goal_revision:0})
  const request={executor:'slow_sim',op:'set_light',request:{level:1},origin_ref:origin},reason={kind:'realtime_tool',priority:100,routing_class:'user_awaited' as const,origin:null,selected_suggestion:null}
  assert.equal((await runtime.dispatchExternal(request,reason)).accepted,false)
  await assert.rejects(runtime.dispatchTaskExternal(request,reason,{...grant}),/invalid_continuation/)
  assert.equal((await runtime.dispatchTaskExternal(request,reason,grant)).accepted,true)
  assert.equal(tasks.get(task.id).work_ids.length,1)
  await assert.rejects(runtime.dispatchTaskExternal({...request,origin_ref:'conversation:2'},reason,grant),/invalid_origin_ref/)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('Nova-only cancellation is durable and mode exit invalidates pending host input without waiting for transport',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-host-control-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open()
  const task=await host.tasks.delegate('declare',{conversation_id:'chat:main',goal:'Nova deliverable',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,control_revision:0,goal_revision:0}
  await host.tasks.controlClient('take',fence,'client','takeover')
  const cancelled=await host.command({type:'personal.command',request_id:'cancel',method:'tasks.cancel',params:{...fence,control_revision:1}},{client_id:'client'}) as {ok:boolean}
  assert.equal(cancelled.ok,true);assert.equal(host.tasks.get(task.id).phase,'cancelled')
  const second=await host.tasks.delegate('second',{conversation_id:'chat:main',goal:'Executor task',acceptance:[],origin_ref:'conversation:2'})
  const secondFence={task_id:second.id,control_revision:0,goal_revision:0}
  await host.tasks.bindWork(secondFence,'work','session');await host.tasks.controlClient('take-second',secondFence,'client','takeover')
  let entered!:()=>void,release!:()=>void,writes=0
  const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  host.attachTaskRuntime('chat:main',0,{input:async grant=>{entered();await gate;if(!grant.stillWanted())return 'failed';writes++;return 'accepted'},cancel:()=>{},dispatch:async()=>{}})
  const pending=host.command({type:'personal.command',request_id:'input',method:'tasks.input',params:{...secondFence,control_revision:1,session_id:'session',text:'draft'}},{client_id:'client'}) as Promise<{ok:boolean;error?:string}>
  await waiting
  const exit=await settleWithin('mode exit while transport pending',host.command({type:'personal.command',request_id:'exit',method:'presentation.set',params:{mode:'orb'}},{client_id:'client'})) as {ok:boolean}
  assert.equal(exit.ok,true);release()
  assert.deepEqual((await pending).error,'task_input_failed');assert.equal(writes,0)
  assert.equal(host.tasks.inputReceipts(second.id)[0]?.session_id,'session')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('task input steer carries exact session and original work identity across a replaced slot',async()=>{
 const value=await fixture({preexistingSession:true});let release!:(outcome:TransportOutcome)=>void
 try{
  await value.adapter.initialize()
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const first=run(value,'first',{delegateId:'first'})
  await until(()=>value.factory.transports[0]?.workOrders.length===1)
  const session=(await value.store.listSessions(await value.store.resolveWorkspace('alpha')))[0]!
  const request={instruction:'exact steer',project:'alpha',session_id:session.session_id,work_id:'first'}
  const accepted=await value.adapter.dispatch('steer',request,context('steer',request,value.clock))
  assert.equal(accepted.outcome,'ok')
  release(COMPLETE);await first
  value.factory.runGate=new Promise(resolve=>{release=resolve})
  const second=run(value,'second',{session:'new',delegateId:'second'})
  await until(()=>value.factory.transports[1]?.workOrders.length===1)
  const refused=await value.adapter.dispatch('steer',request,context('steer',request,value.clock))
  assert.notEqual(refused.outcome,'ok')
  release(COMPLETE);await second
 }finally{release?.(COMPLETE);await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('failed durable session binding rolls back preparation and closes the transport',async()=>{
 const value=await fixture()
 try{
  await value.adapter.initialize()
  const before=await value.store.listSessions(await value.store.resolveWorkspace('alpha'))
  const request={work_order:'new work',project:'alpha',session:'new'}
  await assert.rejects(value.adapter.dispatch('run',request,{...context('run',request,value.clock),bindSession:async()=>{throw Error('takeover')}}),/takeover/)
  assert.equal(value.factory.transports[0]?.closeCalls,1)
  assert.deepEqual(await value.store.listSessions(await value.store.resolveWorkspace('alpha')),before)
  assert.equal(value.adapter.running().length,0)
 }finally{await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('task launch keeps intake cancellation predicate and adapter exceptions settle receipts',async()=>{
 for(const variant of ['cancel','throw']){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-launch-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 let writes=0,current=true
 const runtime=new CausalRuntime({clock:new RealClock(),ids:new MonotonicIdFactory(),executors:[{manifest:fixtureSlowSimManifest,dispatch:async()=>{writes++;throw Error('adapter failed')}}]})
 const stop=new AbortController();let serving:Promise<void>|undefined
 try{
  const origin=runtime.memory.append('conversation',{ts:0,trust:'trusted_user',priority:100,content:{text:'task'}})
  const task=await tasks.delegate('task',{conversation_id:'c',goal:'task',acceptance:[],origin_ref:origin.channel+':'+origin.seq})
  const grant=tasks.continuationContext({task_id:task.id,goal_revision:0,control_revision:0})
  let receipt:string|undefined
  let release!:()=>void,entered!:()=>void
  const enteredBinding=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const bind=tasks.bindWork.bind(tasks)
  tasks.bindWork=async(...args)=>{entered();await gate;return bind(...args)}
  const dispatch=runtime.dispatchTaskExternal.bind(runtime)
  const admission=dispatch({executor:'slow_sim',op:'set_light',request:{level:1},origin_ref:grant.origin_ref},{kind:'realtime_tool',priority:100,routing_class:'user_awaited',origin:null,selected_suggestion:null},grant,status=>{receipt=status},()=>current)
  await enteredBinding
  if(variant==='cancel')current=false
  release();assert.equal((await admission).accepted,true)
  serving=runtime.serve(stop.signal)
  await until(()=>receipt!==undefined)
  assert.equal(receipt,variant==='cancel'?'failed':'unknown')
  assert.equal(writes,variant==='cancel'?0:1)
 }finally{stop.abort();await serving;await tasks.close();await rm(dir,{recursive:true,force:true})}
 }
})


test('Nova-mediated return uses current user authority inside durable serialization',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-handback-'))
 const tasks=new TaskService(join(dir,'tasks.json'));await tasks.open()
 try{
  const task=await tasks.delegate('task',{conversation_id:'chat:main',goal:'task',acceptance:[],origin_ref:'conversation:1'})
  const fence={task_id:task.id,goal_revision:0,control_revision:0}
  await tasks.controlClient('take',fence,'client','takeover');fence.control_revision=1
  let current=true
  const stale=tasks.returnFromUserOrigin('stale',fence,{conversation_id:'chat:main',conversation_generation:0,origin_ref:'conversation:2'},()=>current)
  current=false
  await assert.rejects(stale,/superseded/)
  assert.equal(tasks.get(task.id).controller.kind,'user')
  const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks,conversation_id:'chat:main'}})
  try{
   await service.connect()
   const returned=await dispatchTurn(service,'task',{operation:'return',task_id:task.id,source_refs:[],origin_ref:'conversation:1'})
   assert.equal(returned.accepted,true)
   assert.deepEqual(tasks.get(task.id).controller,{kind:'nova'})
   assert.equal(tasks.get(task.id).control_revision,2)
  }finally{await service.close()}
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('failed activity persistence diagnoses an incomplete replay while later activity and execution succeed',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-replay-failure-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let executor:ExecutorDispatchContext|undefined,finish!:()=>void
 const complete=new Promise<void>(resolve=>{finish=resolve})
 const runtime=new CausalRuntime({clock:new RealClock(),ids:new MonotonicIdFactory(),executors:[{manifest:fixtureSlowSimManifest,dispatch:async(_op,_request,context)=>{await context.bindSession?.('session');executor=context;await complete;return {outcome:'ok',trust:'trusted_system',content:{}}}}]})
 const stop=new AbortController();let serving:Promise<void>|undefined
 try{await host.open();const origin=runtime.memory.append('conversation',{ts:0,trust:'trusted_user',priority:100,content:{text:'task'}})
  const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'task',acceptance:[],origin_ref:origin.channel+':'+origin.seq}),grant=host.tasks.continuationContext({task_id:task.id,control_revision:0,goal_revision:0})
  let completed:string|undefined,notifications=0;host.subscribe(()=>notifications++)
  const append=host.tasks.appendEvent.bind(host.tasks)
  host.tasks.appendEvent=(event,key)=>{if(event.item_id==='lost-sync')throw Error('private sync-error-content');return event.item_id==='lost'?Promise.reject(Error('private disk-error-content')):append(event,key)}
  assert.equal((await runtime.dispatchTaskExternal({executor:'slow_sim',op:'set_light',request:{level:1},origin_ref:grant.origin_ref},{kind:'realtime_tool',priority:100,routing_class:'user_awaited',origin:null,selected_suggestion:null},grant,status=>{completed=status})).accepted,true)
  serving=runtime.serve(stop.signal);await until(()=>executor!==undefined)
  const before=notifications,event={thread_id:'thread',turn_id:'turn',stage:'completed' as const,kind:'message' as const,sender:'executor' as const,refs:[]}
  executor!.activity?.({...event,item_id:'lost',text:'Missing message'})
  await until(()=>runtime.core.diagnostics.some(item=>item.code==='task_event_persistence_failed'))
  assert.ok(notifications>before,'host is notified even though persistence failed')
  assert.equal(host.tasks.events(task.id,0).incomplete,true)
  assert.equal(JSON.stringify(runtime.core.diagnostics).includes('private disk-error-content'),false)
  assert.doesNotThrow(()=>executor!.activity?.({...event,item_id:'lost-sync',text:'Missing synchronous message'}))
  await until(()=>runtime.core.diagnostics.filter(item=>item.code==='task_event_persistence_failed').length===2)
  assert.equal(JSON.stringify(runtime.core.diagnostics).includes('private sync-error-content'),false)
  executor!.activity?.({...event,item_id:'saved',text:'Later message'})
  await until(()=>host.tasks.events(task.id,0).items.some(item=>item.text==='Later message'))
  const response=await host.command({type:'personal.command',request_id:'page',method:'tasks.get',params:{task_id:task.id}},{client_id:'client'}) as {data:{events:{incomplete:boolean;items:{text:string}[]}}}
  assert.equal(response.data.events.incomplete,true);assert.deepEqual(response.data.events.items.map(item=>item.text),['Later message'])
  const restored=new TaskService(host.tasks.path);await restored.open();assert.equal(restored.events(task.id,0).incomplete,true);await restored.close()
  finish();await until(()=>completed!==undefined);assert.equal(completed,'accepted')
 }finally{finish();stop.abort();await serving;await host.close();await rm(dir,{recursive:true,force:true})}
})

test('real Nova declaration and confirmed content drive correction and verified completion without Codex',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-content-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let responses=0,checks=0,continuationGuidance=''
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async request=>{const input=JSON.parse(request.prompt) as {task:{id:string};evidence:{ref:string}[]};checks++;return {text:JSON.stringify(checks===1?{kind:'correct',instruction:'Include all three steps',evidence_refs:[input.evidence[0]!.ref]}:{kind:'complete',evidence_refs:[input.evidence.at(-1)!.ref]})}},async *stream(){throw Error('unused')}},
 createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(input){const n=++responses,r='nova:'+n;yield {kind:'response_started',response_id:r};if(n===1)yield {kind:'tool_call',item_id:'declare',call_id:'declare',name:'task',arguments:{operation:'declare',goal:'Write three steps',acceptance:['Three steps'],source_refs:[],origin_ref:'conversation:1'}};else {if(n>=3)continuationGuidance=input.responseAdaptation??'';yield {kind:'text_delta',text:n===2?'Step one':'Step one. Step two. Step three.'}}yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})})
 host.setConversationRuntime(factory,()=>{});await host.submitConversationText('chat:main','Write three steps');await until(()=>host.tasks.list()[0]?.phase==='completed')
 const task=host.tasks.list()[0]!;assert.equal(task.corrections,1);assert.equal(checks,2);assert.equal(task.work_ids.length,0);assert.match(continuationGuidance,/actual requested deliverable/);assert.equal(host.tasks.evidence(task.id).filter(item=>item.kind==='delivery').length,2)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('host coding delegate starts through actual controller without a session, verifies terminal result and syncs Todo',async()=>{
 let releaseForeground!:()=>void;const foreground=new Promise<void>(resolve=>{releaseForeground=resolve})
 const value=await fixture(),host=new PersonalAgentHost({path:join(await realpath(value.root),'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let responses=0,checks=0
 try{await host.open();await value.adapter.initialize();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:['codex'],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),codexResource:{mode:'project',adapter:value.adapter,agentDescriptor:CODEX_AGENT_DESCRIPTOR,agentControllerFactory:{create:context=>new CodexAgentController({channel:context.channel,resolveCancelTarget:async()=>null,dispatchPort:{dispatch:request=>context.dispatchPort.dispatch({...request,request:{...request.request,project:'alpha'}})}})},projectView:null,approvalController:null,start:async()=>{},close:async()=>{}},searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async request=>{const input=JSON.parse(request.prompt) as {evidence:{ref:string;kind:string;content:string}[]};checks++;assert.ok(input.evidence.some(item=>item.kind==='work'&&item.content.includes('done')));return {text:JSON.stringify({kind:'complete',evidence_refs:input.evidence.filter(item=>item.kind==='work').map(item=>item.ref)})}},async *stream(){throw Error('unused')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){const r='coding:'+ ++responses;yield {kind:'response_started',response_id:r};await foreground;yield {kind:'text_delta',text:'Ready'};yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})})
 host.setConversationRuntime(factory,()=>{});const submitted=host.submitConversationText('chat:main','Please implement the fix');await until(()=>responses===1)
 const todo=await host.life.mutate({op:'create',kind:'todo',title:'Fix',note:'unchanged'},'todo')
 const result=await host.command({type:'personal.command',request_id:'delegate',method:'tasks.delegate',params:{conversation_id:'chat:main',goal:'Implement the fix',acceptance:['done result'],origin_ref:'conversation:1',execution_route:'codex',todo_ref:todo}},{client_id:'client'}) as {ok:boolean;error?:string;data:{id:string}}
 assert.equal(result.ok,true,result.error);releaseForeground();await submitted;await until(()=>host.tasks.get(result.data.id).todo_sync==='synced')
 assert.equal(value.factory.transports.length,1);assert.equal(checks,1);assert.equal(host.tasks.get(result.data.id).corrections,0);assert.equal(host.life.snapshot().todos[0]!.status,'done');assert.equal(host.life.snapshot().todos[0]!.note,'unchanged')
 }finally{releaseForeground();await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

test('explicit model task stop cancels Nova-only and bound work and prevents restart',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-stop-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});try{await host.open();for(const bound of [false,true]){const task=await host.tasks.delegate('task:'+bound,{conversation_id:'chat:main',goal:'stop me',acceptance:[],origin_ref:'conversation:1'});if(bound){await host.tasks.bindWork({task_id:task.id,goal_revision:0,control_revision:0},'work');host.attachTaskRuntime('chat:main',0,{input:async()=> 'accepted',dispatch:async()=>assert.fail('restart'),cancel:work=>assert.equal(work,'work')})}
 const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks:host.tasks,conversation_id:'chat:main',cancel:(request,fence)=>host.cancelTask(request,fence,{kind:'nova'})}});await service.connect();const result=await dispatchTurn(service,'task',{operation:'cancel',task_id:task.id,source_refs:[],origin_ref:'conversation:1'},'cancel:'+bound);assert.equal(result.accepted,true);assert.equal(host.tasks.get(task.id).phase,'cancelled');await host.wakeTask(task.id);await service.close()}
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('explicit continue cannot silently choose Nova for a host task with no route',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-route-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let dispatches=0
 try{await host.open();host.attachTaskRuntime('chat:main',0,{routes:()=>['nova'],input:async()=> 'accepted',cancel:()=>{},dispatch:async()=>{dispatches++}})
 const result=await host.command({type:'personal.command',request_id:'unrouted',method:'tasks.delegate',params:{conversation_id:'chat:main',goal:'Do work',acceptance:[],origin_ref:'conversation:1'}},{client_id:'client'}) as {data:{id:string}}
 const task=host.tasks.get(result.data.id);await host.tasks.continue('continue',{task_id:task.id,control_revision:0,goal_revision:0},{kind:'nova'});await host.wakeTask(task.id)
 assert.equal(dispatches,0);assert.equal(host.tasks.get(task.id).waiting_reason,'execution_route_required')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('presentation and Nova-mediated handback wake verification after durable ownership return',async()=>{
 for(const action of ['presentation','model']){const dir=await mkdtemp(join(await realpath(tmpdir()),'task-return-wake-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'answer',acceptance:[],origin_ref:'conversation:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0};await host.tasks.recordDelivery(fence,'reply','answer');await host.tasks.controlClient('take',fence,'client','takeover')
 host.attachTaskRuntime('chat:main',0,{input:async()=> 'accepted',cancel:()=>{},dispatch:async()=>assert.fail('already delivered'),evaluate:async()=>({kind:'complete',evidence_refs:['task-delivery:reply']})})
 if(action==='presentation')await host.command({type:'personal.command',request_id:'orb',method:'presentation.set',params:{mode:'orb'}},{client_id:'client'})
 else{const {service}=realtimeServiceHarness('pipeline',{taskHost:{tasks:host.tasks,conversation_id:'chat:main',wake:id=>host.wakeTask(id)}});try{await service.connect();const result=await dispatchTurn(service,'task',{operation:'return',task_id:task.id,source_refs:[],origin_ref:'conversation:1'});assert.equal(result.accepted,true)}finally{await service.close()}}
 await until(()=>host.tasks.get(task.id).phase==='completed')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}}
})

test('unrelated host narration is not evidence for a task sharing the latest user origin',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-host-fact-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});let responses=0,captured:Awaited<ReturnType<ReturnType<typeof conversationRuntimeFactory>>>|undefined
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},gateway:{complete:async()=>{throw Error('not task evidence')},async *stream(){throw Error('unused')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(){const n=++responses;yield {kind:'response_started',response_id:'fact:'+n};yield {kind:'text_delta',text:n===1?'Ready':'Unrelated host notice'};yield {kind:'response_completed',response_id:'fact:'+n}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})})
 host.setConversationRuntime(async(...args)=>{captured=await factory(...args);return captured},()=>{});await host.submitConversationText('chat:main','Write a plan');const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Write a plan',acceptance:[],origin_ref:'conversation:1'})
 const bridge=captured!.bridgeService as RealtimeService;bridge.queueHostItem({kind:'host_fact',item:{kind:'recovery',host_item_id:'unrelated',event_id:'unrelated',call_id:null,content:'Unrelated host notice'},task_summary:null,origin_spoken:false});await (captured!.bridgeService as RealtimeService).flushHostItems();await until(()=>host.conversationSnapshot().messages.some(item=>item.text==='Unrelated host notice'));await host.tasks.close()
 assert.equal(host.tasks.evidence(task.id).length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
