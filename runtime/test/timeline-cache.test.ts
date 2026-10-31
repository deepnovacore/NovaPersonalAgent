import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,writeFile,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TimelineCache,type TimelineCachePort} from '../src/personal-agent/timeline-cache.js'

const directory=async(name:string)=>mkdtemp(join(await realpath(tmpdir()),name))
const file=async(path:string)=>JSON.parse(await readFile(path,'utf8')) as {version:number;topics:{scope:string;title:string;members:{id:string;version:string}[]}[];screened:{scope:string;id:string;version:string}[];stages:{key:string;kind:string;payload:unknown}[]}
const topic=(title:string,ids:string[],version='v1')=>({title,members:ids.map(id=>({id,version}))})

test('topics, screened inputs and stage payloads survive a restart',async()=>{
 const dir=await directory('timeline-cache-roundtrip-'),path=join(dir,'cache.json')
 try{
  const cache=new TimelineCache(path)
  await cache.open()
  const run=cache.beginRun('local')
  run.appendBatchResult({topics:[topic('回归反馈',['m1','m2'])],screened:[{id:'m3',version:'v1'}]})
  run.putStage('batch-key','batch',{cards:[{title:'Review the node'}],stages:[]})
  await run.commit()
  const saved=await file(path)
  assert.equal(saved.version,1);assert.deepEqual(saved.topics.map(entry=>entry.title),['回归反馈']);assert.deepEqual(saved.screened.map(entry=>entry.id),['m3']);assert.equal(saved.stages[0]!.kind,'batch')

  const reopened=new TimelineCache(path)
  await reopened.open()
  const next=reopened.beginRun('local')
  assert.deepEqual(next.getTopics().map(entry=>({title:entry.title,members:entry.members})),[{title:'回归反馈',members:[{id:'m1',version:'v1'},{id:'m2',version:'v1'}]}])
  assert.deepEqual(next.getScreened(),[{id:'m3',version:'v1'}])
  assert.deepEqual(next.getStage('batch-key'),{kind:'batch',payload:{cards:[{title:'Review the node'}],stages:[]}})
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('reads are isolated by access scope and a cleared cache drops a late run',async()=>{
 const dir=await directory('timeline-cache-scope-'),path=join(dir,'cache.json')
 try{
  const cache=new TimelineCache(path)
  await cache.open()
  const account=cache.beginRun('feishu:account-a'),local=cache.beginRun('local')
  account.appendBatchResult({topics:[topic('account topic',['m1'])],screened:[{id:'m2',version:'v1'}]})
  local.appendBatchResult({topics:[topic('local topic',['m3'])],screened:[]})
  await account.commit()
  assert.deepEqual(account.getTopics().map(entry=>entry.title),['account topic'])
  assert.deepEqual(local.getTopics().map(entry=>entry.title),['local topic'])
  assert.deepEqual(local.getScreened(),[],'screened inputs belong to the scope that read them')

  const stale=cache.beginRun('local')
  await cache.clear()
  // A reply that arrives after clear() must not repopulate the cache.
  stale.appendBatchResult({topics:[topic('late topic',['m4'])],screened:[{id:'m5',version:'v1'}]})
  stale.putStage('late-key','select',{text:'{}'})
  await stale.commit()
  assert.deepEqual(stale.getTopics(),[],'a cleared run cannot read the old document again')
  const fresh=cache.beginRun('local')
  assert.deepEqual(fresh.getTopics(),[]);assert.deepEqual(fresh.getScreened(),[]);assert.equal(fresh.getStage('late-key'),undefined)
  fresh.appendBatchResult({topics:[topic('fresh topic',['m6'])],screened:[]})
  await fresh.commit()
  const reopened=new TimelineCache(path)
  await reopened.open()
  assert.deepEqual(reopened.beginRun('local').getTopics().map(entry=>entry.title),['fresh topic'])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('expired topics, screened inputs and stages are not reused',async()=>{
 const dir=await directory('timeline-cache-ttl-'),path=join(dir,'cache.json')
 const base=Date.parse('2026-10-17T00:00:00Z')
 try{
  const cache=new TimelineCache(path,{now:()=>base})
  await cache.open()
  const run=cache.beginRun('local')
  run.appendBatchResult({topics:[topic('old topic',['m1'])],screened:[{id:'m2',version:'v1'}]})
  run.putStage('stage-key','select',{text:'{"topics":[]}'})
  await run.commit()

  const withinTtl=new TimelineCache(path,{now:()=>base+20*60*60*1000})
  await withinTtl.open()
  const live=withinTtl.beginRun('local')
  assert.deepEqual(live.getTopics().map(entry=>entry.title),['old topic'])
  assert.equal(live.getStage('stage-key')?.kind,'select','stages live for 24 hours')
  const afterStageTtl=new TimelineCache(path,{now:()=>base+25*60*60*1000})
  await afterStageTtl.open()
  assert.equal(afterStageTtl.beginRun('local').getStage('stage-key'),undefined)
  const later=new TimelineCache(path,{now:()=>base+73*60*60*1000})
  await later.open()
  const next=later.beginRun('local')
  assert.deepEqual(next.getTopics(),[],'topics expire after 72 hours')
  assert.deepEqual(next.getScreened(),[],'the negative index expires with the topics')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('topic and screened indexes keep only their newest bounded entries',async()=>{
 const dir=await directory('timeline-cache-capacity-'),path=join(dir,'cache.json')
 try{
  const cache=new TimelineCache(path)
  await cache.open()
  const run=cache.beginRun('local')
  run.appendBatchResult({topics:Array.from({length:300},(_,i)=>topic('topic '+i,['m'+i])),screened:Array.from({length:5000},(_,i)=>({id:'s'+i,version:'v1'}))})
  assert.equal(run.getTopics().length,256)
  assert.equal(run.getScreened().length,4096)
  assert.equal(run.getTopics()[0]!.title,'topic 44','the oldest topics are evicted first')
  await run.commit()
  const saved=await file(path)
  assert.equal(saved.topics.length,256);assert.equal(saved.screened.length,4096)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a write that cannot fit drops the oldest staged replies instead of growing past the budget',async()=>{
 const dir=await directory('timeline-cache-bytes-'),path=join(dir,'cache.json')
 const payload=()=>({text:'x'.repeat(35*1024)})
 try{
  const cache=new TimelineCache(path)
  await cache.open()
  const run=cache.beginRun('local')
  for(let i=0;i<128;i++)run.putStage('stage-'+i,'select',payload())
  await run.commit()
  const bytes=(await readFile(path)).byteLength
  assert.ok(bytes<=3*1024*1024,'the persisted cache stays below its byte budget, got '+bytes)
  const saved=await file(path)
  assert.ok(saved.stages.length>0&&saved.stages.length<128,'only some stages survive byte eviction')
  assert.ok(saved.stages.some(stage=>stage.key==='stage-127'),'the newest stage survives')
  assert.ok(!saved.stages.some(stage=>stage.key==='stage-0'),'the oldest stage is evicted first')
  const reopened=new TimelineCache(path)
  await reopened.open()
  assert.ok(reopened.beginRun('local').getStage('stage-127'))
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a corrupt cache is ignored and replaced by the next successful write',async()=>{
 const dir=await directory('timeline-cache-corrupt-'),path=join(dir,'cache.json')
 try{
  await writeFile(path,'{not json')
  const cache=new TimelineCache(path)
  await cache.open()
  const run=cache.beginRun('local')
  assert.deepEqual(run.getTopics(),[])
  run.appendBatchResult({topics:[topic('recovered',['m1'])],screened:[]})
  await run.commit()
  assert.deepEqual((await file(path)).topics.map(entry=>entry.title),['recovered'])

  await writeFile(path,JSON.stringify({version:99,topics:'wrong'}))
  const schemaBroken=new TimelineCache(path)
  await schemaBroken.open()
  assert.deepEqual(schemaBroken.beginRun('local').getTopics(),[])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('cache failures stay invisible: an unwritable path never rejects a run',async()=>{
 const dir=await directory('timeline-cache-failopen-'),blocker=join(dir,'blocker')
 await writeFile(blocker,'not a directory')
 const path=join(blocker,'cache.json')
 try{
  const cache=new TimelineCache(path)
  await cache.open()
  const run=cache.beginRun('local')
  run.appendBatchResult({topics:[topic('memory only',['m1'])],screened:[{id:'m2',version:'v1'}]})
  run.putStage('key','select',{text:'{}'})
  await run.commit()
  await cache.flush()
  assert.deepEqual(run.getTopics().map(entry=>entry.title),['memory only'],'the in-memory index still works')
  const port:TimelineCachePort=cache
  await port.clear()
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('commit persists immediately while a debounced write also flushes on demand',async()=>{
 const dir=await directory('timeline-cache-debounce-'),path=join(dir,'cache.json')
 try{
  const cache=new TimelineCache(path)
  await cache.open()
  const run=cache.beginRun('local')
  run.appendBatchResult({topics:[topic('committed',['m1'])],screened:[]})
  await run.commit()
  assert.deepEqual((await file(path)).topics.map(entry=>entry.title),['committed'])
  run.putStage('stage','select',{text:'{"topics":[]}'})
  await cache.flush()
  assert.deepEqual((await file(path)).stages.map(entry=>entry.key),['stage'])
  run.deleteStage('stage')
  await cache.flush()
  assert.deepEqual((await file(path)).stages,[])
 }finally{await rm(dir,{recursive:true,force:true})}
})
