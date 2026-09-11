import test from 'node:test'
import assert from 'node:assert/strict'
import {memoryOverview} from '../src/renderer/memory-overview.mjs'
test('overview groups grounded fields without deriving identity from names',()=>{
 const entries=['MedicalResearch','PersonalFinance','Build'].map((topic,index)=>({id:String(index),status:'active',topic,kind:'fact',origin:'inferred',source_refs:[{type:'file',ref:`/${topic}`}]}))
 entries.push({status:'forgotten',topic:'Hidden',kind:'preference',origin:'stated',source_refs:[]})
 const result=memoryOverview(entries)
 assert.equal(result.groups.length,1);assert.equal(result.groups[0].entries.length,3);assert.equal(result.stated,0)
 assert.equal(result.topics.includes('Hidden'),false);assert.match(result.coverage,/本页 3 条/);assert.doesNotMatch(result.summary,/医生|研究员|投资者|职业/)
 assert.equal(memoryOverview([]).groups.length,0)
})

test('every kind gets an aggregate lead while full content stays in its records',()=>{
 const entries=['fact','preference','plan','concern'].map(kind=>({status:'active',kind,topic:'Topic',content:`Full raw ${kind} content`,origin:'stated',source_refs:[{type:'conversation',ref:kind}]}))
 const result=memoryOverview(entries)
 assert.equal(result.groups.length,4)
 for(const group of result.groups){assert.match(group.lead,/1 个主题/);assert.match(group.lead,/1 条记录/);assert.doesNotMatch(group.lead,/Full raw/);assert.equal(group.entries[0].content,`Full raw ${group.kind} content`)}
})


test('records without topics are not presented as empty memory',()=>{
 const result=memoryOverview([{id:'untitled',kind:'fact',status:'active',origin:'stated',content:'A saved fact',source_refs:[]}])
 assert.equal(result.groups[0].entries.length,1)
 assert.notEqual(result.summary,'暂无记忆。')
})
