import {test} from 'node:test'
import assert from 'node:assert/strict'
import {withTimelineAnchors} from '../src/model/timeline-anchors.js'
import type {TimelineInput} from '../src/personal-agent/timeline-brief.js'

const input=(id:string,text=id,at='2026-10-17T00:00:00Z'):TimelineInput=>({id,version:'v1',kind:'im',text,observed_at:at})

test('new messages stay whole while old evidence is trimmed to anchors',()=>{
 const inputs=[input('m0','计划上线新版本','2026-10-10T00:00:00Z'),input('m1','讨论细节','2026-10-11T00:00:00Z'),input('m2','周报例行同步','2026-10-12T00:00:00Z'),input('m3','另一个话题','2026-10-13T00:00:00Z'),input('m4','已取消本次上线','2026-10-14T00:00:00Z'),input('m5','后续排期','2026-10-15T00:00:00Z'),input('m6','新版本改到下月','2026-10-16T00:00:00Z')]
 const result=withTimelineAnchors({title:'上线计划',inputs},new Set(['m6']),new Set(['m0']),{neighbourWindow:2,budgetChars:8000})
 assert.ok(result.inputs.some(item=>item.id==='m6'),'the new message is never dropped')
 assert.ok(result.inputs.some(item=>item.id==='m0'),'originals cited by the previous card are anchors')
 assert.ok(result.inputs.some(item=>item.id==='m4'),'state-changing history is kept as an anchor')
 assert.equal(result.history_complete,false)
 assert.deepEqual(result.inputs.map(item=>item.id),[...result.inputs.map(item=>item.id)].sort((a,b)=>a.localeCompare(b)),'anchors keep source order')
 assert.ok(result.inputs.length<inputs.length,'routine history is omitted')
})

test('the anchor budget bounds optional neighbours but never drops a mandatory anchor',()=>{
 const inputs=Array.from({length:12},(_,index)=>input('m'+index,'message '+index,`2026-10-${String(1+index).padStart(2,'0')}T00:00:00Z`))
 const result=withTimelineAnchors({title:'topic',inputs},new Set(['m11']),new Set(['m0','m1','m2']),{neighbourWindow:6,budgetChars:1})
 for(const id of ['m0','m1','m2','m11'])assert.ok(result.inputs.some(item=>item.id===id),`${id} is mandatory`)
 assert.ok(result.inputs.length<6,'optional neighbours stop once the budget is spent')
 assert.equal(result.history_complete,false)
})

test('a topic without new input is returned unchanged and keeps its completeness flag',()=>{
 const inputs=[input('m0'),input('m1')]
 const complete=withTimelineAnchors({title:'topic',inputs,history_complete:true},new Set(['other']),new Set(['m0']))
 assert.deepEqual(complete.inputs.map(item=>item.id),['m0','m1'])
 assert.equal(complete.history_complete,true)
 const incomplete=withTimelineAnchors({title:'topic',inputs,history_complete:false},new Set(),new Set())
 assert.equal(incomplete.history_complete,false)
})
