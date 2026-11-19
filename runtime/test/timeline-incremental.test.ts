import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,realpath,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import {TimelineCache,type TimelineCachePort} from '../src/personal-agent/timeline-cache.js'
import type {CompleteRequest,GatewayCompletion,ModelGateway} from '../src/model/model-gateway.js'
import type {TimelineContext,TimelineInput} from '../src/personal-agent/timeline-brief.js'

const context:TimelineContext={local_date:'2026-10-17',timezone:'UTC'}
const message=(id:string,text=id):TimelineInput=>({id,version:'v1',kind:'im',text,observed_at:'2026-10-17T00:00:00Z',group:'chat'})
const directory=async(name:string)=>mkdtemp(join(await realpath(tmpdir()),name))

/**
 * Deterministic gateway: screening keeps one topic per batch (dropping `skip` lines), reconciliation
 * keeps groups separate, composition writes one card per input and review accepts the draft.
 */
class TimelineGateway implements ModelGateway {
 readonly requests:CompleteRequest[]=[]
 async *stream():AsyncIterable<never>{/* the writer only calls complete */}
 count(prefix:string){return this.requests.filter(request=>(request.usage?.operation??'').startsWith(prefix)).length}
 complete(request:CompleteRequest):Promise<GatewayCompletion>{
  this.requests.push(request)
  const operation=request.usage?.operation??''
  if(operation.startsWith('select')){
   const body=JSON.parse(request.prompt) as {inputs:{key:string;text:string}[]}
   const kept=body.inputs.filter(entry=>!entry.text.startsWith('skip'))
   return Promise.resolve({text:JSON.stringify({topics:kept.length?[{title:'batch '+kept[0]!.text,refs:kept.map(entry=>entry.key)}]:[]})})
  }
  if(operation.startsWith('reconcile')){
   const body=JSON.parse(request.prompt) as {topics:{id:string}[]}
   return Promise.resolve({text:JSON.stringify({groups:body.topics.map(topic=>({members:[topic.id]}))})})
  }
  if(operation.startsWith('compose')){
   const body=JSON.parse(request.prompt) as {inputs:{key:string;text:string}[]}
   return Promise.resolve({text:JSON.stringify({cards:body.inputs.map(entry=>({temporal:{kind:'event',dates:[]},category:'Update',title:entry.text.slice(0,60),why_now:'A result was recorded',facts:[{text:entry.text.slice(0,160),quote:entry.text.slice(0,160),ref:entry.key}],uncertainty:'',actions:[],refs:[entry.key]}))})})
  }
  if(operation.startsWith('review')){
   const body=JSON.parse(request.prompt) as {cards:unknown[]}
   return Promise.resolve({text:JSON.stringify({cards:body.cards})})
  }
  throw Error('unexpected timeline operation '+operation)
 }
}

const opened=async(path:string)=>{const cache=new TimelineCache(path);await cache.open();return cache}
const pool=(count:number,prefix='m')=>Array.from({length:count},(_,i)=>message(prefix+i,'msg '+i))
const readCache=async(path:string)=>JSON.parse(await readFile(path,'utf8')) as {topics:{title:string;members:{id:string;version:string}[]}[];screened:{id:string;version:string}[];stages:{key:string;kind:string;payload:Record<string,unknown>}[]}

