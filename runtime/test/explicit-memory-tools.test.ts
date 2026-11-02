
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Memory,makeMemoryRef} from '../src/core/memory.js'
import {VirtualClock} from '../src/core/clock.js'
import {compileToolSchema} from '../src/core/tool-schema.js'
import {RealtimeRuntimeBridge,type ToolCallReady} from '../src/realtime/bridge.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import type {ExplicitMemoryReceipt,ExplicitMemoryPage} from '../src/memory/explicit-memory.js'
import {buildAssembly} from '../src/composition/assembly.js'
import {buildRealtimeAssembly} from '../src/composition/realtime-assembly.js'
import {loadSettings,settingsSchema} from '../src/config/config.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {hostContextItemSchema,type HostContextItem,type RealtimeProvider} from '../src/realtime/protocol.js'
import {setTimeout as delay} from 'node:timers/promises'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {createConversation, type ConversationRuntime} from '../src/personal-agent/conversations.js'
import {SuggestionPool} from '../src/core/suggestions.js'

test('model tool saves through the real ledger and a fresh conversation reads it; stale authority and invented quotes cannot write',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-memory-tools-'))
 const resource=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'test',model:'fixture',gateway:{async *stream(){await Promise.reject(Error('no model'))},complete(){throw Error('no model')}},inputConsent:true,conversationProviders:['chat']})
 const tools=compileToolSchema([],{includeMemoryRecall:true,includeExplicitMemory:true})
 let serial=0
 const bridge=()=>{
  const memory=new Memory(),clock=new VirtualClock()
  return new RealtimeRuntimeBridge({tools,idFactory:()=>String(++serial),conversationConsumer:'chat',explicitMemory:()=>resource,runtime:{memory,clock,executors:new Map(),ingestUserInput({text}){return Promise.resolve(makeMemoryRef('conversation',memory.append('conversation',{ts:clock.now(),trust:'trusted_user',priority:100,content:{role:'user',text}}).seq))},dispatchExternal(){throw Error('must not delegate')}}})
 }
 const call=(name:string,args:ToolCallReady['arguments']):ToolCallReady=>({kind:'tool_call_ready',call_id:'call-'+(++serial),item_id:'item-'+serial,name,arguments:args,response_id:'response',session_epoch:0})
 try{
  await resource.open({deferBackground:true})
  const a=bridge(),originRef=await a.acceptUserTranscript('请记住叫我 kant')
  const userTurn={originRef,sessionEpoch:0,acceptedUserInputRevision:1,stillWanted:()=>true}
  const saved=await a.acceptToolCall(call('memory__remember',{action:'set',kind:'preference',slot:'preferred_name',text:'kant',quote:'叫我 kant'}),{originRef,userTurn})
  assert.equal(saved.code,'committed');assert.equal((JSON.parse(saved.host_item.content) as ExplicitMemoryReceipt).current?.text,'kant')
  const b=bridge(),second=await b.acceptUserTranscript('记得我叫什么吗')
  const lookup=await b.acceptToolCall(call('memory__lookup',{slot:'preferred_name'}),{originRef:second})
  assert.equal((JSON.parse(lookup.host_item.content) as ExplicitMemoryPage).entries[0]?.text,'kant')
  const refused=await a.acceptToolCall(call('memory__remember',{action:'set',kind:'preference',slot:'preferred_name',text:'kay',quote:'叫我 kay'}),{originRef,userTurn})
  assert.equal(refused.accepted,false)
  const stale=await a.acceptToolCall(call('memory__remember',{action:'forget',slot:'preferred_name',quote:'叫我 kant'}),{originRef,userTurn:{...userTurn,stillWanted:()=>false}})
  assert.equal(stale.accepted,false)
  const forged=await a.acceptToolCall(call('memory__remember',{action:'forget',slot:'preferred_name',quote:'叫我 kant'}),{originRef})
  assert.equal(forged.accepted,false,'a trusted transcript alone is not live write authority')
  assert.equal((await resource.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]?.text,'kant')
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('production composition delivers explicit tool receipts across two service sessions', {timeout:30000}, async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-explicit-service-'))
 const gateway={async *stream(){await Promise.reject(Error('no model'))},complete(){throw Error('no model')}}
 const createResource=()=>new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'test',model:'fixture',gateway,inputConsent:true,conversationProviders:['chat']})
 let resource=createResource()
 const outputs:HostContextItem[]=[]
 let sessionId=0
 const session=()=>{
  const provider:RealtimeProvider={
   connect:()=>Promise.resolve({epoch:1,provider_session_id:'fixture'}),
   sendAudio:()=>Promise.resolve(),replaceResponseAdaptation:()=>Promise.resolve(),
   injectHostItem:item=>{outputs.push(hostContextItemSchema.parse(item));return Promise.resolve({session_epoch:1,host_item_id:item.host_item_id,provider_item_id:'provider-'+item.host_item_id})},
   createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
   async *events(signal){if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))},
  }
  const core=buildAssembly({settings:settingsSchema.parse({executors:[]}),gateway,clock:new VirtualClock(),blackboard:{path:join(root,'board-'+(++sessionId)+'.sqlite'),ownerId:'fixture'},capabilities:parseCapabilityRegistry({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}})})
  return buildRealtimeAssembly({core,provider,createPersonalMemory:()=>resource,memoryConsumerFingerprint:'chat',memoryReadMode:'text',onDiagnostic:()=>undefined})
 }
 const call=async(graph:ReturnType<typeof session>,id:string,text:string,name:string,args:ToolCallReady['arguments'])=>{
  await graph.service.handleEvent({kind:'user_speech_started',session_epoch:1,speech_id:id,provider_item_id:id})
  await graph.service.handleEvent({kind:'user_speech_ended',session_epoch:1,speech_id:id,provider_item_id:id})
  await graph.service.handleEvent({kind:'user_transcript_final',session_epoch:1,item_id:id,text})
  await graph.service.handleEvent({kind:'response_started',session_epoch:1,response_id:'response-'+id})
  await graph.service.handleEvent({kind:'tool_call_ready',session_epoch:1,call_id:id,item_id:'tool-'+id,response_id:'response-'+id,name,arguments:args})
  await graph.service.handleEvent({kind:'response_terminal',session_epoch:1,response_id:'response-'+id,status:'completed',reason:''})
  for(let i=0;i<400&&!outputs.some(item=>item.call_id===id);i++)await delay(10)
  const output=outputs.find(item=>item.call_id===id)
  assert(output,'service must deliver the tool result to the provider')
  return output.content
 }
 let graph:ReturnType<typeof session>|undefined
 try{
  await resource.open({deferBackground:true});graph=session();await graph.start()
  const saved=JSON.parse(await call(graph,'save','请记住叫我 kant','memory__remember',{action:'set',kind:'preference',slot:'preferred_name',text:'kant',quote:'叫我 kant'})) as ExplicitMemoryReceipt
  assert.equal(saved.state,'committed');assert.equal(saved.current?.text,'kant')
  await graph.stop();resource=createResource();await resource.open({deferBackground:true});graph=session();await graph.start()
  const found=JSON.parse(await call(graph,'lookup','记得我叫什么吗','memory__lookup',{slot:'preferred_name'})) as ExplicitMemoryPage
  assert.equal(found.entries[0]?.text,'kant')
 }finally{await graph?.stop();await resource.close();await rm(root,{recursive:true,force:true})}
})

