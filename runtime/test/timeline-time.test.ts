import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolveTimelineTime,effectiveTimelineAnchor} from '../src/personal-agent/timeline-time.js'
const context={local_date:'2026-10-17',timezone:'Asia/Shanghai'}
const source={id:'m',kind:'im',observed_at:'2026-10-12T18:00:00Z',text:'10月12日完成验收。10月10日开始，10月20日交付。'}
const resolve=(temporal:Parameters<typeof resolveTimelineTime>[0],sources=[source])=>resolveTimelineTime(temporal,sources,context)
test('old discussion is anchored to source local date, not synthesis date or touched background file',()=>{
 const time=resolve({kind:'synthesis',dates:[]},[source,{id:'f',kind:'file',observed_at:'2026-10-17T09:00:00Z',text:'background'}])!
 assert.equal(time.anchor_date,'2026-10-13');assert.equal(time.anchor_basis,'reported');assert.equal(time.evidence_to,'2026-10-13');assert.equal(time.as_of,'2026-10-17')
})
test('occurrence and deadline come from dated quotes; ongoing duration stops at last report',()=>{
 const dates=[{role:'occurred' as const,date:'2026-10-12',ref:'m',quote:'10月12日完成验收'}]
 assert.equal(resolve({kind:'event',dates})!.anchor_date,'2026-10-12')
 const due=resolve({kind:'deadline',dates:[{role:'deadline',date:'2026-10-20',ref:'m',quote:'10月20日交付'}]})!
 assert.equal(due.anchor_date,'2026-10-13');assert.equal(due.anchor_basis,'reported');assert.equal(due.due_on,'2026-10-20');assert.equal(due.last_reported_on,'2026-10-13')
 const ongoing=resolve({kind:'ongoing',dates:[{role:'started',date:'2026-10-10',ref:'m',quote:'10月10日开始'}]})!
 assert.equal(ongoing.started_on,'2026-10-10');assert.equal(ongoing.anchor_date,'2026-10-13')
})
test('dates without evidence, contradictory years, impossible dates and future occurrences are rejected',()=>{
 for(const date of ['2026-10-17','2025-10-12','2026-02-30','2027-10-12'])assert.equal(resolve({kind:'event',dates:[{role:'occurred',date,ref:'m',quote:'10月12日完成验收'}]}),null)
 assert.equal(resolve({kind:'event',dates:[{role:'occurred',date:'2026-10-12',ref:'other',quote:'10月12日完成验收'}]}),null)
 assert.equal(resolve({kind:'deadline',dates:[]}),null)
})
test('file modification and collection time are not event timestamps; background is excluded',()=>{
 const files=[{...source,kind:'file'}]
 assert.equal(resolve({kind:'unknown',dates:[]},files)!.anchor_date,null)
 assert.equal(resolve({kind:'background',dates:[]}),null)
 assert.equal(resolve({kind:'event',dates:[]})!.anchor_basis,'reported')
})
test('relative dates use the message day and timezone; explicit calendar dates may come from documents',()=>{
 const msg={...source,text:'昨天验收，明天交付。'}
 assert.equal(resolve({kind:'event',dates:[{role:'occurred',date:'2026-10-12',ref:'m',quote:'昨天验收'}]},[msg])!.occurred_on,'2026-10-12')
 assert.equal(resolve({kind:'deadline',dates:[{role:'deadline',date:'2026-10-14',ref:'m',quote:'明天交付'}]},[msg])!.due_on,'2026-10-14')
 const doc={...source,kind:'file',text:'2026-11-02 发布'}
 assert.equal(resolve({kind:'deadline',dates:[{role:'deadline',date:'2026-11-02',ref:'m',quote:doc.text}]},[doc])!.due_on,'2026-11-02')
 assert.equal(resolve({kind:'event',dates:[{role:'occurred',date:'2026-10-12',ref:'m',quote:'昨天验收'}]},[{...msg,kind:'file'}]),null)
})

