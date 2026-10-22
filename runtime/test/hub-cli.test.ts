import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'
import {runHubClient} from '../src/hub/client-cli.js'

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'hub-cli-')),store=new HubStore(join(dir,'hub.db')),server=createHubServer(store)
 const mac=store.enroll('test','mac'),phone=store.enroll('test','phone')
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
 const cli=(args:string[],token=mac.token)=>new Promise<{code:number;out:string;err:string}>(resolve=>{
  execFile(process.execPath,[new URL('../src/hub/cli.js',import.meta.url).pathname,...args],{env:{...process.env,NOVA_HUB_URL:url,NOVA_HUB_TOKEN:token}},(error,out,err)=>resolve({code:error?Number(error.code)||1:0,out,err}))
 })
 const send=['send','--to',phone.device_id,'--goal','Open app','--acceptance','App visible','--target','com.nova.fixture']
 const online=()=>store.routing.heartbeat(phone.token,{name:'Phone',capabilities:['android_native']})
 return {store,mac,phone,cli,send,online,url,close:async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await rm(dir,{recursive:true,force:true})}}
}

test('CLI devices, todos and command replay use the real HTTP Hub',async()=>{
 const f=await fixture()
 try{
  f.online()
  const devices=await f.cli(['devices']);assert.equal(devices.code,0,devices.err);assert.equal((JSON.parse(devices.out) as {device_id:string}[])[0]?.device_id,f.phone.device_id)
  const add=['todo','add','--title','Buy milk','--note','Two bottles','--op-id','todo-one']
  const first=await f.cli(add);assert.equal(first.code,0,first.err)
  assert.deepEqual((JSON.parse((await f.cli(add)).out) as {result:unknown}).result,(JSON.parse(first.out) as {result:unknown}).result)
  assert.match((await f.cli(add.map(v=>v==='Buy milk'?'Different':v))).err,/op_id_conflict/)
  const list=await f.cli(['todo','list']);assert.equal((JSON.parse(list.out) as unknown[]).length,1);assert.equal((JSON.parse(list.out) as {note:string}[])[0]?.note,'Two bottles')
  const args=[...f.send,'--command-id','start-one','--task-id','task-one','--expires-at',String(Date.now()+60000)]
  const sent=await f.cli(args);assert.equal(sent.code,0,sent.err)
  assert.deepEqual(JSON.parse((await f.cli(args)).out),JSON.parse(sent.out))
  assert.match((await f.cli(args.map(v=>v==='Open app'?'Other goal':v))).err,/command_id_conflict/)
  assert.equal((JSON.parse((await f.cli(['tasks'])).out) as {task_id:string}[])[0]?.task_id,'task-one')
  const cancel=await f.cli(['cancel','--task','task-one','--to',f.phone.device_id]);assert.equal(cancel.code,0,cancel.err)
  assert.equal(f.store.routing.inbox(f.phone.token)[1]?.command.kind,'cancel')
 }finally{await f.close()}
})

test('CLI rejects unauthorized, revoked, offline, expired and invalid requests',async()=>{
 const f=await fixture()
 try{
  assert.match((await f.cli(['devices'],'bad')).err,/401.*unauthorized/)
  assert.match((await f.cli(f.send)).err,/target_unavailable/)
  f.online()
  assert.match((await f.cli([...f.send,'--expires-at',String(Date.now()-1000)])).err,/deadline_invalid/)
  assert.notEqual((await f.cli([...f.send,'--ttl-seconds','901'])).code,0)
  assert.notEqual((await f.cli(['send','--to',f.phone.device_id])).code,0)
  assert.notEqual((await f.cli(['devices','--typo','value'])).code,0)
  f.store.revoke('test',f.mac.device_id)
  assert.match((await f.cli(['devices'])).err,/401.*unauthorized/)
 }finally{await f.close()}
})

