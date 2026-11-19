import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import {TimelineBrief,type TimelineInput,type TimelineGenerator} from '../src/personal-agent/timeline-brief.js'
import {TimelineCache} from '../src/personal-agent/timeline-cache.js'
import type {CompleteRequest,ModelGateway} from '../src/model/model-gateway.js'

test('retrying a split topic does not compose its already completed old-only batch again',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-split-retry-'))
 let fail=true;const calls:string[][]=[]
 const inputs:TimelineInput[]=Array.from({length:16},(_,i)=>{const id='m'+String(i).padStart(2,'0');return {id,version:'1',kind:'im',group:'g',text:('completed '+id+' ').padEnd(4000,'x'),observed_at:'2026-10-31T00:00:00Z'}})
 const gateway:ModelGateway={stream(){throw Error('unexpected streaming request')},complete(request){
  const body=JSON.parse(request.prompt) as {inputs:{key:string;text:string}[];topics:{id:string}[]}
  if(request.usage?.operation==='select')return Promise.resolve({text:JSON.stringify({topics:[{title:'Release',refs:body.inputs.map(input=>input.key)}]})})
  if(request.usage?.operation==='reconcile')return Promise.resolve({text:JSON.stringify({groups:[{members:body.topics.map(topic=>topic.id)}]})})
  assert.equal(request.usage?.operation,'compose')
  const ids=body.inputs.map(input=>input.text.split(' ')[1]!)
  calls.push(ids)
  if(fail&&ids.includes('m15'))throw Error('temporary network failure')
  return Promise.resolve({text:'{"cards":[]}'})
 }}
 const cache=new TimelineCache(join(dir,'cache.json')),brief=new TimelineBrief(join(dir,'timeline.json'),new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline,()=>undefined,{cache})
 try{
  await cache.open();await brief.open();brief.update(inputs,'2026-10-31','UTC');await brief.refresh()
  const before=calls.length;fail=false;await brief.refresh()
  assert.deepEqual(calls.slice(before),[['m15']],'completed old-only chunks must not be recomposed')
 }finally{await brief.close();await cache.flush();await rm(dir,{recursive:true,force:true})}
})

for(const restart of [false,true])for(const empty of [false,true])test(`partial timeline retries only failed inputs after ${restart?'restart':'force refresh'} with ${empty?'empty':'published'} successful batches`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-partial-')),path=join(dir,'timeline.json'),cachePath=join(dir,'cache.json')
 let fail=true
 const composed:string[][]=[]
 const gateway:ModelGateway={stream(){throw Error('unexpected streaming request')},complete(request:CompleteRequest){
  const body=JSON.parse(request.prompt) as {inputs:{key:string;text:string}[];topics:{id:string}[];cards:unknown[]}
  const operation=request.usage?.operation
  if(operation==='select')return Promise.resolve({text:JSON.stringify({topics:body.inputs.map(input=>({title:input.text,refs:[input.key]}))})})
  if(operation==='reconcile')return Promise.resolve({text:JSON.stringify({groups:body.topics.map(topic=>({members:[topic.id]}))})})
  if(operation==='review')return Promise.resolve({text:JSON.stringify({cards:body.cards})})
  assert.equal(operation,'compose')
  composed.push(body.inputs.map(input=>input.text))
  if(fail&&body.inputs.some(input=>input.text==='Update 4'))throw Error('temporary network failure')
  return Promise.resolve({text:JSON.stringify({cards:empty?[]:body.inputs.map(input=>({temporal:{kind:'event',dates:[]},category:'Progress',title:input.text,why_now:'A result was recorded',facts:[{text:input.text,quote:input.text,ref:input.key}],uncertainty:'',actions:[],refs:[input.key]}))})})
 }}
 const inputs:TimelineInput[]=Array.from({length:5},(_,i)=>({id:'m'+i,version:'1',kind:'im',group:'g'+i,text:'Update '+i,observed_at:'2026-10-31T00:00:00Z'}))
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 let cache=new TimelineCache(cachePath),brief=new TimelineBrief(path,writer.generateTimeline,()=>undefined,{cache})
 try{
  await cache.open();await brief.open();brief.update(inputs,'2026-10-31','UTC');await brief.refresh()
  assert.equal(brief.snapshot().cards.length,empty?0:4)
  assert.equal(brief.snapshot().diagnostics?.failed_batches.length,1)
  const partial=JSON.parse(await readFile(path,'utf8')) as {checkpoint:{generation:string;input_versions:{id:string}[]}}
  assert.deepEqual(partial.checkpoint.input_versions.map(input=>input.id).sort(),['m0','m1','m2','m3'],'failed input must remain dirty')
  assert.equal(partial.checkpoint.generation,'','partial result must not claim a complete generation')
  if(restart){await brief.close();await cache.flush();cache=new TimelineCache(cachePath);await cache.open();brief=new TimelineBrief(path,writer.generateTimeline,()=>undefined,{cache});await brief.open();brief.update(inputs,'2026-10-31','UTC')}
  fail=false
  const before=composed.length
  await brief.refresh({force:!restart})
  assert.equal(brief.snapshot().cards.length,empty?0:5)
  assert.deepEqual(composed.slice(before),[['Update 4']],'successful batch must not be billed again')
  assert.deepEqual(brief.snapshot().diagnostics?.failed_batches,[])
  assert.ok(brief.snapshot().checkpoint.generation)
  await brief.refresh({force:true})
  assert.equal(composed.length,before+1,'fully covered empty topics are complete too')
 }finally{await brief.close();await cache.flush();await rm(dir,{recursive:true,force:true})}
})

