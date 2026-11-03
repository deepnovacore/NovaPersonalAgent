import assert from 'node:assert/strict'
import {test} from 'node:test'
import {access,mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Worker} from 'node:worker_threads'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient,runInMemoryBackground,type MemoryLedgerWorker} from '../src/memory-ledger/store-client.js'

/** Records arrival order and answers only when the test releases the request in service. */
function heldWorker(){
 const seen:string[]=[],listeners=new Map<string,(value:never)=>void>();let held:{request_id:number}|undefined
 const worker:MemoryLedgerWorker={
  postMessage(value){const request=value as {request_id:number;operation:string;memoryOperation?:string};if(held)throw Error('a second request reached the worker while one was in service');seen.push(request.memoryOperation??request.operation);held=request},
  on(event:string,listener:(value:never)=>void){listeners.set(event,listener);return worker},
  terminate:()=>Promise.resolve(0),
 }
 const release=async(result: number|null=null,authority: {authority_epoch?:number;authority_changed?:boolean;error_code?:string}={})=>{const request=held!;held=undefined;listeners.get('message')!({kind:'response',request_id:request.request_id,ok:authority.error_code===undefined,...(authority.error_code===undefined?{result}:{}),...authority} as never);await new Promise(resolve=>setImmediate(resolve))}
 return {worker,seen,release,fail:()=>listeners.get('exit')!(1 as never)}
}

test('close waits for a slow locked worker and leaves the ledger reopenable', {timeout:15000}, async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-ledger-close-')),path=join(root,'memory.sqlite')
 const storeUrl=new URL('../src/memory-ledger/store.js',import.meta.url).href
 const client=new MemoryLedgerClient(path,{workerFactory:(url,options)=>new Worker(`
  (async()=>{
   const {MemoryLedgerStore}=await import(${JSON.stringify(storeUrl)});
   const close=MemoryLedgerStore.prototype.close;
   MemoryLedgerStore.prototype.close=function(){
    const deadline=Date.now()+600;
    while(Date.now()<deadline){}
    return close.call(this);
   };
   await import(${JSON.stringify(url.href)});
  })()
 `,{...options,eval:true,execArgv:[]})})
 let next:MemoryLedgerClient|undefined
 try{
  await client.open();await client.close()
  await assert.rejects(access(path+'.memory/.nova-memory.lock'),{code:'ENOENT'})
  next=new MemoryLedgerClient(path,{memoryLockWaitMs:100});await next.open()
 }finally{await client.close();await next?.close();await rm(root,{recursive:true,force:true})}
})

for(const failure of ['error','exit'] as const)test(`close settles when its worker reports ${failure}`,{timeout:5000},async()=>{
 const client=new MemoryLedgerClient(':memory:',{workerFactory:()=>new Worker(`
  const {parentPort}=require('node:worker_threads');
  parentPort.on('message',request=>{
   if(request.operation==='close')${failure==='error'?"throw Error('fixture worker failure')":"process.exit(1)"};
   else parentPort.postMessage({kind:'response',request_id:request.request_id,ok:true,result:null});
  });
 `,{eval:true,execArgv:[]})})
 try{await client.open();await client.close();await client.close()}
 finally{await client.close()}
})

test('a conversation read overtakes queued background work after at most the request in service',async()=>{
 const fake=heldWorker(),client=new MemoryLedgerClient(':memory:',{workerFactory:()=>fake.worker})
 const background=runInMemoryBackground(()=>Array.from({length:20},(_,i)=>client.memory('source_processing',{i})))
 const ordinary=client.memory('list',{})
 const conversation=client.memory('conversation_snapshot',{},{priority:'interactive'})
 await fake.release();await fake.release();await fake.release()
 assert.deepEqual(fake.seen,['source_processing','conversation_snapshot','list','source_processing'])
 await Promise.all([conversation,ordinary])
 while(fake.seen.length<22)await fake.release()
 await fake.release();await Promise.all(background)
})

