import * as module from '../src/connectors/macos/mail.js'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
test('local mail identity separates accounts and read flags do not supersede content',()=>{
 const mail={account:'account-a',mailbox:'Inbox',id:'12',messageId:'same@example.test',subject:'Review',sender:'a@example.test',recipients:['b@example.test'],received:'2026-09-20T00:00:00.000Z',sent:'2026-09-19T23:00:00.000Z',content:'Please review',read:false,flagged:false}
 const a=module.normalizeMacMailMessage(mail),read=module.normalizeMacMailMessage({...mail,read:true})
 assert.equal(a.key,read.key);assert.equal(a.semanticHash,read.semanticHash);assert.equal(read.metadata.read,true)
 assert.notEqual(a.key,module.normalizeMacMailMessage({...mail,account:'account-b'}).key)
 assert.notEqual(a.semanticHash,module.normalizeMacMailMessage({...mail,content:'Changed'}).semanticHash)
 assert.equal(a.retentionUntil,'2027-03-19T00:00:00.000Z')
 assert.equal(module.macMailScopeSchema.safeParse({kind:'macos_mail',mailboxes:['box'],pastDays:181}).success,false)
 const client=new module.MacMailClient('/missing-fixture')
 assert.throws(()=>client.request({command:'send'}))
})

test('a mail body that could not be read is flagged instead of carrying a placeholder sentence',()=>{
 const mail={account:'account-a',mailbox:'Inbox',id:'12',messageId:'same@example.test',subject:'Review',sender:'a@example.test',recipients:['b@example.test'],received:'2026-09-20T00:00:00.000Z',sent:'2026-09-19T23:00:00.000Z',content:'',read:false,flagged:false}
 const stored=module.normalizeMacMailMessage({...mail,content:'Please review the plan'}),unavailable=module.normalizeMacMailMessage({...mail,body_unavailable:true})
 assert.equal(unavailable.key,stored.key,'the message identity does not depend on the body')
 assert.equal(unavailable.metadata.body_unavailable,true)
 assert(!unavailable.text.includes('[正文'),'an unread body is never presented as quoted text')
 assert.equal(unavailable.text,[mail.subject,mail.sender,mail.recipients.join(', '),mail.received].join('\n'))
 assert.notEqual(unavailable.semanticHash,stored.semanticHash,'a later real body supersedes the unread one')
 assert.equal(unavailable.semanticHash,module.normalizeMacMailMessage({...mail,body_unavailable:true}).semanticHash,'repeating an unread body changes nothing')
 assert.equal(module.normalizeMacMailMessage({...mail,content:'',body_unavailable:false}).metadata.body_unavailable,undefined)
})

test('local mail incomplete scans retain current evidence and persist continuation',async()=>{
 const {MacMailClient}=await import('../src/connectors/macos/mail.js')
 const {ComposioConnector}=await import('../src/connectors/composio/index.js')
 const {SubstrateMemoryResource}=await import('../src/memory-substrate/resource.js')
 const {MemoryLedgerClient}=await import('../src/memory-ledger/store-client.js')
 const root=await mkdtemp(join(tmpdir(),'nova-local-mail-'));let incomplete=false,capped=false
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',gateway:{async *stream(){await Promise.resolve();throw Error('unexpected model call')},complete(){throw Error('unexpected model call')}}})
 const mail=new MacMailClient('/fixture')
 mail.request=(input:unknown)=>{
  const request=input as {command:string}
  if(request.command==='status')return Promise.resolve({status:'granted'})
  return Promise.resolve({status:'granted',messages:incomplete||capped?[]:[{account:'a',mailbox:'box',id:'1',messageId:'test@example.test',subject:'Task',sender:'sender',recipients:[],received:new Date(Date.now()-60000).toISOString(),sent:new Date(Date.now()-60000).toISOString(),content:'Read only',read:false,flagged:false}],complete:!incomplete,capped,cursor:incomplete?{box:0,offset:100,fingerprints:['200:1:200']}:null})
 }
 const manager=new ComposioConnector({memory:()=>memory,client:null,mail,automatic:false,onChange:()=>{ /* inspected below */ }})
 try{
  await memory.open();await manager.open();const {id}=await manager.command('connector.mail_connect') as {id:string}
  await assert.rejects(manager.command('connector.configure',{id,scope:{kind:'gmail',labels:['INBOX'],pastDays:30},processingConsent:false}),/scope_denied/)
  await manager.command('connector.configure',{id,scope:{kind:'macos_mail',mailboxes:['box'],pastDays:30},processingConsent:false})
  await manager.syncOnce(id);await manager.syncOnce(id)
  incomplete=true;await manager.syncOnce(id)
  const row=await memory.options.client.memory('source_connection',{action:'get',id}) as {continuation:{providerCursor:{offset:number}}}
  assert.equal(row.continuation.providerCursor.offset,100)
  const objects=await memory.options.client.memory('source_pending',{id}) as {objects:{status:string}[]}
  assert.equal(objects.objects.length,1);assert.equal(objects.objects[0]?.status,'current')
  incomplete=false;capped=true;await manager.syncOnce(id)
  await Promise.all([manager.open(),manager.command('connector.status')])
  assert.equal(manager.snapshot().connections.length,1,'overlapping refreshes must not duplicate connection rows')
  assert.equal(manager.snapshot().connections[0]?.scan_limited,true)
  const retained=await memory.options.client.memory('source_pending',{id}) as typeof objects
  assert.equal(retained.objects[0]?.status,'current')
  await manager.command('connector.pause',{id});assert.equal(manager.snapshot().connections[0]?.state,'paused')
  await manager.command('connector.disconnect',{id});assert.equal(manager.snapshot().connections[0]?.state,'disconnected')
 }finally{await manager.close();await memory.close();await rm(root,{recursive:true,force:true})}
})

