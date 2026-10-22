import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createChatCompletionsLlmFactory} from '../src/realtime/cascaded/chat-completions-llm.js'
import {createArkCascadedLlmSession,createArkCascadedLlmFactory} from '../src/realtime/cascaded/ark-llm.js'
import type {CascadedLlmEvent} from '../src/realtime/cascaded/llm.js'
import type {ArkResponsesGateway,ArkStreamInput} from '../src/realtime/volcengine/ark.js'
import type {JsonValue} from '../src/core/events.js'
import {configuredTextLlm} from '../src/cascaded-text-provider.js'
import {loadSettings} from '../src/config/config.js'
import {VirtualClock} from '../src/core/clock.js'
import {BUILD_LLM_TRANSPORT,PLAN_LLM_TRANSPORT,llmToolCallLimit} from '../src/realtime/cascaded/llm-stream-limits.js'
const signal=new AbortController().signal
const tools=[{name:'file_read',parameters:{type:'object'}}]
async function collect(stream:AsyncIterable<CascadedLlmEvent>){const events=[];for await(const event of stream)events.push(event);return events}
function sse(events:Record<string,unknown>[]){return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})}

for(const protocol of ['chat-completions','responses','ark'] as const)test(`Plan ${protocol} pairs parallel calls across restart and rejects incomplete or duplicate results`,async context=>{
 const requests:Record<string,unknown>[]=[],responses=protocol!=='chat-completions'
 const calls=[{id:'item-a',type:'function_call',call_id:'a',name:'monitor',arguments:'{"project":"One"}'},{id:'item-b',type:'function_call',call_id:'b',name:'monitor',arguments:'{"project":"Two"}'}]
 context.mock.method(globalThis,'fetch',(_url:unknown,init?:RequestInit)=>{
  requests.push(JSON.parse(init!.body as string) as Record<string,unknown>)
  if(requests.length>1)return Promise.resolve(sse(responses?[{type:'response.created',response:{id:'r2'}},{type:'response.output_text.delta',delta:'Plan ready'},{type:'response.completed',response:{id:'r2',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Plan ready'}]}]}}]:[{id:'r2',choices:[{delta:{content:'Plan ready'},finish_reason:'stop'}]}]))
  return Promise.resolve(sse(responses?[
   {type:'response.created',response:{id:'r1'}},...calls.map(item=>({type:'response.output_item.done',item})),{type:'response.completed',response:{id:'r1',output:calls}},
  ]:[
   {id:'r1',choices:[{delta:{tool_calls:[{index:1,id:'b',function:{name:'monitor',arguments:'{"project":"'}},{index:0,id:'a',function:{name:'monitor',arguments:'{"project":"'}}]}}]},
   {id:'r1',choices:[{delta:{tool_calls:[{index:0,function:{arguments:'One"}'}},{index:1,function:{arguments:'Two"}'}}]},finish_reason:'tool_calls'}]},
  ]))
 })
 const settings=loadSettings(protocol==='ark'?{CASCADE_LLM_PROVIDER:'ark',ARK_API_KEY:'synthetic'}:{CASCADE_LLM_PROVIDER:'openai-compatible',OPENAI_COMPATIBLE_API_KEY:'synthetic',OPENAI_COMPATIBLE_BASE_URL:'https://example.test',OPENAI_COMPATIBLE_PROTOCOL:protocol,CASCADE_LLM_MODEL:'test'},true)
 const factory=configuredTextLlm({settings,clock:new VirtualClock(),idFactory:()=>crypto.randomUUID(),instructions:'Plan',transport:PLAN_LLM_TRANSPORT}),first=factory.open()
 first.checkpoint!()
 const input={tools:[{name:'monitor',parameters:{type:'object'}}],signal}
 const events=await collect(first.stream({...input,inputs:[{kind:'user_text',text:'Inspect both projects and plan'}]}))
 assert.equal(events.at(-1)?.kind,'response_completed');assert.deepEqual(events.filter(e=>e.kind==='tool_call').map(e=>e.call_id),['a','b'])
 assert.equal(requests[0]!.parallel_tool_calls,true)
 const checkpoint=JSON.parse(JSON.stringify(first.checkpoint!())) as JsonValue;await first.close()
 const restored=factory.open();restored.restoreCheckpoint!(checkpoint)
 try{
  for(const ids of [['a'],['a','a'],['a','unknown']])await assert.rejects(collect(restored.stream({...input,inputs:ids.map(call_id=>({kind:'tool_result',call_id,output:{status:'observed'}}))})),/protocol/)
  assert.equal(requests.length,1,'bad tool receipts must never reach the provider')
  const completed=await collect(restored.stream({...input,inputs:[{kind:'tool_result',call_id:'b',output:{progress:'Two progress'}},{kind:'tool_result',call_id:'a',output:{progress:'One progress'}}]}))
  assert.equal(completed.at(-1)?.kind,'response_completed')
  const wire=JSON.stringify(requests[1]);assert.match(wire,/Two progress/);assert.match(wire,/One progress/)
  const done=restored.checkpoint!(),again=factory.open();again.restoreCheckpoint!(done);await again.close()
 }finally{await restored.close()}
})

test('Responses accepts the earlier pending_call_id checkpoint format',async()=>{
 const session=createArkCascadedLlmSession({async *stream(){await Promise.resolve();yield {kind:'response_started',response_id:'restored'};yield {kind:'response_completed',response_id:'restored'}},close:()=>Promise.resolve()})
 session.restoreCheckpoint!({protocol:'responses',history:[],pending:[{type:'function_call',call_id:'old',name:'monitor',arguments:'{}'}],pending_call_id:'old'})
 assert.equal((await collect(session.stream({inputs:[{kind:'tool_result',call_id:'old',output:{status:'done'}}],tools:[],signal}))).at(-1)?.kind,'response_completed')
 await session.close()
})

test('Build LLM transport accepts up to 64 tool calls in one model response',{timeout:30000},async context=>{
 assert.equal(BUILD_LLM_TRANSPORT.maxToolCallsPerResponse,64);assert.equal(PLAN_LLM_TRANSPORT.maxToolCallsPerResponse,24);assert.equal(llmToolCallLimit(BUILD_LLM_TRANSPORT),64)
 const calls=Array.from({length:32},(_,index)=>({index,id:`build-${index}`,function:{name:'file_read',arguments:JSON.stringify({path:`file-${index}.txt`})}}))
 context.mock.method(globalThis,'fetch',()=>Promise.resolve(sse([{id:'build-batch',choices:[{delta:{tool_calls:calls},finish_reason:'tool_calls'}]}])))
 const session=createChatCompletionsLlmFactory({provider:'deepseek',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Build',...BUILD_LLM_TRANSPORT,fetchImpl:globalThis.fetch}).open()
 try{const events=await collect(session.stream({inputs:[{kind:'user_text',text:'Inspect the files'}],tools,signal}));assert.equal(events.at(-1)?.kind,'response_completed');assert.equal(events.filter(event=>event.kind==='tool_call').length,32)}finally{await session.close()}
})

for(const invalid of ['duplicate','malformed','limit','checkpoint'] as const)test(`Responses refuses a ${invalid} batch before exposing any executable call`,async()=>{
 const calls=[{type:'function_call',id:'item-a',call_id:'a',name:'monitor',arguments:'{}'},{type:'function_call',id:'item-b',call_id:invalid==='duplicate'?'a':'b',name:'monitor',arguments:invalid==='malformed'?'{':'{}'}]
 const factory=createArkCascadedLlmFactory({protocol:'openai-compatible',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Plan',maxToolCallsPerResponse:invalid==='limit'?1:24,fetchImpl:()=>Promise.resolve(sse([{type:'response.created',response:{id:'r'}},...calls.map(item=>({type:'response.output_item.done',item})),{type:'response.completed',response:{id:'r',output:invalid==='checkpoint'?calls.slice(0,1):calls}}]))}),session=factory.open()
 try{
  session.checkpoint!()
  const events=await collect(session.stream({inputs:[],tools,signal}));assert.equal(events.some(event=>event.kind==='tool_call'),false)
  assert.deepEqual(events.at(-1),{kind:'response_failed',response_id:'r',code:'protocol'})
 }finally{await session.close()}
})

for(const invalid of ['duplicate','malformed','limit'] as const)test(`Chat Completions refuses a ${invalid} batch before exposing any executable call`,async()=>{
 const calls=[{index:0,id:'a',function:{name:'monitor',arguments:'{}'}},{index:1,id:invalid==='duplicate'?'a':'b',function:{name:'monitor',arguments:invalid==='malformed'?'{':'{}'}}]
 const factory=createChatCompletionsLlmFactory({provider:'deepseek',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Plan',maxToolCallsPerResponse:invalid==='limit'?1:24,fetchImpl:()=>Promise.resolve(sse([{id:'r',choices:[{delta:{tool_calls:calls},finish_reason:'tool_calls'}]}]))}),session=factory.open()
 try{
  const events=await collect(session.stream({inputs:[],tools,signal}));assert.equal(events.some(event=>event.kind==='tool_call'),false)
  assert.deepEqual(events.at(-1),{kind:'response_failed',response_id:'r',code:'protocol',detail:invalid==='duplicate'?'tool_identity':invalid==='malformed'?'tool_arguments_json':'tool_call_limit',...(invalid==='limit'?{}:{tool_call_count:2})})
 }finally{await session.close()}
})

for(const provider of ['chat-completions','responses','ark'] as const){
 const responses=provider!=='chat-completions'
 const settings=()=>loadSettings(provider==='ark'?{CASCADE_LLM_PROVIDER:'ark',ARK_API_KEY:'test'}:{CASCADE_LLM_PROVIDER:'openai-compatible',CASCADE_LLM_MODEL:'test-model',OPENAI_COMPATIBLE_BASE_URL:'https://example.test/v1',OPENAI_COMPATIBLE_API_KEY:'test',OPENAI_COMPATIBLE_PROTOCOL:provider},true)
 const configured=(build:boolean)=>configuredTextLlm({settings:settings(),clock:new VirtualClock(),idFactory:()=>crypto.randomUUID(),instructions:'Build',...(build?{transport:BUILD_LLM_TRANSPORT}:{})}).open()
 const terminal=()=>responses?{type:'response.completed',response:{id:'r',output:[]}}:{id:'r',choices:[{delta:{content:'done'},finish_reason:'stop'}]}
 const prefix=()=>responses?{type:'response.created',response:{id:'r'}}:{id:'r',choices:[]}

 test(`Build ${provider} survives 120 seconds without model data and still honors Stop`,async context=>{
  context.mock.timers.enable({apis:['setTimeout']})
  let sink!:ReadableStreamDefaultController<Uint8Array>,cancelled=false,finished=false
  context.mock.method(globalThis,'fetch',()=>Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(controller){sink=controller;controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(prefix())+'\n\n'))},cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}})))
  const session=configured(true),own=new AbortController()
  try{
   const pending=collect(session.stream({inputs:[{kind:'user_text',text:'build'}],tools:[],signal:own.signal})).finally(()=>{finished=true})
   await new Promise<void>(resolve=>setImmediate(resolve));context.mock.timers.tick(120001);await new Promise<void>(resolve=>setImmediate(resolve))
   assert.equal(finished,false,'Build must not inherit the 30-second model idle or 120-second turn deadline')
   sink.enqueue(new TextEncoder().encode('data: '+JSON.stringify(terminal())+'\n\n'));sink.close()
   assert.equal((await pending).at(-1)?.kind,'response_completed')
   const stopped=collect(session.stream({inputs:[{kind:'user_text',text:'next'}],tools:[],signal:own.signal}))
   await new Promise<void>(resolve=>setImmediate(resolve));own.abort();await stopped
   assert.equal(cancelled,true)
  }finally{await session.close();context.mock.timers.reset()}
 })

 test(`Build ${provider} has a 10-minute idle bound; ordinary text retains 30 seconds`,async context=>{
  context.mock.timers.enable({apis:['setTimeout']})
  context.mock.method(globalThis,'fetch',()=>Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(prefix())+'\n\n'))}}),{headers:{'content-type':'text/event-stream'}})))
  for(const build of [false,true]){
   const session=configured(build)
   try{const pending=collect(session.stream({inputs:[],tools:[],signal}));await new Promise<void>(resolve=>setImmediate(resolve));context.mock.timers.tick(build?600001:30001);const last=(await pending).at(-1);assert.equal(last?.kind,'response_failed');assert.equal(last.kind==='response_failed'?last.code:null,'timeout')}
   finally{await session.close()}
  }
  context.mock.timers.reset()
 })

 test(`Build ${provider} accepts long streamed responses and large file arguments`,async context=>{
  let events:Record<string,unknown>[]=[]
  context.mock.method(globalThis,'fetch',()=>Promise.resolve(sse(events)))
  const deltas=Array.from({length:5000},()=>responses?{type:'response.output_text.delta',delta:'a'}:{id:'r',choices:[{delta:{content:'a'}}]})
  events=[prefix(),...deltas,terminal()]
  const ordinary=configured(false),build=configured(true)
  try{
   assert.equal((await collect(ordinary.stream({inputs:[],tools:[],signal}))).at(-1)?.kind,'response_failed')
   assert.equal((await collect(build.stream({inputs:[],tools:[],signal}))).at(-1)?.kind,'response_completed')
  }finally{await ordinary.close();await build.close()}
  const args=JSON.stringify({path:'large.txt',content:'源代码'.repeat(100000)}),call={id:'i',type:'function_call',call_id:'write',name:'file_write',arguments:args}
  events=responses?[prefix(),{type:'response.output_item.done',item:call},{type:'response.completed',response:{id:'r',output:[call]}}]:[{id:'r',choices:[{delta:{tool_calls:[{index:0,id:'write',function:{name:'file_write',arguments:args}}]},finish_reason:'tool_calls'}]}]
  const writer=configured(true)
  try{const output=await collect(writer.stream({inputs:[],tools,signal}));assert.equal(output.at(-1)?.kind,'response_completed');assert.ok(output.some(event=>event.kind==='tool_call'&&event.name==='file_write'))}
  finally{await writer.close()}
 })
}