import {FULL_MEMORY_TOOLS, NO_MEMORY_TOOLS, deriveMemoryToolCapabilities, planMemoryToolCapabilities, resolveMemoryToolCapabilities} from '../src/memory/tool-capabilities.js'
import {buildCascadedRealtimeAssembly, buildTextRealtimeAssembly, buildQwenRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {HostSpaceConfig} from '../src/space-host/config.js'
import {composeRealtime, plannedMemoryTools} from '../src/composition/realtime-assembly.js'

const fixtureGateway = {async *stream() {await Promise.reject(Error('unused'))}, complete() {throw Error('unused')}}
const recallOnly: PersonalMemoryResource = {open: () => Promise.resolve(), close: () => Promise.resolve(), recall: () => Promise.resolve({source: 'personal', state: 'empty', scope: 'any', hits: [], degraded: false})}

test('planMemoryToolCapabilities agrees with resource members for each composition branch', () => {
  const ledger = Object.create(SubstrateMemoryResource.prototype) as PersonalMemoryResource
  const mem0 = createMem0PersonalMemory({path: join(tmpdir(), 'capability-mem0'), userId: 'fixture', embedding: {baseUrl: 'https://embedding.example', apiKey: 'fixture', model: 'fixture'}})
  assert.deepEqual(deriveMemoryToolCapabilities(mem0, 'mem0'), {recall: true, evidence: false, sourceFilter: false, lookup: false, remember: false, engine: 'mem0'})
  const knowledge = {...recallOnly, readEvidence: () => Promise.resolve(null)}
  const local = Object.assign(() => ledger, {localMemoryConfig: {}})
  const isolated = {data_mode: 'isolated'} as HostSpaceConfig
  for (const entry of [
    {name: 'legacy local ledger', settings: settingsSchema.parse({executors: []}), createPersonalMemory: local, knowledge: false, resource: ledger, engine: 'ledger'},
    {name: 'isolated space ledger', settings: settingsSchema.parse({executors: []}), knowledge: false, spaceConfig: isolated, resource: ledger, engine: 'ledger'},
    {name: 'knowledge wrapper', settings: settingsSchema.parse({executors: []}), knowledge: true, resource: knowledge, engine: 'knowledge'},
    {name: 'untagged factory retains legacy tools', settings: settingsSchema.parse({executors: []}), createPersonalMemory: () => ledger, knowledge: false, resource: ledger, engine: 'ledger'},
    {name: 'settings alone do not identify an injected factory', settings: settingsSchema.parse({executors: [], memory_provider: 'mem0'}), createPersonalMemory: () => ledger, knowledge: true, resource: ledger, engine: 'ledger'},
    {name: 'mem0 tagged factory with knowledge does not swap', settings: settingsSchema.parse({executors: []}), createPersonalMemory: Object.assign(() => mem0, {memoryBackend: 'mem0'}), knowledge: true, resource: mem0, engine: 'mem0'},
    {name: 'remote tagged factory', settings: settingsSchema.parse({executors: []}), createPersonalMemory: Object.assign(() => recallOnly, {memoryBackend: 'remote'}), knowledge: false, resource: recallOnly, engine: 'remote'},
    {name: 'remote', settings: settingsSchema.parse({executors: [], memory_connection: 'remote'}), createPersonalMemory: () => recallOnly, knowledge: false, resource: recallOnly, engine: 'remote'},
    {name: 'no memory still has session recall', settings: settingsSchema.parse({executors: []}), knowledge: false, resource: undefined, engine: 'none'},
  ] as const) {
    assert.deepEqual(planMemoryToolCapabilities(entry), deriveMemoryToolCapabilities(entry.resource, entry.engine), entry.name)
  }
  assert.equal(deriveMemoryToolCapabilities({...recallOnly, lookupExplicit: () => Promise.resolve({entries: [], next_cursor: null})}).lookup, false, 'lookup needs stable get as well')
  assert.equal(deriveMemoryToolCapabilities(recallOnly).evidence, false)
})

test('live resource removes unsupported tools from an untagged factory FULL plan', () => {
  const planned = planMemoryToolCapabilities({settings: settingsSchema.parse({executors: []}), createPersonalMemory: () => recallOnly, knowledge: false})
  assert.deepEqual(planned, FULL_MEMORY_TOOLS)
  assert.deepEqual(resolveMemoryToolCapabilities(recallOnly, planned), deriveMemoryToolCapabilities(recallOnly, 'ledger'))
})

for (const build of [buildTextRealtimeAssembly, buildCascadedRealtimeAssembly, buildQwenRealtimeAssembly]) {
  for (const branch of ['explicit FULL untagged', 'untagged', 'mem0 tagged', 'remote', 'default ledger', 'explicit FULL mem0', 'explicit NONE untagged'] as const) {
    test(`${build.name} compiles memory capabilities for ${branch}`, async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-builder-capabilities-'))
      const settings = loadSettings({PIPELINE_MODE: 'cascaded', CASCADE_LLM_PROVIDER: 'qwen', INTEGRATED_PROVIDER: 'qwen',
        DASHSCOPE_API_KEY: 'fixture', DOUBAO_BIGMODEL_API_KEY: 'fixture', EXECUTORS: '', CAMERA_MODULE_ENABLED: 'false',
        MEMORY_PATH: join(root, 'legacy.sqlite'), MEMORY_LEDGER_PATH: join(root, 'ledger.sqlite'), WORKSPACE_GRAPH_PATH: join(root, 'workspace.sqlite'),
        ...(branch === 'remote' ? {MEMORY_CONNECTION: 'remote', MEMORY_URL: 'https://memory.example', MEMORY_TOKEN: 'fixture'} : {}),
      })
      const capabilities = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}})
      const createPersonalMemory = branch.includes('mem0') ? Object.assign(() => recallOnly, {memoryBackend: 'mem0' as const}) : () => recallOnly
      const graph = build({settings, capabilities,
        ...(branch === 'default ledger' ? {} : {createPersonalMemory}),
        ...(branch.startsWith('explicit FULL') ? {memoryTools: FULL_MEMORY_TOOLS} : branch === 'explicit NONE untagged' ? {memoryTools: NO_MEMORY_TOOLS} : {}),
      })
      try {
        assert.deepEqual([...graph.tools.bindings.keys()].filter(name => name.startsWith('memory__')).sort(),
          branch === 'explicit NONE untagged' ? [] : branch === 'mem0 tagged' || branch === 'remote' ? ['memory__recall']
            : ['memory__evidence', 'memory__lookup', 'memory__recall', 'memory__remember'])
        if (branch === 'default ledger') assert.deepEqual(graph.core.memoryTools, FULL_MEMORY_TOOLS)
      } finally {await graph.stop(); await rm(root, {recursive: true, force: true})}
    })
  }
}

