import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation,type MemoryOperation} from '../src/memory-substrate/store.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'

test('Life projects shared provenance in one bounded permission-checked evidence read',async()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const calls:{operation:MemoryOperation;input:unknown}[]=[]
 const client={open:()=>Promise.resolve(),close:()=>Promise.resolve(),memory:(operation:MemoryOperation,input:unknown)=>{calls.push({operation,input});return Promise.resolve(operation==='enable_files'?{enabled:true}:memoryOperation(db,operation,input))}} as unknown as MemoryLedgerClient
 const memory=new SubstrateMemoryResource({client,userId:'batch',model:'fixture',personalMemoryEnabled:false,gateway:{async *stream(){/* these reads never call a model */},complete:()=>Promise.reject(Error('no model calls'))}})
 try{
  await memory.open({deferBackground:true})
  const namespace=memory.prefix+'life:',at=new Date().toISOString(),source=memory.prefix+'source',ref=memory.prefix+'e:shared'
  memoryOperation(db,'source_grant',{source_id:source,expected_revision:0,grant:memory.processingGrant(true)})
  memoryOperation(db,'append_evidence',{id:ref,source_id:source,source_kind:'im',locator:'message',observed_at:at,recorded_at:at,raw_text:'shared source',hash:'source-hash',trust:'untrusted_external'})
  const state={todos:['a','b'].map(id=>({id,title:id,note:'',version:1,created_at:at,updated_at:at,status:'open',due:null,goal_id:null,idea_id:null,provenance_refs:[ref]})),goals:[],ideas:[],profile:{about:'',version:0},receipts:{}}
  memoryOperation(db,'life_load',{namespace,legacy:state})
  calls.length=0
  const snapshot=await memory.lifeBackend().peek!()
  assert.deepEqual(snapshot!.state.todos.map(row=>row.sources?.map(s=>s.summary)),[['shared source'],['shared source']])
  assert.equal(calls.filter(c=>c.operation==='processing_evidence').length,1,'one storage permission read for all Life rows')
  assert.deepEqual((calls.find(c=>c.operation==='processing_evidence')!.input as {ids:string[]}).ids,[ref])
  calls.length=0
  await memory.setProcessingConsent(source,memory.processingGrant(true,2))
  assert.equal(calls.filter(c=>c.operation==='processing_stamp').length,1,'refresh checks all row grants in one worker request')
  assert.equal((calls.find(c=>c.operation==='processing_stamp')!.input as {groups:string[][]}).groups.length,2)
  const page=await memory.list();calls.length=0
  const reversed=[...page.entries].reverse()
  assert.deepEqual(await memory.getMany([...reversed.map(row=>row.id),'missing']),[...reversed,null])
  assert.equal(calls.filter(c=>c.operation==='evidence').length,1,'bulk projections fetch all provenance in one request')
  assert.equal(calls.filter(c=>c.operation==='processing_evidence').length,1,'bulk projections check all source labels in one request')
  assert.deepEqual(await memory.canProcessEvidenceMany([ref],'extraction'),[ref])
  memoryOperation(db,'source_grant',{source_id:source,expected_revision:2,grant:memory.processingGrant(false,3)})
  assert.deepEqual(await memory.canProcessEvidenceMany([ref],'extraction'),[])
  assert.deepEqual((await memory.lifeBackend().peek!())!.state.todos.map(row=>row.sources),[[],[]],'revoked sources are never reused from an earlier projection')
 }finally{await memory.close();db.close()}
})

test('batched evidence omits unauthorized and missing IDs and bounds requests',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 try{
  const at=new Date().toISOString()
  for(const id of ['allowed','denied']){
   memoryOperation(db,'append_evidence',{id,source_id:id,source_kind:'im',locator:id,observed_at:at,recorded_at:at,raw_text:id,hash:id,trust:'untrusted_external'})
   memoryOperation(db,'source_grant',{source_id:id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:id==='allowed'?'fixture':'other',embedding_provider:null,conversation_providers:[]}})
  }
  assert.deepEqual((memoryOperation(db,'processing_evidence',{ids:['allowed','denied','missing','allowed'],purpose:'extraction',provider:'fixture'}) as {id:string}[]).map(e=>e.id),['allowed'])
  assert.throws(()=>memoryOperation(db,'processing_evidence',{ids:Array(257).fill('allowed'),purpose:'extraction',provider:'fixture'}))
  const access={purpose:'extraction',provider:'fixture'}
  const groups=[['allowed'],['allowed','denied'],['missing']]
  assert.deepEqual(memoryOperation(db,'processing_stamp',{groups,...access}),groups.map(ids=>memoryOperation(db,'processing_stamp',{ids,...access})))
  assert.throws(()=>memoryOperation(db,'processing_stamp',{groups:Array(257).fill(['allowed']),...access}))
 }finally{db.close()}
})