test('Chat Completions checkpoint restores outstanding tool chain, provider extras and large plan context',async()=>{
 const requests:Record<string,unknown>[]=[],plan='确认计划。'.repeat(30000)
 const factory=createChatCompletionsLlmFactory({provider:'gemini',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Build Markdown',fetchImpl:(_url,init)=>{
  assert.equal(typeof init?.body,'string');requests.push(JSON.parse(init!.body as string) as Record<string,unknown>)
  return Promise.resolve(sse(requests.length===1?[
   {id:'r1',choices:[{delta:{tool_calls:[{index:0,id:'read-1',extra_content:{google:{thought_signature:'opaque-signature'}},function:{name:'file_read',arguments:'{"path":"src.ts"}'}}]}}]},
   {id:'r1',choices:[{delta:{},finish_reason:'tool_calls'}]},
  ]:[{id:'r2',choices:[{delta:{content:'# 完成'},finish_reason:'stop'}]}]))
 }})
 const first=factory.open();first.setHistoryLimits!({items:512,codepoints:8*1024*1024})
 await collect(first.stream({inputs:[{kind:'host_context',content:plan},{kind:'user_text',text:'实现'}],tools,signal}))
 const checkpoint=JSON.parse(JSON.stringify(first.checkpoint!())) as JsonValue;await first.close()
 const restored=factory.open();restored.setHistoryLimits!({items:512,codepoints:8*1024*1024});restored.restoreCheckpoint!(checkpoint)
 await assert.rejects(collect(restored.stream({inputs:[{kind:'user_text',text:'missing result'}],tools,signal})),/protocol/)
 const events=await collect(restored.stream({inputs:[{kind:'tool_result',call_id:'read-1',output:{content:'actual file'}},{kind:'user_text',text:'补充要求'}],tools,signal}))
 assert.ok(events.some(event=>event.kind==='text_delta'&&event.text==='# 完成'))
 const wire=JSON.stringify(requests[1]);assert.ok(wire.includes(plan));assert.match(wire,/opaque-signature/);assert.match(wire,/actual file/);assert.match(wire,/补充要求/)
 const completed=restored.checkpoint!();await restored.close();const again=factory.open();again.restoreCheckpoint!(completed);await again.close()
})

