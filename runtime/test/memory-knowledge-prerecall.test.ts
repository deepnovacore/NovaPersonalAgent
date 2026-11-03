import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {loadSettings} from '../src/config/config.js'
import {configuredMemoryConsumer} from '../src/memory/consumer.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {buildAssembly} from '../src/composition/assembly.js'
import {composeRealtime,plannedMemoryTools} from '../src/composition/realtime-assembly.js'
import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'
import {KnowledgeMcpAdapter} from '../src/knowledge/mcp.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import {retrievalPrerecall} from '../src/memory/prerecall-port.js'
import type {RealtimeProvider} from '../src/realtime/protocol.js'
import {providerFixture} from './memory-engine-provider-fixture.js'

const signal=()=>new AbortController().signal

test('production knowledge-only prerecall is a consumer-authorized reference channel, revalidated at consume', {timeout:30_000},async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-knowledge-prerecall-')),provider=await providerFixture(),path=join(root,'ledger.sqlite')
  const settings=loadSettings({DASHSCOPE_API_KEY:'fixture',PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'qwen',EXECUTORS:'',MEMORY_CONNECTION:'disabled',WORKSPACE_GRAPH_PATH:path,MEMORY_LEDGER_PATH:path,MEMORY_CONSOLIDATION_ENABLED:'false'})
  const capabilities=parseCapabilityRegistry({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:true}}})
  const embedding=new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2})
  const service=new KnowledgeService({store:new KnowledgeStoreClient({path:join(root,'knowledge.sqlite')}),embedding,requireEvidenceLedger:true}),adapter=new KnowledgeMcpAdapter(service)
  const knowledge={service,adapter,embedding,capabilities,codexEntries:{},close:async()=>{await adapter.close();await service.close()}}
  let graph:ReturnType<typeof composeRealtime>|undefined
  try{
    await service.open();await adapter.connect()
    const options={settings,knowledge,memoryReadMode:'text' as const},core=buildAssembly({...options,capabilities,memoryTools:plannedMemoryTools(options),blackboard:{path:join(root,'board.sqlite'),ownerId:'fixture'}})
    const transport:RealtimeProvider={connect:()=>Promise.resolve({epoch:1,provider_session_id:'fixture'}),sendAudio:()=>Promise.resolve(),replaceResponseAdaptation:()=>Promise.resolve(),injectHostItem:()=>Promise.resolve({}),createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),async *events(){await Promise.resolve()}}
    graph=composeRealtime(core,transport,{...options,idFactory:()=> 'fixture'},{controlledPreemptiveAlertReconnect:false,preemptiveAlertHistoryRecovery:'none',preemptiveAlertHistoryPairs:4})
    const memory=graph.personalMemory!,retrieval=graph.retrieval,consumer=configuredMemoryConsumer(settings,'text');assert.ok(consumer)
    assert.equal(core.memoryTools.engine,'knowledge');assert.ok(memory.requiresConversationConsumer)
    assert.ok(memory.readEvidence&&memory.recordEvidence&&memory.recordEvidenceBatch&&memory.forgetSource&&memory.processingGrant&&memory.setProcessingConsent&&memory.canReadConversationEvidence)
    await memory.open()
    // Bind the same real A-only resource used by production; no personal-memory mock or scope default.
    await service.bindEvidenceLedger({record:input=>memory.recordEvidence!(input),recordBatch:inputs=>memory.recordEvidenceBatch!(inputs),read:id=>memory.readEvidence!(id),remove:id=>memory.forgetSource!(id),processingGrant:(...args)=>memory.processingGrant!(...args),canProcess:(...args)=>memory.canProcessEvidence!(...args),processingStamp:ids=>memory.processingStamp!(ids)})
    const prepare=retrievalPrerecall(()=>retrieval,()=>consumer)
    for(const outcome of ['unchanged','revoked','forgotten','changed','expired','conversation-quote','general-quote'] as const)await t.test(outcome,async()=>{
      const text=`KNOWLEDGE_REFERENCE_${outcome}: project launch requires a documented rollback checklist.`,file=join(root,`${outcome}.md`)
      await writeFile(file,text)
      const ingested=await service.handle('knowledge.ingest',{kind:'file',locator:file,consent:true}) as {ok?:boolean;id:string}
      try{
        assert.equal(ingested.ok,true)
        const query='project launch rollback checklist',indexHits=await service.recall(query,5),id=indexHits[0]?.evidence_id
        assert.ok(id);assert.equal(indexHits.length,1);assert.equal(indexHits[0]?.source_id,ingested.id)
        const canonical=await memory.readEvidence!(id);assert.equal(canonical?.source_kind,'file');assert.equal(canonical?.text,text)
        assert.equal(await memory.canReadConversationEvidence!(id,consumer),true)
        const raw=await retrieval.recall(query,{userOnly:true,consumer})
        assert.equal(raw.state,'ok');assert.equal(raw.degraded,false);assert.deepEqual(raw.entries,[])
        assert.equal(raw.snippets[0]?.evidence_id,id);assert.equal(raw.snippets[0]?.context_kind,'knowledge_reference');assert.equal(raw.snippets[0]?.trust,'untrusted_external')
        const prepared=await prepare(query,signal());assert.ok(prepared)
        if(outcome==='unchanged'){
          const context=await prepared(signal());assert.ok(context);assert.ok(context.includes(text));assert.ok(context.includes('knowledge_reference'));assert.ok(context.includes(id))
          const denied=await retrievalPrerecall(()=>retrieval,()=> 'unauthorized-receiving-model')(query,signal());assert.ok(denied);assert.equal(await denied(signal()),null)
          let calls=0
          const unmarked=new UnifiedRetrieval({memory:()=>memory,rawRecall:async(q,k,abort)=>{calls++;return (await service.recall(q,Math.min(k,5),abort)).flatMap(hit=>typeof hit.evidence_id==='string'?[{evidence_id:hit.evidence_id,score:hit.score}]:[])}})
          const unknown=await retrievalPrerecall(()=>unmarked,()=>consumer)(query,signal());assert.ok(unknown);assert.equal(await unknown(signal()),null)
          assert.equal(calls,0,'an arbitrary raw hook is not a knowledge-reference capability')
          const unauthorized=new UnifiedRetrieval({memory:()=>memory,rawRecallKind:'knowledge',rawRecall:async(q,k,abort)=>(await service.recall(q,Math.min(k,5),abort)).flatMap(hit=>typeof hit.evidence_id==='string'?[{evidence_id:hit.evidence_id,score:hit.score}]:[])})
          assert.deepEqual((await unauthorized.recall(query,{userOnly:true})).snippets,[],'knowledge references require an actual receiving consumer')
        }else{
          if(outcome==='revoked')await memory.setProcessingConsent!(`knowledge:${ingested.id}`,memory.processingGrant!(false,2))
          if(outcome==='forgotten')await service.handle('knowledge.remove',{id:ingested.id})
          if(outcome==='changed'||outcome==='expired'||outcome==='conversation-quote'||outcome==='general-quote'){
            const db=new DatabaseSync(path)
            const field=outcome==='changed'?'raw_text':outcome==='expired'?'retention_until':'source_kind'
            const value=outcome==='changed'?'Changed canonical document; stale prefetched relevance is invalid':outcome==='expired'?new Date(Date.now()-1000).toISOString():outcome==='conversation-quote'?'conversation':'user_correction'
            try{db.prepare(`UPDATE memory_evidence SET payload_json=json_set(payload_json,'$.${field}',?) WHERE id=?`).run(value,id)}finally{db.close()}
          }
          assert.equal(await prepared(signal()),null,`${outcome} knowledge must not survive prepare → consume`)
          if(outcome==='conversation-quote'||outcome==='general-quote'){
            const fresh=await prepare(query,signal());assert.ok(fresh);assert.equal(await fresh(signal()),null,'non-file canonical quotes cannot escape through the knowledge channel on fresh retrieval')
          }
        }
      }finally{
        assert.deepEqual(await service.handle('knowledge.remove',{id:ingested.id}),{ok:true},'fixture source cleanup must succeed')
      }
    })
    assert.deepEqual((await memory.recall('project')).hits,[],'knowledge-only references never become personal facts')
  }finally{await graph?.stop();await knowledge.close();await provider.close();await rm(root,{recursive:true,force:true})}
})
