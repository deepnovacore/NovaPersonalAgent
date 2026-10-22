import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {LifeService} from '../src/personal-agent/life.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

test('a direct @me message never becomes a Todo and no model call is made for it, but stays timeline and daily-brief input',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-auto-im-'))
 const systems:string[]=[]
 const gateway={complete:(request:{system:string;prompt:string})=>{systems.push(request.system);return Promise.resolve({text:JSON.stringify({entries:[]}),model:'fixture',usage:{input_tokens:0,output_tokens:0}})}} as unknown as ModelGateway
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(dir,'ledger.sqlite')),userId:'fixture',gateway,model:'fixture',inputConsent:true,consolidation:{enabled:false}})
 const life=new LifeService(join(dir,'life.json'),()=>{/* test observer */},()=>memory.lifeBackend())
 try{
  await memory.open();await life.open()
  const im={sender_id:'ou_sender',account_id:'account',provider:'feishu',source_url:'https://applink.feishu.cn/client/chat/open?messageId=synthetic',message_id:'om_request',chat_id:'oc_test',recipient_id:'ou_me',mention:'direct' as const,auto_capture:true}
  const input={sourceId:'feishu:account:0:oc_test',locator:'feishu://message/om_request',text:'@我 请提交材料',observedAt:new Date().toISOString(),kind:'im' as const,im,processingConsent:memory.processingGrant(true)}
  await memory.feishuProcessingConsent('apply',[input.sourceId],input.processingConsent)
  await memory.feishuProcessingConsent('activate',[input.sourceId],input.processingConsent)
  await memory.ingestEvidence(input);await memory.flush();await life.refresh()
  assert.equal(life.snapshot().todos.length,0,'a mention is no longer turned into a Todo')
  assert.equal(systems.some(system=>system.includes('IM_ACTION')||system.includes('IM_MATCH')),false)
  assert.equal((await memory.list()).entries.some(entry=>entry.kind==='todo'),false)
  const timeline=await memory.timelineEvidence();const row=timeline.find(item=>item.text==='@我 请提交材料')
  assert.ok(row,'the mention is a timeline brief input');assert.equal(row.kind,'im')
  const daily=await memory.dailyBriefEvidence({localDate:new Date().toLocaleDateString('en-CA'),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})
  assert.ok(daily.some(item=>item.text==='@我 请提交材料'),'and a daily brief input')
  await memory.ingestEvidence({...input,locator:'feishu://message/om_other',im:{...im,message_id:'om_other',mention:'none'}});await memory.flush();await life.refresh();assert.equal(life.snapshot().todos.length,0)
 }finally{await life.close();await memory.close();await rm(dir,{recursive:true,force:true})}
})

test('daily calendar selection uses event dates and exclusive ends in the user timezone',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-daily-calendar-'))
 const client=new MemoryLedgerClient(join(dir,'ledger.sqlite'))
 const gateway={complete:()=>Promise.resolve({text:'{"entries":[]}'})} as unknown as ModelGateway
 const memory=new SubstrateMemoryResource({client,userId:'calendar-fixture',gateway,model:'fixture',consolidation:{enabled:false}})
 try{
  await memory.open()
  const cases=[
   {id:'old-update-today-event',start:{dateTime:'2026-10-04T10:00:00+08:00'},end:{dateTime:'2026-10-04T11:00:00+08:00'}},
   {id:'all-day-today',start:{date:'2026-10-04'},end:{date:'2026-10-05'}},
   {id:'all-day-ended',start:{date:'2026-10-03'},end:{date:'2026-10-04'}},
   {id:'midnight-ended',start:'2026-10-03T10:00:00+08:00',end:'2026-10-03T16:00:00Z'},
   {id:'spans-today',start:'2026-10-03T10:00:00+08:00',end:'2026-10-04T01:00:00+08:00'},
   {id:'tomorrow',start:{date:'2026-10-05'},end:{date:'2026-10-06'}},
  ]
  for(const value of cases){
   const source=memory.prefix+value.id
   await client.memory('append_evidence',{id:memory.prefix+'e:'+value.id,source_id:source,source_kind:'calendar',locator:value.id,observed_at:'2026-09-01T00:00:00Z',recorded_at:'2026-09-01T00:00:00Z',raw_text:value.id,hash:value.id,trust:'untrusted_external',extracted:{calendar:{start:value.start,end:value.end}}})
   await client.memory('source_grant',{source_id:source,expected_revision:0,grant:memory.processingGrant(true)})
  }
  const selected=await memory.dailyBriefEvidence({localDate:'2026-10-04',timezone:'Asia/Shanghai'})
  assert.deepEqual(new Set(selected.map(e=>e.locator)),new Set(['old-update-today-event','all-day-today','spans-today']))
 }finally{await memory.close();await rm(dir,{recursive:true,force:true})}
})
