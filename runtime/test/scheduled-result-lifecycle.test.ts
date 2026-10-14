import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {ScheduleRun} from '../src/personal-agent/scheduled-tasks.js'
const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
const input={title:'Review',goal:'Prioritize',acceptance:['One action'],rule:{kind:'daily' as const,timezone:'UTC',time:'10:00'},context}
const authority={user_scope:'test',source:'ui' as const,origin_ref:'ui:create',source_refs:[],allowed_context:context}
const create=(host:PersonalAgentHost,key:string)=>host.schedules.create(key,input,authority)
async function complete(host:PersonalAgentHost,external=false,key=''){
 const scope={...context,memory:external},schedule=await host.schedules.create('rule'+key,{...input,context:scope},{...authority,allowed_context:scope}),run=await host.schedules.runNow('run'+key,schedule.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:0,goal_revision:0}
 await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
 const page=await host.readAppContext('todos',null,host.scheduledRunGrant(run.run_id,new AbortController().signal,external?'provider':null))
 if(external)await host.tasks.recordContextEvidence(fence,'source',JSON.stringify({consumer:'provider'}),['external:secret'])
 await host.tasks.recordDelivery(fence,'answer'+key,'Original source report')
 await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:answer'+key],criteria:[{index:0,evidence_refs:['task-delivery:answer'+key]}]})
 return {run,task,fence,page}
}
function bind(host:PersonalAgentHost){host.setConversationRuntime(conversation=>{
 host.attachTaskRuntime(conversation.id,conversation.generation,{routes:()=>['nova'],ready:()=>false,input:()=>Promise.resolve('failed'),cancel:()=>{/* test */},dispatch:()=>Promise.reject(Error('unused'))})
 return Promise.resolve({runTurn:()=>Promise.resolve({assistant:'Hello'}),close:()=>Promise.resolve()})
},()=>{/* observer */})}
for(const phase of ['before_summary','after_summary'] as const)test('changed sources settle safely and do not block another run or restart: '+phase,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-result-life-')),path=join(dir,'personal.json'),make=()=>new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{await host.open();const {run,page}=await complete(host)
  if(phase==='after_summary')await host.schedules.markFinished(run.run_id,{outcome:'completed',text:'Original source report',evidence_refs:page.evidence_refs,consumer:null,published:false})
  await host.life.mutate({op:'create',kind:'todo',title:'Changed after verification'},'change')
  const another=await create(host,'another'),second=await host.schedules.runNow('another-run',another.id,1);bind(host)
  await host.scheduledTaskTick()
  assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.outcome,'failed')
  assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.published,true)
  assert.deepEqual(host.schedules.getRun(run.run_id).terminal_summary?.evidence_refs,[])
  assert.ok(!JSON.stringify(host.schedules.getRun(run.run_id).terminal_summary).includes('Original source report'))
  assert.equal(host.schedules.getRun(second.run_id).stage,'prepared')
  assert.equal(host.conversationSnapshot().messages.some(m=>m.schedule_ref?.run_id===run.run_id),false)
  await host.close();host=make();bind(host);await host.open();await host.scheduledTaskTick()
  assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.outcome,'failed')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('transient publication failure does not prevent another run preparing and retries later',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-result-retry-')),host=new PersonalAgentHost({path:join(dir,'p.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const {run}=await complete(host);await complete(host,false,'-two');const another=await create(host,'another'),second=await host.schedules.runNow('another-run',another.id,1);bind(host)
  const publish=host.publishScheduledResult.bind(host);host.publishScheduledResult=()=>Promise.reject(Error('temporary_store_unavailable'))
  await host.scheduledTaskTick();assert.equal(host.schedules.getRun(second.run_id).stage,'prepared');assert.equal(host.schedules.getRun(run.run_id).terminal_summary,null)
  host.publishScheduledResult=publish;await host.scheduledTaskTick();assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.published,true)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('committed main delivery survives a missing publication receipt and later source changes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-result-receipt-')),host=new PersonalAgentHost({path:join(dir,'p.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const {run}=await complete(host),mark=host.schedules.markPublished.bind(host.schedules)
  host.schedules.markPublished=()=>Promise.reject(Error('crash_after_main_commit'))
  await assert.rejects(host.publishScheduledResult(run.run_id),/crash_after_main_commit/)
  host.schedules.markPublished=mark
  await host.life.mutate({op:'create',kind:'todo',title:'Changed after delivery'},'change');await host.scheduledTaskTick()
  assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.outcome,'completed')
  assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.published,true)
  assert.equal(host.conversationSnapshot().messages.filter(m=>m.schedule_ref?.run_id===run.run_id).length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic understanding never consumes scheduled report bodies after source revocation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-result-consent-'));let allowed=true;const captured:string[]=[]
 const memory={open:()=>Promise.resolve(),close:()=>Promise.resolve(),canReadConversationEvidence:()=>Promise.resolve(allowed)} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'p.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,understand:source=>{captured.push(source.context??'');return Promise.resolve([])}})
 try{await host.open();bind(host);const {run}=await complete(host,true)
  await host.publishScheduledResult(run.run_id);allowed=false
  assert.ok(!(await host.scheduledConversationContext('chat:main',0,'provider'))?.includes('Original source report'))
  await host.submitConversationText('chat:main','Hello');await host.waitConversation('chat:main')
  assert.ok(captured.length>0);assert.ok(captured.every(text=>!text.includes('Original source report')))
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('retired report focus and message references do not break ordinary conversation context',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-result-retention-')),path=join(dir,'p.json'),make=()=>new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{await host.open();const {run}=await complete(host);await host.publishScheduledResult(run.run_id);await host.openScheduledResult(run.run_id);await host.close()
  const saved=JSON.parse(await readFile(path+'.schedules.json','utf8')) as {runs:ScheduleRun[]}
  for(let i=0;i<2000;i++){const row=structuredClone(saved.runs[0]!);row.run_id='history-'+i;row.input.origin_ref='schedule-run:'+row.run_id;row.input.trigger!.run_id=row.run_id;row.prepared_namespace='schedule-run:'+row.run_id;saved.runs.push(row)}
  await writeFile(path+'.schedules.json',JSON.stringify(saved));host=make();await host.open();assert.equal(host.schedules.terminalRuns().length,2000)
  const result=await host.scheduledConversationContext('chat:main',0,null);assert.match(result??'',/unavailable/);assert.ok(!result?.includes('Original source report'))
  const state=JSON.parse(await readFile(path,'utf8')) as {conversations:{items:{id:string;scheduled_result_focus?:string}[]}}
  assert.equal(state.conversations.items.find(c=>c.id==='chat:main')?.scheduled_result_focus,undefined)
  bind(host);await host.submitConversationText('chat:main','Hello');await host.waitConversation('chat:main');assert.ok(host.conversationSnapshot().messages.some(m=>m.text==='Hello'&&m.role==='assistant'))
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
