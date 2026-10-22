import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveWorkbenchGroups,temporalIndex,compactTemporalIndex} from '../src/personal-agent/workbench-temporal.js'
import type {WorkbenchMatter} from '../src/personal-agent/workbench-evidence.js'
const m=(id:string,state:WorkbenchMatter['state']='open',kind:WorkbenchMatter['kind']='goal'):WorkbenchMatter=>({id,kind,state,title:'交付',summary:'原文说明',ownership:'user',assertion:'direct',due:null,due_quote:null,group:'chat:2026-10-18',observed_at:'2026-10-18T00:00:00Z',refs:[{entry_id:id,version:'1',quote:'原文说明'}]})
test('compact temporal authors retain all quotation text, timestamps and attribution',()=>{
 const inputs=Array.from({length:30},(_,i)=>({id:'e'+i,version:'1',kind:'message' as const,text:'原文说明',observed_at:'2026-10-18T00:00:00Z',author:{key:'person',name:'Example author',kind:'person' as const,is_user:true}}))
 inputs[0]!.author.name='Earlier display name'
 const rows=temporalIndex(inputs.map(i=>m(i.id)),inputs),packed=compactTemporalIndex(rows)
 assert.equal(Object.keys(packed.authors).length,2)
 const restored=packed.matters.map(row=>({...row,quotes:row.quotes.map(q=>({...q,author:q.author===undefined?undefined:packed.authors[q.author]}))}))
 assert.deepEqual(restored,rows)
 assert.ok(JSON.stringify(packed).length<JSON.stringify(rows).length)
})
test('completion extracted as topic closes an earlier commitment across groups',()=>{
 const rows=[{...m('old'),group:'a:2026-10-04'},m('progress'),{...m('done','completed','topic'),group:'b:2026-10-18'}]
 const result=resolveWorkbenchGroups(rows,{groups:[{members:rows.map(x=>x.id),state:'completed',current:'done',basis:['done']}]})
 assert.equal(result[0]!.state,'completed');assert.equal(result[0]!.members.length,3)
 assert.equal(resolveWorkbenchGroups(rows,{groups:[{members:rows.map(x=>x.id),state:'open',current:'old',basis:['old']} ]})[0]!.state,'uncertain')
})
test('coverage, membership and duplicate identities fail closed',()=>{
 const rows=[m('a'),m('b')],g={members:['a'],state:'open',current:'a',basis:['a']}
 for(const groups of [[g],[g,g],[{...g,members:['a','b'],basis:['foreign']}],[{...g,members:['a','a','b']} ]])assert.throws(()=>resolveWorkbenchGroups(rows,{groups}))
})
test('forwarded old commitment cannot reopen, while unrelated same-title matters stay separate',()=>{
 const rows=[m('a'),{...m('b'),assertion:'forwarded' as const}]
 const result=resolveWorkbenchGroups(rows,{groups:rows.map(r=>({members:[r.id],state:'open',current:r.id,basis:[r.id]}))})
 assert.deepEqual(result.map(g=>g.state),['open','uncertain']);assert.notEqual(result[0]!.id,result[1]!.id)
})

test('a model cannot manufacture a terminal state from only open quotations',()=>{
 const result=resolveWorkbenchGroups([m('a')],{groups:[{members:['a'],state:'completed',current:'a',basis:['a']}]})
 assert.equal(result[0]!.state,'uncertain')
})
test('reconciliation input does not imply that a source conversation is a matter identity',()=>{
 const rows=[m('ppt'),m('network')]
 const index=temporalIndex(rows)
 assert.equal(index.length,2)
 assert.ok(index.every(row=>!('group' in row)))
 assert.deepEqual(index.map(row=>row.quotes[0]!.text),rows.map(row=>row.refs[0]!.quote))
})

test('only proposed merges are reviewed, and unrelated work can be split without rereading singletons',async()=>{
 const {createWorkbenchGenerator}=await import('../src/model/workbench-writer.js')
 const rows=[m('fix'),m('qa'),m('other')]
 let calls=0
 const writer=createWorkbenchGenerator({stream:()=>{throw Error('unused')},complete:r=>{
  calls++
  if(calls===1)return Promise.resolve({text:JSON.stringify({groups:[{members:['m0','m1'],state:'open',current:'m1',basis:['m1']},{members:['m2'],state:'open',current:'m2',basis:['m2']}]})})
  const body=JSON.parse(r.prompt) as {matters:{id:string}[]}
  assert.deepEqual(body.matters.map(m=>m.id),['m0','m1'])
  assert.equal(r.usage?.operation,'reconcile_review')
  return Promise.resolve({text:JSON.stringify({groups:body.matters.map(m=>({members:[m.id],state:'open',current:m.id,basis:[m.id]}))})})
 }},'test')
 const result=await writer({phase:'reconcile',matters:rows,inputs:[],date:'2026-10-18',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.equal(resolveWorkbenchGroups(rows,result).length,3);assert.equal(calls,2)
})

test('invalid review coverage cannot silently retain a proposed merge',async()=>{
 const {createWorkbenchGenerator}=await import('../src/model/workbench-writer.js')
 let calls=0
 const writer=createWorkbenchGenerator({stream:()=>{throw Error('unused')},complete:()=>Promise.resolve({text:JSON.stringify({groups:[{members:++calls===1?['m0','m1']:['m0'],state:'open',current:'m0',basis:['m0']}]})})},'test')
 await assert.rejects(writer({phase:'reconcile',matters:[m('a'),m('b')],inputs:[],date:'2026-10-18',timezone:'Asia/Shanghai'},new AbortController().signal),/incomplete_temporal_coverage/u)
})

test('splitting a possible closure cannot resurrect its earlier commitment',async()=>{
 const {createWorkbenchGenerator}=await import('../src/model/workbench-writer.js')
 let calls=0
 const writer=createWorkbenchGenerator({stream:()=>{throw Error('unused')},complete:()=>Promise.resolve({text:JSON.stringify({groups:++calls===1?[{members:['m0','m1'],state:'completed',current:'m1',basis:['m1']}]:[{members:['m0'],state:'open',current:'m0',basis:['m0']},{members:['m1'],state:'completed',current:'m1',basis:['m1']}]})})},'test')
 const rows=[m('old'),m('done','completed')]
 const result=await writer({phase:'reconcile',matters:rows,inputs:[],date:'2026-10-18',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.deepEqual(resolveWorkbenchGroups(rows,result).map(g=>g.state),['uncertain','completed'])
})
