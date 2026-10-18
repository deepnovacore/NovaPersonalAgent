import test from 'node:test'
import assert from 'node:assert/strict'
import {HubStore} from '../src/hub/store.js'

const grant={kind:'grant',source_id:'source',revision:1,provider:'https://model.invalid|fixture',purpose:'profile',allow_upload:true,allow_processing:true} as const
const fact={kind:'source_fact',source_id:'source',grant_revision:1,evidence_id:'evidence',resource_id:'message',source_version:'1',text:'Fictional observation',occurred_at:new Date().toISOString()} as const
test('explicit corrections keep event provenance separate from source evidence',()=>{
 const hub=new HubStore(':memory:');try{
  const phone=hub.enroll('space','phone','mobile');hub.authority.initialize(phone.token)
  hub.context.append(phone.token,[{protocol_version:1,space_id:'space',producer_device_id:phone.device_id,producer_seq:1,event_id:'correction-event',payload:{kind:'correction',key:'tone',value:'concise'}}])
  const input={authority_epoch:1,expected_revision:0,input_cursor:1,provider:grant.provider,entries:[]}
  assert.throws(()=>hub.context.publish(phone.token,{...input,entries:[{key:'inferred',text:'unsupported',evidence_ids:[]}]}),'inferred entries must still cite real sources')
  const result=hub.context.publish(phone.token,input)
  assert.deepEqual(result.entries,[{key:'tone',text:'concise',evidence_ids:[],explicit:true}])
  const state=hub.context.snapshot(phone.token)
  assert.equal(state.corrections.tone?.event_id,'correction-event')
  assert.deepEqual(state.facts,[])
  assert.deepEqual(state.derived?.entries,result.entries)
 }finally{hub.close()}
})
test('retention removes originals and projections, advances the fence, and scrubs replay logs',t=>{
 const hub=new HubStore(':memory:');try{
  const phone=hub.enroll('space','phone','mobile');hub.authority.initialize(phone.token)
  const event=(seq:number,payload:unknown)=>({protocol_version:1,space_id:'space',producer_device_id:phone.device_id,producer_seq:seq,event_id:`e${seq}`,payload})
  hub.context.append(phone.token,[event(1,grant),event(2,fact)])
  hub.context.publish(phone.token,{authority_epoch:1,expected_revision:0,input_cursor:2,provider:grant.provider,entries:[{key:'about',text:'Summary',evidence_ids:['evidence']}]})
  t.mock.method(Date,'now',()=>Date.parse(fact.occurred_at)+31*86400000)
  const state=hub.context.snapshot(phone.token)
  assert.equal(state.facts.length,0);assert.equal(state.derived,null);assert.ok(state.cursor>2)
  assert.ok(!JSON.stringify(hub.context.pull(phone.token,0)).includes(fact.text))
  hub.context.append(phone.token,[event(3,{...fact,evidence_id:'late'})])
  assert.equal(hub.context.snapshot(phone.token).facts.length,0)
  assert.ok(!JSON.stringify(hub.context.pull(phone.token,0)).includes(fact.text))
 }finally{hub.close()}
})
test('delete control overtakes an offline outbox and discarded sequences cannot resurrect content',()=>{
 const hub=new HubStore(':memory:');try{
  const phone=hub.enroll('space','phone','mobile');hub.authority.initialize(phone.token)
  const deletion=hub.context.deleteSource(phone.token,{source_id:'source',request_id:'forget'})
  assert.equal(deletion.deleted,true)
  assert.deepEqual(hub.context.deleteSource(phone.token,{source_id:'source',request_id:'forget'}),deletion)
  const receipt=hub.context.discard(phone.token,{event_id:'old',producer_seq:1,payload_hash:'a'.repeat(64)})
  assert.equal(receipt.receipts[0]?.event_id,'old')
  assert.throws(()=>hub.context.append(phone.token,[{protocol_version:1,space_id:'space',producer_device_id:phone.device_id,producer_seq:1,event_id:'old',payload:grant}]),/event_id_conflict/)
  hub.context.append(phone.token,[{protocol_version:1,space_id:'space',producer_device_id:phone.device_id,producer_seq:2,event_id:'correction',payload:{kind:'correction',key:'style',value:'concise'}}])
  assert.equal(hub.context.snapshot(phone.token).facts.length,0)
 }finally{hub.close()}
})
test('durable context replay, deletion and canonical publisher are separately fenced',()=>{
 const hub=new HubStore(':memory:');try{
  const phone=hub.enroll('space','phone','mobile'),pc=hub.enroll('space','pc','desktop');hub.authority.initialize(pc.token)
  const event=(seq:number,payload:unknown)=>({protocol_version:1,space_id:'space',producer_device_id:phone.device_id,producer_seq:seq,event_id:`e${seq}`,payload})
  const g=event(1,grant),f=event(2,fact)
  hub.context.append(phone.token,[g,f]);hub.context.append(phone.token,[g,f]);
  assert.equal(hub.context.snapshot(phone.token).facts.length,1)
  assert.throws(()=>hub.context.append(phone.token,[event(2,{...fact,text:'different'})]),/event_id_conflict/)
  assert.throws(()=>hub.context.append(phone.token,[event(4,{kind:'correction',key:'tone',value:'concise'})]),/producer_sequence_gap/)
  const projection={authority_epoch:1,expected_revision:0,input_cursor:2,provider:grant.provider,entries:[{key:'observation',text:'Summary',evidence_ids:['evidence']}]}
  assert.throws(()=>hub.context.publish(phone.token,projection),/publisher_required/)
  assert.equal(hub.context.publish(pc.token,projection).revision,1)
  hub.context.append(phone.token,[event(3,{kind:'correction',key:'tone',value:'concise'})]);
  assert.throws(()=>hub.context.publish(pc.token,{...projection,expected_revision:1}),/stale_inputs/)
  const published=hub.context.publish(pc.token,{...projection,expected_revision:1,input_cursor:3,entries:[{key:'tone',text:'verbose',evidence_ids:['evidence']}]})
  assert.equal(published.entries.find(e=>e.key==='tone')?.text,'concise')
  hub.context.append(phone.token,[event(4,{kind:'delete_source',source_id:'source',revision:2})]);
  assert.equal(hub.context.snapshot(phone.token).facts.length,0)
  assert.equal(hub.context.snapshot(phone.token).derived,null)
  assert.throws(()=>hub.context.append(phone.token,[event(5,{...fact,evidence_id:'resurrected'})]),/source_deleted/)
  assert.throws(()=>hub.context.append(phone.token,[event(5,{...grant,revision:3})]),/source_deleted/)
  const replay=hub.context.pull(phone.token,0)
  assert.ok(!JSON.stringify(replay).includes('Fictional observation'))
 }finally{hub.close()}
})
test('same evidence from a second collector deduplicates but conflicting content is rejected',()=>{
 const hub=new HubStore(':memory:');try{
  const a=hub.enroll('s','a','mobile'),b=hub.enroll('s','b','mobile');hub.authority.initialize(a.token)
  const wrap=(device:string,seq:number,payload:unknown)=>({protocol_version:1,space_id:'s',producer_device_id:device,producer_seq:seq,event_id:`${device}-${seq}`,payload})
  hub.context.append(a.token,[wrap(a.device_id,1,grant),wrap(a.device_id,2,fact)])
  hub.context.append(b.token,[wrap(b.device_id,1,fact)])
  assert.equal(hub.context.snapshot(b.token).facts.length,1)
  assert.throws(()=>hub.context.append(b.token,[wrap(b.device_id,2,{...fact,text:'conflict'})]),/evidence_conflict/)
  assert.throws(()=>hub.context.append(b.token,[wrap(a.device_id,3,{kind:'correction',key:'x',value:'x'})]),/producer_mismatch/)
  const other=hub.enroll('other','other','mobile')
  assert.throws(()=>hub.context.append(other.token,[wrap(a.device_id,3,grant)]),/space_mismatch/)
 }finally{hub.close()}
})