for (const branch of ['explicit NONE ledger', 'derived ledger', 'explicit FULL recall-only', 'derived recall-only'] as const) {
  test(`conversationRuntimeFactory exposes ${branch} memory tools at provider connect`, async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-conversation-capabilities-'))
    const ledger: PersonalMemoryResource = {...recallOnly,
      readEvidence: () => Promise.resolve(null), recallSources: () => Promise.reject(Error('unused')),
      lookupExplicit: () => Promise.resolve({entries: [], next_cursor: null}), get: () => Promise.resolve(null),
      beginExplicitTurn: () => {throw Error('unused')}, writeExplicit: () => Promise.reject(Error('unused')),
    }
    const memory = branch.endsWith('ledger') ? ledger : recallOnly
    const host = new PersonalAgentHost({path: join(root, 'personal.json'), userScope: 'test', memory: () => memory, pool: new SuggestionPool(), evidence: () => null})
    let offered: string[] | undefined
    const provider: RealtimeProvider = {
      connect: options => {
        offered = options.tools.map(tool => (tool.function as {name: string}).name).filter(name => name.startsWith('memory__')).sort()
        return Promise.resolve({epoch: 1, provider_session_id: 'capability'})
      },
      sendAudio: () => Promise.resolve(), replaceResponseAdaptation: () => Promise.resolve(),
      injectHostItem: () => Promise.resolve({}), createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
      async *events(signal) {if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}))},
    }
    let runtime: ConversationRuntime | undefined
    try {
      await host.open()
      const factory = conversationRuntimeFactory({host, memory: () => memory, clock: new VirtualClock(), gateway: fixtureGateway,
        // A disabled static plan must still defer to the live ledger when no override is supplied.
        settings: settingsSchema.parse({executors: [], camera_module_enabled: false, cascade_llm_provider: 'qwen', dashscope_api_key: 'fixture', memory_connection: branch.endsWith('ledger') ? 'disabled' : 'local'}),
        capabilities: parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}}),
        ...(branch === 'explicit NONE ledger' ? {memoryTools: NO_MEMORY_TOOLS} : branch === 'explicit FULL recall-only' ? {memoryTools: FULL_MEMORY_TOOLS} : {}),
        createTextProvider: () => provider,
      })
      runtime = await factory(createConversation('chat', 'Capabilities', null, 'chat:main'), () => undefined)
      assert.deepEqual(offered, branch === 'explicit NONE ledger' ? [] : branch === 'derived recall-only' ? ['memory__recall']
        : ['memory__evidence', 'memory__lookup', 'memory__recall', 'memory__remember'])
    } finally {await runtime?.close(); await host.close(); await rm(root, {recursive: true, force: true})}
  })
}