test('Responses portable checkpoint restores function pairs without server-side response IDs',async()=>{
 const requests:ArkStreamInput[]=[]
 const gateway:ArkResponsesGateway={async *stream(request){await Promise.resolve();requests.push(request);yield {kind:'response_started',response_id:'r'+requests.length};if(requests.length===1)yield {kind:'tool_call',response_id:'r1',item_id:'i1',call_id:'c1',name:'file_read',arguments:{path:'a'}};else yield {kind:'text_delta',response_id:'r2',text:'done'};yield {kind:'response_completed',response_id:'r'+requests.length}},close:()=>Promise.resolve()}
 const first=createArkCascadedLlmSession(gateway);first.checkpoint!()
 await collect(first.stream({inputs:[{kind:'user_text',text:'full requirement'}],tools,signal}));const checkpoint=first.checkpoint!();await first.close()
 const restored=createArkCascadedLlmSession(gateway);restored.restoreCheckpoint!(checkpoint)
 await assert.rejects(collect(restored.stream({inputs:[{kind:'tool_result',call_id:'wrong',output:{}}],tools,signal})),/protocol/)
 await collect(restored.stream({inputs:[{kind:'tool_result',call_id:'c1',output:{content:'file'}},{kind:'user_text',text:'steering after pause'}],tools,signal}))
 assert.equal(requests[1]!.previousResponseId,null);const wire=JSON.stringify(requests[1]!.inputItems)
 assert.match(wire,/full requirement/);assert.match(wire,/function_call/);assert.match(wire,/function_call_output/);assert.match(wire,/steering after pause/)
 await restored.close()
})

