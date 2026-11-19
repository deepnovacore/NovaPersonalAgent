import assert from 'node:assert/strict'
import {test,type TestContext} from 'node:test'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerStore} from '../src/memory-ledger/store.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MarkdownRepository} from '../src/memory-substrate/markdown-repository.js'
import {memoryDocuments} from '../src/memory-substrate/memory-documents.js'
import {contentHash,isLedgerOnlyOperation,type EntryRevision} from '../src/memory-substrate/store.js'
import type {ExplicitMemoryReceipt} from '../src/memory/explicit-memory.js'

const prefix='personal:test:',consumer='chat',now='2026-11-02T10:00:00.000Z'
const grant={revision:1,scope_revision:0,extraction_provider:'fixture',embedding_provider:null,conversation_providers:[consumer]}
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'nova-deferred-files-')),path=join(root,'ledger.sqlite'),repository=path+'.memory'
 let db:DatabaseSync
 const create=()=>new MemoryLedgerStore(path,path=>db=new DatabaseSync(path))
 const store=create();store.open();store.memory('enable_files',{})
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 const pending=()=>db.prepare('SELECT payload_json FROM memory_file_outbox WHERE slot=1').get()
 return {root,path,repository,store,create,pending,db:()=>db}
}
const git=(root:string,...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim()
function write(store:MemoryLedgerStore,index:number,defer=true){
 const text='Synthetic fact '+index,turn={sourceId:'turn-'+index,text,occurredAt:now},id=prefix+'e:'+index
 store.memory('explicit_begin',{prefix,turn})
 return store.memory('explicit_write',{prefix,turn,requestId:'write',consumer,defer_files:defer,arguments:{action:'set',kind:'fact',text,quote:text},grant,
  evidence:{id,source_id:prefix+'explicit:'+index,source_kind:'user_correction',locator:id,observed_at:now,recorded_at:now,raw_text:text,hash:contentHash(id),trust:'trusted_user'},automaticHash:contentHash(text)}) as ExplicitMemoryReceipt
}
function assertMirror(f:ReturnType<typeof fixture>){
 const ledger=f.db().prepare('SELECT payload_json FROM memory_revisions ORDER BY entry_id,revision').all().map(row=>JSON.parse(String(row.payload_json)) as EntryRevision)
 assert.deepEqual(new MarkdownRepository(f.repository).read().revisions,ledger)
 for(const [path,text] of memoryDocuments(ledger)){
  assert.equal(readFileSync(join(f.repository,path),'utf8'),text)
  assert.equal(execFileSync('git',['-C',f.repository,'show','HEAD:'+path],{encoding:'utf8'}),text)
 }
 assert.equal(f.pending(),undefined)
}

test('deferred explicit_write commits receipt and outbox without publishing; flush_files publishes once',t=>{
 const f=fixture(t),head=git(f.repository,'rev-parse','HEAD'),before=readFileSync(join(f.repository,'MEMORY.md'),'utf8')
 const receipt=write(f.store,1)
 assert.equal(receipt.state,'committed');assert.ok(f.pending())
 assert.equal(f.db().prepare('SELECT COUNT(*) n FROM memory_explicit_receipts').get()?.n,1)
 assert.equal(git(f.repository,'rev-parse','HEAD'),head)
 assert.equal(readFileSync(join(f.repository,'MEMORY.md'),'utf8'),before)
 assert.equal(isLedgerOnlyOperation('flush_files',{}),true)
 assert.deepEqual(f.store.memory('flush_files',{}),{flushed:true});assertMirror(f)
 assert.notEqual(git(f.repository,'rev-parse','HEAD'),head)
 assert.deepEqual(f.store.memory('flush_files',{}),{flushed:false})
})

test('flush_files is a no-op without file authority and rejects unexpected input',t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-no-files-')),store=new MemoryLedgerStore(join(root,'ledger.sqlite'),path=>new DatabaseSync(path))
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})});store.open()
 assert.deepEqual(store.memory('flush_files',{}),{flushed:false})
 assert.throws(()=>store.memory('flush_files',{unexpected:true}))
})

test('crash after deferred COMMIT recovers the complete mirror and git on open',t=>{
 const f=fixture(t),head=git(f.repository,'rev-parse','HEAD');write(f.store,1);assert.ok(f.pending())
 // Store.close only closes SQLite: simulate losing the resource/timer without its final drain.
 f.store.close();const reopened=f.create();t.after(()=>reopened.close());reopened.open()
 assertMirror(f);assert.notEqual(git(f.repository,'rev-parse','HEAD'),head)
})