test('background context survives awaits and never leaks into the caller',async()=>{
 const fake=heldWorker(),client=new MemoryLedgerClient(':memory:',{workerFactory:()=>fake.worker})
 const first=client.memory('list',{})
 const later=runInMemoryBackground(async()=>{await Promise.resolve();return client.memory('pending_vectors',{})})
 await Promise.resolve();const ordinary=client.memory('life_load',{})
 await fake.release();await fake.release();await fake.release()
 assert.deepEqual(fake.seen,['list','life_load','pending_vectors'])
 await Promise.all([first,ordinary,later])
})

test('close runs after every queued request and a worker failure rejects queued requests',async()=>{
 const fake=heldWorker(),client=new MemoryLedgerClient(':memory:',{workerFactory:()=>fake.worker})
 const queued=[client.memory('list',{}),runInMemoryBackground(()=>client.memory('source_processing',{}))]
 const closing=client.close()
 await fake.release();await fake.release();await fake.release();await closing
 assert.deepEqual(fake.seen,['list','source_processing','close']);await Promise.all(queued)

 const broken=heldWorker(),other=new MemoryLedgerClient(':memory:',{workerFactory:()=>broken.worker})
 const inService=other.memory('list',{}),waiting=other.memory('life_load',{},{priority:'interactive'})
 broken.fail()
 await assert.rejects(inService,{code:'WORKER_EXITED'});await assert.rejects(waiting,{code:'WORKER_EXITED'})
 await other.close()
})

test('an aborted queued read never reaches the worker',async()=>{
 const fake=heldWorker(),client=new MemoryLedgerClient(':memory:',{workerFactory:()=>fake.worker})
 const inService=client.memory('list',{})
 const controller=new AbortController()
 const queued=client.memory('conversation_snapshot',{},{priority:'interactive',signal:controller.signal})
 controller.abort()
 await assert.rejects(queued,{code:'REQUEST_ABORTED'})
 await fake.release();await inService
 assert.deepEqual(fake.seen,['list'])
 const closing=client.close()
 await fake.release();await closing
})

test('a temporary auto-reopen failure is retried with bounded backoff',async()=>{
 const workers:{messages:unknown[];respond:(id:number,code?:string)=>void;emitExit:()=>void;listeners:Map<string,(value:never)=>void>}[]=[]
 const make=()=>{
  const listeners=new Map<string,(value:never)=>void>(),messages:unknown[]=[]
  const worker:MemoryLedgerWorker={postMessage(value){messages.push(value)},on(event:string,listener:(value:never)=>void){listeners.set(event,listener);return worker},terminate:()=>Promise.resolve(0)}
  const entry={messages,listeners,respond:(id:number,code?:string)=>{listeners.get('message')!((code===undefined?{kind:'response',request_id:id,ok:true,result:null}:{kind:'response',request_id:id,ok:false,error_code:code}) as never)},emitExit:()=>listeners.get('exit')!(1 as never)}
  workers.push(entry);return worker
 }
 const client=new MemoryLedgerClient(':memory:',{workerFactory:make})
 const id=(index:number)=>Number((workers[index]!.messages[0] as {request_id:number}).request_id)
 const opening=client.open()
 workers[0]!.respond(id(0))
 await opening
 workers[0]!.emitExit()
 await new Promise(resolve=>setTimeout(resolve,300))
 assert.equal(workers.length,2,'recycle spawns a replacement immediately')
 workers[1]!.respond(Number((workers[1]!.messages[0] as {request_id:number}).request_id),'STORE_READ_FAILED')
 await new Promise(resolve=>setTimeout(resolve,700))
 workers[1]!.respond(Number((workers[1]!.messages[1] as {request_id:number}).request_id))
 await new Promise(resolve=>setTimeout(resolve,20))
 const list=client.memory('list',{})
 workers[1]!.respond(Number((workers[1]!.messages[2] as {request_id:number}).request_id))
 assert.equal(await list,null)
 const closing=client.close()
 workers[1]!.respond(Number((workers[1]!.messages[3] as {request_id:number}).request_id))
 await closing
})