test('a future appointment is placed at its report while keeping its planned date',()=>{
 const inputs=[{...source,text:'2026-10-20 项目讨论会'}]
 const time=resolve({kind:'scheduled',dates:[{role:'scheduled',date:'2026-10-20',ref:'m',quote:inputs[0]!.text}]},inputs)!
 assert.equal(time.anchor_date,'2026-10-13');assert.equal(time.anchor_basis,'reported');assert.equal(time.scheduled_on,'2026-10-20');assert.equal(time.due_on,null)
})

test('message date mistakenly supplied as occurrence falls back to reported time without inventing an event date',()=>{
 const source={id:'message',kind:'im',text:'明确交互以提问为入口',observed_at:'2026-10-13T01:00:00Z'}
 const time=resolveTimelineTime({kind:'event',dates:[{role:'occurred',date:'2026-10-13',ref:source.id,quote:source.text}]},[source],{local_date:'2026-10-17',timezone:'Asia/Shanghai'})
 assert.equal(time?.anchor_date,'2026-10-13');assert.equal(time?.anchor_basis,'reported');assert.equal(time?.occurred_on,null)
 assert.equal(resolveTimelineTime({kind:'event',dates:[{role:'occurred',date:'2026-10-16',ref:source.id,quote:source.text}]},[source],{local_date:'2026-10-17',timezone:'Asia/Shanghai'}),null)
})


test('future mail schedules and deadlines use report placement without changing activity or evidence dates',()=>{
 for(const [kind,planned] of [['scheduled','2026-12-11'],['deadline','2026-11-24']] as const){
  const mail={id:'mail',kind:'mail',observed_at:'2026-10-28T01:00:00Z',text:planned+' 活动'}
  const time=resolveTimelineTime({kind,dates:[{role:kind,date:planned,ref:mail.id,quote:mail.text}]},[mail],{local_date:'2026-11-02',timezone:'Asia/Shanghai'})!
  assert.equal(time.kind,kind);assert.equal(time.anchor_basis,'reported');assert.equal(time.anchor_date,'2026-10-28')
  assert.equal(time.due_on,kind==='deadline'?planned:null);assert.equal(time.scheduled_on,kind==='scheduled'?planned:null)
  assert.equal(time.last_reported_on,'2026-10-28');assert.equal(time.evidence_from,'2026-10-28');assert.equal(time.evidence_to,'2026-10-28')
 }
})

test('past and today deadlines and schedules keep their activity anchor; undated reports cannot clamp',()=>{
 for(const kind of ['deadline','scheduled'] as const)for(const planned of ['2026-11-01','2026-11-02','2026-11-24']){
  for(const sourceKind of ['mail','file']){
   const source={id:'source',kind:sourceKind,observed_at:'2026-10-28T01:00:00Z',text:planned+' 活动'}
   const time=resolveTimelineTime({kind,dates:[{role:kind,date:planned,ref:source.id,quote:source.text}]},[source],{local_date:'2026-11-02',timezone:'Asia/Shanghai'})!
   const clamp=sourceKind==='mail'&&planned>'2026-11-02'
   assert.equal(time.anchor_basis,clamp?'reported':kind);assert.equal(time.anchor_date,clamp?'2026-10-28':planned)
   if(sourceKind==='file')assert.equal(time.last_reported_on,null)
  }
 }
})

test('effectiveTimelineAnchor clamps legacy cards using saved as_of, not the wall clock',()=>{
 const time={anchor_date:'2026-12-11',anchor_basis:'scheduled' as const,due_on:null,scheduled_on:'2026-12-11',last_reported_on:'2026-10-28',as_of:'2026-11-02'}
 assert.deepEqual(effectiveTimelineAnchor(time),{anchor_date:'2026-10-28',anchor_basis:'reported'})
 assert.deepEqual(effectiveTimelineAnchor({...time,anchor_basis:'deadline',due_on:'2026-11-24'}),{anchor_date:'2026-10-28',anchor_basis:'reported'})
 assert.deepEqual(effectiveTimelineAnchor({...time,as_of:'2026-12-11'}),{anchor_date:'2026-12-11',anchor_basis:'scheduled'})
 assert.deepEqual(effectiveTimelineAnchor({...time,last_reported_on:null}),{anchor_date:'2026-12-11',anchor_basis:'scheduled'})
 assert.equal(time.anchor_date,'2026-12-11','the saved object remains untouched')
})
