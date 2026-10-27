import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createChatCompletionsLlmFactory,MAX_REASONING_CODEPOINTS} from '../src/realtime/cascaded/chat-completions-llm.js'
import type {CascadedLlmEvent} from '../src/realtime/cascaded/llm.js'
const signal=new AbortController().signal
async function collect(stream:AsyncIterable<CascadedLlmEvent>){const events:CascadedLlmEvent[]=[];for await(const event of stream)events.push(event);return events}
function sse(events:Record<string,unknown>[]){return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})}
function textEvents(events:readonly CascadedLlmEvent[]){return events.filter((event):event is Extract<CascadedLlmEvent,{kind:'text_delta'}>=>event.kind==='text_delta').map(event=>event.text).join('')}
function reasoningEvents(events:readonly CascadedLlmEvent[]){return events.filter((event):event is Extract<CascadedLlmEvent,{kind:'reasoning_delta'}>=>event.kind==='reasoning_delta').map(event=>event.text).join('')}

const providers=[
 ['deepseek',{apiKey:'synthetic',baseUrl:'https://example.test'},{thinking:{type:'enabled'}},{thinking:{type:'disabled'}}],
 ['qwen',{apiKey:'synthetic',baseUrl:'https://example.test'},{enable_thinking:true},{enable_thinking:false}],
 ['openai',{apiKey:'synthetic',baseUrl:'https://example.test'},{reasoning_effort:'low'},{reasoning_effort:'none'}],
 ['self-hosted',{apiKey:'',baseUrl:'http://127.0.0.1:8000/v1'},{},{ }],
] as const