test('an abandoned in-service read is dropped and its stuck worker replaced',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const workers:ReturnType<typeof heldWorker>[]=[]
 const client=new MemoryLedgerClient(':memory:',{workerFactory:()=>{const fake=heldWorker();workers.push(fake);return fake.worker}})
 const controller=new AbortController()
 const abandoned=client.memory('conversation_snapshot',{},{priority:'interactive',signal:controller.signal})
 controller.abort()
 await assert.rejects(abandoned,{code:'REQUEST_ABORTED'})
 assert.equal(workers.length,1,'the worker is not replaced before the grace period')
 t.mock.timers.tick(30_000)
 assert.equal(workers.length,2,'a stuck worker is replaced after the grace period')
 t.mock.timers.tick(250)
 if(workers[1]!.seen[0]==='open')await workers[1]!.release()
 const next=client.memory('list',{})
 await workers[1]!.release()
 assert.equal(await next,null)
 assert.deepEqual(workers[0]!.seen,['conversation_snapshot'])
 assert.deepEqual(workers[1]!.seen.filter(name=>name==='list'),['list'])
 const closing=client.close()
 await workers[1]!.release()
 await closing
})

test('recall authority revision fences dispatched and completed mutations, not read-only grants', async () => {
 const fake=heldWorker(),client=new MemoryLedgerClient(':memory:',{workerFactory:()=>fake.worker})
 for(const operation of ['merge','forget','delete_source','purge','purge_index_complete','source_grant','source_apply_page','invalidate_message','invalidate_evidence','explicit_write','space_source_input'] as const){
  const before=client.recallAuthorityRevision(),pending=client.memory(operation,{})
  assert.ok(client.recallAuthorityRevision()>before,operation+' dispatch')
  const dispatched=client.recallAuthorityRevision()
  await fake.release();await pending
  assert.ok(client.recallAuthorityRevision()>dispatched,operation+' completion')
 }
 const before=client.recallAuthorityRevision(),reading=client.memory('source_grant',{action:'get'})
 await fake.release();await reading
 assert.equal(client.recallAuthorityRevision(),before)
 for(const count of [0,1]){
  const previous=client.recallAuthorityRevision(),expiry=client.memory('expire',{})
  await fake.release(count);await expiry
  assert.equal(client.recallAuthorityRevision(),previous+(count>0?1:0))
 }
 const closing=client.close();await fake.release();await closing
})


test('read replies observe shared epochs before resolution, rejection, and abandoned late replies', async () => {
 const fake=heldWorker(),client=new MemoryLedgerClient(':memory:',{workerFactory:()=>fake.worker})
 for(const epoch of [7,7,8,3]){
  const before=client.recallAuthorityRevision(),reading=client.memory('list',{})
  const resolved=reading.then(()=>client.recallAuthorityRevision())
  await fake.release(null,{authority_epoch:epoch})
  assert.equal(await resolved,before+(epoch===7&&before>0?0:1),'epoch differences, not ordering, fence reads')
 }
 let before=client.recallAuthorityRevision()
 const failed=client.memory('list',{})
 const rejected=assert.rejects(failed,{code:'STORE_MEMORY_CONFLICT'})
 await fake.release(null,{authority_epoch:4,error_code:'STORE_MEMORY_CONFLICT'})
 await rejected;assert.equal(client.recallAuthorityRevision(),before+1)
 before=client.recallAuthorityRevision()
 const controller=new AbortController(),abandoned=client.memory('list',{},{signal:controller.signal})
 controller.abort();await assert.rejects(abandoned,{code:'REQUEST_ABORTED'})
 await fake.release(null,{authority_epoch:5})
 assert.equal(client.recallAuthorityRevision(),before+1)
 before=client.recallAuthorityRevision()
 const local=client.memory('list',{})
 await fake.release(null,{authority_epoch:5,authority_changed:true});await local
 assert.equal(client.recallAuthorityRevision(),before+1,'connection-local consent still fences with an unchanged shared epoch')
 const closing=client.close();await fake.release();await closing
})

