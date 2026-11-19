import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {ScheduleOwnership} from '../src/device/schedule-ownership.js'
const definition={title:'Fixture',goal:'Read fixture',acceptance:['Return result'],rule:{kind:'daily' as const,timezone:'UTC',time:'09:00'},context:{todos:false,goals:false,tasks:false,memory:false,knowledge:false,search:false}}
test('fixed Host reserves and checkpoints slots without a transferable owner revision',()=>{
 const db=new DatabaseSync(':memory:');const revoked=new Set<string>();
 const host={token:'host',device_id:'host'},other={token:'other',device_id:'other'},phone={token:'phone',device_id:'phone'};
 const ownership=new ScheduleOwnership(db,token=>{if(revoked.has(token))throw Error('unauthorized');return {account_id:'s',device_id:token}},token=>{if(token!=='host'||revoked.has(token))throw Error('host_required')});try{
  const item=ownership.register(host.token,{id:'rule',definition,frontier:'2026-10-16T00:00:00.000Z'})
  assert.equal('revision' in item,false);assert.equal('pending' in item,false)
  const claim={id:'rule',run_id:'stable',slot_key:'2026-10-17',scheduled_at:'2026-10-17T09:00:00.000Z'}
  for(const client of [phone,other])assert.throws(()=>ownership.claim(client.token,claim),/host_required/)
  assert.deepEqual(ownership.claim(host.token,claim),ownership.claim(host.token,claim))
  ownership.checkpoint(host.token,{id:'rule',run_id:'stable',task_id:'task',terminal:false})
  assert.throws(()=>ownership.claim(host.token,{...claim,run_id:'next',slot_key:'next',scheduled_at:'2026-10-18T09:00:00.000Z'}),/schedule_unresolved/)
  ownership.checkpoint(host.token,{id:'rule',run_id:'stable',task_id:'task',terminal:true})
  assert.equal(ownership.claim(host.token,claim).status,'terminal')
  assert.throws(()=>ownership.claim(host.token,{...claim,run_id:'replay'}),/occurrence_conflict/)
  revoked.add(host.token)
  assert.throws(()=>ownership.register(other.token,{id:'another',definition,frontier:'2026-10-16T00:00:00.000Z'}),/host_required/)
 }finally{db.close()}
})