test('Responses compatible checkpoint retains opaque reasoning and matching tool output',async()=>{
 const requests:Record<string,unknown>[]=[],factory=createArkCascadedLlmFactory({protocol:'openai-compatible',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Build',fetchImpl:(_url,init)=>{
  assert.equal(typeof init?.body,'string');requests.push(JSON.parse(init!.body as string) as Record<string,unknown>)
  if(requests.length===1)return Promise.resolve(sse([
   {type:'response.created',response:{id:'r1'}},
   {type:'response.output_item.done',item:{id:'i1',type:'function_call',call_id:'c1',name:'file_read',arguments:'{"path":"a"}'}},
   {type:'response.completed',response:{id:'r1',output:[{id:'reasoning1',type:'reasoning',encrypted_content:'opaque'},{id:'i1',type:'function_call',call_id:'c1',name:'file_read',arguments:'{"path":"a"}'}]}},
  ]))
  return Promise.resolve(sse([{type:'response.created',response:{id:'r2'}},{type:'response.output_text.delta',delta:'done'},{type:'response.completed',response:{id:'r2',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}]}}]))
 }})
 const first=factory.open();first.checkpoint!();await collect(first.stream({inputs:[{kind:'user_text',text:'do it'}],tools,signal}));const state=first.checkpoint!();await first.close()
 const restored=factory.open();restored.restoreCheckpoint!(state);await collect(restored.stream({inputs:[{kind:'tool_result',call_id:'c1',output:{content:'a'}}],tools,signal}))
 assert.match(JSON.stringify(requests[1]),/encrypted_content/);assert.match(JSON.stringify(requests[1]),/opaque/);assert.match(JSON.stringify(requests[1]),/function_call_output/);assert.equal(requests[1]!.previous_response_id,undefined)
 await restored.close()
})