for(const epoch of [undefined,0])test(`first open and ordinary reads do not spuriously advance authority (epoch=${String(epoch)})`,async()=>{
 const fake=heldWorker(),client=new MemoryLedgerClient(':memory:',{workerFactory:()=>fake.worker})
 const authority=epoch===undefined?{}:{authority_epoch:epoch}
 assert.equal(client.recallAuthorityRevision(),0)
 const opening=client.open()
 assert.equal(client.recallAuthorityRevision(),0,'first open is not a worker replacement')
 await fake.release(null,authority);await opening
 const baseline=client.recallAuthorityRevision()
 assert.equal(baseline,epoch===undefined?0:1,'only the initial shared epoch observation advances authority')
 await client.open()
 for(let i=0;i<2;i++){
  const reading=client.memory('list',{})
  const resolved=reading.then(()=>client.recallAuthorityRevision())
  await fake.release(null,authority)
  assert.equal(await resolved,baseline,'ordinary reads keep the same fence')
 }
 const closing=client.close();await fake.release();await closing
})

test('idle worker replacement advances authority synchronously before same-epoch reopen and read resolution',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const workers:ReturnType<typeof heldWorker>[]=[]
 const client=new MemoryLedgerClient(':memory:',{workerFactory:()=>{const fake=heldWorker();workers.push(fake);return fake.worker}})
 const opening=client.open();await workers[0]!.release(null,{authority_epoch:7});await opening
 const reading=client.memory('list',{});await workers[0]!.release(null,{authority_epoch:7});await reading
 const before=client.recallAuthorityRevision()
 workers[0]!.fail()
 assert.ok(client.recallAuthorityRevision()>before,'in-flight combined results are fenced immediately on replacement')
 const replaced=client.recallAuthorityRevision()
 t.mock.timers.tick(250)
 await workers[1]!.release(null,{authority_epoch:7});await client.open()
 const next=client.memory('list',{}),resolved=next.then(()=>client.recallAuthorityRevision())
 await workers[1]!.release(null,{authority_epoch:7})
 assert.equal(await resolved,replaced,'same-epoch replacement reads resolve with the advanced fence')
 const closing=client.close();await workers[1]!.release();await closing
})

test('opening a legacy database adds the shared authority epoch without changing schema version or records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-ledger-epoch-migration-')),path=join(root,'ledger.sqlite')
 let client=new MemoryLedgerClient(path)
 try{
  await client.open()
  const now=new Date().toISOString()
  await client.memory('append_evidence',{id:'fixture-evidence',source_id:'fixture-source',source_kind:'conversation',locator:'fixture',observed_at:now,recorded_at:now,raw_text:'fixture text',hash:'fixture',trust:'trusted_user'})
  await client.close()
  const legacy=new DatabaseSync(path)
  let version:number
  try{
   version=Number(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version)
   for(const row of legacy.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'recall_authority_%'").all())legacy.exec(`DROP TRIGGER ${String(row.name)}`)
   legacy.exec('DROP TABLE recall_authority_epoch')
  }finally{legacy.close()}
  for(let attempt=0;attempt<2;attempt++){
   client=new MemoryLedgerClient(path);await client.open()
   const db=new DatabaseSync(path)
   try{
    assert.equal(Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version),version)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recall_authority_epoch').get()!.count,1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_evidence').get()!.count,1)
    const epoch=()=>Number(db.prepare('SELECT value FROM recall_authority_epoch').get()!.value)
    const before=epoch()
    db.exec('BEGIN; DELETE FROM memory_evidence; ROLLBACK')
    assert.equal(epoch(),before,'rolled back authority writes do not advance the shared epoch')
    db.exec('UPDATE memory_evidence SET payload_json=payload_json')
    assert.equal(epoch(),before,'no-op updates do not advance the shared epoch')
    const fence=client.recallAuthorityRevision()
    db.prepare("UPDATE memory_evidence SET payload_json=json_set(payload_json,'$.raw_text',?)").run('fixture correction '+attempt)
    assert.ok(epoch()>before,'a connection unaware of epoch tracking still fires persistent triggers')
    await client.memory('list',{})
    assert.ok(client.recallAuthorityRevision()>fence,'read observes another connection authority write')
   }finally{db.close()}
   await client.close()
  }
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
