import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServer} from 'node:http'
import {Memory} from '../src/core/memory.js'
import {VirtualClock} from '../src/core/clock.js'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {RealtimeRuntimeBridge} from '../src/realtime/bridge.js'
import {RemotePersonalMemoryResource} from '../src/memory/remote-personal-memory.js'
import type {PersonalMemoryResource,PersonalMemoryRecallHit} from '../src/memory/personal-memory.js'

async function directRecall(personalMemory:PersonalMemoryResource){
  const memory=new Memory(),origin=memory.append('conversation',{ts:1,trust:'trusted_user',priority:100,content:{text:'Recall project constraints'}})
  const bridge=new RealtimeRuntimeBridge({runtime:{clock:new VirtualClock(),memory,executors:new Map(),ingestUserInput:()=>Promise.reject(Error('unused')),dispatchExternal:()=>({accepted:false,delegate_id:null})},personalMemory,tools:compileToolSchema([],{includeMemoryRecall:true}),idFactory:()=> 'host'})
  const result=await bridge.acceptPersonalMemoryRecall({kind:'tool_call_ready',session_epoch:1,call_id:'recall',item_id:'tool',response_id:'response',name:'memory__recall',arguments:{query:'project',scope:'any',source:'personal'}},{originRef:`${origin.channel}:${origin.seq}`})
  assert.equal(result.accepted,true)
  return JSON.parse(result.host_item.content) as {state:string;degraded:boolean;hits:{memory_id:string;memory_scope?:'user'|'general'}[];context_hits:{memory_id:string;memory_scope?:'user'|'general'}[]}
}

test('direct realtime recall preserves validated general/user scope from the actual remote parser without defaulting unknown scope',async()=>{
  const hit={text:'Project constraints',evidenceIds:['source']}
  const server=createServer((req,res)=>{req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/v1/preferences'?{revision:0,replyPreferences:[]}:{source:'personal',state:'ok',scope:'any',degraded:false,hits:[{...hit,memoryId:'general',memory_scope:'general'},{...hit,memoryId:'user',memory_scope:'user'},{...hit,memoryId:'unknown'}],contextHits:[{...hit,memoryId:'general-context',memory_scope:'general'}]}))})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const remote=new RemotePersonalMemoryResource({url:`http://127.0.0.1:${address.port}`,token:'fixture'})
  try{
    await remote.open()
    const result=await directRecall(remote)
    assert.equal(result.state,'ok');assert.equal(result.degraded,false)
    assert.deepEqual(result.hits.map(hit=>[hit.memory_id,hit.memory_scope]),[['general','general'],['user','user'],['unknown',undefined]])
    assert.ok(!Object.hasOwn(result.hits[2]!,'memory_scope'))
    assert.equal(result.context_hits[0]?.memory_scope,'general')
  }finally{await remote.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('direct realtime bridge rejects malformed optional scope and copies no arbitrary backend metadata',async()=>{
  for(const scope of ['unknown',null,true,1,{scope:'user'}]){
    const valid={memoryId:'general',text:'Project constraint',evidenceIds:['source'],memory_scope:'general' as const,private_metadata:'BACKEND_SECRET'}
    const resource:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.resolve({source:'personal',state:'ok',scope:'any',degraded:false,hits:[valid,{...valid,memoryId:'invalid',text:'INVALID_SCOPE_TEXT',memory_scope:scope as NonNullable<PersonalMemoryRecallHit['memory_scope']>}]})}
    const result=await directRecall(resource)
    assert.deepEqual(result.hits.map(hit=>[hit.memory_id,hit.memory_scope]),[['general','general']]);assert.equal(result.degraded,true)
    assert.ok(!JSON.stringify(result).includes('INVALID_SCOPE_TEXT'));assert.ok(!JSON.stringify(result).includes('BACKEND_SECRET'))
  }
})
