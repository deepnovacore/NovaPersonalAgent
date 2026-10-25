import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {createConversation,conversationUnreadCount} from '../src/personal-agent/conversations.js'
for(const count of [0,2,512])test(`stored proactive history upgrades without loss (${count} messages)`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-proactive-upgrade-')),path=join(root,'personal.json'),state=initialState()
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
