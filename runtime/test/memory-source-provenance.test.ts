import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import type {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {initializeMemory,memoryOperation,type MemoryOperation} from '../src/memory-substrate/store.js'
import {MemoryEntrySchema} from '../src/memory/entry.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

test('unavailable evidence remains an empty source list across get, list and getMany',async()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const gateway:ModelGateway={async *stream(){/* Provenance reads never stream model output. */},complete(){throw Error('unexpected model call')}}
 const client={open:()=>Promise.resolve(),memory:(operation:MemoryOperation,input:unknown)=>Promise.resolve(operation==='enable_files'?null:memoryOperation(db,operation,input))} as MemoryLedgerClient
 const memory=new SubstrateMemoryResource({client,userId:'provenance',gateway,model:'fixture',closeClient:false})
 try{
  await memory.open({deferBackground:true})
  const id=memory.prefix+'entry',missing=memory.prefix+'e:removed',surviving=memory.prefix+'e:surviving'
  const recorded='2026-09-12T12:00:00.000Z',observed='2026-09-10T10:00:00.000Z'
  const appendMissing=()=>client.memory('append_evidence',{id:missing,source_id:memory.prefix+'removed',source_kind:'conversation',locator:'removed',observed_at:observed,recorded_at:recorded,raw_text:'statement',hash:'removed',trust:'trusted_user'})
  await appendMissing()
  await client.memory('merge',{entry_id:id,kind:'fact',origin:'stated',written_by:'user_correction',evidence_refs:[missing],content:{text:'An independently retained statement'},recorded_at:recorded})
  // Reproduce a legacy revision whose original evidence is no longer available.
  db.prepare('DELETE FROM memory_evidence WHERE id=?').run(missing)
  for(const entry of [await memory.get(id),(await memory.list()).entries[0],(await memory.getMany([id]))[0]]){
   assert.ok(entry)
   assert.deepEqual(entry.source_refs,[],'missing evidence must not fabricate a conversation citation')
   assert.deepEqual(entry.sources,[])
   assert.equal(entry.observed_at,recorded,'an entry without source dates falls back to its own recorded time')
   assert.equal(MemoryEntrySchema.safeParse(entry).success,true)
  }
  await client.memory('append_evidence',{id:surviving,source_id:memory.prefix+'mail',source_kind:'mail',locator:'message',observed_at:observed,recorded_at:recorded,raw_text:'statement',hash:'surviving',trust:'untrusted_external'})
  await appendMissing()
  await client.memory('merge',{entry_id:id,expected_revision:1,kind:'fact',origin:'stated',written_by:'user_correction',evidence_refs:[missing,surviving],content:{text:'An independently retained statement'},recorded_at:recorded})
  db.prepare('DELETE FROM memory_evidence WHERE id=?').run(missing)
  const entry=(await memory.get(id))!
  assert.deepEqual(entry.source_refs,[{type:'mail',ref:'mail',observed_at:observed}])
  assert.equal(entry.observed_at,observed,'a surviving real source retains its observed time')
 }finally{await memory.close();db.close()}
})
