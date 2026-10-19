import {test} from 'node:test'
import assert from 'node:assert/strict'
import {selectTimelineInputs,timelineContextInputs,timelineBatches} from '../src/personal-agent/timeline-inputs.js'
import type {ContextEntry} from '../src/personal-agent/workbench-context.js'

test('timeline covers more than sixteen documents across Profile project roots',()=>{
 const files:ContextEntry[]=Array.from({length:120},(_,i)=>({kind:'file',id:'source:'+i,version:'v1',content:'Project evidence '+i,source_id:'s',file_id:String(i),root:'/project/'+Math.floor(i/10),rel_path:'notes/'+i+'.md',role:'document',mtime_ms:Date.UTC(2026,9,1)+i,priority:1}))
 const selected=timelineContextInputs(files,[])
 assert.equal(selected.length,120);assert.equal(new Set(selected.slice(0,12).map(x=>x.group)).size,12)
 assert.equal(selected[0]!.kind,'file','mtime remains file metadata, never a message timestamp')
})
test('large message groups cannot crowd out other conversations or Profile documents',()=>{
 const message=(id:string,group:string)=>({id,group,version:'v1',kind:'im',text:'x'.repeat(4000),observed_at:'2026-10-17T00:00:00Z'})
 const selected=selectTimelineInputs([...Array.from({length:300},(_,i)=>message('busy'+i,'busy')),message('quiet','quiet'),{...message('document','project'),kind:'file'}])
 assert.ok(selected.some(x=>x.id==='quiet'));assert.ok(selected.some(x=>x.id==='document'))
 assert.equal(selected.length,302,'do not silently truncate the message pool at the single-prompt budget')
 assert.equal(selectTimelineInputs([message('same','a'),message('same','b')]).length,1)
})

test('all five thousand messages reach bounded screening batches exactly once',()=>{
 const inputs=Array.from({length:5000},(_,i)=>({id:String(i),group:'chat'+i%13,version:'1',kind:'im',text:'x'.repeat(1000),observed_at:'2026-10-17T00:00:00Z'}))
 const pool=selectTimelineInputs(inputs),batches=timelineBatches(pool)
 assert.equal(pool.length,5000);assert.equal(new Set(batches.flat().map(x=>x.id)).size,5000)
 assert.ok(batches.every(batch=>batch.length<=200&&batch.reduce((sum,x)=>sum+x.text.length,0)<=60000))
})

test('authorized cached file citations survive the document selection cap without expanding generation inputs',()=>{
 const files:ContextEntry[]=Array.from({length:140},(_,i)=>({kind:'file',id:'source:'+i,version:'v1',content:'Project evidence '+i,source_id:'s',file_id:String(i),root:'/project',rel_path:'notes/'+i+'.md',role:'document',mtime_ms:Date.UTC(2026,9,1)+i,priority:1}))
 const selected=timelineContextInputs(files,[],['source:0','source:1'])
 assert.equal(selected.filter(input=>!input.history_only).length,128)
 assert.deepEqual(selected.filter(input=>input.history_only).map(input=>input.id),['source:1','source:0'])
 assert.equal(timelineContextInputs(files.filter(file=>file.id!=='source:0'),[],['source:0']).some(input=>input.id==='source:0'),false,'a revoked or removed file is not recovered from the cache')
})
