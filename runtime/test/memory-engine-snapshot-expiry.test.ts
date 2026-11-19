import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import type {LedgerDatabase} from '../src/memory-ledger/store.js'
import {initializeMemory,memoryOperation,type EntryRevision} from '../src/memory-substrate/store.js'

test('canonical snapshot drops evidence expiring between successful processing stamp and deadline collection',t=>{
  const db=new DatabaseSync(':memory:');initializeMemory(db)
  const scope='personal:boundary:',engine='fixture',id=scope+'e:source',cutoff=Date.now()+1000,now=new Date().toISOString()
  const run=(action:string,extra:Record<string,unknown>={})=>memoryOperation(db,'engine_outbox',{action,scope,engine,...extra})
  try{
    memoryOperation(db,'append_evidence',{id,source_id:scope+'source',source_kind:'conversation',locator:'fixture',raw_text:'Synthetic retained preference',hash:'fixture',observed_at:now,recorded_at:now,retention_until:new Date(cutoff).toISOString(),trust:'trusted_user'})
    memoryOperation(db,'source_grant',{source_id:scope+'source',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:'extraction',embedding_provider:'embedding',conversation_providers:[]}})
    memoryOperation(db,'merge',{entry_id:scope+'fact',kind:'fact',origin:'stated',written_by:'user_correction',evidence_refs:[id],content:{text:'Synthetic retained preference'},recorded_at:now})
    run('register')
    const generation=db.prepare('SELECT generation FROM memory_engine_outbox').get()!.generation
    let clock=cutoff-1,evidenceReads=0
    t.mock.method(Date,'now',()=>clock)
    const raced:LedgerDatabase={
      exec:sql=>db.exec(sql),close:()=>db.close(),
      prepare:sql=>{
        const statement=db.prepare(sql)
        return {all:(...args)=>statement.all(...args),run:(...args)=>statement.run(...args),get:(...args)=>{
          if(sql==='SELECT payload_json FROM memory_evidence WHERE id=?'&&++evidenceReads===2)clock=cutoff
          return statement.get(...args)
        }}
      },
    }
    const job=memoryOperation(raced,'engine_outbox',{action:'claim',scope,engine,embedding:'embedding',extraction:'extraction'}) as {owner:string;generation:number;snapshot:{entries:{entry:EntryRevision}[]}}
    assert.equal(evidenceReads,2,'the second evidence read is reached only after the live processing stamp succeeded')
    assert.equal(job.generation,generation,'no extra claim or generation advance masks the boundary')
    assert.deepEqual(job.snapshot.entries,[],'a null evidence reread cannot retain plaintext with a missing expiry cutoff')
    assert.equal(run('check',{owner:job.owner,generation:job.generation}),true,'empty authorized snapshot contains no expired plaintext to send')
  }finally{t.mock.restoreAll();db.close()}
})
