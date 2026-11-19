import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {RealtimeProvider} from '../src/realtime/protocol.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {providerFixture,settle} from './memory-engine-provider-fixture.js'

for(const backend of ['mem0','voicemem'] as const)test(`production composeRealtime selects and feeds ${backend}`,{timeout:30_000},async()=>{
  const {buildAssembly}=await import('../src/composition/assembly.js'),{composeRealtime,plannedMemoryTools}=await import('../src/composition/realtime-assembly.js'),{loadSettings,resolveMemoryComposition}=await import('../src/config/config.js'),{parseCapabilityRegistry}=await import('../src/config/capability-registry.js')
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-composed-engine-')),provider=await providerFixture()
  let graph:ReturnType<typeof composeRealtime>|undefined
  try{
  const settings=loadSettings({DASHSCOPE_API_KEY:'fixture',FAST_MODEL:'fixture',CASCADE_LLM_PROVIDER:'qwen',EMBEDDING_API_KEY:'fixture',EMBEDDING_MODEL:'fixture',MEMORY_RECALL_ENGINE:backend,MEMORY_EXTRACTORS:'ledger,voicemem',MEMORY_PATH:join(root,'legacy.sqlite'),WORKSPACE_GRAPH_PATH:join(root,'ledger.sqlite'),MEMORY_LEDGER_PATH:join(root,'ledger.sqlite'),EXECUTORS:''})
  const plan=resolveMemoryComposition(settings);assert.equal(plan.kind,'ledger');if(plan.kind!=='ledger')throw Error('expected ledger composition')
  // Only provider transport endpoints are redirected to deterministic loopback HTTP; engine/extractor selection is the real env plan.
  const memoryComposition={...plan,local:{...plan.local,extraction:{...plan.local.extraction,baseUrl:provider.baseUrl},embedding:{...plan.local.embedding,baseUrl:provider.baseUrl}}},options={settings,memoryComposition}
  const capabilities=parseCapabilityRegistry({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}})
  const core=buildAssembly({...options,capabilities,memoryTools:plannedMemoryTools(options),blackboard:{path:join(root,'board.sqlite'),ownerId:'fixture'}})
  const transport:RealtimeProvider={connect:()=>Promise.resolve({epoch:1,provider_session_id:'fixture'}),sendAudio:()=>Promise.resolve(),replaceResponseAdaptation:()=>Promise.resolve(),injectHostItem:()=>Promise.resolve({}),createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),async *events(){await Promise.resolve()}}
  graph=composeRealtime(core,transport,{...options,idFactory:()=> 'fixture'},{controlledPreemptiveAlertReconnect:false,preemptiveAlertHistoryRecovery:'none',preemptiveAlertHistoryPairs:4})
    assert.ok(graph.personalMemory instanceof SubstrateMemoryResource)
    const memory=graph.personalMemory
    assert.equal(memory.recallEngine,backend)
    assert.equal(core.memoryTools.engine,backend)
    await memory.open()
    await memory.remember({sourceId:'composed',sessionId:'session',sequence:1,text:'I always prefer concise answers',occurredAt:new Date().toISOString(),confirmed:true})
    await settle(memory)
    assert.ok((await memory.recall('answers')).hits.some(hit=>hit.text==='I prefer concise answers'),'env plan reaches real SDK and canonical ledger hydration')
    assert.ok(provider.counts().embeddings>0)
  }finally{await graph?.stop();await provider.close();await rm(root,{recursive:true,force:true})}
})