test('buildAssembly default memory schemas remain byte-identical to FULL', async () => {
  const settings = settingsSchema.parse({executors: []})
  const capabilities = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}})
  const first = buildAssembly({settings, gateway: fixtureGateway, capabilities})
  const second = buildAssembly({settings, gateway: fixtureGateway, capabilities, memoryTools: FULL_MEMORY_TOOLS})
  assert.equal(JSON.stringify(first.tools.schemas), JSON.stringify(second.tools.schemas))
  await first.stop(); await second.stop()
})

test('composeRealtime reports unsupported offered tools once after memory opens', async () => {
  let opened = false
  const events: {kind: string; payload: unknown}[] = []
  const core = buildAssembly({settings: settingsSchema.parse({executors: []}), gateway: fixtureGateway, capabilities: parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}})})
  const provider: RealtimeProvider = {
    connect: () => Promise.resolve({epoch: 1, provider_session_id: 'capability'}), sendAudio: () => Promise.resolve(), replaceResponseAdaptation: () => Promise.resolve(),
    injectHostItem: () => Promise.resolve({}), createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
    async *events(signal) {if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}))},
  }
  const graph = composeRealtime(core, provider, {settings: core.settings, idFactory: () => 'capability',
    createPersonalMemory: () => ({...recallOnly, open: () => {opened = true; return Promise.resolve()}}),
    telemetry: {record: (kind, payload) => {if (kind === 'memory.capability.mismatch') {assert.equal(opened, true); events.push({kind, payload})}}, close() { /* fixture owns no resources */ }}, onDiagnostic() { /* diagnostics not under test */ },
  }, {controlledPreemptiveAlertReconnect: false, preemptiveAlertHistoryRecovery: 'none', preemptiveAlertHistoryPairs: 4})
  try {
    assert.equal(events.length, 0)
    await graph.start()
    assert.deepEqual(events.map(event => (event.payload as {tool: string}).tool).sort(), ['memory__evidence', 'memory__lookup', 'memory__remember'])
    await graph.start()
    assert.equal(events.length, 3)
  } finally {await graph.stop()}
})

