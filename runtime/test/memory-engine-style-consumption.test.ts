import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {RealClock} from '../src/core/clock.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {retrievalPrerecall} from '../src/memory/prerecall-port.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import {providerFixture,settle} from './memory-engine-provider-fixture.js'

// Real SQLite ledger, embedding/extraction fixture server and flush loops: ~10-30s alone on a loaded machine, so budget about 3x.
for(const backend of ['ledger','mem0'] as const)test(`retrievalPrerecall consumes configured ${backend}+VoiceMem styles separately with TTL/forget/revoke`,{timeout:60_000},async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-style-consume-')),provider=await providerFixture()
  const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'owner',gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',inputConsent:true,conversationProviders:['consumer'],embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'embedding',extractionFingerprint:'extraction',consolidation:{enabled:false},engine:{recall:backend,styles:true,consumer:'consumer',config:{path:join(root,'engines'),embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}}})
  const signal=()=>new AbortController().signal
  const remember=async(sourceId:string,text:string,occurredAt=new Date().toISOString())=>{await memory.remember({sourceId,text,occurredAt,sessionId:'session',sequence:1,confirmed:true});await settle(memory)}
  try{
    await memory.open();await remember('fact','I always prefer concise answers');await remember('emotion','I am upset today')
    const retrieval=new UnifiedRetrieval({memory:()=>memory}),prepare=retrievalPrerecall(()=>retrieval,()=> 'consumer')
    const factual=await retrieval.recall('answers',{consumer:'consumer'})
    assert.ok(!JSON.stringify(factual).includes('Temporary emotion'),'serialized factual results never contain derived styles')
    const prepared=await prepare('answers',signal());assert.ok(prepared)
    const content=await prepared(signal());assert.ok(content)
    assert.match(content,/<possible_memory>/u);assert.match(content,/<response_style_hint/u)
    assert.ok(!content.split('</possible_memory>')[0]!.includes('Temporary emotion'),'style is separate from factual memory')
    assert.match(content,/Temporary emotion: sad/u)
    await memory.forgetSource('emotion')
    assert.ok(!(await prepared(signal()))?.includes('response_style_hint'),'consume revalidates forgotten source even with prefetched styles')
    await remember('emotion-revoke','I am upset today')
    const revoking=await prepare('answers',signal());assert.ok(revoking)
    await memory.setProcessingConsent('emotion-revoke',memory.processingGrant(false,2))
    assert.ok(!(await revoking(signal()))?.includes('response_style_hint'),'consume revalidates revoked source')
    const sourceNow=Date.now(),expiresAt=sourceNow+600_000
    await remember('emotion-expire','I am upset today',new Date(sourceNow).toISOString())
    const expiring=await prepare('answers',signal());assert.ok(expiring)
    const beforeExpiry=await expiring(signal());assert.ok(beforeExpiry)
    assert.match(beforeExpiry,/response_style_hint/u)
    assert.match(beforeExpiry,/Temporary emotion: sad/u)
    assert.ok(beforeExpiry.includes('"expiresAt":"'+new Date(expiresAt).toISOString()+'"'),'expiry is fixed to the source observation plus the trusted ten-minute TTL')
    t.mock.method(Date,'now',()=>expiresAt+1)
    const afterExpiry=await expiring(signal())
    assert.ok(!afterExpiry?.includes('response_style_hint'),'fixed style TTL expires at consume, not query time')
    assert.match(afterExpiry!,/<possible_memory>/u,'style expiry does not discard authorized facts')
    t.mock.restoreAll()
  }finally{t.mock.restoreAll();await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})

test('unconfigured internal style channel cannot be enabled by arbitrary contextHits',async()=>{
  const now=new Date().toISOString()
  const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recallEngine:'ledger',supportsResponseStyle:false,recall:()=>Promise.resolve({source:'personal',state:'ok',scope:'any',hits:[],contextHits:[{memoryId:'untrusted',kind:'experience',text:'Unconfigured style',evidenceIds:['e'],recordedAt:now,expiresAt:new Date(Date.parse(now)+600_000).toISOString()}],degraded:false}),readEvidence:()=>Promise.resolve({evidence_id:'e',locator:'fixture',text:'fixture',source_kind:'conversation',observed_at:now,trust:'untrusted_external'}),canReadConversationEvidence:()=>Promise.resolve(true)}
  const retrieval=new UnifiedRetrieval({memory:()=>memory}),signal=new AbortController().signal
  const prepared=await retrievalPrerecall(()=>retrieval,()=> 'consumer')('answers',signal)
  assert.ok(prepared);assert.equal(await prepared(signal),null)
})
