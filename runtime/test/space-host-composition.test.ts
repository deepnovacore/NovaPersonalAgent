import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildTextRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js';
import {loadSettings} from '../src/config/config.js';
import {parseCapabilityRegistry} from '../src/config/capability-registry.js';
import {scopeHostSpaceSettings,type HostSpaceConfig} from '../src/space-host/config.js';
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js';

test('Space composition retains disabled conversation capture while source input and Life use its private ledger',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'space-disabled-memory-')),configPath=join(dir,'space.json'),personalPath=join(dir,'personal.json');
 const config:HostSpaceConfig={v:1,mode:'host',space:'isolated',personal_path:personalPath,relay_url:'https://relay.invalid',epoch:1,identity:{device:'host',signingPublicKey:{},signingPrivateKey:{},encryptionPublicKey:{},encryptionPrivateKey:{}},content_key:'x'.repeat(43),members:[]};
 await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const base=loadSettings({MEMORY_CONNECTION:'disabled',MEMORY_LEDGER_PATH:join(dir,'old-ledger.sqlite'),MEMORY_PATH:join(dir,'old-memory.sqlite'),PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'fixture',MODEL_API_KEY:'fixture'},true);
 const settings=scopeHostSpaceSettings(base,config),capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},search:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}},{});
 const runtime=buildTextRealtimeAssembly({settings,capabilities,spaceHostConfigPath:configPath});
 try{assert.equal(settings.memory_connection,'disabled');const memory=runtime.personalMemory;assert.ok(memory instanceof SubstrateMemoryResource);assert.equal(memory.options.personalMemoryEnabled,false);assert.equal(memory.options.inputConsent,false);await memory.open({deferBackground:true});await assert.rejects(memory.remember({sourceId:'disabled',sessionId:'fixture',sequence:1,occurredAt:new Date().toISOString(),text:'Do not capture this',confirmed:true}),/personal_memory_disabled/);
 const llm=memory.sourceProcessingLlm()!;await memory.receiveSpaceSourceInput({space:'isolated',sender:'phone',opId:'grant'},{kind:'grant',source_id:'calendar',revision:1,provider:llm.baseUrl+'|'+llm.model,allow_upload:true,allow_processing:false});const result=await memory.receiveSpaceSourceInput({space:'isolated',sender:'phone',opId:'fact'},{kind:'source_fact',source_id:'calendar',grant_revision:1,resource_id:'one',source_version:'v1',text:'Explicit phone source',relation:'self',occurred_at:new Date().toISOString()}) as {evidence_id:string};assert.ok(result.evidence_id);assert.equal((await memory.readEvidence(result.evidence_id))?.text,'Explicit phone source');
 await runtime.personalAgent.life.open();await runtime.personalAgent.life.mutate({op:'create',kind:'todo',title:'One authority'},'one');assert.equal(runtime.personalAgent.life.snapshot().todos.length,1);assert.ok(await stat(personalPath+'.memory.sqlite'));await assert.rejects(stat(personalPath+'.life.json'),error=>(error as NodeJS.ErrnoException).code==='ENOENT');await assert.rejects(stat(join(dir,'old-ledger.sqlite')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
 }finally{await runtime.stop();await rm(dir,{recursive:true,force:true})}
});