import {createMem0PersonalMemory} from '../src/mem0/resource.js'
import {personalMemoryFactory} from '../src/memory/factory.js'
import {prepareKnowledge} from '../src/knowledge/assembly.js'

for (const backend of ['ledger', 'mem0', 'remote', 'none'] as const) test(`shared conversation tools before resource creation use the configured ${backend} plan`, async () => {
  const settings = loadSettings({DASHSCOPE_API_KEY: 'fixture', CASCADE_LLM_PROVIDER: 'qwen', EXECUTORS: '',
    ...(backend === 'mem0' ? {MEMORY_PROVIDER: 'mem0'} : backend === 'remote' ? {MEMORY_CONNECTION: 'remote', MEMORY_URL: 'https://memory.example', MEMORY_TOKEN: 'fixture'} : backend === 'none' ? {MEMORY_CONNECTION: 'disabled'} : {})})
  const createPersonalMemory = personalMemoryFactory(settings)
  const planned = plannedMemoryTools({settings, ...(createPersonalMemory ? {createPersonalMemory} : {})})
  const caps = resolveMemoryToolCapabilities(undefined, planned)
  const core = buildAssembly({settings, gateway: fixtureGateway, memoryTools: caps, capabilities: parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: false}}})})
  try {
    assert.deepEqual([...core.tools.bindings.keys()].filter(name => name.startsWith('memory__')).sort(), backend === 'ledger'
      ? ['memory__evidence', 'memory__lookup', 'memory__recall', 'memory__remember'] : ['memory__recall'])
    assert.equal(caps.engine, backend)
    const ledger = Object.create(SubstrateMemoryResource.prototype) as PersonalMemoryResource
    assert.deepEqual(resolveMemoryToolCapabilities(ledger, planned), FULL_MEMORY_TOOLS, 'live shared ledger overrides a reduced static plan')
  } finally {await core.stop()}
})

