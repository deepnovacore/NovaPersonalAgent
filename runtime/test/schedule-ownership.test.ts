import test from 'node:test'
import assert from 'node:assert/strict'
import {HubStore} from '../src/hub/store.js'
test('shared slots have one fixed owner; an unknown effect blocks transfer and an epoch change cannot replay a slot',()=>{
 const hub=new HubStore(':memory:');try{
  const pc=hub.enroll('s','pc','desktop'),other=hub.enroll('s','other','desktop'),phone=hub.enroll('s','phone','mobile');hub.authority.initialize(pc.token)
  const definition={title:'Fixture',goal:'Read fixture',acceptance:['Return result'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context:{todos:false,goals:false,tasks:false,memory:false,knowledge:false,search:false}}
  hub.scheduleOwnership.register(pc.token,{id:'rule',authority_epoch:1,definition,frontier:'2026-10-16T00:00:00.000Z'})
  const claim={id:'rule',owner_revision:1,run_id:'stable',slot_key:'2026-10-17',scheduled_at:'2026-10-17T09:00:00.000Z'}
  assert.throws(()=>hub.scheduleOwnership.claim(phone.token,claim),/schedule_owner_required/)
  assert.deepEqual(hub.scheduleOwnership.claim(pc.token,claim),hub.scheduleOwnership.claim(pc.token,claim))
  const transfer={id:'rule',owner_revision:1,transition_id:'transfer',target:other.device_id}
  assert.throws(()=>hub.scheduleOwnership.handoff(pc.token,{...transfer,action:'prepare'}),/schedule_unresolved/)
  hub.scheduleOwnership.checkpoint(pc.token,{id:'rule',owner_revision:1,run_id:'stable',task_id:'task',terminal:false})
  assert.throws(()=>hub.scheduleOwnership.handoff(pc.token,{...transfer,action:'prepare'}),/schedule_unresolved/)
  hub.scheduleOwnership.checkpoint(pc.token,{id:'rule',owner_revision:1,run_id:'stable',task_id:'task',terminal:true})
  hub.scheduleOwnership.handoff(pc.token,{...transfer,action:'prepare'});hub.scheduleOwnership.handoff(other.token,{...transfer,action:'ack'});hub.scheduleOwnership.handoff(pc.token,{...transfer,action:'commit'})
  assert.throws(()=>hub.scheduleOwnership.claim(pc.token,claim),/schedule_owner_required/)
  assert.equal(hub.scheduleOwnership.claim(other.token,{...claim,owner_revision:2}).status,'terminal')
  assert.throws(()=>hub.scheduleOwnership.claim(other.token,{...claim,owner_revision:2,run_id:'epoch-replay'}),/occurrence_conflict/)
 }finally{hub.close()}
})
