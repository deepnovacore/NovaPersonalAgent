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
  assert.equal(hostCodexHomeValue(value.factory.bindings[1].codexHome).path,originalHome)
  const cancelled=await host.command({type:'personal.command',request_id:'stop',method:'tasks.cancel',params:{...fence,control_revision:1}},{client_id:'client'}) as {ok:boolean}
  assert.equal(cancelled.ok,true)
  await until(()=>value.adapter.running().length===0)
  await delay(30)
  assert.equal(host.tasks.get(task.id).phase,'cancelled')
  assert.deepEqual(host.conversationSnapshot().messages,[],'late task results cannot restore a cleared transcript')
 }finally{release?.(COMPLETE);await host.close();await value.adapter.close();await rm(value.root,{recursive:true,force:true})}
})

import {CausalRuntime} from '../src/core/causal-runtime.js'
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
