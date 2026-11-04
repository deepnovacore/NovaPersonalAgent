import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerStore} from '../src/memory-ledger/store.js'
import {MemoryLedgerClient,type MemoryLedgerWorker} from '../src/memory-ledger/store-client.js'

test('compact Life authority rejects malformed persisted numeric counters and present missing/null revisions',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-life-revision-validation-')),path=join(root,'ledger.sqlite'),db=new DatabaseSync(path),store=new MemoryLedgerStore(path,()=>db),namespace='personal:owner:life:'
  try{
    store.open()
    assert.deepEqual(store.lifeAuthorizationRevision(namespace),[null,0,0,[]],'null revision is only an absent namespace')
    for(const revision of [-1,0.5,'1',true,null,undefined,Number.MAX_SAFE_INTEGER+1]){
      db.prepare('INSERT OR REPLACE INTO memory_life_meta VALUES(?,?)').run(namespace,JSON.stringify({revision}))
      assert.throws(()=>store.lifeAuthorizationRevision(namespace),{code:'STORE_READ_FAILED'})
    }
    db.prepare('UPDATE memory_life_meta SET payload_json=? WHERE namespace=?').run('{"revision":0}',namespace)
    assert.deepEqual(store.lifeAuthorizationRevision(namespace),[0,0,0,[]])
    db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run('personal:owner:','z-provider',1,'not a projected payload')
    db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run('personal:owner:','a-provider',2,'not a projected payload')
    assert.deepEqual(store.lifeAuthorizationRevision(namespace)[3],[['a-provider',2],['z-provider',1]],'provider metadata is sorted and payloads are not parsed')
    db.exec('DELETE FROM processing_profiles')
    for(const [provider,revision] of [['',0],['x'.repeat(513),0],['provider',-1],['provider',0.5],['provider','invalid'],['provider',Number.MAX_SAFE_INTEGER+1]] as const){
      db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run('personal:owner:',provider,revision,'{}')
      assert.throws(()=>store.lifeAuthorizationRevision(namespace),{code:'STORE_READ_FAILED'})
      db.exec('DELETE FROM processing_profiles')
    }
    for(let n=0;n<257;n++)db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run('personal:owner:','provider-'+n,0,'{}')
    assert.throws(()=>store.lifeAuthorizationRevision(namespace),{code:'STORE_READ_FAILED'},'provider metadata is bounded, never silently truncated')
    db.exec('DELETE FROM processing_profiles')
    db.exec('UPDATE recall_authority_epoch SET value=-1')
    assert.throws(()=>store.lifeAuthorizationRevision(namespace),{code:'STORE_READ_FAILED'})
    db.exec('UPDATE recall_authority_epoch SET value=0')
    for(const invalid of [-1,0.5,'invalid']){
      db.prepare('UPDATE temp.recall_authority_revision SET value=?').run(invalid)
      assert.throws(()=>store.lifeAuthorizationRevision(namespace),{code:'STORE_READ_FAILED'})
    }
  }finally{store.close();await rm(root,{recursive:true,force:true})}
})

for(const value of ['unbounded-string',[],[null,0,0],[-1,0,0,[]],[0,0.5,0,[]],[0,'0',0,[]],[true,0,0,[]],[null,0,-1,[]],[0,0,Number.MAX_SAFE_INTEGER+1,[]],[null,0,0,[['',0]]],[null,0,0,[['provider',-1]]],[null,0,0,[['provider','1']]],[null,0,0,[['provider',0,0]]],{revision:0},[null,0,0,[['x'.repeat(513),0]]],[null,0,0,Array.from({length:257},(_,n)=>['provider-'+n,0])]])test(`Life authority RPC rejects malformed tuple ${JSON.stringify(value).slice(0,80)}`,async()=>{
  const listeners=new Map<string,(value:never)=>void>()
  const worker:MemoryLedgerWorker={postMessage(input){const q=input as {request_id:number;operation:string};queueMicrotask(()=>listeners.get('message')!({kind:'response',request_id:q.request_id,ok:true,result:q.operation==='close'?null:value} as never))},on(event,listener){listeners.set(event,listener);return worker},terminate:()=>Promise.resolve(0)}
  const client=new MemoryLedgerClient(':memory:',{workerFactory:()=>worker})
  try{await assert.rejects(client.lifeAuthorizationRevision('personal:owner:life:'),{code:'WORKER_PROTOCOL_FAILURE'})}finally{await client.close()}
})