test('consecutive deferred writes retain correct state (the second write drains the first)',t=>{
 const f=fixture(t),count=Number(git(f.repository,'rev-list','--count','HEAD'))
 write(f.store,1);const first=JSON.parse(String(f.pending()!.payload_json)) as {operation_id:string}
 write(f.store,2);assert.ok(f.pending());assert.notEqual((JSON.parse(String(f.pending()!.payload_json)) as {operation_id:string}).operation_id,first.operation_id)
 assert.equal(Number(git(f.repository,'rev-list','--count','HEAD')),count+1)
 f.store.memory('flush_files',{});assertMirror(f)
 assert.equal(f.db().prepare('SELECT COUNT(DISTINCT entry_id) n FROM memory_revisions').get()?.n,2)
})

for(const operation of ['list','conversation_snapshot','history'] as const)test(`next ordinary ${operation} drains the pending mirror before reading`,t=>{
 const f=fixture(t),receipt=write(f.store,1);assert.ok(f.pending())
 const input=operation==='conversation_snapshot'?{entry_prefix:prefix,consumer}:operation==='history'?{entry_id:receipt.id}:{}
 f.store.memory(operation,input);assertMirror(f)
})

test('pending begin/lookup/post-write refresh read committed ledger, but default list still drains',t=>{
 const f=fixture(t),receipt=write(f.store,1),head=git(f.repository,'rev-parse','HEAD')
 f.store.memory('explicit_begin',{prefix,turn:{sourceId:'next',text:'next',occurredAt:now}})
 const page=f.store.memory('explicit_lookup',{prefix,consumer,query:{}}) as {entries:{id:string}[]}
 assert.equal(page.entries[0]?.id,receipt.id)
 assert.equal((f.store.memory('list',{skip_file_reconcile:true}) as EntryRevision[]).length,1)
 assert.ok(f.pending());assert.equal(git(f.repository,'rev-parse','HEAD'),head)
 f.store.memory('list',{});assertMirror(f)
})

test('purge after a deferred write drains first and does not report an outbox conflict',t=>{
 const f=fixture(t),receipt=write(f.store,1)
 const result=f.store.memory('purge',{request_id:'purge',entry_prefix:prefix,selection:{kind:'entry',id:receipt.id,expected_revision:receipt.version}}) as {status:string}
 assert.equal(result.status,'complete');assert.equal(f.pending(),undefined)
 assert.deepEqual(new MarkdownRepository(f.repository).read().revisions,[])
})

test('hand edit during pending flush conflicts before publication and preserves bytes; restoring permits retry',t=>{
 const f=fixture(t);write(f.store,1,false)
 const file=join(f.repository,'MEMORY.md'),original=readFileSync(file,'utf8')
 // Edit an existing editable body rather than the generated directory.
 const row=new MarkdownRepository(f.repository).read().revisions[0]!
 const [relative]=[...memoryDocuments([row])].find(([,text])=>text.includes('<!-- editable-current -->'))!
 const editable=join(f.repository,relative),before=readFileSync(editable,'utf8')
 write(f.store,2);const head=git(f.repository,'rev-parse','HEAD'),edited=before.replace('Synthetic fact 1','User hand edit')
 writeFileSync(editable,edited)
 assert.throws(()=>f.store.memory('flush_files',{}),{code:'STORE_MEMORY_CONFLICT'})
 assert.throws(()=>f.store.memory('list',{}),{code:'STORE_MEMORY_CONFLICT'})
 assert.equal(readFileSync(editable,'utf8'),edited);assert.equal(readFileSync(file,'utf8'),original)
 assert.equal(git(f.repository,'rev-parse','HEAD'),head);assert.ok(f.pending())
 writeFileSync(editable,before);f.store.memory('flush_files',{});assertMirror(f)
})

for(const operation of ['list','explicit_begin','explicit_lookup'] as const)test(`without an outbox ${operation} still admits ordinary hand edits`,t=>{
 const f=fixture(t);write(f.store,1,false)
 const rows=new MarkdownRepository(f.repository).read().revisions
 const [relative]=[...memoryDocuments(rows)].find(([,text])=>text.includes('<!-- editable-current -->'))!
 const file=join(f.repository,relative);writeFileSync(file,readFileSync(file,'utf8').replace('Synthetic fact 1','User approved edit'))
 const input=operation==='list'?{skip_file_reconcile:true}:operation==='explicit_begin'?{prefix,turn:{sourceId:'next',text:'next',occurredAt:now}}:{prefix,consumer,query:{}}
 f.store.memory(operation,input)
 const result=f.store.memory('list',{}) as EntryRevision[]
 assert.equal(result[0]?.content.text,'User approved edit');assertMirror(f)
})