test('a body that could not be read leaves the stored message and its text untouched',async()=>{
 const {MacMailClient}=await import('../src/connectors/macos/mail.js')
 const {ComposioConnector}=await import('../src/connectors/composio/index.js')
 const {SubstrateMemoryResource}=await import('../src/memory-substrate/resource.js')
 const {MemoryLedgerClient}=await import('../src/memory-ledger/store-client.js')
 const root=await mkdtemp(join(tmpdir(),'nova-local-mail-unread-'));let unread=false
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',gateway:{async *stream(){await Promise.resolve();throw Error('unexpected model call')},complete(){throw Error('unexpected model call')}}})
 const mail=new MacMailClient('/fixture')
 mail.request=(input:unknown)=>{
  const request=input as {command:string}
  if(request.command==='status')return Promise.resolve({status:'granted'})
  return Promise.resolve({status:'granted',messages:[{account:'a',mailbox:'box',id:'1',messageId:'test@example.test',subject:'Task',sender:'sender',recipients:[],received:new Date(Date.now()-60000).toISOString(),sent:new Date(Date.now()-60000).toISOString(),content:unread?'':'Read only',...(unread?{body_unavailable:true}:{}),read:false,flagged:false}],complete:true,capped:false,cursor:null})
 }
 const manager=new ComposioConnector({memory:()=>memory,client:null,mail,automatic:false,onChange:()=>{ /* inspected below */ }})
 try{
  await memory.open();await manager.open();const {id}=await manager.command('connector.mail_connect') as {id:string}
  const objects=async()=>(await memory.options.client.memory('source_pending',{id})) as {objects:{semantic_hash:string;current_evidence_ids:string[];metadata:{body_unavailable?:boolean}}[]}
  await manager.command('connector.configure',{id,scope:{kind:'macos_mail',mailboxes:['box'],pastDays:30},processingConsent:false})
  await manager.syncOnce(id)
  const read=await objects();assert.equal(read.objects.length,1);assert.equal(read.objects[0]?.metadata.body_unavailable,undefined)
  unread=true;await manager.syncOnce(id)
  const after=await objects()
  assert.equal(after.objects[0]?.semantic_hash,read.objects[0]?.semantic_hash,'an unread body must not retire the body read earlier')
  assert.deepEqual(after.objects[0]?.current_evidence_ids,read.objects[0]?.current_evidence_ids)
 }finally{await manager.close();await memory.close();await rm(root,{recursive:true,force:true})}
})

test('an unread body protects every stored message, not only the one that sorts first',async()=>{
 const {MacMailClient}=await import('../src/connectors/macos/mail.js')
 const {ComposioConnector}=await import('../src/connectors/composio/index.js')
 const {SubstrateMemoryResource}=await import('../src/memory-substrate/resource.js')
 const {MemoryLedgerClient}=await import('../src/memory-ledger/store-client.js')
 const root=await mkdtemp(join(tmpdir(),'nova-local-mail-two-unread-'));let unread=false
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',gateway:{async *stream(){await Promise.resolve();throw Error('unexpected model call')},complete(){throw Error('unexpected model call')}}})
 const mail=new MacMailClient('/fixture')
 // Two messages with a real body first: only the lowest object key could be found by a LIMIT-then-filter lookup.
 const messages=()=>['one','two'].map((id,index)=>{const received=new Date(Date.now()-60_000-index*1000).toISOString();return {account:'a',mailbox:'box',id,messageId:id+'@example.test',subject:'Task '+id,sender:'sender',recipients:[],received,sent:received,content:'Body '+id,...(unread?{body_unavailable:true}:{}),read:false,flagged:false}})
 mail.request=(input:unknown)=>{
  const request=input as {command:string}
  if(request.command==='status')return Promise.resolve({status:'granted'})
  return Promise.resolve({status:'granted',messages:messages(),complete:true,capped:false,cursor:null})
 }
 const manager=new ComposioConnector({memory:()=>memory,client:null,mail,automatic:false,onChange:()=>{ /* inspected below */ }})
 try{
  await memory.open();await manager.open();const {id}=await manager.command('connector.mail_connect') as {id:string}
  const objects=async()=>(await memory.options.client.memory('source_pending',{id})) as {objects:{semantic_hash:string;current_evidence_ids:string[];metadata:{remote_id:string;body_unavailable?:boolean}}[]}
  const signature=(rows:{semantic_hash:string;current_evidence_ids:string[];metadata:{remote_id:string}}[])=>rows.map(row=>[row.metadata.remote_id,row.semantic_hash,row.current_evidence_ids]).sort()
  await manager.command('connector.configure',{id,scope:{kind:'macos_mail',mailboxes:['box'],pastDays:30},processingConsent:false})
  await manager.syncOnce(id)
  const read=await objects();assert.equal(read.objects.length,2);for(const row of read.objects)assert.equal(row.metadata.body_unavailable,undefined)
  unread=true;await manager.syncOnce(id)
  const after=await objects()
  assert.deepEqual(signature(after.objects),signature(read.objects),'an unread body must not overwrite any stored message')
 }finally{await manager.close();await memory.close();await rm(root,{recursive:true,force:true})}
})