test('a thousand-input briefing screens only the new increment on the next run',async()=>{
 const dir=await directory('timeline-incremental-add-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const first=await writer.generateTimeline(pool(1200),context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.count('select'),6,'the initial pool is screened in bounded batches')
  assert.equal(cache.beginRun('local').getTopics().length,6)
  assert.equal(first.diagnostics?.cache_reused_inputs,0)

  const before=gateway.requests.length
  const inputs=[...pool(1200),message('new-1','msg new')]
  const second=await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.count('select'),7,'the one new input is screened and indexed instead of taking the local pass-through')
  assert.equal(gateway.requests.length-before,4,'the screening round, reconcile and only the changed composition batch call the model')
  assert.ok((second.diagnostics?.cache_stage_hits??0)>0,'the untouched composition batch is replayed from the cache')
  assert.equal(second.diagnostics?.cache_reused_topics,6)
  assert.equal(second.diagnostics?.cache_reused_inputs,1200)
  assert.equal(second.diagnostics?.cache_screened_inputs,0)
  assert.equal(second.cards.length,1201,'every screened original plus the new one is composed')
  assert.ok(second.cards.some(card=>card.refs.includes('m0'))&&second.cards.some(card=>card.refs.includes('new-1')))
  assert.equal(cache.beginRun('local').getTopics().length,7,'the increment is recorded as a screening result')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('the negative index stops previously rejected inputs from being screened again',async()=>{
 const dir=await directory('timeline-incremental-negative-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const inputs=Array.from({length:300},(_,i)=>message('m'+i,i%3===0?'skip '+i:'msg '+i))
  const first=await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(first.diagnostics?.cache_screened_inputs,0)
  assert.equal(first.cards.length,200,'rejected inputs never reach composition')
  assert.equal(cache.beginRun('local').getScreened().length,100)

  const before=gateway.requests.length
  const second=await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.requests.length,before,'a fully indexed run spends no model call')
  assert.equal(second.diagnostics?.cache_reused_inputs,200)
  assert.equal(second.diagnostics?.cache_screened_inputs,100)
  assert.equal(second.cards.length,200)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a changed input version invalidates the whole topic that screened it',async()=>{
 const dir=await directory('timeline-incremental-invalidate-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const inputs=pool(1200)
  await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  const cached=cache.beginRun('local').getTopics()
  assert.equal(cached.length,6)
  // Change one member of the first two screening topics: both topics lose their positive index.
  const changedIds=new Set([cached[0]!.members[0]!.id,cached[1]!.members[0]!.id])
  const revised=inputs.map(entry=>changedIds.has(entry.id)?{...entry,version:'v2'}:entry)
  const beforeSelect=gateway.count('select')
  const versionRun=await writer.generateTimeline(revised,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.count('select')-beforeSelect,2,'the two invalidated topics are screened again')
  assert.equal(versionRun.diagnostics?.cache_reused_topics,4)
  assert.equal(versionRun.diagnostics?.cache_reused_inputs,800)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a withdrawn member only shrinks its topic instead of invalidating it',async()=>{
 const dir=await directory('timeline-incremental-withdrawn-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const inputs=pool(1200)
  await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  const withdrawn=inputs.filter(entry=>entry.id!=='m0'),before=gateway.count('select')
  const withdrawnRun=await writer.generateTimeline(withdrawn,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.count('select'),before,'a shrunken topic needs no new screening')
  assert.equal(withdrawnRun.diagnostics?.cache_reused_topics,6)
  assert.equal(withdrawnRun.diagnostics?.cache_reused_inputs,1199)
  assert.equal(withdrawnRun.cards.length,1199)
  assert.ok(!withdrawnRun.cards.some(card=>card.refs.includes('m0')))
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a durable index disables the local pass-through so fresh input is screened and stored',async()=>{
 const dir=await directory('timeline-incremental-direct-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const result=await writer.generateTimeline(pool(100),context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.count('select'),1,'a cached run screens small pools instead of pass-through')
  assert.equal(cache.beginRun('local').getTopics().length,1)
  assert.equal(result.diagnostics?.composition_batches,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a cached screening, reconciliation and composition set is replayed even when the versions moved',async()=>{
 const dir=await directory('timeline-incremental-stages-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const inputs=Array.from({length:300},(_,i)=>message('m'+i,'msg '+i))
  const first=await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(first.diagnostics?.cache_stage_misses,4,'two screening batches, reconciliation and one composition batch')
  // New versions invalidate the topic members, but request prompts are version-free, so every
  // raw reply is still usable after the batch-local reference validation.
  const revised=inputs.map(entry=>({...entry,version:'v2'}))
  const before=gateway.requests.length
  const second=await writer.generateTimeline(revised,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.requests.length,before,'every stage is answered from the cache')
  assert.equal(second.diagnostics?.cache_stage_hits,4)
  assert.equal(second.diagnostics?.cache_stage_misses,0)
  assert.equal(second.diagnostics?.cache_reused_topics,0,'the stale positive index still fails closed on the member version')
  assert.deepEqual(second.diagnostics?.stages,first.diagnostics?.stages,'replayed stages keep the review_removed accounting')
  assert.equal(second.cards.length,first.cards.length)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('an invalid cached payload is discarded and regenerated instead of trusting it',async()=>{
 const dir=await directory('timeline-incremental-corrupt-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const inputs=Array.from({length:300},(_,i)=>message('m'+i,'msg '+i))
  const revised=inputs.map(entry=>({...entry,version:'v2'}))
  await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  const saved=await readCache(path)
  assert.equal(saved.stages.length,4)
  for(const stage of saved.stages)stage.payload=stage.kind==='batch'?{cards:[{broken:true}],stages:[]}:{text:'not json'}
  await writeFile(path,JSON.stringify(saved))

  const reopened=await opened(path),before=gateway.requests.length
  const second=await writer.generateTimeline(revised,context,new AbortController().signal,undefined,{cache:reopened,scope:'local',force:false})
  assert.ok(gateway.requests.length>before,'invalid entries fall back to the model')
  assert.equal(second.cards.length,300)
  assert.equal(second.diagnostics?.cache_stage_hits,0)
  assert.equal(second.diagnostics?.cache_stage_misses,4)
  // The rejected entries are replaced by valid ones, so the next run is served from the cache again.
  const repaired=await readCache(path)
  for(const stage of repaired.stages)assert.ok(stage.kind==='batch'?Array.isArray((stage.payload as {cards?:unknown[]}).cards):typeof (stage.payload as {text?:unknown}).text==='string')
  const thirdBefore=gateway.requests.length
  const third=await writer.generateTimeline(revised,context,new AbortController().signal,undefined,{cache:reopened,scope:'local',force:false})
  assert.equal(gateway.requests.length,thirdBefore,'the repaired entries serve the next run')
  assert.equal(third.diagnostics?.cache_stage_misses,0)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a cache that throws on every operation never fails the briefing',async()=>{
 const dir=await directory('timeline-incremental-throwing-')
 try{
  const failing:TimelineCachePort={
   open:()=>Promise.reject(Error('open failed')),
   beginRun:()=>({getTopics:()=>{throw Error('topics failed')},getScreened:()=>{throw Error('screened failed')},appendBatchResult:()=>{throw Error('append failed')},getStage:()=>{throw Error('stage failed')},putStage:()=>{throw Error('put failed')},deleteStage:()=>{throw Error('delete failed')},commit:()=>Promise.reject(Error('commit failed'))}),
   clear:()=>Promise.reject(Error('clear failed')),
   flush:()=>Promise.reject(Error('flush failed')),
  }
  const gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const result=await writer.generateTimeline(Array.from({length:300},(_,i)=>message('m'+i,'msg '+i)),context,new AbortController().signal,undefined,{cache:failing,scope:'local',force:false})
  assert.equal(result.cards.length,300)
  assert.equal(result.diagnostics?.cache_reused_inputs,0)
  assert.equal(result.diagnostics?.cache_stage_hits,0)
  assert.equal(result.diagnostics?.cache_stage_misses,4,'each stage was genuinely recomputed after the cache failed')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a manual refresh is cache-first and spends no model call when nothing changed',async()=>{
 const dir=await directory('timeline-incremental-force-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const inputs=Array.from({length:300},(_,i)=>message('m'+i,i%3===0?'skip '+i:'msg '+i))
  await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  const before=gateway.requests.length
  const forced=await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:true})
  assert.equal(gateway.requests.length,before,'a manual refresh replays the cache instead of recomputing')
  assert.equal(forced.diagnostics?.cache_reused_topics,cache.beginRun('local').getTopics().length)
  assert.ok((forced.diagnostics?.cache_stage_hits??0)>0)
  assert.equal(forced.cards.length,200)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('reused topic titles are offered to screening as a read-only hint',async()=>{
 const dir=await directory('timeline-incremental-hints-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  await writer.generateTimeline(pool(1200),context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  const inputs=[...pool(1200),...Array.from({length:300},(_,i)=>message('n'+i,'new '+i))]
  const before=gateway.requests.length
  const second=await writer.generateTimeline(inputs,context,new AbortController().signal,undefined,{cache,scope:'local',force:false})
  const selects=gateway.requests.slice(before).filter(request=>(request.usage?.operation??'').startsWith('select'))
  assert.equal(selects.length,2)
  const body=JSON.parse(selects[0]!.prompt) as {existing_topics?:string[];inputs:{text:string}[]}
  assert.equal(body.existing_topics?.length,6,'reused topic titles travel as bounded hints')
  assert.ok(body.existing_topics.every(title=>title.startsWith('batch ')))
  const screenedInputs=selects.reduce((sum,request)=>sum+(JSON.parse(request.prompt) as {inputs:unknown[]}).inputs.length,0)
  assert.equal(screenedInputs,300,'only the new inputs are screened')
  assert.equal(second.diagnostics?.cache_reused_inputs,1200)
 }finally{await rm(dir,{recursive:true,force:true})}
})

/** Seed the durable index as a previous run would have left it. */
const seedTopics=async(cache:TimelineCache,topics:{title:string;ids:string[]}[]):Promise<void>=>{
 const run=cache.beginRun('local')
 run.appendBatchResult({topics:topics.map(topic=>({title:topic.title,members:topic.ids.map(id=>({id,version:'v1'}))})),screened:[]})
 await run.commit()
}
const deltaContext=(newIds:string[],prior:{id:string;evidence_ids:string[]}[]=[])=>({...context,new_input_ids:newIds,...(prior.length?{prior_cards:prior.map(card=>({id:card.id,title:'旧卡',category:'topic',why_now:'理由',anchor_date:null,evidence_ids:card.evidence_ids}))}:{})})

test('topics with no new evidence are skipped instead of rewritten',async()=>{
 const dir=await directory('timeline-incremental-clean-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  await seedTopics(cache,[{title:'batch msg 0',ids:['m0','m1']},{title:'batch msg 2',ids:['m2','m3']}])
  const inputs=[...pool(4),message('m4','msg 4')]
  const result=await writer.generateTimeline(inputs,deltaContext(['m4']),new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(gateway.count('select'),1,'only the new message is screened')
  assert.equal(gateway.count('reconcile'),1)
  assert.equal(gateway.count('compose'),1,'clean topics never reach composition')
  assert.equal(result.diagnostics?.cache_skipped_topics,2)
  assert.equal(result.diagnostics?.cache_reused_inputs,4)
  assert.equal(result.cards.length,1)
  const composite=gateway.requests.find(request=>(request.usage?.operation??'').startsWith('compose'))!
  const body=JSON.parse(composite.prompt) as {inputs:{key:string;text:string}[]}
  assert.deepEqual(body.inputs.map(entry=>entry.text),['msg 4'])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a dirty topic keeps every new message and only the anchors of its history',async()=>{
 const dir=await directory('timeline-incremental-anchors-'),path=join(dir,'cache.json')
 try{
  const cache=await opened(path),gateway=new TimelineGateway(),writer=new GatewayPersonalWriter({gateway,model:'fixture'})
  const inputs=Array.from({length:11},(_,index)=>({...message('m'+index,index===0?'计划上线':index===4?'已取消上线':'msg '+index),observed_at:`2026-10-${String(1+index).padStart(2,'0')}T00:00:00Z`}))
  await seedTopics(cache,[{title:'上线计划',ids:inputs.map(input=>input.id)}])
  const result=await writer.generateTimeline(inputs,deltaContext(['m10'],[{id:'card-a',evidence_ids:['m0']}]),new AbortController().signal,undefined,{cache,scope:'local',force:false})
  assert.equal(result.diagnostics?.cache_skipped_topics,0)
  const composite=gateway.requests.find(request=>(request.usage?.operation??'').startsWith('compose'))!
  const body=JSON.parse(composite.prompt) as {topics:{title:string;history_complete:boolean}[];inputs:{key:string;text:string}[]}
  assert.ok(body.inputs.length<11,'old evidence is trimmed to anchors')
  assert.ok(body.inputs.some(entry=>entry.text==='msg 10'),'the new message is always sent')
  assert.ok(body.inputs.some(entry=>entry.text==='计划上线'),'the previous card original is an anchor')
  assert.ok(body.inputs.some(entry=>entry.text==='已取消上线'),'state-changing history is an anchor')
  assert.equal(body.topics[0]?.history_complete,false,'a trimmed topic reports incomplete history')
 }finally{await rm(dir,{recursive:true,force:true})}
})
