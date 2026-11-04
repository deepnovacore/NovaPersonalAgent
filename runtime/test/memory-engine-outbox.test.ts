import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'

test('engine outbox is atomic, content-free, scoped, leased and stale-ack fenced',()=>{
  const db=new DatabaseSync(':memory:');initializeMemory(db)
  const scope='personal:owner:',engine='fixture'
  const run=(action:string,extra:Record<string,unknown>={})=>memoryOperation(db,'engine_outbox',{action,scope,engine,...extra})
  try{
    run('register',{descriptor:{engine:'mem0',path:'/synthetic/engine',userId:'owner'}})
    const before=db.prepare('SELECT generation FROM memory_engine_outbox').get()!.generation
    db.exec('BEGIN IMMEDIATE')
    db.prepare('INSERT INTO memory_deleted_sources VALUES(?)').run(scope+'private-source')
    assert.ok(Number(db.prepare('SELECT generation FROM memory_engine_outbox').get()!.generation)>Number(before))
    db.exec('ROLLBACK')
    assert.equal(db.prepare('SELECT generation FROM memory_engine_outbox').get()!.generation,before,'rolled-back mutation cannot enqueue')
    const claim=run('claim',{embedding:'embedding',extraction:'extractor'}) as {owner:string;generation:number;snapshot:unknown}
    assert.ok(claim.owner);assert.deepEqual(claim.snapshot,{entries:[],sources:[]})
    assert.equal(run('claim',{embedding:'embedding',extraction:'extractor'}),null,'second scope drainer cannot overtake active lease')
    assert.equal(run('check',{owner:claim.owner,generation:claim.generation}),true)
    memoryOperation(db,'delete_source',{source_id:scope+'private-source'})
    assert.equal(run('check',{owner:claim.owner,generation:claim.generation}),false,'authority mutation invalidates in-flight disclosure')
    run('ack',{owner:claim.owner,generation:claim.generation})
    assert.equal(run('status'),false,'stale acknowledgement cannot mark newer generation complete')
    const next=run('claim',{embedding:'embedding',extraction:'extractor'}) as {owner:string;generation:number}
    run('ack',{owner:next.owner,generation:next.generation})
    assert.equal(run('status'),true)
    const payload=JSON.stringify(db.prepare('SELECT * FROM memory_engine_outbox').all())
    assert.ok(!payload.includes('private-source'),'outbox retains no source payload or forgotten identifiers')
    run('retire')
    assert.equal(run('claim',{embedding:'embedding',extraction:'extractor'}),null,'retired engines may not feed new facts')
    const cleanup=run('claim',{embedding:'embedding',extraction:'extractor',cleanup:true}) as {snapshot:unknown}
    assert.deepEqual(cleanup.snapshot,{entries:[],sources:[]},'retired adapters receive erasure-only jobs')
  }finally{db.close()}
})
