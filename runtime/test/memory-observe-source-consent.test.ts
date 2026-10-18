import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import type {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {initializeMemory,memoryOperation,type MemoryOperation} from '../src/memory-substrate/store.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

async function fixture(){
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 let calls=0
 const gateway:ModelGateway={async *stream(){/* extraction uses complete */},complete(){calls++;return Promise.resolve({text:'{"entries":[]}'})}}
 // Exercise the real consent/extraction ledger with an in-process transport.
 const client={open:()=>Promise.resolve(),memory:(operation:MemoryOperation,input:unknown)=>Promise.resolve(operation==='enable_files'?null:memoryOperation(db,operation,input))} as MemoryLedgerClient
 const memory=new SubstrateMemoryResource({client,userId:'source-boundary',gateway,model:'fixture',conversationProviders:['chat'],closeClient:false})
 await memory.open({deferBackground:true})
 const at=new Date().toISOString(),source='requested',victim='victim'
 const grant=(id:string)=>client.memory('source_grant',{source_id:memory.prefix+id,action:'get'})
 for(const id of [source,victim])await memory.setProcessingConsent(id,memory.processingGrant(false,1))
 const append=async(id:string,sourceId:string,kind:'im'|'mail')=>{
  const evidenceId=memory.prefix+'e:'+id
  await client.memory('append_evidence',{id:evidenceId,source_id:memory.prefix+sourceId,source_kind:kind,locator:id,observed_at:at,recorded_at:at,raw_text:id,hash:id,trust:'untrusted_external'})
  return evidenceId
 }
 const first=await append('first',source,'im'),second=await append('second',source,'im'),foreign=await append('foreign',victim,'im'),wrongKind=await append('wrong-kind',source,'mail')
 return {memory,source,victim,at,first,second,foreign,wrongKind,grant,get calls(){return calls},async close(){await memory.close();db.close()}}
}

for(const invalid of ['foreign','valid-then-foreign','valid-then-wrong-kind','valid-then-missing'] as const)test(`observeSource validates the whole evidence batch before changing any consent (${invalid})`,async()=>{
 const f=await fixture()
 try{
  const before=await Promise.all([f.grant(f.source),f.grant(f.victim)])
  const ids=invalid==='foreign'?[f.foreign]:[f.first,invalid==='valid-then-foreign'?f.foreign:invalid==='valid-then-wrong-kind'?f.wrongKind:f.memory.prefix+'e:missing']
  await assert.rejects(f.memory.observeSource({source_ref:{type:'im',ref:f.source,observed_at:f.at},content:'requested source',evidence_ids:ids,processing_consent:f.memory.processingGrant(true,999)}),invalid==='valid-then-missing'?/memory_evidence_unavailable/:/memory_evidence_source_mismatch/)
  assert.deepEqual(await Promise.all([f.grant(f.source),f.grant(f.victim)]),before,'rejected observations must not grant or revision-lock either source')
  assert.equal(f.calls,0,'no member of an invalid batch may enter a model')
  // An invalid high revision cannot prevent the next ordinary grant or revocation.
  for(const sourceId of [f.source,f.victim]){
   await f.memory.setProcessingConsent(sourceId,f.memory.processingGrant(true,2))
   assert.deepEqual(await f.grant(sourceId),f.memory.processingGrant(true,2))
   await f.memory.setProcessingConsent(sourceId,f.memory.processingGrant(false,3))
   assert.deepEqual(await f.grant(sourceId),f.memory.processingGrant(false,3))
  }
  assert.equal(f.calls,0)
 }finally{await f.close()}
})

test('observeSource still extracts all validated evidence from one source under its explicit consent',async()=>{
 const f=await fixture()
 try{
  await f.memory.observeSource({source_ref:{type:'im',ref:f.source,observed_at:f.at},content:'requested source',evidence_ids:[f.first,f.second],processing_consent:f.memory.processingGrant(true,2)})
  assert.equal(f.calls,2)
  assert.deepEqual(await f.grant(f.source),f.memory.processingGrant(true,2))
  assert.deepEqual(await f.grant(f.victim),f.memory.processingGrant(false,1))
 }finally{await f.close()}
})
