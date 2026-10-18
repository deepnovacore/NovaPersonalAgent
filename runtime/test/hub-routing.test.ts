import test from 'node:test'
import assert from 'node:assert/strict'
import {HubStore} from '../src/hub/store.js'

test('routing is explicit, scoped, durable and never changes Life state',()=>{
 const store=new HubStore(':memory:')
 try{
  const a=store.enroll('a','computer'),b=store.enroll('a','phone'),c=store.enroll('other','phone')
  store.routing.heartbeat(b.token,{name:'Phone',capabilities:['android_native']})
  assert.equal(store.routing.devices(a.token).length,1)
  assert.equal(store.routing.devices(c.token).length,0)
  const command={command_id:'cmd',task_id:'task',target_device_id:b.device_id,kind:'start',expires_at:Date.now()+60000,goal:'fixture',acceptance:'count one',capability:'android_native',target:'com.nova.fixture'}
  const receipt=store.routing.submit(a.token,command)
  assert.deepEqual(store.routing.submit(a.token,command),receipt)
  assert.throws(()=>store.routing.submit(a.token,{...command,goal:'different'}),/command_id_conflict/)
  assert.throws(()=>store.routing.submit(c.token,{...command,command_id:'foreign'}),/target_unavailable/)
  assert.equal(store.snapshot(a.token).cursor,0)
  assert.equal(store.routing.inbox(b.token).length,1)
  assert.throws(()=>store.routing.ack(a.token,{command_id:'cmd',decision:'accepted'}),/recipient_required/)
  store.routing.ack(b.token,{command_id:'cmd',decision:'accepted'})
  assert.equal(store.routing.inbox(b.token).length,0)
  assert.throws(()=>store.routing.publish(a.token,{task_id:'task',seq:1,phase:'running',summary:'fake'}),/owner_required/)
  store.routing.publish(b.token,{task_id:'task',seq:1,phase:'running',summary:'started'})
  store.routing.publish(b.token,{task_id:'task',seq:1,phase:'running',summary:'started'})
  assert.throws(()=>store.routing.publish(b.token,{task_id:'task',seq:1,phase:'completed',summary:'rewritten'}),/event_id_conflict/)
  assert.throws(()=>store.routing.publish(b.token,{task_id:'task',seq:3,phase:'completed',summary:'gap'}),/sequence_gap/)
  store.routing.publish(b.token,{task_id:'task',seq:2,phase:'verifying',summary:'needs review'})
  store.routing.publish(b.token,{task_id:'task',seq:3,phase:'completed',summary:'verified'})
  assert.throws(()=>store.routing.publish(b.token,{task_id:'task',seq:4,phase:'running',summary:'restart'}),/terminal_task/)
  assert.equal(store.routing.tasks(a.token)[0]?.phase,'completed')
 }finally{store.close()}
})

test('expired commands and revoked senders cannot be accepted or retried',()=>{
 const store=new HubStore(':memory:')
 try{
  const a=store.enroll('a','sender'),b=store.enroll('a','phone')
  store.routing.heartbeat(b.token,{name:'Phone',capabilities:['ios_native']})
  const command={command_id:'cmd',task_id:'task',target_device_id:b.device_id,kind:'start',expires_at:Date.now()+60000,goal:'fixture',acceptance:'one',capability:'ios_native',target:'nova'}
  assert.throws(()=>store.routing.submit(a.token,{...command,expires_at:Date.now()-1}),/deadline_invalid/)
  store.routing.submit(a.token,command);store.revoke('a',a.device_id)
  assert.equal(store.routing.inbox(b.token).length,0)
  assert.throws(()=>store.routing.ack(b.token,{command_id:'cmd',decision:'accepted'}),/sender_revoked/)
 }finally{store.close()}
})
