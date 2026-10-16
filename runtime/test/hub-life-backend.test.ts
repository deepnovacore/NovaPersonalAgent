import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation,type MemoryOperation,type EntryRevision} from '../src/memory-substrate/store.js'
import {LifeService,emptyLifeState,type LifeSnapshot,type LifeState} from '../src/personal-agent/life.js'

import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {AddressInfo} from 'node:net'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'
import {LifeSyncClient} from '../src/hub/life-sync.js'
import {saveHubCredentials} from '../src/hub/life-sync-transport.js'

const namespace='personal:hub-test:life:'
const todo={kind:'todo',id:'imported-id',title:'Remote',note:'',status:'open',importance:'normal',due:null,goal_id:null}
function setup(legacy:LifeState=emptyLifeState()){const db=new DatabaseSync(':memory:');initializeMemory(db);const run=(op:MemoryOperation,input:unknown)=>memoryOperation(db,op,input) as LifeSnapshot;run('life_load',{namespace,legacy});return {db,run}}

test('Hub backend projection preserves arbitrary IDs, uses CAS and retries idempotently',()=>{
 const {db,run}=setup()
 try{
  const request={namespace,projection:{entities:[todo]},requestId:'sync-1',expectedRevision:0}
  const first=run('life_sync_projection',request)
  assert.equal(first.state.todos[0]?.id,'imported-id')
  assert.deepEqual(run('life_sync_projection',request),first)
  assert.throws(()=>run('life_sync_projection',{...request,projection:{entities:[{...todo,title:'Wrong'}]}}),/request_id_conflict/)
  assert.throws(()=>run('life_sync_projection',{...request,requestId:'sync-2'}),/version_conflict/)
  const next=run('life_sync_projection',{...request,projection:{entities:[{kind:'profile',id:'profile',about:'About'}]},requestId:'sync-3',expectedRevision:first.revision})
  assert.equal(next.state.todos.length,1)
  assert.equal(next.state.profile.about,'About')
 }finally{db.close()}
})

test('Hub backend projection preserves local metadata and records only explicit tombstones',()=>{
 const legacy=emptyLifeState();legacy.todos.push({id:todo.id,title:'Local',note:'',status:'open',due:null,goal_id:null,idea_id:null,version:4,created_at:'2025-01-01',updated_at:'2025-01-01',auto_recorded:true,source_changed:true})
 const {db,run}=setup(legacy)
 try{
  let current=run('life_sync_projection',{namespace,projection:{entities:[todo]},requestId:'initial',expectedRevision:0})
  current=run('life_mutate',{namespace,input:{op:'update',kind:'todo',id:todo.id,expected_version:current.state.todos[0]!.version,note:'Local'},requestId:'local',expectedRevision:current.revision})
  current=run('life_sync_projection',{namespace,projection:{entities:[{...todo,title:'Updated'}]},requestId:'update',expectedRevision:current.revision})
  assert.equal(current.state.todos[0]?.title,'Updated')
  assert.equal(current.state.todos[0]?.auto_recorded,true)
  assert.equal(current.state.todos[0]?.source_changed,true)
  assert.ok(current.state.todos[0].version>4)
  assert.ok(current.state.receipts.local)
  current=run('life_sync_projection',{namespace,projection:{entities:[],tombstones:[todo.id]},requestId:'delete',expectedRevision:current.revision})
  assert.equal(current.state.todos.length,0)
  const rows=memoryOperation(db,'list',{include_history:true}) as EntryRevision[]
  assert.equal(rows.find(row=>row.content.life_id===todo.id)?.op,'tombstone')
 }finally{db.close()}
})


