import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm,readdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {RealClock} from '../src/core/clock.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {retrievalPrerecall} from '../src/memory/prerecall-port.js'
import type {MemoryEntry,PersonalMemoryResource} from '../src/memory/personal-memory.js'
import {providerFixture,settle} from './memory-engine-provider-fixture.js'

async function engineContains(root:string,text:string):Promise<boolean>{
  try{for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory()?await engineContains(path,text):(await readFile(path)).includes(Buffer.from(text)))return true}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  return false
}

for(const backend of ['legacy-ledger','ledger','mem0','voicemem'] as const)test(`explicit/all vs automatic/user-only canonical recall: ${backend}`,{timeout:30_000},async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-recall-projection-')),provider=await providerFixture(),enginePath=join(root,'engines')
  const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'owner',gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',inputConsent:true,conversationProviders:['consumer'],embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'embedding',extractionFingerprint:'extraction',consolidation:{enabled:false},...(backend==='legacy-ledger'?{}:{engine:{recall:backend,styles:false,consumer:'consumer',config:{path:enginePath,embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}}})})
  const query='SCOPE_MARK',general='Project SCOPE_MARK requires strict TypeScript',user='SCOPE_MARK concise answers',legacy='SCOPE_MARK prefer examples',signal=()=>new AbortController().signal
  const write=async(sourceId:string,text:string,scope?:'user'|'general')=>{const turn=await memory.beginExplicitTurn({sourceId,text,occurredAt:new Date().toISOString()});return memory.writeExplicit(turn,sourceId,{action:'set',kind:scope==='general'?'fact':'preference',quote:text,text,...(scope?{scope}:{})},'consumer')}
  try{
    await memory.open()
    const project=await write('project',general,'general'),person=await write('user',user,'user');await write('legacy',legacy)
    await settle(memory)
    const explicit=await memory.recall(query,{scope:'any',limit:4})
    assert.ok(explicit.hits.length<=4,'one combined SDK/general limit')
    assert.equal(explicit.hits.find(hit=>hit.memoryId===project.id)?.memory_scope,'general')
    assert.equal(explicit.hits.find(hit=>hit.memoryId===person.id)?.memory_scope,'user')
    assert.equal((await memory.get(project.id))?.memory_scope,'general')
    assert.equal((await memory.list()).entries.find(row=>row.content===legacy)?.memory_scope,'user','host-owned missing scope retains legacy semantics')
    assert.ok(!(await memory.recall(query,{userOnly:true})).hits.some(hit=>hit.memoryId===project.id))
    const retrieval=new UnifiedRetrieval({memory:()=>memory}),prepare=retrievalPrerecall(()=>retrieval,()=> 'consumer')
    const tool=await retrieval.recall(query,{consumer:'consumer'})
    assert.equal(tool.entries.find(row=>row.entry_id===project.id)?.memory_scope,'general','explicit tools retain the canonical scope tag')
    assert.deepEqual((await retrieval.recall(query,{consumer:'denied'})).entries,[])
    const prepared=await prepare(query,signal());assert.ok(prepared)
    const background=await prepared(signal());assert.ok(background);assert.ok(background.includes(user));assert.ok(!background.includes(general))
    for(const adaptation of [memory.responseAdaptation(),await memory.prepareResponseAdaptation('consumer')]){
      assert.ok(!adaptation.replyPreferences.some(row=>row.text===general));assert.ok(!adaptation.memoryContext?.voice.includes(general))
      assert.ok(!adaptation.memoryContext?.text.split('Memory directory')[0]?.includes(general))
    }
    if(backend==='mem0'||backend==='voicemem'){
      assert.equal(await engineContains(enginePath,general),false,'general content is never admitted to the selected SDK index/style store')
      provider.setFail(true)
      await assert.rejects(memory.recall(query),'SDK error cannot become a healthy ledger substitute')
      const failed=await retrieval.recall(query,{consumer:'consumer'});assert.equal(failed.degraded,true);assert.deepEqual(failed.entries,[])
      provider.setFail(false)
    }
    const generalSource=(await memory.get(project.id))!.source_refs[0]!.ref
    await memory.setProcessingConsent(generalSource,memory.processingGrant(false,2))
    assert.ok(!(await retrieval.recall(query,{consumer:'consumer'})).entries.some(row=>row.entry_id===project.id),'receiving-consumer revocation excludes explicit general results')
    await memory.forgetEntry(project.id,project.version);await settle(memory)
    assert.ok(!(await memory.recall(query)).hits.some(hit=>hit.memoryId===project.id),'forgotten general entries are not supplemented')
    await memory.forgetEntry(person.id,person.version)
    assert.ok(!(await prepared(signal()))?.includes(user),'prefetched user context is revalidated after forget')
  }finally{await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})

test('automatic projection distrusts ignored filters/unknown scope and preserves its constraint at consume',async()=>{
  const now=new Date().toISOString(),row=(id:string,text:string,memory_scope?:'user'|'general'):MemoryEntry=>({id,version:1,content:text,kind:'fact',origin:'stated',source_refs:[],evidence_refs:[id+'-source'],observed_at:now,recorded_at:now,topic:'',status:'active',corrected_to:null,confidence_note:null,...(memory_scope?{memory_scope}:{})})
  const rows=new Map([['user',row('user','scope user preference','user')],['general',row('general','scope project constraint','general')],['unknown',row('unknown','scope unknown provider data')]])
  let userOnly:boolean|undefined,rawCalls=0
  const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:(_query,options)=>{userOnly=options?.userOnly;return Promise.resolve({source:'personal',state:'ok',scope:'any',degraded:false,hits:[...rows.values()].map(item=>({memoryId:item.id,revision:1,text:item.content,evidenceIds:item.evidence_refs!,memory_scope:'user'}))})},get:id=>Promise.resolve(rows.get(id)??null),readEvidence:id=>Promise.resolve({evidence_id:id,locator:'fixture',source_kind:'conversation',text:'scope '+id,observed_at:now,trust:'untrusted_external'}),canReadConversationEvidence:()=>Promise.resolve(true),recallSources:()=>{rawCalls++;return Promise.resolve({hits:[{evidence_id:'general-source',score:1}],truncated:false})}}
  const retrieval=new UnifiedRetrieval({memory:()=>memory,rawRecall:()=>{rawCalls++;return Promise.resolve([{evidence_id:'general-source'}])}}),signal=new AbortController().signal
  const result=await retrieval.recall('scope',{consumer:'consumer',userOnly:true})
  assert.equal(userOnly,true);assert.equal(rawCalls,0,'unscoped external source channels cannot enable automatic user claims')
  assert.deepEqual(result.entries.map(item=>item.entry_id),['user']);assert.equal(result.degraded,true,'unknown canonical scope is refused, not defaulted')
  assert.ok(result.snippets.every(item=>item.evidence_id==='user-source'))
  const prepared=await retrievalPrerecall(()=>retrieval,()=> 'consumer')('scope',signal);assert.ok(prepared)
  rows.set('user',{...rows.get('user')!,memory_scope:'general'})
  const revalidated=await retrieval.revalidate(result,signal)
  assert.deepEqual(revalidated.entries,[]);assert.deepEqual(revalidated.snippets,[])
  assert.equal(await prepared(signal),null,'even a backend changing scope without a revision cannot bypass consume filtering')
  const explicit=await retrieval.recall('scope',{consumer:'consumer'})
  assert.equal(explicit.entries.find(item=>item.entry_id==='unknown')?.memory_scope,null)
})
