import assert from 'node:assert/strict'
import {test} from 'node:test'
import {collectDueOccurrences,nextOccurrence,scheduleRuleSchema,type ScheduleRule} from '../src/personal-agent/scheduled-time.js'

test('daily and weekly slots use the rule timezone and strictly future instants',()=>{
 const cases:[ScheduleRule,string,string|null][]=[
  [{kind:'daily',timezone:'Asia/Shanghai',time:'10:30'},'2026-10-12T02:29:00Z','2026-10-12T02:30:00.000Z'],
  [{kind:'daily',timezone:'Asia/Shanghai',time:'10:30'},'2026-10-12T02:30:00Z','2026-10-13T02:30:00.000Z'],
  [{kind:'weekly',timezone:'Asia/Shanghai',time:'09:00',weekdays:[1,2,3,4,5]},'2026-10-16T01:01:00Z','2026-10-19T01:00:00.000Z'],
  [{kind:'once',timezone:'Asia/Shanghai',date:'2026-10-12',time:'10:30'},'2026-10-12T02:31:00Z',null],
 ]
 for(const [rule,after,want] of cases)assert.equal(nextOccurrence(rule,new Date(after))?.scheduled_at??null,want)
})

test('rule validation rejects invalid calendar dates, zones, weekdays and once DST gaps',()=>{
 for(const rule of [
  {kind:'daily',timezone:'Mars/Sea',time:'10:30'},
  {kind:'daily',timezone:'UTC',time:'24:00'},
  {kind:'weekly',timezone:'UTC',time:'10:30',weekdays:[0]},
  {kind:'weekly',timezone:'UTC',time:'10:30',weekdays:[1,1]},
  {kind:'once',timezone:'UTC',date:'2026-02-30',time:'10:30'},
  {kind:'once',timezone:'America/New_York',date:'2026-03-08',time:'02:30'},
 ])assert.equal(scheduleRuleSchema.safeParse(rule).success,false,JSON.stringify(rule))
})

test('overlap runs at its first instant only; gaps skip including half-hour transitions',()=>{
 const fall:ScheduleRule={kind:'daily',timezone:'America/New_York',time:'01:30'}
 assert.equal(nextOccurrence(fall,new Date('2026-11-01T05:29:00Z'))?.scheduled_at,'2026-11-01T05:30:00.000Z')
 assert.equal(nextOccurrence(fall,new Date('2026-11-01T05:31:00Z'))?.scheduled_at,'2026-11-02T06:30:00.000Z')
 assert.equal(nextOccurrence({kind:'daily',timezone:'America/New_York',time:'02:30'},new Date('2026-03-08T05:00:00Z'))?.scheduled_at,'2026-03-09T06:30:00.000Z')
 assert.equal(nextOccurrence({kind:'daily',timezone:'Australia/Lord_Howe',time:'02:15'},new Date('2026-10-03T13:00:00Z'))?.scheduled_at,'2026-10-04T15:15:00.000Z')
})

test('catchup keeps just the latest recent slot and does not rewind a clock cursor',()=>{
 const rule:ScheduleRule={kind:'daily',timezone:'Asia/Shanghai',time:'10:30'}
 const due=collectDueOccurrences(rule,new Date('2026-10-09T02:30:00Z'),new Date('2026-10-12T03:00:00Z'))
 assert.equal(due.latest?.scheduled_at,'2026-10-12T02:30:00.000Z');assert.equal(due.missed_count,2)
 const stale=collectDueOccurrences(rule,new Date('2026-10-11T02:30:00Z'),new Date('2026-10-12T04:31:00Z'))
 assert.equal(stale.latest,null);assert.equal(stale.missed_count,1)
 assert.deepEqual(collectDueOccurrences(rule,new Date('2026-10-12T03:00:00Z'),new Date('2026-10-12T02:00:00Z')),{latest:null,missed_count:0,dst_gaps:[]})
})

test('a recurring gap is recorded only after the missing local slot has elapsed',()=>{
 const rule:ScheduleRule={kind:'daily',timezone:'America/New_York',time:'02:30'}
 assert.deepEqual(collectDueOccurrences(rule,new Date('2026-03-08T05:00:00Z'),new Date('2026-03-08T06:59:00Z')).dst_gaps,[])
 assert.deepEqual(collectDueOccurrences(rule,new Date('2026-03-08T05:00:00Z'),new Date('2026-03-08T07:00:00Z')).dst_gaps,['2026-03-08'])
 assert.deepEqual(collectDueOccurrences(rule,new Date('2026-03-08T07:00:00Z'),new Date('2026-03-08T08:00:00Z')).dst_gaps,[])
})
