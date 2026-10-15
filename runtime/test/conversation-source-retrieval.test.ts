import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {z} from 'zod'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import {Memory} from '../src/core/memory.js'
import {VirtualClock} from '../src/core/clock.js'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {RealtimeRuntimeBridge} from '../src/realtime/bridge.js'

test('conversation recall finds authorized IM originals without extraction or a knowledge index',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-conversation-sources-'))
 const gateway:ModelGateway={async *stream(){await Promise.resolve();throw Error('unused')},complete:()=>Promise.resolve({text:'{"entries":[]}'})}
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',gateway,model:'fixture',personalMemoryEnabled:false,conversationProviders:['chat']})
 try{
  await memory.open()
  const now=new Date(),at=now.toISOString(),old=new Date(now.getTime()-10*86400000).toISOString()
  const ingest=(sourceId:string,locator:string,text:string,observedAt=at,provider='feishu')=>memory.ingestEvidence({sourceId,locator,text,observedAt,kind:'im',im:{sender_id:'self',recipient_id:'self',sender_name:'林青',account_id:'fixture',provider},processingConsent:memory.processingGrant(true)})
  await ingest('im','feishu://message/current','本周完成原型评审')
  await ingest('im','feishu://message/old','上周完成旧方案',old)
  await ingest('other','other://message/current','另一个渠道消息',at,'other')
  await memory.recordEvidence({sourceId:'file',locator:'file:///fixture.md',text:'林青的项目文件',observedAt:at,kind:'file',embeddingConsent:false,processingConsent:memory.processingGrant(true)})
  const engine=new UnifiedRetrieval({memory:()=>memory})
  const options={consumer:'chat',scope:'any' as const,sourceFilter:{kind:'im' as const,provider:'feishu',since:new Date(now.getTime()-7*86400000).toISOString()}}
  const result=await engine.recall('林青',options)
  assert.equal(result.state,'ok')
  assert.deepEqual(result.entries,[])
  assert.deepEqual(result.snippets.map(row=>row.locator),['feishu://message/current'])
  assert.equal(result.snippets[0]?.text,'本周完成原型评审')
  assert.deepEqual((await engine.recall('林青',{...options,sourceFilter:{kind:'im',provider:'feishu',last_days:7}})).snippets.map(row=>row.locator),['feishu://message/current'])
  const session=new Memory(),origin=session.append('conversation',{ts:1,trust:'trusted_user',priority:100,content:{text:'查飞书近七天消息'}})
  const bridge=new RealtimeRuntimeBridge({runtime:{clock:new VirtualClock(),memory:session,executors:new Map(),ingestUserInput:()=>Promise.reject(Error('unused')),dispatchExternal:()=>{throw Error('read_must_not_dispatch')}},tools:compileToolSchema([],{includeMemoryRecall:true}),idFactory:()=> 'source-result',retrieval:engine,conversationConsumer:'chat'})
  const call={kind:'tool_call_ready' as const,session_epoch:1,call_id:'source',item_id:'tool',name:'memory__recall',arguments:{query:'林青',scope:'any',source_filter:options.sourceFilter},response_id:'response'}
  const originRef=`${origin.channel}:${origin.seq}`
  const wire=await bridge.acceptPersonalMemoryRecall(call,{originRef})
  assert.equal(wire.inline_fulfilled,true)
  const wireResult=z.object({snippets:z.array(z.object({locator:z.string()}))}).parse(JSON.parse(wire.host_item.content))
  assert.deepEqual(wireResult.snippets.map(row=>row.locator),['feishu://message/current'])
  assert.equal((await bridge.acceptPersonalMemoryRecall({...call,arguments:{...call.arguments,source:'session'}},{originRef})).code,'invalid_params')
  assert.equal((await bridge.acceptPersonalMemoryRecall({...call,arguments:{...call.arguments,source_filter:{since:at,before:old}}},{originRef})).code,'invalid_params')
  assert.equal((await bridge.acceptPersonalMemoryRecall({...call,arguments:{...call.arguments,source_filter:{since:old,last_days:7}}},{originRef})).code,'invalid_params')
  const unfiltered=await engine.recall('原型评审',{consumer:'chat',scope:'any'})
  assert.equal(unfiltered.snippets[0]?.locator,'feishu://message/current')
  await ingest('im','feishu://message/current','修订后改到下周评审')
  assert.equal((await engine.recall('林青',options)).snippets[0]?.text,'修订后改到下周评审')
  assert.equal((await engine.evidence(result.snippets[0].evidence_id,{consumer:'chat'})).state,'gone')
  await memory.setProcessingConsent('im',memory.processingGrant(false,2))
  assert.deepEqual((await engine.recall('林青',options)).snippets,[])
  assert.deepEqual((await engine.revalidate(result,new AbortController().signal)).snippets,[])
  assert.deepEqual((await engine.recall('林青',{...options,consumer:'unapproved-model'})).snippets,[])
  // Earlier sync versions stored originals without sender/provider metadata.
  await memory.recordEvidence({sourceId:'legacy',locator:'feishu://message/legacy',text:'兼容记录',observedAt:old,kind:'im',embeddingConsent:false,processingConsent:memory.processingGrant(true)})
  const legacy=await engine.recall('兼容记录',{consumer:'chat',scope:'any',sourceFilter:{kind:'im',provider:'feishu',before:new Date(now.getTime()-8*86400000).toISOString()}})
  assert.deepEqual(legacy.snippets.map(row=>row.locator),['feishu://message/legacy'])
  assert.equal(legacy.snippets[0]?.trust,'untrusted_external')
  assert.equal((await engine.recall('兼容记录',{...options,sourceFilter:{kind:'im',provider:'feishu',last_days:7}})).state,'empty')
 }finally{await memory.close();await rm(root,{recursive:true,force:true})}
})
