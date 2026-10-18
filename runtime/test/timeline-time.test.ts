import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolveTimelineTime} from '../src/personal-agent/timeline-time.js'
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
 assert.equal(due.anchor_date,'2026-10-20');assert.equal(due.last_reported_on,'2026-10-13')
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

test('a future appointment uses a planned date rather than claiming it already occurred or is a deadline',()=>{
 const inputs=[{...source,text:'2026-10-20 项目讨论会'}]
 const time=resolve({kind:'scheduled',dates:[{role:'scheduled',date:'2026-10-20',ref:'m',quote:inputs[0]!.text}]},inputs)!
 assert.equal(time.anchor_date,'2026-10-20');assert.equal(time.anchor_basis,'scheduled');assert.equal(time.due_on,null)
})

test('message date mistakenly supplied as occurrence falls back to reported time without inventing an event date',()=>{
 const source={id:'message',kind:'im',text:'明确交互以提问为入口',observed_at:'2026-10-13T01:00:00Z'}
 const time=resolveTimelineTime({kind:'event',dates:[{role:'occurred',date:'2026-10-13',ref:source.id,quote:source.text}]},[source],{local_date:'2026-10-17',timezone:'Asia/Shanghai'})
 assert.equal(time?.anchor_date,'2026-10-13');assert.equal(time?.anchor_basis,'reported');assert.equal(time?.occurred_on,null)
 assert.equal(resolveTimelineTime({kind:'event',dates:[{role:'occurred',date:'2026-10-16',ref:source.id,quote:source.text}]},[source],{local_date:'2026-10-17',timezone:'Asia/Shanghai'}),null)
})
