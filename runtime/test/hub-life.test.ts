import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {HubStore} from '../src/hub/store.js'

test('separately initialized Hubs do not share an identity even with the same account name',()=>{
 const first=new HubStore(':memory:'),second=new HubStore(':memory:')
 try{
  const a=first.enroll('same','phone'),b=second.enroll('same','phone')
  assert.notEqual(first.snapshot(a.token).hub_id,second.snapshot(b.token).hub_id)
 }finally{first.close();second.close()}
})

test('Hub persists acknowledgements beyond reducer eviction and isolates accounts', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-hub-')),path=join(dir,'hub.db')
 let hub=new HubStore(path)
 try{
  const a=hub.enroll('alice','phone'),b=hub.enroll('bob','phone')
  const command={op_id:'create-first',input:{op:'create',kind:'todo',title:'Buy milk'}}
  const first=hub.mutate(a.token,command)
  for(let i=0;i<260;i++)hub.mutate(a.token,{op_id:`edit-${i}`,input:{op:'update',kind:'todo',id:first.result.id,expected_version:i+1,note:String(i)}})
  hub.close();hub=new HubStore(path)
  const retry=hub.mutate(a.token,command)
  assert.deepEqual(retry.result,first.result)
  assert.equal(retry.snapshot.state.todos.length,1)
  assert.equal(retry.snapshot.cursor,261)
  assert.equal(hub.snapshot(b.token).state.todos.length,0)
  assert.throws(()=>hub.mutate(a.token,{...command,input:{...command.input,title:'Different'}}),/op_id_conflict/)
  assert.throws(()=>hub.mutate(b.token,{op_id:'attack',input:{op:'update',kind:'todo',id:first.result.id,expected_version:261,title:'Stolen'}}),/item_not_found/)
  hub.revoke('alice',a.device_id)
  assert.throws(()=>hub.snapshot(a.token),/unauthorized/)
 }finally{hub.close();await rm(dir,{recursive:true,force:true})}
})

test('stale writes leave canonical state and sequence unchanged; choices race safely',()=>{
 const hub=new HubStore(':memory:')
 try{
  const a=hub.enroll('alice','phone'),b=hub.enroll('alice','desktop')
  const id=hub.mutate(a.token,{op_id:'create',input:{op:'create',kind:'todo',title:'Original'}}).result.id
  hub.mutate(b.token,{op_id:'desktop-edit',input:{op:'update',kind:'todo',id,expected_version:1,title:'Desktop'}})
  assert.throws(()=>hub.mutate(a.token,{op_id:'offline',input:{op:'update',kind:'todo',id,expected_version:1,title:'Phone'}}),/version_conflict/)
  assert.equal(hub.snapshot(a.token).cursor,2)
  assert.equal(hub.snapshot(a.token).state.todos[0]?.title,'Desktop')
  hub.mutate(a.token,{op_id:'choice',input:{op:'update',kind:'todo',id,expected_version:2,title:'Phone'}})
  assert.throws(()=>hub.mutate(b.token,{op_id:'late-choice',input:{op:'update',kind:'todo',id,expected_version:2,title:'Desktop'}}),/version_conflict/)
  const delta=hub.changes(b.token,1)
  assert.equal(delta.events.length,2)
  assert.equal(delta.cursor,3)
  assert.equal(delta.events[1]?.device_id,a.device_id)
  assert.throws(()=>hub.changes(a.token,99),/cursor_invalid/)
 }finally{hub.close()}
})

test('conversion aliases converge, undo is tombstoned and stale edits do not resurrect',()=>{
 const hub=new HubStore(':memory:')
 try{
  const a=hub.enroll('alice','phone'),b=hub.enroll('alice','desktop')
  const idea=hub.mutate(a.token,{op_id:'idea',input:{op:'create',kind:'idea',title:'Learn'}}).result.id
  const one=hub.mutate(a.token,{op_id:'convert-a',input:{op:'convert',id:idea,target:'todo',expected_version:1}})
  const two=hub.mutate(b.token,{op_id:'convert-b',input:{op:'convert',id:idea,target:'todo',expected_version:1}})
  assert.equal(one.result.id,two.result.id)
  hub.mutate(a.token,{op_id:'undo',input:{op:'undo_create',id:one.result.id,expected_version:1}})
  assert.equal(hub.snapshot(b.token).tombstones[one.result.id],1)
  assert.throws(()=>hub.mutate(b.token,{op_id:'late',input:{op:'update',kind:'todo',id:one.result.id,expected_version:1,title:'Revived'}}),/item_not_found/)
  assert.equal(hub.snapshot(a.token).state.todos.length,0)
  assert.equal(hub.mutate(a.token,{op_id:'convert-a',input:{op:'convert',id:idea,target:'todo',expected_version:1}}).result.id,one.result.id)
  assert.equal(hub.snapshot(a.token).state.todos.length,0)
 }finally{hub.close()}
})
