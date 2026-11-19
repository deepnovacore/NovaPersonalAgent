import assert from 'node:assert/strict'
import {test} from 'node:test'
import {providerFixture,settle} from './memory-engine-provider-fixture.js'
import {mkdtemp,realpath,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {RealClock} from '../src/core/clock.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {deriveMemoryToolCapabilities} from '../src/memory/tool-capabilities.js'

// Identical paired behavior runs through production SDK workers and deterministic provider HTTP, not fake engine ports.
for(const backend of ['ledger','mem0','voicemem'] as const)test(`production ${backend}: paired quality, authority, restart and forget`,{timeout:60_000},async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-production-engines-')),provider=await providerFixture(),path=join(root,'ledger.sqlite')
  const create=(userId='owner')=>new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId,
    gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',
    embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'fixture-embedding',extractionFingerprint:'fixture-extraction',
    inputConsent:true,conversationProviders:['consumer'],consolidation:{enabled:false},
    engine:{recall:backend,styles:true,consumer:'consumer',config:{path:join(root,'engines'),embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}}})
  let memory=create()
  const remember=async(sourceId:string,text:string)=>{await memory.remember({sourceId,text,sessionId:'fixture',sequence:1,occurredAt:new Date().toISOString(),confirmed:true});await settle(memory)}
  try{
    await memory.open()
    await remember('temporary','Please answer briefly just this turn')
    assert.deepEqual((await memory.list()).entries,[],'one-turn request is not a stable preference')
    await remember('emotion','I am upset today')
    let result=await memory.recall('feelings')
    assert.ok(result.contextHits?.some(hit=>hit.kind==='experience'),'transient emotion uses actual VoiceMem extraction')
    assert.ok(!result.contextHits?.some(hit=>hit.kind==='trait'),'one emotion cannot become a trait')
    assert.deepEqual((await memory.list()).entries,[],'emotion is not a ledger fact')
    await remember('standing-1','I always prefer concise answers')
    result=await memory.recall('answers')
    assert.ok(result.hits.some(hit=>hit.text==='I prefer concise answers'))
    assert.ok(!result.contextHits?.some(hit=>hit.kind==='trait'),'one standing assertion is not repeated evidence')
    await remember('standing-2','I always prefer concise answers')
    assert.ok(!(await memory.recall('answers')).contextHits?.some(hit=>hit.kind==='trait'),'two observations below threshold')
    await remember('standing-3','I always prefer concise answers')
    result=await memory.recall('answers')
    const trait=result.contextHits?.find(hit=>hit.kind==='trait');assert.ok(trait)
    assert.equal(trait.evidenceIds.length,3)
    assert.equal(Date.parse(trait.expiresAt!)-Date.parse(trait.recordedAt!),600_000)
    const row=(await memory.list()).entries[0]!
    assert.equal((await memory.list()).entries.length,1,'repeated assertions do not duplicate ledger facts')
    await remember('standing-3','I always prefer concise answers')
    assert.equal((await memory.list()).entries.length,1,'idempotent admission')
    assert.equal((await memory.recall('answers')).contextHits?.find(hit=>hit.kind==='trait')?.evidenceIds.length,3)
    const generalTurn=await memory.beginExplicitTurn({sourceId:'project',text:'Use project convention ONLY_PROJECT',occurredAt:new Date().toISOString()})
    const general=await memory.writeExplicit(generalTurn,'project',{action:'set',kind:'fact',scope:'general',text:'ONLY_PROJECT',quote:'ONLY_PROJECT'},'consumer')
    await settle(memory)
    assert.equal((await memory.recall('ONLY_PROJECT')).hits.find(hit=>hit.memoryId===general.id)?.memory_scope,'general','explicit recall keeps authorized general memories readable')
    assert.ok(!(await memory.recall('ONLY_PROJECT',{userOnly:true})).hits.some(hit=>hit.memoryId===general.id),'general/project facts are not user recall')
    const retrieval=new UnifiedRetrieval({memory:()=>memory})
    assert.ok((await retrieval.recall('answers',{consumer:'consumer'})).entries.length)
    assert.deepEqual((await retrieval.recall('answers',{consumer:'denied'})).entries,[])
    assert.equal(deriveMemoryToolCapabilities(memory,backend).remember,true,'ledger mutation capabilities survive engine selection')
    await assert.rejects(memory.recall('answers',{signal:AbortSignal.abort()}))
    await memory.close();memory=create();await memory.open();await settle(memory)
    assert.ok((await memory.recall('answers')).hits.some(hit=>hit.memoryId===row.id),'real engine survives restart')
    await memory.correct(row.id,row.version,'I prefer detailed answers',{type:'conversation',ref:'correction',observed_at:new Date().toISOString()});await settle(memory)
    result=await memory.recall('answers')
    assert.ok(!result.hits.some(hit=>hit.text==='I prefer concise answers'),'stale SDK revision cannot revive correction')
    assert.ok(result.hits.some(hit=>hit.text==='I prefer detailed answers'))
    await memory.forgetSource('standing-1');await memory.forgetSource('standing-2');await memory.forgetSource('standing-3');await settle(memory)
    assert.ok(!(await memory.recall('answers')).contextHits?.some(hit=>hit.kind==='trait'),'forget clears derived repeated-evidence style')
    await memory.setProcessingConsent('emotion',memory.processingGrant(false,2));await settle(memory)
    assert.ok(!(await memory.recall('feelings')).contextHits?.some(hit=>hit.kind==='experience'),'revoked source hides and removes emotion')
    const corrected=(await memory.get(row.id))!;await memory.forgetEntry(corrected.id,corrected.version);await settle(memory)
    assert.deepEqual((await memory.recall('answers',{userOnly:true})).hits,[])
    await memory.close();memory=create('other-user');await memory.open();await settle(memory)
    assert.deepEqual((await memory.recall('answers',{userOnly:true})).hits,[],'same engine root isolates users')
    assert.deepEqual((await memory.recall('feelings')).contextHits,[])
    await memory.close();memory=create();await memory.open();await settle(memory)
    assert.deepEqual((await memory.recall('answers',{userOnly:true})).hits,[],'forget survives restart')
    assert.ok(provider.counts().embeddings>0&&provider.counts().extractions>0,'actual SDK providers were called')
  }finally{await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})

