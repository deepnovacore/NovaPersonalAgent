import test from 'node:test'
import assert from 'node:assert/strict'
import {request as httpRequest} from 'node:http'
import type {AddressInfo} from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'

async function setup(){
 const store=new HubStore(':memory:'),server=createHubServer(store)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
 return {store,server,origin,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close()}}
}
const headers={'content-type':'application/json'}
const redeem=(origin:string,body:unknown,extra:Record<string,string>={})=>fetch(origin+'/hub/v1/pairing/redeem',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body),redirect:'error'})
const payload=(invite:{code:string;hub_id:string;account_id:string})=>({code:invite.code,hub_id:invite.hub_id,account_id:invite.account_id,device_name:'Phone'})
test('only redeem bypasses bearer authentication; concurrent attempts create exactly one device',async()=>{
 const f=await setup()
 try{
  const invite=f.store.createInvitation('alice','https://nova.example.ts.net')
  const replies=await Promise.all([redeem(f.origin,payload(invite)),redeem(f.origin,payload(invite))])
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,400])
  const device=await replies.find(r=>r.status===200)!.json() as {token:string;device_id:string}
  assert.equal(f.store.listDevices('alice').length,1)
  assert.equal((await fetch(f.origin+'/hub/v1/identity',{headers:{authorization:`Bearer ${device.token}`}})).status,200)
  for(const path of ['/hub/v1/state','/hub/v1/invite','/hub/v1/devices','/admin','/hub/v1/pairing/redeem'])assert.equal((await fetch(f.origin+path)).status,401)
  f.store.revoke('alice',device.device_id)
  assert.equal((await fetch(f.origin+'/hub/v1/identity',{headers:{authorization:`Bearer ${device.token}`}})).status,401)
 }finally{await f.close()}
})
test('pairing enforces a global 60 per minute budget regardless of proxy headers',async()=>{
 const f=await setup()
 try{
  for(let i=0;i<60;i++)assert.equal((await redeem(f.origin,{}, {'x-forwarded-for':`192.0.2.${i}`})).status,400)
  const blocked=await redeem(f.origin,{}, {'x-forwarded-for':'198.51.100.1'})
  assert.equal(blocked.status,429);assert.deepEqual(await blocked.json(),{error:'rate_limited'})
  assert.equal((await fetch(f.origin+'/hub/v1/state')).status,401)
 }finally{await f.close()}
})
test('pairing rejects bodies over 4 KiB and reports no submitted secrets',async()=>{
 const f=await setup()
 try{
  const secret='do-not-echo-this-secret'
  const response=await redeem(f.origin,{code:secret,padding:'x'.repeat(4096)})
  assert.equal(response.status,413);assert.ok(!(await response.text()).includes(secret))
  const invalid=await redeem(f.origin,{code:secret});assert.equal(invalid.status,400)
  assert.deepEqual(await invalid.json(),{error:'invalid_pairing'})
 }finally{await f.close()}
})
test('pairing caps eight simultaneous readers and stops a trickled body after five seconds',async()=>{
 const f=await setup(),pending:ReturnType<typeof httpRequest>[]=[]
 try{
  const results:Promise<number>[]=[]
  for(let i=0;i<8;i++){
   results.push(new Promise<number>((resolve,reject)=>{
    const req=httpRequest(f.origin+'/hub/v1/pairing/redeem',{method:'POST',headers},res=>{res.resume();resolve(res.statusCode!)})
    req.on('error',reject);req.flushHeaders();pending.push(req)
   }))
  }
  await delay(100)
  const blocked=await redeem(f.origin,{})
  assert.equal(blocked.status,429)
  const start=Date.now()
  const trickle=setInterval(()=>{for(const req of pending)if(!req.destroyed)req.write(' ')},300)
  try{assert.deepEqual(await Promise.all(results),Array(8).fill(408))}finally{clearInterval(trickle)}
  assert.ok(Date.now()-start<6000)
  assert.equal((await redeem(f.origin,{})).status,400)
 }finally{for(const req of pending)req.destroy();await f.close()}
})
