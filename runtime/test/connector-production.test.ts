import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {buildTextRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'
import {loadSettings} from '../src/config/config.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'

test('production text host materializes the shared source ledger for configured local memory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-connector-production-'))
 const settings=loadSettings({NOVA_AUDIO_AGENT_MEMORY_LEDGER_PATH:join(root,'memory.sqlite'),NOVA_AUDIO_AGENT_MEMORY_PATH:join(root,'legacy.sqlite'),NOVA_AUDIO_AGENT_PIPELINE_MODE:'cascaded',NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'fixture',NOVA_AUDIO_AGENT_MODEL_API_KEY:'fixture',NOVA_AUDIO_AGENT_MEMORY_CONNECTION:'local'},true)
 const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},search:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}},{})
 const runtime=buildTextRealtimeAssembly({settings,capabilities})
 try{assert(runtime.personalMemory instanceof SubstrateMemoryResource)}finally{await runtime.stop();await rm(root,{recursive:true,force:true})}
})
