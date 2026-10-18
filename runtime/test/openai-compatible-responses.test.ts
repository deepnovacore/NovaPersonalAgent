import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createArkCascadedLlmFactory} from '../src/realtime/cascaded/ark-llm.js'
import type {CascadedLlmEvent} from '../src/realtime/cascaded/llm.js'
import {ResponsesModelGateway} from '../src/model/responses-model-gateway.js'
import {createChatCompletionsLlmFactory} from '../src/realtime/cascaded/chat-completions-llm.js'

const collect=async(stream:AsyncIterable<CascadedLlmEvent>)=>{const events:CascadedLlmEvent[]=[];for await(const event of stream)events.push(event);return events}
const sse=(events:unknown[])=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})
test('compatible Responses replays stateless tools and encrypted reasoning without Ark parameters',async()=>{
  const requests:Record<string,unknown>[]=[]
  const reasoning={type:'reasoning',id:'reason-1',summary:[],encrypted_content:'opaque'}
  const call={type:'function_call',id:'fc-1',call_id:'call-1',name:'lookup',arguments:'{}',status:'completed'}
  const session=createArkCascadedLlmFactory({baseUrl:'https://relay.example/v1/',apiKey:'synthetic',model:'test',instructions:'Use lookup',...{protocol:'openai-compatible' as const},fetchImpl:(_url,init)=>{
    requests.push(JSON.parse(init!.body as string) as Record<string,unknown>)
    assert.equal(init!.redirect,'error')
    const first=requests.length===1,id=first?'r1':'r2'
    return Promise.resolve(sse([{type:'response.created',response:{id}},...(first?[{type:'response.output_item.done',item:call}]:[{type:'response.output_text.delta',delta:'Done'}]),{type:'response.completed',response:{id,output:first?[reasoning,call]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Done'}]}],usage:{input_tokens:4,output_tokens:2}}}]))
  }}).open()
  const signal=new AbortController().signal
  try {
    const first=await collect(session.stream({inputs:[{kind:'user_text',text:'look up'}],tools:[{name:'lookup',parameters:{type:'object',properties:{}}}],signal}))
    assert.equal(first.filter(e=>e.kind==='tool_call').length,1)
    await collect(session.stream({inputs:[{kind:'tool_result',call_id:'call-1',output:{value:7}}],tools:[],signal}))
    assert.equal(requests[0]!.store,false)
    assert.equal(requests[0]!.thinking,undefined)
    assert.deepEqual(requests[0]!.include,['reasoning.encrypted_content'])
    assert.equal(requests[1]!.previous_response_id,undefined)
    const items=requests[1]!.input as Record<string,unknown>[]
    assert.ok(items.some(item=>item.role==='user'&&item.content==='look up'))
    assert.deepEqual(items.find(item=>item.type==='reasoning'),reasoning)
    assert.deepEqual(items.find(item=>item.type==='function_call'),call)
    assert.equal(items.at(-1)!.call_id,'call-1')
  } finally {await session.close()}
})

test('compatible chat omits vendor reasoning flags and does not follow credential redirects',async()=>{
  let body:Record<string,unknown>={}
  const session=createChatCompletionsLlmFactory({provider:'openai-compatible',baseUrl:'https://relay.example/v1',apiKey:'synthetic',model:'test',instructions:'test',fetchImpl:(_url,init)=>{
    body=JSON.parse(init!.body as string) as Record<string,unknown>
    assert.equal(init!.redirect,'error')
    return Promise.resolve(sse([{id:'r1',choices:[{delta:{content:'OK'},finish_reason:'stop'}]}]))
  }}).open()
  try {
    const result=await collect(session.stream({inputs:[{kind:'user_text',text:'hello'}],tools:[],signal:new AbortController().signal}))
    assert.ok(result.some(e=>e.kind==='text_delta'&&e.text==='OK'))
    for(const key of ['reasoning_effort','thinking','enable_thinking'])assert.equal(body[key],undefined)
  }finally{await session.close()}
})

test('compatible Responses auxiliary JSON calls use selected protocol and model',async()=>{
  let body:Record<string,unknown>={}
  const gateway=new ResponsesModelGateway({baseUrl:'https://relay.example/v1',apiKey:'synthetic',fetch:(_url,init)=>{
    assert.equal(_url,'https://relay.example/v1/responses')
    body=JSON.parse(init!.body as string) as Record<string,unknown>
    return Promise.resolve(sse([{type:'response.created',response:{id:'r1'}},{type:'response.output_text.delta',delta:'{"ok":true}'},{type:'response.completed',response:{id:'r1',output:[],usage:{input_tokens:1,output_tokens:1}}}]))
  }})
  assert.deepEqual(await gateway.complete({model:'chosen',system:'Output JSON',prompt:'test',jsonSchema:{type:'object'}}),{text:'{"ok":true}'})
  assert.deepEqual(body.text,{format:{type:'json_object'}})
  assert.match(JSON.stringify(body.input),/JSON/)
  assert.equal(body.model,'chosen');assert.equal(body.store,false)
})

test('compatible Responses abort releases a transport that ignores cancellation',async()=>{
  let started!:()=>void
  const began=new Promise<void>(r=>started=r),controller=new AbortController()
  const session=createArkCascadedLlmFactory({baseUrl:'https://relay.example/v1',apiKey:'synthetic',model:'test',instructions:'test',protocol:'openai-compatible',fetchImpl:()=>{started();return new Promise<Response>(()=>{ /* Simulate a transport that never settles. */ })}}).open()
  const result=collect(session.stream({inputs:[{kind:'user_text',text:'hello'}],tools:[],signal:controller.signal}))
  const rejected=assert.rejects(result,/aborted/)
  await began;controller.abort();await rejected;await session.close()
})
