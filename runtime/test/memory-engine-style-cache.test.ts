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

const original='我一贯更喜欢简洁直接的回答，这是一项长期沟通偏好。'
const signal=()=>AbortSignal.timeout(8000)
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

// Real SQLite ledger, embedding/extraction fixture server and flush loops: ~10-30s alone on a loaded machine, so budget about 3x.
test('production cached style inventory: contradiction, async mutation and other-client discovery preserve independent facts',{timeout:120_000},async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'style-cache-')),provider=await providerFixture(),path=join(root,'ledger.sqlite')
  const client=new MemoryLedgerClient(path)
  const memory=new SubstrateMemoryResource({client,userId:'owner',gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',inputConsent:true,conversationProviders:['consumer'],embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'embedding',extractionFingerprint:'extraction',consolidation:{enabled:false},engine:{recall:'voicemem',styles:true,consumer:'consumer',config:{path:join(root,'engines'),embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}}})
  let owner:PersonalMemoryResource|undefined=memory
  const retrieval=new UnifiedRetrieval({memory:()=>owner}),prepare=retrievalPrerecall(()=>retrieval,()=> 'consumer')
  const remember=async(sourceId:string,text:string)=>{await memory.remember({sourceId,text,sessionId:'same-session',sequence:1,occurredAt:new Date().toISOString(),confirmed:true});await settle(memory)}
  const append=(writer:MemoryLedgerClient,id:string)=>writer.memory('append_evidence',{id:memory.prefix+'e:'+id,source_id:memory.prefix+id,source_kind:'conversation',locator:'fixture',raw_text:'Unrelated synthetic observation',hash:'fixture',observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),retention_until:null,trust:'trusted_user'})
  try{
    await memory.open()
    const factText='Synthetic independent answers fact'
    const turn=await memory.beginExplicitTurn({sourceId:'fact',text:factText,occurredAt:new Date().toISOString()})
    const fact=await memory.writeExplicit(turn,'fact',{action:'set',kind:'fact',scope:'user',text:factText,quote:factText},'consumer')
    await settle(memory)
    for(let n=1;n<=3;n++)await remember('original-'+n,original)
    const prepared=await prepare('answers',signal());assert.ok(prepared)
    let counts=provider.counts()
    for(let n=0;n<2;n++){
      const content=await prepared(signal())
      assert.match(content!,/Prefers brief replies/u,'pure-read/no-change consumes retain grounded style')
      assert.ok(content!.includes(factText))
    }
    assert.deepEqual(provider.counts(),counts,'consume does not perform another embedding or model request')
    await append(client,'unrelated-before-consume')
    counts=provider.counts()
    const unrelated=await prepared(signal())
    assert.ok(unrelated?.includes(factText),'unrelated inventory changes do not discard canonical facts')
    assert.ok(!unrelated?.includes('response_style_hint'),'inventory-dependent style is conservatively withdrawn')
    assert.deepEqual(provider.counts(),counts)
    await settle(memory)
    const projection=await retrieval.recall('answers',{consumer:'consumer',userOnly:true})
    const render=await retrieval.prepareResponseStyle(projection,signal())
    assert.match(render()!,/Prefers brief replies/u)
    const beforeOpposite=await prepare('answers',signal());assert.ok(beforeOpposite)
    await remember('opposite','I always prefer detailed replies.')
    const fresh=(await memory.recall('answers')).contextHits?.filter(hit=>hit.kind==='trait').map(hit=>hit.text)
    assert.deepEqual(fresh,['Prefers direct replies'],'fresh SDK conflict suppression retains the unaffected dimension')
    counts=provider.counts()
    assert.equal(render(),null,'already-prepared render closure rejects mutation after callback preparation')
    const cached=await beforeOpposite(signal())
    assert.ok(!cached?.includes('Prefers brief replies'),'old prefetched style cannot bypass a new contradiction')
    assert.ok(cached?.includes(factText),'cached factual memory remains independently canonical')
    const revalidated=await retrieval.revalidate(projection,signal())
    assert.ok(revalidated.entries.some(entry=>entry.entry_id===fact.id))
    assert.equal((await retrieval.prepareResponseStyle(revalidated,signal()))(),null,'revalidate must carry the original style inventory revision, never refresh it')
    assert.deepEqual(provider.counts(),counts)
    const freshPrepared=await prepare('answers',signal());assert.ok(freshPrepared)
    assert.match((await freshPrepared(signal()))!,/Prefers direct replies/u,'fresh projection still carries current directness')

    // A second client changes the persistent epoch without updating this client's
    // synchronous revision. Existing authorization reads must discover it first.
    const externalProjection=await retrieval.recall('answers',{consumer:'consumer',userOnly:true})
    const externalRender=await retrieval.prepareResponseStyle(externalProjection,signal())
    assert.match(externalRender()!,/Prefers direct replies/u)
    const revision=memory.recallAuthorityRevision(),writer=new MemoryLedgerClient(path)
    try{await writer.open();await append(writer,'other-client')}finally{await writer.close()}
    assert.equal(memory.recallAuthorityRevision(),revision,'writer cannot directly alter another client\'s local revision')
    counts=provider.counts()
    assert.equal((await retrieval.prepareResponseStyle(externalProjection,signal()))(),null,'current authorization reads discover the other-client mutation')
    assert.ok(memory.recallAuthorityRevision()>revision)
    assert.equal(externalRender(),null,'discovered epoch also invalidates previously prepared callbacks')
    assert.deepEqual(provider.counts(),counts)
    await settle(memory)

    // Mutate real ledger authority while style authorization is asynchronously held.
    const asyncProjection=await retrieval.recall('answers',{consumer:'consumer',userOnly:true})
    const entered=deferred(),release=deferred(),readEvidence=memory.readEvidence.bind(memory)
    t.mock.method(memory,'readEvidence',async(id:string)=>{const row=await readEvidence(id);entered.resolve();await release.promise;return row})
    const preparing=retrieval.prepareResponseStyle(asyncProjection,signal())
    try{await entered.promise;await append(client,'during-style-authorization')}finally{release.resolve()}
    assert.equal((await preparing)(),null,'post-async fence rejects a changed inventory')
    t.mock.restoreAll();await settle(memory)

    // A valid style closure must still check the origin fence at final render,
    // even if a later factual revalidation discovers an unrelated real mutation.
    const finalProjection=await retrieval.recall('answers',{consumer:'consumer',userOnly:true})
    const finalRender=await retrieval.prepareResponseStyle(finalProjection,signal())
    assert.match(finalRender()!,/Prefers direct replies/u)
    const reading=deferred(),resume=deferred(),get=memory.get.bind(memory)
    t.mock.method(memory,'get',async(id:string)=>{const row=await get(id);reading.resolve();await resume.promise;return row})
    const validating=retrieval.revalidate(finalProjection,signal())
    try{await reading.promise;await append(client,'during-fact-revalidation')}finally{resume.resolve()}
    const finalFacts=await validating
    assert.ok(finalFacts.entries.some(entry=>entry.entry_id===fact.id),'inventory fence applies only to style, not unrelated valid facts')
    assert.equal(finalRender(),null,'mutation between callback preparation and final render is fenced')
    t.mock.restoreAll();await settle(memory)
    const ownedProjection=await retrieval.recall('answers',{consumer:'consumer',userOnly:true})
    const ownedRender=await retrieval.prepareResponseStyle(ownedProjection,signal())
    assert.match(ownedRender()!,/Prefers direct replies/u)
    owner=undefined
    assert.equal(ownedRender(),null,'resource owner swap fences prepared style')
    assert.equal((await retrieval.prepareResponseStyle(ownedProjection,signal()))(),null)
  }finally{t.mock.restoreAll();await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})
