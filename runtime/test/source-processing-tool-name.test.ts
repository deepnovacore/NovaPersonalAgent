import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import {createChatCompletionsLlmFactory} from '../src/realtime/cascaded/chat-completions-llm.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import type {ProcessingBatch,ProcessingRequest} from '../src/memory-substrate/source-processing.js'

test('real Qwen wire refuses action names as functions and delivers a corrective tool-name receipt',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'source-tool-name-')),db=new DatabaseSync(join(dir,'ledger.sqlite'));initializeMemory(db)
 const baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1',model='qwen-flash',consumer=createHash('sha256').update(baseUrl+'|'+model).digest('hex'),prefix='personal:test:',source_id=prefix+'source'
 const op=(request:ProcessingRequest)=>Promise.resolve(memoryOperation(db,'source_processing',{prefix,provider:consumer,...request}))
 const memory={sourceProcessing:op,sourceProcessingConsumer:()=>consumer,sourceProcessingLlm:()=>({baseUrl,model,apiKey:'offline-fixture'})} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 let requests=0
 const gateway={complete:()=>Promise.reject(Error('unexpected_model'))} as unknown as ModelGateway
 host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>memory,gateway,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'offline-fixture'}),blackboard:{path:join(dir,'blackboard.sqlite'),ownerId:'test'},searchTransport:{search:()=>Promise.reject(Error('unexpected_search'))},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:input=>createChatCompletionsLlmFactory({provider:'qwen',baseUrl,model,apiKey:'offline-fixture',instructions:input.instructions,fetchImpl:async(_url,init)=>{
  assert.ok(typeof init?.body==='string')
  const body=JSON.parse(init.body) as {tools:{function:{name:string}}[];messages:{role:string;content:string}[]}
  assert.deepEqual(body.tools.map(tool=>tool.function.name),['source__process'])
  const n=++requests;assert.ok(n<=4,'the offline task must finish without a refusal loop')
  if(n===2){
   const receipt=body.messages.filter(item=>item.role==='tool').at(-1);assert.ok(receipt)
   const result=JSON.parse(receipt.content) as {state:string;code:string;hint:string}
   assert.equal(result.state,'refused');assert.equal(result.code,'scheduled_tool_readonly');assert.match(result.hint,/function name is source__process/);assert.match(result.hint,/arguments \{"action":"read"\}/)
   const run=host.schedules.activeRuns().find(item=>item.processing);assert.equal(run?.processing?.calls.length,0,'the read alias never executes');assert.equal(run?.processing?.attempts.length,1,'the refused provider call still consumes an attempt')
  }
  let delta:Record<string,unknown>,finish:string
  if(n<=2){delta={tool_calls:[{index:0,id:'call_'+n,type:'function',function:{name:n===1?'read':'source__process',arguments:'{"action":"read"}'}}]};finish='tool_calls'}
  else if(n===3){const batch=(await op({action:'status'}) as {active_batch:ProcessingBatch}).active_batch;delta={tool_calls:[{index:0,id:'call_3',type:'function',function:{name:'source__process',arguments:JSON.stringify({action:'finish',topics:[{title:'合成主题',summary:'合成摘要',refs:batch.items}]})}}]};finish='tool_calls'}
  else{delta={content:'done'};finish='stop'}
  return new Response('data: '+JSON.stringify({id:'chatcmpl-'+n,choices:[{delta,finish_reason:null}]})+'\n\n'+'data: '+JSON.stringify({id:'chatcmpl-'+n,choices:[{delta:{},finish_reason:finish}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
 }})}})}),()=>undefined)
 try{
  await host.open();const at=new Date().toISOString();memoryOperation(db,'append_evidence',{id:prefix+'e:one',source_id,source_kind:'im',locator:'one',raw_text:'合成资料',hash:'v1',observed_at:at,recorded_at:at,trust:'untrusted_external',source_metadata:{sender_id:'self',recipient_id:'self',account_id:'test'}})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:consumer,embedding_provider:null,conversation_providers:[]}})
  await host.sourceChanged({revision:1,phase:'ready'})
  const deadline=Date.now()+8000;while(Date.now()<deadline&&!host.schedules.terminalRuns().length)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(host.tasks.list()[0]?.phase,'completed');assert.equal(requests,4)
  const run=host.schedules.terminalRuns()[0];assert.equal(run?.processing?.calls.length,2);assert.equal(run?.processing?.attempts.length,3)
 }finally{await host.close();db.close();await rm(dir,{recursive:true,force:true})}
})
