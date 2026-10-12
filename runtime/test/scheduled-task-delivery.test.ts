import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {GatewayTaskVerifier} from '../src/model/task-verifier.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import {TaskService} from '../src/personal-agent/tasks.js'
test('verified scheduled delivery is idempotent, continues in the main chat, and user adoption writes once',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-schedule-delivery-')),path=join(dir,'personal.json')
 const make=()=>new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{await host.open()
  const context={todos:true,goals:false,tasks:false,memory:false,search:false,knowledge:false}
  const s=await host.schedules.create('create',{title:'Review',goal:'Prioritize',acceptance:['Suggest one action'],rule:{kind:'daily',timezone:'UTC',time:'10:00'},context},{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context}),run=await host.schedules.runNow('run',s.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
  const page=await host.readAppContext('todos',null,host.scheduledRunGrant(run.run_id,new AbortController().signal))
  await host.tasks.recordDelivery(fence,'reply','First, draft the proposal.')
  const delivered='task-delivery:reply'
  await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:[delivered],criteria:[{index:0,evidence_refs:[delivered]}]})
  await host.command({type:'personal.command',method:'conversations.create',request_id:'other-chat',params:{title:'Other discussion'}},{client_id:'test'})
  const selected=host.conversationSnapshot().selected_id
  await host.publishScheduledResult(run.run_id);await host.publishScheduledResult(run.run_id)
  assert.equal(host.conversationSnapshot().selected_id,selected,'background delivery must not switch conversations')
  await host.command({type:'personal.command',method:'conversations.select',request_id:'main-chat',params:{id:'chat:main'}},{client_id:'test'})
  assert.equal(host.snapshot().feed.filter(item=>item.id==='scheduled-result:'+run.run_id).length,1)
  assert.equal(host.conversationSnapshot().unread_count,1)
  assert.equal(host.conversationSnapshot().messages.filter(item=>item.id==='scheduled-result:'+run.run_id&&item.text.includes('First, draft the proposal.')).length,1,'result body is delivered to main chat')
  const nextRun=await host.schedules.runNow('next',s.id,1),nextTask=await host.tasks.delegate('scheduled:'+nextRun.run_id,nextRun.input)
  await host.schedules.bindTask(nextRun.run_id,nextTask.id);await host.schedules.markPrepared(nextRun.run_id,'schedule-run:'+nextRun.run_id)
  const recent=()=>Reflect.apply(Reflect.get(host,'recentScheduledSummaries'),host,[host.scheduledRunGrant(nextRun.run_id,new AbortController().signal)]) as Promise<unknown[]>
  assert.equal((await recent()).length,1)
  assert.match(await host.scheduledConversationContext('chat:main',0,null)??'',/First, draft the proposal/u)
  const topic=await host.openScheduledResult(run.run_id)
  assert.equal(host.conversationSnapshot().selected_id,topic.id);assert.equal(topic.kind,'chat');assert.equal(topic.id,'chat:main')
  const adoption={run_id:run.run_id,kind:'todo' as const,title:'Draft proposal',note:'First step'}
  const first=await host.adoptScheduledResult('adopt',adoption),again=await host.adoptScheduledResult('adopt',adoption)
  assert.equal(first.id,again.id);assert.equal(host.life.snapshot().todos.length,1)
  assert.equal((await recent()).length,0,'an old summary cannot bypass current App versions')
  const followUp=await host.scheduledConversationContext('chat:main',0,null);assert.ok(!followUp?.includes('First, draft the proposal.'));assert.match(followUp??'',/unavailable/u)
  assert.ok(page.evidence_refs.length>0)
  await host.close();host=make();await host.open()
  await host.publishScheduledResult(run.run_id)
  assert.equal(host.snapshot().feed.filter(item=>item.id==='scheduled-result:'+run.run_id).length,1)
  assert.equal(host.tasks.list().length,2)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('context is checked before and after verification and before the completion write',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-schedule-verification-')),tasks=new TaskService(join(dir,'tasks.json'))
 let allowed=true,calls=0
 try{await tasks.open()
  const task=await tasks.delegate('task',{conversation_id:'c',goal:'Prioritize current data',acceptance:['One action'],origin_ref:'c:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  const contextRef=await tasks.recordContextEvidence(fence,'read','{"items":[],"coverage":{"complete":true}}',['app:todos:version'])
  await tasks.recordDelivery(fence,'answer','One action')
  const gateway={complete:(input:{prompt:string})=>{calls++;const prompt=JSON.parse(input.prompt) as {evidence:{kind:string}[]};assert.deepEqual(prompt.evidence.map(item=>item.kind),['context','delivery']);allowed=false;return Promise.resolve({text:JSON.stringify({kind:'complete',evidence_refs:[contextRef,'task-delivery:answer'],criteria:[{index:0,evidence_refs:['task-delivery:answer']}]})});}} as unknown as ModelGateway
  const verifier=new GatewayTaskVerifier({gateway,model:'test'}),check=()=>Promise.resolve(allowed)
  const evaluate=()=>verifier.evaluateTask(task,tasks.evidence(task.id),new AbortController().signal,[],check)
  const revokedDuringCall=await evaluate();assert.equal(revokedDuringCall.kind,'wait');assert.equal(calls,1)
  assert.equal((await evaluate()).kind,'wait');assert.equal(calls,1,'revoked context never enters a model request')
  const result=await tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:answer']},check)
  assert.equal(result.phase,'waiting');assert.equal(result.waiting_reason,'context_authorization_changed')
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})
test('missed occurrences without Agent Tasks settle publication without blocking later ticks',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-schedule-missed-')),path=join(dir,'personal.json')
 let now=new Date('2026-10-12T08:00:00Z')
 const host=new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null,now:()=>now})
 try{await host.open();const context={todos:false,goals:false,tasks:false,memory:false,search:false,knowledge:false}
  const schedule=await host.schedules.create('rule',{title:'Once',goal:'Review',acceptance:['A review'],rule:{kind:'once',timezone:'UTC',date:'2026-10-12',time:'09:00'},context},{user_scope:'test',source:'ui',origin_ref:'ui:rule',source_refs:[],allowed_context:context})
  await host.schedules.runNow('manual',schedule.id,1)
  now=new Date('2026-10-12T09:00:00Z');await host.scheduledTaskTick()
  assert.equal(host.schedules.terminalRuns()[0]!.terminal_summary!.published,true)
  await host.scheduledTaskTick();assert.equal(host.tasks.list().length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