for(const backend of ['mem0','voicemem'] as const)test(`production ${backend}: outbox failure/restart/backfill and bounded abort`,{timeout:60_000},async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-engine-retry-')),provider=await providerFixture(),path=join(root,'ledger.sqlite')
  const create=(engine:boolean)=>new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'owner',gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',inputConsent:true,conversationProviders:['consumer'],embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'embedding',extractionFingerprint:'extraction',consolidation:{enabled:false},...(engine?{engine:{recall:backend,styles:false,consumer:'consumer',config:{path:join(root,'engines'),embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}}}:{})})
  let memory=create(false)
  try{
    await memory.open();await memory.remember({sourceId:'existing',sessionId:'session',sequence:1,text:'I always prefer concise answers',occurredAt:new Date().toISOString(),confirmed:true});await memory.flush();await memory.close()
    provider.setFail(true);memory=create(true);await memory.open()
    await assert.rejects(memory.flushEngines())
    assert.ok(memory.engineIndexStatus().some(status=>status.error==='memory_engine_index_pending'))
    await memory.close()
    const db=new DatabaseSync(path),jobs=db.prepare('SELECT generation,completed FROM memory_engine_outbox').all();db.close()
    assert.ok(jobs.some(job=>Number(job.generation)>Number(job.completed)),'failed job is durable')
    provider.setFail(false);memory=create(true);await memory.open();await settle(memory)
    assert.ok((await memory.recall('answers')).hits.length,'existing ledger backfilled after restart')
    const files=await readdir(join(root,'engines'));assert.ok(files.length>0)
    provider.setHold(true)
    const abort=new AbortController(),pending=memory.recall('answers',{signal:abort.signal})
    setTimeout(()=>abort.abort(),40)
    const started=Date.now();await assert.rejects(pending);assert.ok(Date.now()-started<2000,'SDK recall abort terminates its worker')
    const closing=Date.now();await memory.close();assert.ok(Date.now()-closing<2000,'shutdown bounded while provider stalls')
  }finally{provider.setHold(false);await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})