test('revoked timeline cannot backfill a partial generation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-partial-revoked-'))
 let release!:()=>void,started!:()=>void
 const pending=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{started=resolve})
 const input:TimelineInput={id:'m',version:'1',kind:'im',text:'Release passed',observed_at:'2026-10-31T00:00:00Z'}
 const brief=new TimelineBrief(join(dir,'timeline.json'),async()=>{started();await pending;return {cards:[{category:'Release',title:'Release passed',why_now:'A result was recorded',facts:[{text:input.text,quote:input.text,ref:input.id}],uncertainty:'',actions:[],refs:[input.id]}]}},()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-31','UTC');const run=brief.refresh();await ready
  brief.setAccess({scope:'local',allowed:false,legacy_refs:[]});release();await run
  assert.equal(brief.snapshot().cards.length,0)
  assert.equal(brief.snapshot().checkpoint.generation,'')
  assert.deepEqual((JSON.parse(await readFile(join(dir,'timeline.json'),'utf8')) as {cards:unknown[]}).cards,[])
 }finally{release?.();await brief.close();await rm(dir,{recursive:true,force:true})}
})

for(const reason of ['failed_batch','pending_batch','failure'])test(`an old falsely complete checkpoint with ${reason} retries after restart`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'timeline-legacy-partial-')),path=join(dir,'timeline.json')
 const input:TimelineInput={id:'m',version:'1',kind:'im',text:'Release passed',observed_at:'2026-10-31T00:00:00Z'}
 const contexts:{new_input_ids?:string[]}[]=[]
 const generate:TimelineGenerator=(_inputs,context)=>{contexts.push(context);return Promise.resolve({cards:[]})}
 let brief=new TimelineBrief(path,generate,()=>undefined)
 try{
  await brief.open();brief.update([input],'2026-10-31','UTC');await brief.refresh();await brief.close()
  const saved=JSON.parse(await readFile(path,'utf8')) as {diagnostics:{failed_batches:unknown[];pending_batches:number};failure:unknown}
  if(reason==='failed_batch')saved.diagnostics.failed_batches=[{batch:1,reason:'generation_failed'}]
  if(reason==='pending_batch')saved.diagnostics.pending_batches=1
  if(reason==='failure')saved.failure={name:'Error',code:'unavailable'}
  await writeFile(path,JSON.stringify(saved))
  brief=new TimelineBrief(path,generate,()=>undefined);await brief.open();brief.update([input],'2026-10-31','UTC');await brief.refresh({force:false})
  assert.equal(contexts.length,2,'failure evidence invalidates the old whole-pool checkpoint')
  assert.deepEqual(contexts[1]!.new_input_ids,['m'])
  assert.ok(brief.snapshot().checkpoint.generation)
 }finally{await brief.close();await rm(dir,{recursive:true,force:true})}
})
