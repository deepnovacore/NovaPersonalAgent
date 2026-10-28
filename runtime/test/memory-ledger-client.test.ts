import assert from 'node:assert/strict'
import {test} from 'node:test'
import {access,mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Worker} from 'node:worker_threads'
import {MemoryLedgerClient,runInMemoryBackground,type MemoryLedgerWorker} from '../src/memory-ledger/store-client.js'

/** Records arrival order and answers only when the test releases the request in service. */
function heldWorker(){
 const seen:string[]=[],listeners=new Map<string,(value:never)=>void>();let held:{request_id:number}|undefined
 const worker:MemoryLedgerWorker={
  postMessage(value){const request=value as {request_id:number;operation:string;memoryOperation?:string};if(held)throw Error('a second request reached the worker while one was in service');seen.push(request.memoryOperation??request.operation);held=request},
  on(event:string,listener:(value:never)=>void){listeners.set(event,listener);return worker},
  terminate:()=>Promise.resolve(0),
 }
 const release=async()=>{const request=held!;held=undefined;listeners.get('message')!({kind:'response',request_id:request.request_id,ok:true,result:null} as never);await new Promise(resolve=>setImmediate(resolve))}
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