test('CLI watch reports completion, cancellation, interruption, expiry and timeout',async()=>{
 const f=await fixture()
 try{
  f.online()
  for(const phase of ['completed','cancelled','interrupted'] as const){
   const sent=JSON.parse((await f.cli(f.send)).out) as {command_id:string;task_id:string}
   f.store.routing.ack(f.phone.token,{command_id:sent.command_id,decision:'accepted'})
   f.store.routing.publish(f.phone.token,{task_id:sent.task_id,seq:1,phase:'verifying',summary:'Check'})
   f.store.routing.publish(f.phone.token,{task_id:sent.task_id,seq:2,phase,summary:'Done'})
   const watched=await f.cli(['watch','--task',sent.task_id,'--timeout-seconds','2'])
   assert.equal(watched.code,phase==='completed'?0:1,watched.err);assert.equal((JSON.parse(watched.out) as {phase:string}).phase,phase)
  }
  const pending=JSON.parse((await f.cli([...f.send,'--ttl-seconds','1'])).out) as {task_id:string}
  const expired=await f.cli(['watch','--task',pending.task_id,'--timeout-seconds','3']);assert.equal(expired.code,1);assert.match(expired.out,/expired/)
  const timeout=await f.cli(['watch','--task','missing','--timeout-seconds','0.1']);assert.notEqual(timeout.code,0);assert.match(timeout.err,/watch_timeout/)
 }finally{await f.close()}
})

for(const stalledAt of ['headers','body'] as const){
 test(`CLI watch reports its deadline when the HTTP response stalls at ${stalledAt}`,{timeout:5000},async()=>{
  const server=createServer((_request,response)=>{
   if(stalledAt==='body'){
    response.writeHead(200,{'content-type':'application/json'})
    response.flushHeaders()
   }
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
   const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
   await assert.rejects(runHubClient(['watch','--task','missing','--timeout-seconds','0.1',
    '--url',url,'--token','test-token']),{message:'watch_timeout'})
  }finally{
   server.closeAllConnections()
   await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
 })
}

test('CLI options override environment and preserve schema and transport boundaries',async()=>{
 const f=await fixture()
 try{
  f.online()
  assert.equal((await f.cli(['devices','--url',f.url,'--token',f.mac.token],'bad')).code,0)
  assert.match((await f.cli(['devices','--url','http://example.com'])).err,/HTTPS origin/)
  assert.match((await f.cli(['devices','--url',`${f.url}/wrong`])).err,/HTTPS origin/)
  assert.match((await f.cli([...f.send,'--ttl-seconds','NaN'])).err,/Invalid --ttl-seconds/)
  assert.match((await f.cli([...f.send,'--capability','unknown'])).err,/invalid_request/)
  assert.match((await f.cli(f.send.map(v=>v==='com.nova.fixture'?'not-a-package':v))).err,/invalid_target/)
  assert.match((await f.cli(['todo','add','--title','x'.repeat(201)])).err,/invalid_request/)
  assert.equal(f.store.snapshot(f.mac.token).cursor,0)
 }finally{await f.close()}
})

test('CLI watch polls live changes and fails on rejection without inventing completion',async()=>{
 const f=await fixture()
 try{
  f.online()
  const sent=JSON.parse((await f.cli(f.send)).out) as {command_id:string;task_id:string}
  f.store.routing.ack(f.phone.token,{command_id:sent.command_id,decision:'accepted'})
  f.store.routing.publish(f.phone.token,{task_id:sent.task_id,seq:1,phase:'running',summary:'Started'})
  const watched=f.cli(['watch','--task',sent.task_id,'--timeout-seconds','5'])
  const timer=setTimeout(()=>{
   f.store.routing.publish(f.phone.token,{task_id:sent.task_id,seq:2,phase:'verifying',summary:'Checked'})
   f.store.routing.publish(f.phone.token,{task_id:sent.task_id,seq:3,phase:'completed',summary:'Done'})
  },1000)
  try{
   const result=await watched;assert.equal(result.code,0,result.err)
   const phases=result.out.trim().split('\n').map(line=>(JSON.parse(line) as {phase:string}).phase)
   assert.equal(phases.at(-1),'completed')
  }finally{clearTimeout(timer)}
  const rejected=JSON.parse((await f.cli(f.send)).out) as {command_id:string;task_id:string}
  f.store.routing.ack(f.phone.token,{command_id:rejected.command_id,decision:'rejected'})
  const result=await f.cli(['watch','--task',rejected.task_id]);assert.equal(result.code,1);assert.match(result.out,/rejected/)
 }finally{await f.close()}
})
