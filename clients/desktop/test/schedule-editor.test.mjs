import test from 'node:test'
import assert from 'node:assert/strict'
import {ScheduleDraft} from '../src/renderer/schedule-editor.mjs'
const input={title:'Daily',goal:'Read priorities',acceptance:['Give an action'],rule:{kind:'daily',time:'09:00',timezone:'Asia/Shanghai'},context:{todos:true,goals:true,tasks:true,memory:false,knowledge:false,search:false}}
test('only the newest preview can enable save, and invalid drafts never write',async()=>{
 const reads=[],writes=[],draft=new ScheduleDraft(input,(method,params)=>method==='schedules.preview'?new Promise(resolve=>reads.push({params,resolve})):(writes.push(params),Promise.resolve({id:'s'})))
 const first=draft.preview();draft.set('rule',{...input.rule,time:'11:00'});const second=draft.preview()
 reads[1].resolve({next_slot:{scheduled_at:'2026-10-13T03:00:00Z'}});await second;reads[0].resolve({next_slot:{scheduled_at:'2026-10-13T01:00:00Z'}});await first
 assert.equal(draft.next.scheduled_at,'2026-10-13T03:00:00Z');draft.set('title','');await assert.rejects(draft.save());assert.equal(writes.length,0)
})
test('lost acknowledgement keeps the exact draft and request identity until confirmed',async()=>{
 const calls=[];let attempts=0
 const draft=new ScheduleDraft(input,async(method,params,options)=>{calls.push({method,params,options});if(method==='schedules.preview')return {next_slot:{scheduled_at:'2026-10-13T01:00:00Z'}};if(method==='schedules.list')return {items:[]};if(++attempts===1)throw Error('timeout');return {id:'s',revision:1}})
 await draft.preview();await assert.rejects(draft.save(),/timeout/);assert.equal(draft.value.title,'Daily');assert.ok(draft.pending);assert.equal(draft.set('title','Changed'),false)
 assert.equal((await draft.save()).id,'s');const writes=calls.filter(c=>c.method==='schedules.create');assert.equal(writes[0].options.request_id,writes[1].options.request_id);assert.deepEqual(writes[0].params,writes[1].params);assert.ok(calls.some(c=>c.method==='schedules.list'))
})
test('stale edit preserves user input and requires reloading the current revision',async()=>{
 const draft=new ScheduleDraft({...input,id:'s',revision:1},async method=>{if(method==='schedules.preview')return {next_slot:{scheduled_at:'2026-10-13T01:00:00Z'}};if(method==='schedules.get')return {...input,id:'s',revision:2};throw Error('stale_schedule')})
 await draft.preview();await assert.rejects(draft.save(),/stale_schedule/);assert.equal(draft.value.goal,input.goal);assert.equal(draft.conflict,true);assert.equal(draft.pending,null)
})
