import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {emptyLifeState} from '../src/personal-agent/life.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
const context={todos:true,goals:false,tasks:true,memory:false,knowledge:false,search:false}
test('App reads enumerate fresh authorized versions, detect changed pages and reject scope expansion',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-app-context-')),path=join(dir,'personal.json')
 let allowed=true
 const memory:PersonalMemoryResource={open:()=>{return Promise.resolve();},close:()=>{return Promise.resolve();},recall:()=>{return Promise.reject(Error('not semantic recall'));},canReadConversationEvidence:(id,consumer)=>Promise.resolve(allowed&&id==='source:allowed'&&consumer==='model-a')}
 const life=emptyLifeState(),now=new Date().toISOString()
 life.todos.push({id:'derived',version:1,title:'Authorized external item',note:'Source detail',status:'open',due:null,goal_id:null,idea_id:null,created_at:now,updated_at:now,auto_recorded:true,provenance_refs:['source:allowed']})
 await writeFile(path+'.life.json',JSON.stringify(life),{mode:0o600})
 const host=new PersonalAgentHost({path,userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open()
  const s=await host.schedules.create('create',{title:'Review',goal:'Read current todos',acceptance:['Prioritize current todos'],rule:{kind:'daily',timezone:'UTC',time:'10:00'},context},{user_scope:'test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context}),run=await host.schedules.runNow('run',s.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input)
  await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
  for(let i=0;i<22;i++)await host.life.mutate({op:'create',kind:'todo',title:'New item '+i,note:i===0?'x'.repeat(4000):''},'todo'+i)
  const grant=host.scheduledRunGrant(run.run_id,new AbortController().signal,'model-a')
  await assert.rejects(host.readAppContext('todos','null',grant),/^Error: context_cursor_invalid: start with cursor null; otherwise copy next_cursor unchanged$/)
  const first=await host.readAppContext('todos',null,grant)
  assert.equal(first.items.length,20);assert.ok(first.next_cursor);assert.equal(first.coverage.truncated,true);assert.equal(first.coverage.complete,false);assert.ok(Buffer.byteLength(JSON.stringify(first))<=32768)
  const second=await host.readAppContext('todos',first.next_cursor,grant)
  assert.equal(second.items.length,3);assert.equal(second.next_cursor,null)
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,23)
  assert.equal(host.tasks.evidence(task.id).filter(item=>item.kind==='context').length,2)
  await assert.rejects(host.readAppContext('goals',null,grant),/context_not_authorized/)
  assert.equal(await host.appContext.validateTask(task.id,'model-a'),true)
  assert.equal(await host.appContext.validateTask(task.id,'model-a','model-b'),false,'verification has its own actual model recipient')
  const item=host.life.snapshot().todos.find(item=>item.title==='New item 0')!
  await host.life.mutate({op:'update',kind:'todo',id:item.id,expected_version:item.version,title:'Changed priority'},'edit')
  assert.equal(await host.appContext.validateTask(task.id,'model-a'),false)
  await assert.rejects(host.readAppContext('todos',first.next_cursor,grant),/context_cursor_stale/)
  allowed=false
  const current=await host.readAppContext('todos',null,grant)
  assert.ok(!current.items.some(item=>item.id==='derived'));assert.equal(current.coverage.omitted,1)
  assert.equal(await host.appContext.validateTask(task.id,'model-a'),false)
  const wrong=host.scheduledRunGrant(run.run_id,new AbortController().signal,'model-b')
  assert.ok(!(await host.readAppContext('todos',null,wrong)).items.some(item=>item.id==='derived'))
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('stored retrieval evidence becomes unusable after a memory revision changes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-scheduled-revision-'))
 let revision=1
 const memory={open:()=>{return Promise.resolve();},close:()=>{return Promise.resolve();},recall:()=>{return Promise.reject(Error('unused'));},canReadConversationEvidence:()=>Promise.resolve(true),get:()=>Promise.resolve(({status:'active',version:revision,content:'Original'}))} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'p.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const task=await host.tasks.delegate('t',{conversation_id:'chat:main',goal:'Read memory',acceptance:['Summary'],origin_ref:'conversation:1'})
 const fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
 await host.tasks.recordContextEvidence(fence,'read',JSON.stringify({consumer:'model',projection:{entries:[{entry_id:'m',revision:1,text:'Original'}],snippets:[]}}),['source:1'])
 assert.equal(await host.appContext.validateTask(task.id,'model'),true)
 revision=2
 assert.equal(await host.appContext.validateTask(task.id,'model'),false)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