async function resourceFixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'nova-resource-deferred-')),path=join(root,'ledger.sqlite'),client=new MemoryLedgerClient(path)
 const memory=new SubstrateMemoryResource({client,userId:'test',model:'fixture',gateway:{async *stream(){/* never called */},complete(){throw Error('unexpected model')}},inputConsent:true,conversationProviders:[consumer]})
 await memory.open({deferBackground:true})
 const db=new DatabaseSync(path,{readOnly:true}),pending=()=>db.prepare('SELECT 1 FROM memory_file_outbox WHERE slot=1').get()!==undefined
 t.after(async()=>{t.mock.timers.reset();await memory.close();db.close();rmSync(root,{recursive:true,force:true})})
 const write=async(index:number)=>{const text='Resource fact '+index,turn=await memory.beginExplicitTurn({sourceId:'turn-'+index,text,occurredAt:now});return memory.writeExplicit(turn,'write',{action:'set',kind:'fact',text,quote:text},consumer)}
 return {memory,client,path,pending,write}
}
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))

test('writeExplicit defers through refresh and lookup; idle timer resets after the last write and uses background priority',async t=>{
 const f=await resourceFixture(t),head=git(f.path+'.memory','rev-parse','HEAD'),original=f.client.memory.bind(f.client)
 const flushes:{priority:string|undefined;done:Promise<unknown>}[]=[]
 t.mock.method(f.client,'memory',((op,input,options)=>{const done=original(op,input,options);if(op==='flush_files')flushes.push({priority:options?.priority,done});return done}) as typeof original)
 t.mock.timers.enable({apis:['setTimeout']})
 assert.equal((await f.write(1)).state,'committed');assert.ok(f.pending())
 assert.equal((await f.memory.lookupExplicit({},consumer)).entries.length,1)
 assert.equal(git(f.path+'.memory','rev-parse','HEAD'),head)
 t.mock.timers.tick(1000);assert.equal(flushes.length,0)
 await f.write(2);assert.ok(f.pending())
 t.mock.timers.tick(1499);assert.equal(flushes.length,0)
 t.mock.timers.tick(1);await settle();assert.equal(flushes.length,1);assert.equal(flushes[0]?.priority,'background')
 await flushes[0].done;assert.equal(f.pending(),false)
 assert.equal(new MarkdownRepository(f.path+'.memory').read().revisions.length,2)
})

test('close cancels idle timer and drains at interactive priority before client close',async t=>{
 const f=await resourceFixture(t),original=f.client.memory.bind(f.client),operations:string[]=[]
 t.mock.method(f.client,'memory',((op,input,options)=>{if(op==='flush_files')operations.push('flush:'+options?.priority);return original(op,input,options)}) as typeof original)
 const close=f.client.close.bind(f.client);t.mock.method(f.client,'close',()=>{operations.push('close');return close()})
 t.mock.timers.enable({apis:['setTimeout']});await f.write(1);assert.ok(f.pending())
 await f.memory.close();assert.equal(f.pending(),false);assert.deepEqual(operations,['flush:interactive','close'])
 t.mock.timers.tick(2000);await settle();assert.deepEqual(operations,['flush:interactive','close'])
})

test('Git flush failure does not fail write receipt or leak rejection; close retries durable outbox',async t=>{
 const f=await resourceFixture(t),lock=join(f.path+'.memory','.git','HEAD.lock'),original=f.client.memory.bind(f.client)
 let background:Promise<unknown>|undefined
 t.mock.method(f.client,'memory',((op,input,options)=>{const result=original(op,input,options);if(op==='flush_files'&&options?.priority==='background')background=result;return result}) as typeof original)
 t.mock.timers.enable({apis:['setTimeout']})
 writeFileSync(lock,'external git lock')
 const receipt=await f.write(1);assert.equal(receipt.state,'committed');assert.ok(f.pending())
 t.mock.timers.tick(1500);await settle();assert.ok(background);await assert.rejects(background)
 assert.ok(f.pending());assert.equal((await f.memory.lookupExplicit({},consumer)).entries[0]?.id,receipt.id)
 rmSync(lock);await f.memory.close();assert.equal(f.pending(),false)
 assert.equal(new MarkdownRepository(f.path+'.memory').read().revisions[0]?.entry_id,receipt.id)
})