test('Hub backend projection rolls back evidence, grants and state after failed revision insertion',()=>{
 const {db,run}=setup()
 try{
  const snapshot=()=>['memory_evidence','source_grants','memory_revisions','memory_life_meta'].map(table=>db.prepare('SELECT * FROM '+table).all())
  const before=snapshot()
  const faulty={exec:db.exec.bind(db),close:db.close.bind(db),prepare:(sql:string)=>{if(sql==='INSERT INTO memory_revisions VALUES(?,?,?)')throw Error('synthetic revision failure');return db.prepare(sql)}}
  const request={namespace,projection:{entities:[todo]},requestId:'atomic',expectedRevision:0,processingGrant:{revision:1,scope_revision:0,extraction_provider:'consented-model',embedding_provider:null}}
  assert.throws(()=>memoryOperation(faulty,'life_sync_projection',request),/synthetic revision failure/)
  assert.deepEqual(snapshot(),before)
  assert.equal(run('life_sync_projection',request).state.todos.length,1)
 }finally{db.close()}
})

test('Hub backend projection rejects an out-of-band ledger edit even at the same aggregate revision',()=>{
 const {db,run}=setup()
 try{
  const first=run('life_sync_projection',{namespace,projection:{entities:[todo]},requestId:'first',expectedRevision:0})
  const row=(memoryOperation(db,'list',{}) as EntryRevision[]).find(item=>item.kind==='todo')!
  memoryOperation(db,'merge',{entry_id:row.entry_id,expected_revision:row.revision,kind:row.kind,origin:'stated',written_by:'user_correction',evidence_refs:row.evidence_refs,content:{...row.content,text:'Edited outside Life'},recorded_at:new Date().toISOString()})
  assert.throws(()=>run('life_sync_projection',{namespace,projection:{entities:[todo]},requestId:'stale',expectedRevision:first.revision}),/version_conflict/)
  assert.equal(run('life_load',{namespace}).state.todos[0]?.title,'Edited outside Life')
 }finally{db.close()}
})


test('Substrate Life backend roundtrips local and remote changes through the Hub',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'hub-substrate-roundtrip-'))
 const client=new MemoryLedgerClient(join(dir,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'hub-roundtrip',model:'fixture',inputConsent:true,consolidation:{enabled:false},gateway:{complete:()=>Promise.reject(Error('unexpected model call')),async *stream(){throw Error('unexpected model call')}}})
 const hub=new HubStore(':memory:'),server=createHubServer(hub)
 const life=new LifeService(join(dir,'legacy-life.json'),()=>undefined,resource.lifeBackend())
 const credentialsPath=join(dir,'credentials'),sync=new LifeSyncClient(life,join(dir,'sync-state'),credentialsPath)
 try{
  await resource.open();await life.open()
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const device=hub.enroll('synthetic','desktop')
  await saveHubCredentials(credentialsPath,{url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token:device.token})
  await sync.open()
  const local=await life.mutate({op:'create',kind:'todo',title:'Desktop item'},'desktop-item')
  await sync.sync()
  assert.equal(hub.snapshot(device.token).state.todos.find(row=>row.id===local.id)?.title,'Desktop item')
  hub.mutate(device.token,{op_id:'phone-edit',input:{op:'update',kind:'todo',id:local.id,expected_version:1,title:'Phone edit'}})
  hub.mutate(device.token,{op_id:'phone-import',input:{op:'import',entity:todo}})
  await sync.sync()
  assert.equal(life.snapshot().todos.find(row=>row.id===local.id)?.title,'Phone edit')
  assert.equal(life.snapshot().todos.find(row=>row.id===todo.id)?.title,'Remote')
  const remote=life.snapshot().todos.find(row=>row.id===todo.id)!
  await life.mutate({op:'update',kind:'todo',id:remote.id,expected_version:remote.version,note:'Edited on desktop'},'desktop-edit')
  await sync.sync()
  assert.equal(hub.snapshot(device.token).state.todos.find(row=>row.id===todo.id)?.note,'Edited on desktop')
  const reopened=new LifeService(join(dir,'legacy-life.json'),()=>undefined,resource.lifeBackend())
  try{await reopened.open();assert.deepEqual(reopened.snapshot(),life.snapshot())}finally{await reopened.close()}
  assert.equal(sync.status().conflicts.length,0)
 }finally{
  await sync.close();await life.close();await resource.close()
  if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()))
  hub.close();await rm(dir,{recursive:true,force:true})
 }
})