for (const branch of ['ledger', 'isolated', 'knowledge', 'mem0', 'remote', 'none'] as const) test(`plan agrees with composeRealtime resource for ${branch}`, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-capability-composition-'))
  const knowledgeEnabled = branch === 'knowledge' || branch === 'mem0'
  const settings = loadSettings({DASHSCOPE_API_KEY: 'fixture', CASCADE_LLM_PROVIDER: 'qwen', EXECUTORS: '',
    MEMORY_PATH: join(root, 'legacy.sqlite'), MEMORY_LEDGER_PATH: join(root, 'ledger.sqlite'), KNOWLEDGE_PATH: join(root, 'knowledge.sqlite'),
    ...(branch === 'mem0' ? {MEMORY_PROVIDER: 'mem0'} : branch === 'remote' ? {MEMORY_CONNECTION: 'remote', MEMORY_URL: 'https://memory.example', MEMORY_TOKEN: 'fixture'} : branch === 'ledger' ? {} : {MEMORY_CONNECTION: 'disabled'})})
  const capabilities = parseCapabilityRegistry({version: 1, modules: {search: {enabled: false}, camera: {enabled: false}, coding: {enabled: false}, knowledge: {enabled: knowledgeEnabled}}})
  const knowledge = await prepareKnowledge(settings, capabilities)
  let graph: ReturnType<typeof composeRealtime> | undefined
  try {
    const spaceConfigPath = branch === 'isolated' ? join(root, 'space.json') : undefined
    if (spaceConfigPath) await writeFile(spaceConfigPath, JSON.stringify({v: 1, mode: 'host', data_mode: 'isolated', space: 'fixture', personal_path: join(root, 'personal.json'), relay_url: 'https://relay.example', epoch: 1, identity: {device: 'fixture', signingPublicKey: {}, signingPrivateKey: {}, encryptionPublicKey: {}, encryptionPrivateKey: {}}, content_key: 'a'.repeat(43), members: []}), {mode: 0o600})
    const createPersonalMemory = personalMemoryFactory(settings)
    const options = {settings, ...(knowledge ? {knowledge} : {}), ...(createPersonalMemory ? {createPersonalMemory} : {}), ...(spaceConfigPath ? {spaceHostConfigPath: spaceConfigPath} : {})}
    const planned = plannedMemoryTools(options)
    const core = buildAssembly({...options, capabilities, gateway: fixtureGateway, memoryTools: planned})
    const provider: RealtimeProvider = {
      connect: () => Promise.resolve({epoch: 1, provider_session_id: 'capability'}), sendAudio: () => Promise.resolve(), replaceResponseAdaptation: () => Promise.resolve(),
      injectHostItem: () => Promise.resolve({}), createResponse: () => Promise.resolve(), cancelResponse: () => Promise.resolve(), close: () => Promise.resolve(),
      async *events() {await Promise.resolve()},
    }
    graph = composeRealtime(core, provider, {...options, idFactory: () => 'capability'}, {controlledPreemptiveAlertReconnect: false, preemptiveAlertHistoryRecovery: 'none', preemptiveAlertHistoryPairs: 4})
    // Composition creates the real facade synchronously; opening SDKs or relay transports is unnecessary.
    assert.deepEqual(deriveMemoryToolCapabilities(graph.personalMemory, planned.engine), planned)
    assert.equal(planned.engine, branch === 'isolated' ? 'ledger' : branch)
  } finally {await graph?.stop(); await knowledge?.close(); await rm(root, {recursive: true, force: true})}
})
