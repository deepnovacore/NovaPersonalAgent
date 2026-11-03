import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'

test('completed engine jobs become dirty at fixed expiry without new ledger traffic',()=>{
  const db=new DatabaseSync(':memory:');initializeMemory(db)
  const ticket={scope:'personal:owner:',engine:'fixture'}
  const run=(action:string,extra:Record<string,unknown>={})=>memoryOperation(db,'engine_outbox',{action,...ticket,...extra})
  try{
    run('register')
    const first=run('claim',{embedding:'embedding',extraction:'extraction'}) as {owner:string;generation:number}
    run('ack',{owner:first.owner,generation:first.generation});assert.equal(run('status'),true)
    db.prepare('UPDATE memory_engine_outbox SET next_expiry=?').run(Date.now()-1)
    assert.equal(run('status'),false,'expiry is not renewed by querying')
    const next=run('claim',{embedding:'embedding',extraction:'extraction'}) as {owner:string;generation:number}
    assert.ok(next.generation>first.generation)
    assert.equal(run('check',{owner:first.owner,generation:first.generation}),false,'expired/stale owner cannot disclose again')
    run('ack',{owner:next.owner,generation:next.generation});assert.equal(run('status'),true)
  }finally{db.close()}
})

