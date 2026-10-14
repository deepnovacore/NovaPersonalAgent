// Synthetic sources, real SQLite + ScheduleService + TaskLoop + conversationRuntimeFactory + provider.
import assert from 'node:assert/strict'
import {mkdir,writeFile,readFile,appendFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {homedir} from 'node:os'
import {createHash} from 'node:crypto'
import {MemoryLedgerClient} from '../../dist/src/memory-ledger/store-client.js'
import {OpenAIModelGateway} from '../../dist/src/model/model-gateway.js'
import {SubstrateMemoryResource} from '../../dist/src/memory-substrate/resource.js'
import {PersonalAgentHost} from '../../dist/src/personal-agent/host.js'
import {conversationRuntimeFactory} from '../../dist/src/personal-agent/conversation-runtime.js'
import {buildCascadedTextProvider} from '../../dist/src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../../dist/src/composition/cascaded-realtime-assembly.js'
import {SuggestionPool} from '../../dist/src/core/suggestions.js'
import {settingsSchema} from '../../dist/src/config/config.js'
import {RealClock} from '../../dist/src/core/clock.js'
const directory=resolve(process.argv[2]);await mkdir(directory,{recursive:true,mode:0o700})
const baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1',model='qwen3-vl-plus',apiKey=process.env.DASHSCOPE_API_KEY
assert(apiKey)
const originalFetch=globalThis.fetch
globalThis.fetch=async(...args)=>{const response=await originalFetch(...args);if(!response.ok){const body=await response.clone().text();console.log('HTTP_FAILURE',response.status,body.replaceAll(apiKey,'[redacted]').slice(0,2000))}return response}
const originalPaths=['blackboard.sqlite.personal.json.profile-draft.json','blackboard.sqlite.personal.json.feishu/state.json'].map(p=>join(homedir(),'.nova-audio-agent',p))
const digest=async p=>createHash('sha256').update(await readFile(p).catch(()=>Buffer.from('absent'))).digest('hex'),before=await Promise.all(originalPaths.map(digest))
const settings=settingsSchema.parse({executors:[],camera_module_enabled:false,pipeline_mode:'cascaded',cascade_llm_provider:'qwen',cascade_llm_model:model,dashscope_api_key:apiKey,model_base_url:baseUrl,fast_model:model,support_model:model})
const consumer=createHash('sha256').update(baseUrl+'|'+model).digest('hex'),prefix='personal:'+createHash('sha256').update('synthetic-background').digest('hex')+':',source_id=prefix+'messages'
let host,client,resource,modelCalls=0,writerCalls=0
const gateway=new OpenAIModelGateway({baseUrl,apiKey,clock:new RealClock(),requestTimeout:120,redirect:'error',metrics:{record(){}}}),complete=gateway.complete.bind(gateway)
gateway.complete=async request=>{writerCalls++;console.log('PROFILE_CALL',writerCalls);return complete(request)}
const report={synthetic:true,real_agent_task:true,real_background_trigger:true,model,endpoint:baseUrl,trigger_modes:['source_change','existing_scheduler_timer'],source:'Only synthetic self-authored messages; isolated host/factory/resource/SQLite runtime',runs:[],checks:[],profile_publications:[],semantic_acceptance:'not_evaluated_by_harness'}
const save=async()=>writeFile(join(directory,'report.json'),JSON.stringify({...report,model_calls:modelCalls,writer_calls:writerCalls},null,2),{mode:0o600})
const op=async request=>{try{const result=await resource.sourceProcessing(request);if(request.action==='publish')report.profile_publications.push({run_id:request.run_id,applied:result.applied,revision:result.revision});return result}catch(error){if(request.action==='publish')report.profile_publications.push({run_id:request.run_id,applied:false,error:error.message});await appendFile(join(directory,'operation-errors.jsonl'),JSON.stringify({request,error:error.message})+'\n',{mode:0o600});throw error}}
const start=async()=>{
 client=new MemoryLedgerClient(join(directory,'ledger.sqlite'));await client.open()
 resource=new SubstrateMemoryResource({client,userId:'synthetic-background',gateway,model,extractionFingerprint:consumer,sourceProcessingLlm:{baseUrl,apiKey},personalMemoryEnabled:false,closeClient:false});await resource.open();assert.equal(resource.prefix,prefix)
 const memory={sourceProcessing:op,sourceProcessingConsumer:resource.sourceProcessingConsumer.bind(resource),sourceProcessingLlm:resource.sourceProcessingLlm.bind(resource),sourceProcessingProfile:resource.sourceProcessingProfile.bind(resource)}
 host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'synthetic-background',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>memory,gateway,settings,blackboard:{path:join(directory,'blackboard.sqlite'),ownerId:'synthetic'},searchTransport:{search:async()=>{throw Error('unexpected_search')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:input=>{const factory=cascadedProviderRegistries.llm.qwen(input);return {open:(...args)=>{const port=factory.open(...args),stream=port.stream.bind(port);port.stream=async function*(request){modelCalls++;console.log('AGENT_CALL',modelCalls);try{yield* stream(request)}catch(error){console.log('STREAM_FAILURE',error.code,error.message);throw error}};return port}}}}})}),()=>{})
 await host.open()
}
const stop=async()=>{await host?.close();await resource?.close();await client?.close()}
const wait=async(predicate,label,ms=240000)=>{const end=Date.now()+ms;let next=0;while(Date.now()<end){const result=await predicate();if(result)return result;if(host.tasks.list().some(task=>task.phase==='cancelled'||task.phase==='waiting'&&task.waiting_reason==='delivery_interrupted'))throw Error('task_failed:'+host.tasks.list().filter(task=>task.phase==='cancelled'||task.waiting_reason==='delivery_interrupted').map(task=>task.waiting_reason??task.phase).join(','));if(Date.now()>next){console.log('WAIT',label);next=Date.now()+20000;await writeFile(join(directory,'progress.json'),JSON.stringify({runs:host.schedules.activeRuns(),tasks:host.tasks.list()},null,2),{mode:0o600})}await new Promise(r=>setTimeout(r,500))}throw Error('timeout_'+label)}
const add=async(n,text)=>{const at=new Date().toISOString();await client.memory('append_evidence',{id:prefix+'e:'+n,source_id,source_kind:'im',locator:'synthetic:'+n,raw_text:text,hash:'v'+n,observed_at:at,recorded_at:at,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'synthetic',message_id:String(n),chat_id:'synthetic'}})}
try{
 await start();assert.equal(modelCalls+writerCalls,0);assert(host.schedules.list().some(s=>s.processing&&s.enabled));report.checks.push('default registration, zero model calls without source changes')
 await client.memory('source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:consumer,embedding_provider:null,conversation_providers:[]}})
 await add(1,'我是合成场景里的林舟，正在开发个人开源读书笔记工具 PaperNest。这周由我负责离线检索，已经完成分页接口；向量检索还只是计划。')
 await add(2,'我做 PaperNest 时希望保留笔记原文引用，协作前先写清输入输出和验收条件。当前还需要验证长文导入中断后的恢复。')
 await host.sourceChanged({revision:1,phase:'ready'})
 const first=await wait(()=>host.schedules.terminalRuns().find(r=>r.processing&&r.terminal_summary?.outcome==='completed'),'source_change_completion')
 report.runs.push({run_id:first.run_id,task_id:first.task_id,trigger:'source_change',calls:first.processing.calls.length});assert.equal(host.tasks.get(first.task_id).phase,'completed');assert(host.tasks.evidence(first.task_id).some(e=>e.kind==='context'));assert.equal(host.snapshot().feed.length,0)
 report.checks.push('real source change -> scheduled Task -> scoped provider tools -> durable completion, no foreground report')
 await save();const count=modelCalls+writerCalls;await stop();await start();assert.equal(modelCalls+writerCalls,count);assert.equal(host.tasks.list().length,1);assert.equal(await op({action:'claim'}),null);report.checks.push('restart preserves cursor and does not duplicate task or model work')
 // Do not call tick or sourceChanged: only the existing production 60-second scheduler may start this run.
 await add(3,'今天我完成了 PaperNest 关键词检索回归测试，断点恢复仍待验证。计划请两位朋友试用，尚未发出邀请。')
 const second=await wait(()=>host.schedules.terminalRuns().find(r=>r.processing&&r.run_id!==first.run_id&&r.terminal_summary?.outcome==='completed'),'periodic_fallback',300000)
 report.runs.push({run_id:second.run_id,task_id:second.task_id,trigger:'existing_60s_scheduler',calls:second.processing.calls.length});report.checks.push('real wall-clock fallback runs only new source batch')
 const beforeIdle=modelCalls+writerCalls;await new Promise(r=>setTimeout(r,65000));assert.equal(modelCalls+writerCalls,beforeIdle);report.checks.push('unchanged periodic tick makes zero model calls')
 report.profile=await op({action:'profile'});assert(report.profile.draft,'at least one bounded draft must publish');report.status='passed'
}catch(error){report.status='failed';report.error=error.message;console.error('FAIL',error.message)}finally{await stop();report.original_files_unchanged=JSON.stringify(before)===JSON.stringify(await Promise.all(originalPaths.map(digest)));await save()}
console.log('REPORT',join(directory,'report.json'));process.exitCode=report.status==='passed'?0:1
