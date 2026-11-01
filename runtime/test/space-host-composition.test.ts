import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildTextRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js';
import {loadSettings} from '../src/config/config.js';
import {parseCapabilityRegistry} from '../src/config/capability-registry.js';
import {scopeHostSpaceSettings,existingHostPersonalPath,initializeHostSpace,attachExistingHostSpace,type HostSpaceConfig} from '../src/space-host/config.js';
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js';

test('Space composition retains disabled conversation capture while source input and Life use its private ledger',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-disabled-memory-')),configPath=join(dir,'space.json'),personalPath=join(dir,'personal.json');
 const config:HostSpaceConfig={v:1,mode:'host',space:'isolated',personal_path:personalPath,relay_url:'https://relay.invalid',epoch:1,identity:{device:'host',signingPublicKey:{},signingPrivateKey:{},encryptionPublicKey:{},encryptionPrivateKey:{}},content_key:'x'.repeat(43),members:[]};
 await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const base=loadSettings({MEMORY_CONNECTION:'disabled',MEMORY_LEDGER_PATH:join(dir,'old-ledger.sqlite'),MEMORY_PATH:join(dir,'old-memory.sqlite'),PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'fixture'},true);
 const settings=scopeHostSpaceSettings(base,config),capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},search:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}},{});
 const runtime=buildTextRealtimeAssembly({settings,capabilities,spaceHostConfigPath:configPath});
 try{assert.equal(settings.memory_connection,'disabled');const memory=runtime.personalMemory;assert.ok(memory instanceof SubstrateMemoryResource);assert.equal(memory.options.personalMemoryEnabled,false);assert.equal(memory.options.inputConsent,false);await memory.open({deferBackground:true});await assert.rejects(memory.remember({sourceId:'disabled',sessionId:'fixture',sequence:1,occurredAt:new Date().toISOString(),text:'Do not capture this',confirmed:true}),/personal_memory_disabled/);
 const llm=memory.sourceProcessingLlm()!;await memory.receiveSpaceSourceInput({space:'isolated',sender:'phone',opId:'grant'},{kind:'grant',source_id:'calendar',revision:1,provider:llm.baseUrl+'|'+llm.model,allow_upload:true,allow_processing:false});const result=await memory.receiveSpaceSourceInput({space:'isolated',sender:'phone',opId:'fact'},{kind:'source_fact',source_id:'calendar',grant_revision:1,resource_id:'one',source_version:'v1',text:'Explicit phone source',relation:'self',occurred_at:new Date().toISOString()}) as {evidence_id:string};assert.ok(result.evidence_id);assert.equal((await memory.readEvidence(result.evidence_id))?.text,'Explicit phone source');
 await runtime.personalAgent.life.open();await runtime.personalAgent.life.mutate({op:'create',kind:'todo',title:'One authority'},'one');assert.equal(runtime.personalAgent.life.snapshot().todos.length,1);assert.ok(await stat(personalPath+'.memory.sqlite'));await assert.rejects(stat(personalPath+'.life.json'),error=>(error as NodeJS.ErrnoException).code==='ENOENT');await assert.rejects(stat(join(dir,'old-ledger.sqlite')),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
 }finally{await runtime.stop();await rm(dir,{recursive:true,force:true})}
});


test('existing mode keeps original stores, scope and disabled capture while new Space remains isolated',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-existing-')),blackboardPath=join(dir,'original.sqlite'),personalPath=blackboardPath+'.personal.json',configPath=join(dir,'host.json');
 const config:HostSpaceConfig={v:1,mode:'host',data_mode:'existing',space:'relay-space',personal_path:personalPath,relay_url:'https://relay.invalid',epoch:1,identity:{device:'host',signingPublicKey:{},signingPrivateKey:{},encryptionPublicKey:{},encryptionPrivateKey:{}},content_key:'x'.repeat(43),members:[]};
 try{
 const base=loadSettings({BLACKBOARD_PATH:blackboardPath,BLACKBOARD_OWNER_ID:'original-owner',MEMORY_CONNECTION:'disabled',MEMORY_LEDGER_PATH:join(dir,'original-ledger.sqlite'),PIPELINE_MODE:'cascaded',CASCADE_LLM_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'fixture'},true);
 assert.equal(existingHostPersonalPath({BLACKBOARD_PATH:blackboardPath}),personalPath);
 assert.throws(()=>existingHostPersonalPath({BLACKBOARD_PATH:'relative.sqlite'}),/space_existing_data_unavailable/);
 assert.equal(scopeHostSpaceSettings(base,config),base);
 assert.throws(()=>scopeHostSpaceSettings(base,{...config,personal_path:join(dir,'wrong.personal.json')}),/space_existing_data_mismatch/);
 assert.notEqual(scopeHostSpaceSettings(base,{...config,data_mode:undefined}).blackboard_path,blackboardPath);
 await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const capabilities=parseCapabilityRegistry({version:1,modules:{coding:{enabled:false},search:{enabled:false},camera:{enabled:false},knowledge:{enabled:false}}},{});
 const runtime=buildTextRealtimeAssembly({settings:base,capabilities,blackboard:{path:blackboardPath,ownerId:base.blackboard_owner_id},spaceHostConfigPath:configPath});
 try{assert.equal(runtime.personalAgent.path,personalPath);assert.equal(runtime.personalAgent.options.userScope,base.blackboard_owner_id);assert.equal(runtime.personalMemory,undefined);
 let factories=0;
 const shared=buildTextRealtimeAssembly({settings:base,capabilities,spaceHostConfigPath:configPath,sharedPersonal:{host:runtime.personalAgent,memory:undefined},createPersonalMemory:()=>{factories++;throw Error('second_writer')}});
 try{assert.equal(shared.personalAgent,runtime.personalAgent);assert.equal(shared.personalMemory,undefined);assert.equal(factories,0)}finally{await shared.stop()}
 }finally{await runtime.stop()}
 // The isolated initializer must keep rejecting original data before loading relay modules.
 await writeFile(personalPath,'original-data',{mode:0o600});
 await assert.rejects(initializeHostSpace({configPath:join(dir,'new.json'),personalPath,relayUrl:'https://relay.invalid',bootstrapToken:'fixture'}),/space_personal_path_exists/);
 await assert.rejects(attachExistingHostSpace({configPath:join(dir,'new.json'),personalPath:dir,relayUrl:'https://relay.invalid',bootstrapToken:'fixture'}),/space_existing_data_invalid/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