for(const [provider,connection,enabled,disabled] of providers)test(`${provider} sends reasoning flags only when reasoning is enabled`,async()=>{
 const requests:Record<string,unknown>[]=[]
 const factory=createChatCompletionsLlmFactory({provider,...connection,model:'test',instructions:'Plan',fetchImpl:(_url,init)=>{requests.push(JSON.parse(init!.body as string) as Record<string,unknown>);return Promise.resolve(sse([{id:'r1',choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]))}})
 const session=factory.open()
 try{
  await collect(session.stream({inputs:[{kind:'user_text',text:'first'}],tools:[],reasoning:'enabled',signal}))
  await collect(session.stream({inputs:[{kind:'user_text',text:'second'}],tools:[],reasoning:'disabled',signal}))
  const [withReasoning,withoutReasoning]=requests
  assert.deepEqual(Object.fromEntries(Object.entries(withReasoning!).filter(([key])=>key==='thinking'||key==='enable_thinking'||key==='reasoning_effort')),enabled)
  assert.deepEqual(Object.fromEntries(Object.entries(withoutReasoning!).filter(([key])=>key==='thinking'||key==='enable_thinking'||key==='reasoning_effort')),disabled)
 }finally{await session.close()}
})

test('legacy callers without the reasoning option keep the disabled provider shape',async()=>{
 const requests:Record<string,unknown>[]=[]
 const factory=createChatCompletionsLlmFactory({provider:'deepseek',apiKey:'synthetic',baseUrl:'https://example.test',model:'test',instructions:'Plan',fetchImpl:(_url,init)=>{requests.push(JSON.parse(init!.body as string) as Record<string,unknown>);return Promise.resolve(sse([{id:'r1',choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]))}}),session=factory.open()
 try{await collect(session.stream({inputs:[{kind:'user_text',text:'first'}],tools:[],signal}));assert.deepEqual(requests[0]!.thinking,{type:'disabled'})}finally{await session.close()}
})

test('provider-volunteered reasoning is dropped when reasoning is disabled or absent',async()=>{
 for(const reasoning of ['disabled',undefined] as const){
  const factory=createChatCompletionsLlmFactory({provider:'deepseek',apiKey:'synthetic',baseUrl:'https://example.test',model:'test',instructions:'Plan',fetchImpl:()=>Promise.resolve(sse([
   {id:'r1',choices:[{delta:{reasoning_content:'不该出现的思考'}}]},
   {id:'r1',choices:[{delta:{reasoning:'也不该出现'}}]},
   {id:'r1',choices:[{delta:{content:'可见正文'},finish_reason:'stop'}]},
  ]))}),session=factory.open()
  try{
   const events=await collect(session.stream({inputs:[{kind:'user_text',text:'问候'}],tools:[],...(reasoning===undefined?{}:{reasoning}),signal}))
   assert.equal(reasoningEvents(events),'')
   assert.equal(textEvents(events),'可见正文')
   assert.doesNotMatch(JSON.stringify(events),/不该出现的思考|也不该出现/u)
  }finally{await session.close()}
 }
})

test('reasoning_content and reasoning stream as reasoning_delta and never as text or history',async()=>{
 const factory=createChatCompletionsLlmFactory({provider:'deepseek',apiKey:'synthetic',baseUrl:'https://example.test',model:'test',instructions:'Plan',fetchImpl:()=>Promise.resolve(sse([
  {id:'r1',choices:[{delta:{reasoning_content:'先想一'}}]},
  {id:'r1',choices:[{delta:{reasoning:'想二'}}]},
  {id:'r1',choices:[{delta:{content:'你好'}}]},
  {id:'r1',choices:[{delta:{content:'世界'}}]},
  {id:'r1',choices:[{delta:{content:''},finish_reason:'stop'}]},
 ]))}),session=factory.open()
 try{
  const events=await collect(session.stream({inputs:[{kind:'user_text',text:'问候'}],tools:[],reasoning:'enabled',signal}))
  assert.equal(reasoningEvents(events),'先想一想二')
  assert.equal(textEvents(events),'你好世界')
  assert.equal(events.at(-1)?.kind,'response_completed')
  assert.doesNotMatch(JSON.stringify(events.filter(event=>event.kind==='text_delta')),/先想|想二/u)
  const history=(session.checkpoint!() as {history:{role:string;content:string}[][]}).history.flat()
  assert.equal(history.filter(message=>message.role==='assistant').at(-1)?.content,'你好世界')
  assert.doesNotMatch(JSON.stringify(session.checkpoint!()),/先想|想二/u)
 }finally{await session.close()}
})

test('reasoning output is bounded per response without truncating the visible text',async()=>{
 const chunk='思'.repeat(40_000)
 const factory=createChatCompletionsLlmFactory({provider:'deepseek',apiKey:'synthetic',baseUrl:'https://example.test',model:'test',instructions:'Plan',fetchImpl:()=>Promise.resolve(sse([
  {id:'r1',choices:[{delta:{reasoning_content:chunk}}]},
  {id:'r1',choices:[{delta:{reasoning_content:chunk}}]},
  {id:'r1',choices:[{delta:{reasoning_content:chunk}}]},
  {id:'r1',choices:[{delta:{content:'可见正文'},finish_reason:'stop'}]},
 ]))}),session=factory.open()
 try{
  const events=await collect(session.stream({inputs:[{kind:'user_text',text:'长推理'}],tools:[],reasoning:'enabled',signal}))
  assert.equal([...reasoningEvents(events)].length,MAX_REASONING_CODEPOINTS)
  assert.equal(textEvents(events),'可见正文')
 }finally{await session.close()}
})

test('a provider that rejects the thinking flag is retried once without reasoning and remembered',async()=>{
 const requests:Record<string,unknown>[]=[];let attempts=0
 const factory=createChatCompletionsLlmFactory({provider:'deepseek',apiKey:'synthetic',baseUrl:'https://example.test',model:'test',instructions:'Plan',fetchImpl:(_url,init)=>{
  requests.push(JSON.parse(init!.body as string) as Record<string,unknown>)
  if(attempts++===0)return Promise.resolve(new Response(JSON.stringify({error:{code:'invalid_request'}}),{status:400,headers:{'content-type':'application/json'}}))
  return Promise.resolve(sse([{id:'r'+attempts,choices:[{delta:{content:'ok'},finish_reason:'stop'}]}]))
 }}),session=factory.open()
 try{
  const first=await collect(session.stream({inputs:[{kind:'user_text',text:'first'}],tools:[],reasoning:'enabled',signal}))
  assert.equal(first.at(-1)?.kind,'response_completed')
  assert.equal(requests.length,2)
  assert.deepEqual(requests[0]!.thinking,{type:'enabled'})
  assert.deepEqual(requests[1]!.thinking,{type:'disabled'})
  // The session remembers the refusal, so later rounds never ask again.
  await collect(session.stream({inputs:[{kind:'user_text',text:'second'}],tools:[],reasoning:'enabled',signal}))
  assert.equal(requests.length,3)
  assert.deepEqual(requests[2]!.thinking,{type:'disabled'})
 }finally{await session.close()}
})

test('a 400 without a reasoning request is not retried',async()=>{
 const requests:Record<string,unknown>[]=[]
 const factory=createChatCompletionsLlmFactory({provider:'deepseek',apiKey:'synthetic',baseUrl:'https://example.test',model:'test',instructions:'Plan',fetchImpl:(_url,init)=>{requests.push(JSON.parse(init!.body as string) as Record<string,unknown>);return Promise.resolve(new Response(JSON.stringify({error:{code:'invalid_request'}}),{status:400,headers:{'content-type':'application/json'}}))}}),session=factory.open()
 try{await assert.rejects(collect(session.stream({inputs:[{kind:'user_text',text:'first'}],tools:[],reasoning:'disabled',signal})),/http/u);assert.equal(requests.length,1)}finally{await session.close()}
})
