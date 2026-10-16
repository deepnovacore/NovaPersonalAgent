import test from 'node:test'
import assert from 'node:assert/strict'
import type {AddressInfo} from 'node:net'
import {HubStore} from '../src/hub/store.js'
import {createHubServer} from '../src/hub/server.js'

test('HTTP Hub authenticates before reading data and returns current snapshot on conflict',async()=>{
 const store=new HubStore(':memory:'),server=createHubServer(store)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1`,device=store.enroll('alice','phone')
 const headers={authorization:`Bearer ${device.token}`,'content-type':'application/json'}
 const post=(body:unknown)=>fetch(`${url}/mutations`,{method:'POST',headers,body:JSON.stringify(body)})
 try{
  assert.equal((await fetch(`${url}/state`)).status,401)
  const first=await post({op_id:'first',input:{op:'create',kind:'todo',title:'First'}})
  assert.equal(first.status,200)
  const value=await first.json() as {result:{id:string}}
  assert.equal((await post({op_id:'bad',account_id:'bob',input:{op:'create',kind:'todo',title:'Wrong'}})).status,400)
  const conflict=await post({op_id:'stale',input:{op:'update',kind:'todo',id:value.result.id,expected_version:0,title:'Stale'}})
  assert.equal(conflict.status,409)
  const body=await conflict.json() as {error:string;snapshot:{state:{todos:{title:string}[]}}}
  assert.equal(body.error,'version_conflict')
  assert.equal(body.snapshot.state.todos[0]?.title,'First')
  assert.equal((await fetch(`${url}/changes?after=-1`,{headers})).status,400)
  store.revoke('alice',device.device_id)
  assert.equal((await fetch(`${url}/state`,{headers})).status,401)
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close()}
})

test('HTTP import returns a snapshot with 409 and changes paginate without hiding import inputs',async()=>{
 const store=new HubStore(':memory:'),server=createHubServer(store)
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/hub/v1`,{token}=store.enroll('alice','desktop')
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'}
 const input={op:'import',entity:{kind:'idea',id:'imported',title:'Idea',note:'',status:'active',importance:'normal',goal_id:null}}
 try{
  assert.equal((await fetch(`${url}/mutations`,{method:'POST',headers,body:JSON.stringify({op_id:'seed',input})})).status,200)
  const conflict=await fetch(`${url}/mutations`,{method:'POST',headers,body:JSON.stringify({op_id:'collision',input})})
  assert.equal(conflict.status,409)
  const body=await conflict.json() as {error:string;snapshot:{state:{ideas:{id:string}[]}}}
  assert.equal(body.error,'entity_id_conflict')
  assert.equal(body.snapshot.state.ideas[0]?.id,'imported')
  for(let i=0;i<256;i++)store.mutate(token,{op_id:`edit-${i}`,input:{op:'update',kind:'idea',id:'imported',expected_version:i+1,note:String(i)}})
  const first=await (await fetch(`${url}/changes?after=0`,{headers})).json() as {events:{input:unknown}[];has_more:boolean;cursor:number}
  assert.equal(first.events.length,256)
  assert.deepEqual(first.events[0]?.input,input)
  assert.equal(first.has_more,true)
  const last=await (await fetch(`${url}/changes?after=${first.cursor}`,{headers})).json() as {events:unknown[];has_more:boolean;cursor:number}
  assert.equal(last.events.length,1)
  assert.equal(last.has_more,false)
  assert.equal(last.cursor,257)
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close()}
})
