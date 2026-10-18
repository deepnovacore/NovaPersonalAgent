import {decide} from '../src/model/jev-client.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {RealClock} from '../src/core/clock.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import type {UsageReport} from '../src/realtime/usage.js'

const request={model:'qwen3-vl-plus',system:'private instructions',prompt:'private content'}
const rawUsage={prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:40},completion_tokens_details:{reasoning_tokens:5}}
function gateway(fetch:typeof globalThis.fetch,reports:UsageReport[]){
 return new OpenAIModelGateway({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'secret',clock:new RealClock(),fetch,metrics:{record(){/* quiet test sink */}},onUsage:(r:UsageReport)=>reports.push(r)})
}
test('gateway reports usage once per actual call without logging content',async()=>{
 const reports:UsageReport[]=[]
 const g=gateway(()=>Promise.resolve(Response.json({id:'provider-id',usage:rawUsage,choices:[{finish_reason:'stop',message:{content:'private answer'}}]})),reports)
 await g.complete(request);await g.complete(request)
 assert.equal(reports.length,2)
 assert.equal(reports[0]?.inputTokens,100)
 assert.equal(reports[0]?.cachedTokens,40)
 assert.equal(reports[0]?.reasoningTokens,5)
 assert.notEqual(reports[0]?.id,reports[1]?.id)
 assert.doesNotMatch(JSON.stringify(reports),/secret|private/)
})
test('SSE trailing usage is counted and HTTP failure is visible as missing usage',async()=>{
 const reports:UsageReport[]=[]
 const stream='data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({usage:rawUsage,choices:[]})+'\n\ndata: [DONE]\n\n'
 const deltas=[]
 for await(const delta of gateway(()=>Promise.resolve(new Response(stream)),reports).stream(request))deltas.push(delta)
 assert.equal(deltas.length,1)
 await assert.rejects(gateway(()=>Promise.resolve(new Response('',{status:429})),reports).complete(request))
 assert.equal(reports.length,2)
 assert.equal(reports[0]?.outputTokens,20)
 assert.equal(reports[1]?.status,'missing')
})
test('embeddings record each batch and do not invent completion tokens',async()=>{
 const reports:UsageReport[]=[]
 const embedding=new DashScopeEmbeddingProvider({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1/',apiKey:'secret',dims:1,onUsage:(r:UsageReport)=>reports.push(r),fetch:(_input:unknown,init?:RequestInit)=>{
  assert.equal(typeof init?.body,'string')
  const texts=(JSON.parse(init?.body as string) as {input:string[]}).input
  return Promise.resolve(Response.json({usage:{prompt_tokens:texts.length*10},data:texts.map((_,index)=>({index,embedding:[1]}))}))
 }})
 assert.equal((await embedding.embed(Array.from({length:11},(_,i)=>'document '+i))).length,11)
 assert.equal(reports.length,2)
 assert.deepEqual(reports.map(r=>r.inputTokens),[100,10])
 assert.equal(reports[0]?.outputTokens,undefined)
 assert.equal(reports[0]?.status,'complete')
})

test('sparse stream usage retains earlier meters when the consumer cancels',async()=>{
 const reports:UsageReport[]=[]
 const chunks=[{usage:rawUsage,choices:[{delta:{content:'first'}}]},{usage:{completion_tokens:21},choices:[{delta:{content:'second'}}]}]
 const stream=chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')
 for await(const delta of gateway(()=>Promise.resolve(new Response(stream)),reports).stream(request)){
  if(delta.kind==='text'&&delta.text==='second')break
 }
 assert.equal(reports.length,1)
 assert.equal(reports[0]?.inputTokens,100)
 assert.equal(reports[0]?.outputTokens,21)
 assert.equal(reports[0]?.cachedTokens,40)
 assert.equal(reports[0]?.outcome,'cancelled')
})
test('successful JSON without finish_reason and throwing observers preserve the answer',async()=>{
 const reports:UsageReport[]=[]
 const fetcher=()=>Promise.resolve(Response.json({usage:rawUsage,choices:[{message:{content:'answer'}}]}))
 await gateway(fetcher,reports).complete(request)
 assert.equal(reports[0]?.outcome,'success')
 const g=new OpenAIModelGateway({baseUrl:'https://example.test',apiKey:'secret',clock:new RealClock(),fetch:fetcher,onUsage(){throw Error('observer')},metrics:{record(){throw Error('metrics')}}})
 assert.deepEqual(await g.complete(request),{text:'answer'})
})

test('OpenRouter decisions retain billed cost even when answer validation fails',async()=>{
 const reports:UsageReport[]=[]
 await assert.rejects(decide({apiKey:'secret',onUsage:r=>reports.push(r),fetcher:()=>Promise.resolve(Response.json({answers:{},usage:{prompt_tokens:10,completion_tokens:5,cost:.003}}))},{private:'content'},{rank:{type:'choice',instructions:'private',criteria:{yes:'yes'}}},new AbortController().signal))
 assert.equal(reports.length,1)
 assert.equal(reports[0]?.reportedCostUsd,.003)
 assert.equal(reports[0]?.outcome,'error')
 assert.doesNotMatch(JSON.stringify(reports),/secret|private/)
})