test('historical facts retain original date and expire from fetched access; replay cannot refresh',t=>{
 const hub=new HubStore(':memory:');try{
  const phone=hub.enroll('space','phone','mobile');hub.authority.initialize(phone.token)
  const now=Date.now(),historical={...fact,occurred_at:'2020-01-01T00:00:00.000Z',fetched_at:new Date(now).toISOString()}
  const event=(seq:number,payload:unknown)=>({protocol_version:1,space_id:'space',producer_device_id:phone.device_id,producer_seq:seq,event_id:`history${seq}`,payload})
  const input=[event(1,grant),event(2,historical)]
  hub.context.append(phone.token,input)
  assert.equal(hub.context.snapshot(phone.token).facts[0]?.occurred_at,historical.occurred_at)
  t.mock.method(Date,'now',()=>now+31*86400000)
  assert.equal(hub.context.snapshot(phone.token).facts.length,0)
  hub.context.append(phone.token,input)
  assert.equal(hub.context.snapshot(phone.token).facts.length,0)
  assert.ok(!JSON.stringify(hub.context.pull(phone.token,0)).includes(historical.text))
 }finally{hub.close()}
})

test('only source owner can renew access; future access and changed content rejected',()=>{
 const hub=new HubStore(':memory:');try{
  const a=hub.enroll('space','a','mobile'),b=hub.enroll('space','b','mobile');hub.authority.initialize(a.token)
  const now=Date.now(),historical={...fact,occurred_at:'2020-01-01T00:00:00.000Z',fetched_at:new Date(now-1000).toISOString()}
  const event=(device:string,seq:number,payload:unknown)=>({protocol_version:1,space_id:'space',producer_device_id:device,producer_seq:seq,event_id:`${device}fresh${seq}`,payload})
  hub.context.append(a.token,[event(a.device_id,1,grant),event(a.device_id,2,historical)])
  const renewed={...historical,fetched_at:new Date(now).toISOString()}
  assert.throws(()=>hub.context.append(b.token,[event(b.device_id,1,renewed)]),/source_owner_required/)
  assert.throws(()=>hub.context.append(a.token,[event(a.device_id,3,{...renewed,fetched_at:new Date(now+600000).toISOString()})]),/source_time_invalid/)
  assert.throws(()=>hub.context.append(a.token,[event(a.device_id,3,{...renewed,text:'changed'})]),/evidence_conflict/)
  hub.context.append(a.token,[event(a.device_id,3,renewed)])
  assert.equal(hub.context.snapshot(a.token).facts.length,1)
  assert.equal(hub.context.snapshot(a.token).facts[0]?.fetched_at,renewed.fetched_at)
  hub.context.append(a.token,[event(a.device_id,4,{...grant,revision:2,allow_upload:false})])
  assert.equal(hub.context.snapshot(a.token).facts.length,0)
  assert.ok(!JSON.stringify(hub.context.pull(a.token,0)).includes(historical.text))
 }finally{hub.close()}
})
