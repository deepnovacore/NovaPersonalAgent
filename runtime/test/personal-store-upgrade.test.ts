import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {createConversation,conversationUnreadCount} from '../src/personal-agent/conversations.js'
for(const count of [0,2,512])test(`stored proactive history upgrades without loss (${count} messages)`,async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-proactive-upgrade-')),path=join(root,'personal.json'),state=initialState()
 const main=state.conversations.items[0]!,at=new Date().toISOString()
 main.messages=[{id:'user',conversation_id:main.id,role:'user',text:'original',created_at:at}]
 const old={...createConversation('chat','旧主动消息',null,'chat:proactive'),kind:'proactive',messages:Array.from({length:count},(_,i)=>({id:'old'+i,conversation_id:'chat:proactive',role:'assistant',text:'kept'+i,origin:'proactive',created_at:at,read:i===0}))}
 const input={...state,conversations:{...state.conversations,selected_id:'chat:proactive',items:[main,old]}}
 const text=JSON.stringify(input);await writeFile(path,text,{mode:0o600});await writeFile(path+'.before-schedules.json',text,{mode:0o600})
 const store=new PersonalStore(path)
 try{
  const result=await store.read();assert.equal(result.conversations.selected_id,'chat:main')
  assert.ok(!result.conversations.items.some(c=>String(c.kind)==='proactive'||c.id==='chat:proactive'))
  const messages=result.conversations.items.flatMap(c=>c.messages);assert.equal(messages.length,count+1);assert.equal(new Set(messages.map(m=>m.id)).size,count+1)
  assert.equal(result.conversations.items.reduce((n,c)=>n+conversationUnreadCount(c),0),Math.max(0,count-1))
  await store.ensureScheduleBackup();assert.equal(await readFile(path+'.before-schedules.json','utf8'),text)
  await store.write(result);assert.deepEqual(await store.read(),result)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('legacy opaque persona metadata survives reading, schedule backup and writing with conversation history',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-persona-upgrade-')),path=join(root,'personal.json'),state=initialState()
 const main=state.conversations.items[0]!,topic=createConversation('topic','Saved topic',null,'topic:saved'),at=new Date().toISOString()
 main.persona='neutral-a';topic.persona='neutral-b'
 main.messages=[{id:'kept-user',conversation_id:main.id,role:'user',text:'Retained question',created_at:at}]
 topic.messages=[{id:'kept-answer',conversation_id:topic.id,role:'assistant',text:'Retained answer',created_at:at}]
 state.conversations.items.push(topic);state.conversations.selected_id=topic.id
 const original=JSON.stringify(state);await writeFile(path,original,{mode:0o600});await writeFile(path+'.before-schedules.json',original,{mode:0o600})
 const store=new PersonalStore(path)
 try{
  const loaded=await store.read()
  assert.deepEqual(loaded,state)
  assert.equal(await readFile(path,'utf8'),original,'reading must not rewrite the old profile')
  await store.ensureScheduleBackup();assert.equal(await readFile(path+'.before-schedules.json','utf8'),original)
  await store.write(loaded)
  assert.deepEqual(await store.read(),state)
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')).conversations,state.conversations)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('persona compatibility stays bounded and does not admit unrelated unknown conversation fields',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-persona-strict-')),path=join(root,'personal.json')
 try{
  for(const extra of [{persona:''},{persona:'a'.repeat(129)},{persona:42},{persona:{}},{future_metadata:true}]){
   const state=initialState();Object.assign(state.conversations.items[0]!,extra)
   const original=JSON.stringify(state);await writeFile(path,original,{mode:0o600})
   await assert.rejects(new PersonalStore(path).read(),{code:'state_schema_incompatible'})
   assert.equal(await readFile(path,'utf8'),original)
  }
 }finally{await rm(root,{recursive:true,force:true})}
})
