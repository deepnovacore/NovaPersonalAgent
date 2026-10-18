import assert from 'node:assert/strict'
import {test} from 'node:test'
import {VirtualClock} from '../src/core/clock.js'
import {createLocalMemoryGateway} from '../src/composition/realtime-assembly.js'

test('the production local-memory gateway transmits explicit Qwen Profile reasoning controls',async()=>{
 for(const baseUrl of ['https://dashscope.aliyuncs.com/compatible-mode/v1','https://example.invalid/v1']){
  const bodies:Record<string,unknown>[]=[]
  const gateway=createLocalMemoryGateway({baseUrl,apiKey:'synthetic',clock:new VirtualClock(),metrics:{record:()=>undefined},fetch:(_url,init)=>{bodies.push(JSON.parse(init!.body as string) as Record<string,unknown>);return Promise.resolve(Response.json({choices:[{message:{content:'{}'}}]}))}})
  await gateway.complete({model:'qwen3-vl-plus',system:'s',prompt:'p',reasoning:'enabled',reasoningBudget:4096,maxTokens:6000,jsonSchema:{type:'object'}})
  await gateway.complete({model:'qwen3-vl-plus',system:'s',prompt:'p',reasoning:'disabled',jsonSchema:{type:'object'}})
  if(baseUrl.includes('dashscope.')){assert.equal(bodies[0]!.enable_thinking,true);assert.equal(bodies[0]!.thinking_budget,4096);assert.equal(Object.hasOwn(bodies[0]!,'response_format'),false);assert.equal(bodies[1]!.enable_thinking,false);assert.deepEqual(bodies[1]!.response_format,{type:'json_object'})}
  else assert.equal(Object.hasOwn(bodies[0]!,'enable_thinking'),false)
 }
})
