import test from 'node:test'
import assert from 'node:assert/strict'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {VirtualClock} from '../src/core/clock.js'

const gateway=()=>new OpenAIModelGateway({baseUrl:'https://example.invalid/v1',apiKey:'test',clock:new VirtualClock(),metrics:{record:()=>undefined},requestTimeout:0.005,
 fetch:(_url,init)=>Promise.resolve(new Response(new ReadableStream({start(controller){
  const timer=setTimeout(()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({choices:[{message:{content:'done'},finish_reason:'stop'}]})));controller.close()},30)
  init!.signal!.addEventListener('abort',()=>{clearTimeout(timer);controller.error(init!.signal!.reason)},{once:true})
 }})))})
test('long structured completion can extend its deadline without changing the gateway default',async()=>{
 const model=gateway()
 assert.equal((await model.complete({model:'fixture',system:'',prompt:'',timeoutSeconds:1})).text,'done')
 await assert.rejects(model.complete({model:'fixture',system:'',prompt:''}),/TimeoutError/)
})
test('extended completion deadline still honors caller cancellation',async()=>{
 await assert.rejects(gateway().complete({model:'fixture',system:'',prompt:'',timeoutSeconds:1,signal:AbortSignal.timeout(5)}),/TimeoutError/)
})
