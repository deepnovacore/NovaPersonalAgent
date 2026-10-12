import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {createConversation} from '../src/personal-agent/conversations.js'
const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
const input={title:'Review',goal:'Review priorities',acceptance:['State priorities'],rule:{kind:'daily' as const,timezone:'UTC',time:'10:00'},context}

test('claim and delegate crashes reconcile one Task; first prepare never requests recovery',async()=>{
 for(const crash of ['claim','delegate','prepared']){
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-run-recovery-')),path=join(dir,'personal.json')
  const make=()=>new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  let host=make();const prepared:{recovery:boolean;namespace:string}[]=[]
  try{await host.open();const schedule=await host.schedules.create('create',input,{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context}),run=await host.schedules.runNow('run',schedule.id,1)
   if(crash!=='claim'){const task=await host.tasks.delegate('scheduled:'+run.run_id,run.input);if(crash==='prepared'){await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)}}
   await host.close();host=make()
   host.setConversationRuntime(async(conversation,_emit,_mode,_lifetime,recovery,execution)=>{
    assert.equal(conversation.kind,'schedule');prepared.push({recovery:recovery??false,namespace:execution!.namespace})
    if(recovery)throw Error('task_blackboard_unavailable')
    const task=host.tasks.findByRun(run.run_id)!
    host.attachTaskRuntime(conversation.id,0,{routes:()=>['nova'],ready:()=>false,input:async()=> 'failed',cancel:()=>{},dispatch:async()=>{throw Error('no foreground turn')}})
    assert.equal(task.origin_ref,'schedule-run:'+run.run_id)
    return {runTurn:async()=>{throw Error('scheduled execution cannot fabricate user text')},close:async()=>{}}
   },()=>{})
   await host.open();await host.scheduledTaskTick()
   assert.equal(host.tasks.list().length,1);assert.equal(host.schedules.getRun(run.run_id).task_id,host.tasks.list()[0]!.id)
   assert.deepEqual(prepared,[{recovery:crash==='prepared',namespace:'schedule-run:'+run.run_id}])
   if(crash==='prepared')assert.equal(host.tasks.list()[0]!.waiting_reason,'task_blackboard_unavailable')
  }finally{await host.close();await rm(dir,{recursive:true,force:true})}
 }
})
test('hidden schedule ownership has a separate quota, rejects foreground use and preserves a verified backup',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-hidden-schedule-')),path=join(dir,'personal.json'),state=initialState()
 while(state.conversations.items.length<128)state.conversations.items.push(createConversation('chat','Chat'))
 await new PersonalStore(path).write(state);const original=await readFile(path,'utf8')
 const host=new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open()
  let hidden=''
  for(let i=0;i<64;i++){const item=await host.schedules.create('c'+i,input,{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context});hidden='schedule:'+item.id}
  await assert.rejects(host.schedules.create('overflow',input,{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context}),/schedule_capacity/)
  await host.scheduledTaskTick();assert.equal(host.conversationSnapshot().items.length,128)
  for(const method of ['conversations.select','conversations.voice'] as const){const ack=await host.command({type:'personal.command',request_id:method,method,params:{id:hidden,...(method==='conversations.voice'?{enabled:true}:{})}}) as {ok:boolean};assert.equal(ack.ok,false)}
  await assert.rejects(host.submitConversationText(hidden,'hi'),/hidden_conversation/)
  const backup=path+'.before-schedules.json';assert.equal(await readFile(backup,'utf8'),original);assert.equal((await stat(backup)).mode&0o777,0o600)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('an unknown dispatched effect survives recovery without a second attempt',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-run-unknown-')),path=join(dir,'personal.json')
 const make=()=>new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=make(),dispatched=0
 try{await host.open();const schedule=await host.schedules.create('create',input,{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context}),run=await host.schedules.runNow('run',schedule.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
  await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
  const effect=await host.tasks.reserveInitial({task_id:task.id,control_revision:0,goal_revision:0});await host.tasks.markEffectDispatching(effect)
  await host.close();host=make()
  host.setConversationRuntime(async conversation=>{host.attachTaskRuntime(conversation.id,0,{recover:async()=>null,ready:()=>true,input:async()=> 'failed',cancel:()=>{},dispatch:async()=>{dispatched++}});return {runTurn:async()=>{throw Error('no user turn')},close:async()=>{}}},()=>{})
  await host.open();await host.scheduledTaskTick();await host.wakeTask(task.id)
  assert.equal(host.tasks.get(task.id).phase,'waiting');assert.equal(host.tasks.get(task.id).waiting_reason,'uncertain_recovery');assert.equal(dispatched,0)
  assert.equal(host.tasks.list().length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('only two scheduled runtimes prepare and hidden frames never reach the foreground transport',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-run-capacity-')),path=join(dir,'personal.json')
 const host=new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let prepared=0,emitted=0
 host.setConversationRuntime(async(conversation,emit)=>{prepared++;emit({type:'caption',role:'assistant',text:'Unverified private result',final:true});host.attachTaskRuntime(conversation.id,0,{ready:()=>false,input:async()=> 'failed',cancel:()=>{},dispatch:async()=>{throw Error('must not run')}});return {runTurn:async()=>{throw Error('no user turn')},close:async()=>{}}},()=>{emitted++})
 try{await host.open()
  for(let i=0;i<3;i++){const s=await host.schedules.create('create'+i,input,{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context});await host.schedules.runNow('run'+i,s.id,1)}
  await host.scheduledTaskTick();assert.equal(prepared,2);assert.equal(host.schedules.activeRuns().filter(run=>run.stage==='bound').length,1);assert.equal(emitted,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
