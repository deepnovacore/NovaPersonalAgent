import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {HubStore} from '../src/hub/store.js'
import {HubScheduleCoordinator} from '../src/hub/schedule-coordinator.js'
import {ScheduleService,scheduleHash} from '../src/personal-agent/scheduled-tasks.js'
test('shared definitions enter the ordinary scheduler only on the owner; reserved claim survives local write loss',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'nova-shared-schedule-'))),hub=new HubStore(':memory:')
 let now=new Date('2026-10-17T08:00:00.000Z')
 const a=hub.enroll('s','a','desktop'),b=hub.enroll('s','b','desktop');hub.authority.initialize(a.token)
 const request=(token:string)=>async(path:string,body?:unknown):Promise<unknown>=>{
  if(path==='identity')return hub.identity(token)
  if(path==='authority')return hub.authority.snapshot(token)
  if(path==='schedule-owners')return hub.scheduleOwnership.list(token)
  if(path==='schedule-owners/register')return hub.scheduleOwnership.register(token,body)
  if(path==='schedule-owners/claim')return hub.scheduleOwnership.claim(token,body)
  if(path==='schedule-owners/checkpoint')return hub.scheduleOwnership.checkpoint(token,body)
  throw Error('unexpected_request')
 }
 const one=new ScheduleService(join(dir,'a.json'),undefined,()=>now),two=new ScheduleService(join(dir,'b.json'),undefined,()=>now)
 try{
  await one.open();await two.open();one.coordinator=new HubScheduleCoordinator(one,request(a.token));two.coordinator=new HubScheduleCoordinator(two,request(b.token))
  const context={todos:false,goals:false,tasks:false,memory:false,knowledge:false,search:false}
  const item=await one.createShared('create',{title:'Fixture',goal:'Read',acceptance:['Report'],rule:{kind:'daily',time:'09:00',timezone:'UTC'},context},{user_scope:'s',source:'ui',origin_ref:'ui',source_refs:[],allowed_context:context})
  await two.syncShared();assert.equal(two.list().length,0)
  now=new Date('2026-10-17T09:00:00.000Z')
  const slot='UTC:2026-10-17:09:00',run_id=scheduleHash([item.id,slot])
  hub.scheduleOwnership.claim(a.token,{id:item.id,owner_revision:1,run_id,slot_key:slot,scheduled_at:now.toISOString()})
  // Hub reserved; original process died before the local claim reached disk.
  await one.syncShared();assert.equal(one.activeRuns().length,1)
  assert.equal((await one.claimDue()).length,0)
  await one.bindTask(run_id,'task')
  assert.equal(hub.scheduleOwnership.list(a.token)[0]!.claims[run_id]!.status,'running')
  await one.markFinished(run_id,{outcome:'completed',text:'Fixture result',evidence_refs:[],published:true})
  assert.equal(hub.scheduleOwnership.list(a.token)[0]!.claims[run_id]!.status,'terminal')
 }finally{await one.close();await two.close();hub.close();await rm(dir,{recursive:true,force:true})}
})
