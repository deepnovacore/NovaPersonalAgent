import {test} from 'node:test'
import assert from 'node:assert/strict'
import {selectTimelineEvidence,parseTimelineJson} from '../src/model/timeline-selection.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

test('transport wrappers are normalized without extracting embedded prose',()=>{
 const topics=[{title:'Update',refs:['e0']}]
 for(const text of [JSON.stringify(topics),JSON.stringify(JSON.stringify({topics})),'```json\n'+JSON.stringify({topics})+'\n```'])assert.deepEqual(parseTimelineJson(text,'topics'),{topics})
 assert.throws(()=>parseTimelineJson('Explanation before '+JSON.stringify({topics}),'topics'),SyntaxError)
})

test('screening reads every message, retains independent batch topics, and returns originals',async()=>{
 const inputs=Array.from({length:1200},(_,i)=>({id:String(i),version:'1',kind:'im',group:'chat'+i%8,text:'message '+i,observed_at:'2026-10-17T00:00:00Z'}))
 const read=new Set<string>();let calls=0
 const gateway={complete:async(request:{prompt:string})=>{
  assert.ok(JSON.parse(request.prompt).output_schema,'JSON-mode gateways also need the schema in the prompt');const {inputs:batch}=JSON.parse(request.prompt) as {inputs:{key:string;text:string}[]};calls++;batch.forEach(x=>read.add(x.text))
  return {text:JSON.stringify({topics:[{title:'First topic',refs:[batch[0]!.key]},{title:'Latest update',refs:[batch.at(-1)!.key]}]})}
 }} as unknown as ModelGateway
 const result=await selectTimelineEvidence(gateway,'fixture',inputs,{local_date:'2026-10-17',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.equal(calls,6);assert.equal(read.size,1200);assert.equal(result.length,12)
 assert.ok(result.every(item=>inputs.some(original=>original===item)))
 assert.ok(result.some(item=>item.id==='1199'))
})
test('screening rejects references outside the batch rather than accepting invented evidence',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:String(i),version:'1',kind:'im',text:'message',observed_at:'2026-10-17T00:00:00Z'}))
 const gateway={complete:async()=>({text:JSON.stringify({topics:[{title:'Invalid',refs:['invented']} ]})})} as unknown as ModelGateway
 await assert.rejects(selectTimelineEvidence(gateway,'fixture',inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal),/invalid_timeline_selection/)
})

test('screening repairs alternate reference fields once for JSON-mode providers',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:String(i),version:'1',kind:'im',text:'message',observed_at:'2026-10-17T00:00:00Z'}))
 let repairs=0
 const gateway={complete:async(request:{prompt:string})=>{
  if(request.prompt.includes('上一轮格式未通过')){repairs++;return {text:JSON.stringify({topics:[{title:'Grounded topic',refs:['e0']}]})}}
  assert.ok(JSON.parse(request.prompt).output_schema)
  return {text:JSON.stringify({topics:[{title:'Grounded topic',keys:['e0']}]})}
 }} as unknown as ModelGateway
 const result=await selectTimelineEvidence(gateway,'fixture',inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(repairs,2);assert.deepEqual(result.map(x=>x.id),['0','200'])
})

test('screening topic indexes can retain more than sixteen related messages',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:String(i),version:'1',kind:'im',text:'message',observed_at:'2026-10-17T00:00:00Z'}))
 const gateway={complete:async(request:{prompt:string})=>{
  const batch=JSON.parse(request.prompt).inputs as {key:string}[]
  return {text:JSON.stringify({topics:[{title:'Repeated alerts and their recovery',refs:batch.slice(0,40).map(x=>x.key)}]})}
 }} as unknown as ModelGateway
 const result=await selectTimelineEvidence(gateway,'fixture',inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(result.length,41);assert(result.some(x=>x.id==='39'))
})

test('a batch with extra grounded topics and provider metadata still reaches composition',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:String(i),version:'1',kind:'im',text:'message',observed_at:'2026-10-17T00:00:00Z'}))
 const gateway={complete:async(request:{prompt:string})=>{
  const batch=JSON.parse(request.prompt).inputs as {key:string}[]
  return {text:JSON.stringify({type:'json_object',topics:batch.slice(0,20).map(x=>({title:'Independent topic '.repeat(12),refs:[x.key],note:'unused metadata'}))})}
 }} as unknown as ModelGateway
 const result=await selectTimelineEvidence(gateway,'fixture',inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(result.length,21);assert.ok(result.some(x=>x.id==='200'))
})

test('large pools retain every selected original rather than silently truncating at 60000 characters',async()=>{
 const inputs=Array.from({length:500},(_,i)=>({id:String(i),version:'1',kind:'im',text:String(i).padEnd(1000,'x'),observed_at:'2026-10-17T00:00:00Z'}))
 let read=0
 const gateway={complete:async(request:{prompt:string})=>{const batch=JSON.parse(request.prompt).inputs as {key:string}[];read+=batch.length;return {text:JSON.stringify({topics:[{title:'Batch topic',refs:batch.map(x=>x.key)}]})}}} as unknown as ModelGateway
 const result=await selectTimelineEvidence(gateway,'fixture',inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(read,500);assert.equal(result.length,500)
 assert.ok(result.some(x=>Number(x.id)>=480),'late batches remain represented')
})

test('a transient batch failure retries only that batch once',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:String(i),version:'1',kind:'im',text:String(i),observed_at:'2026-10-17T00:00:00Z'}))
 const attempts=new Map<string,number>()
 const gateway={complete:async(request:{prompt:string})=>{
  const body=request.prompt.split('\n上一轮')[0]!,first=(JSON.parse(body).inputs as {key:string;text:string}[])[0]!;const count=(attempts.get(first.text)??0)+1;attempts.set(first.text,count)
  if(first.text==='0'&&count===1)throw Error('temporary transport failure')
  return {text:JSON.stringify({topics:[{title:'Update',refs:[first.key]}]})}
 }} as unknown as ModelGateway
 const result=await selectTimelineEvidence(gateway,'fixture',inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(attempts.get('0'),2);assert.equal(attempts.get('200'),1);assert.equal(result.length,2)
})

test('composition batches keep all topics and shared updates within bounded requests',async()=>{
 const {timelineCompositionBatches}=await import('../src/model/timeline-selection.js')
 const inputs=Array.from({length:201},(_,i)=>({id:String(i),version:'1',kind:'im',text:String(i).padEnd(1000,'x'),observed_at:'2026-10-17T00:00:00Z'}))
 const topics=inputs.map(input=>({title:input.id,inputs:[input]}))
 topics.push({title:'Recovery',inputs:[inputs[0]!,inputs[200]!]})
 const batches=timelineCompositionBatches(topics)
 assert.equal(new Set(batches.flat(2).flatMap(topic=>topic.inputs.map(input=>input.id))).size,201)
 assert.ok(batches.every(batch=>batch.reduce((sum,topic)=>sum+topic.inputs.reduce((n,input)=>n+input.text.length,0),0)<=60000))
 assert.ok(batches.some(batch=>batch.some(topic=>topic.inputs.some(input=>input.id==='0')&&topic.inputs.some(input=>input.id==='200'))))
})
