/* eslint-disable @typescript-eslint/require-await -- deterministic provider and verifier ports */
/* eslint-disable @typescript-eslint/no-empty-function -- inert provider callbacks */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {settingsSchema} from '../src/config/config.js'
import {buildCascadedTextProvider} from '../src/cascaded-text-provider.js'
import {cascadedProviderRegistries} from '../src/composition/cascaded-realtime-assembly.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

for(const failure of [false,true])for(const persistent of [false,true])for(const mode of ['workbench','background'] as const)test(`scheduled runtime settles without a fabricated user turn (${mode}, persistent=${persistent}, failure=${failure})`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-scheduled-factory-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let responses=0
 const mainContexts:(string|null|undefined)[]=[]
 const gateway={complete:async(input:{prompt:string})=>{const data=JSON.parse(input.prompt) as {evidence:{ref:string;kind:string}[]};const refs=data.evidence.filter(row=>row.kind==='delivery').map(row=>row.ref);assert.ok(data.evidence.some(row=>row.kind==='context'));return {text:JSON.stringify({kind:'complete',evidence_refs:refs,criteria:[{index:0,evidence_refs:refs}]})}},async *stream(){throw Error('unused')}} as unknown as ModelGateway
 host.setConversationRuntime(conversationRuntimeFactory({host,...(persistent?{blackboard:{path:join(dir,'blackboard.sqlite'),ownerId:'test'}}:{}),memory:()=>undefined,gateway,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),searchTransport:{search:async()=>{throw Error('unused')}},createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({async *stream(input){if(!options.scheduledTask){mainContexts.push(input.responseAdaptation);yield {kind:'response_started',response_id:'main:'+mainContexts.length};yield {kind:'text_delta',text:'已说明报告。'};yield {kind:'response_completed',response_id:'main:'+mainContexts.length};return}const n=++responses,r='scheduled:'+n;yield {kind:'response_started',response_id:r};if(failure&&n===1){yield {kind:'response_failed',response_id:r,code:'network'};return}if(n===(failure?2:1))yield {kind:'tool_call',item_id:'context',call_id:'context',name:'app__context',arguments:{section:'todos',cursor:null}};else yield {kind:'text_delta',text:'当前没有待办。'};yield {kind:'response_completed',response_id:r}},restoreHistory:async()=>{},abandonPendingResponse:async()=>{},close:async()=>{}})})}})}),()=>{})
 try{
  await host.open();await host.command({type:'personal.command',method:'presentation.set',request_id:'mode',params:{mode}},{client_id:'test'})
  if(!failure){await host.submitConversationText('chat:main','普通聊天','warm');await host.waitConversation('chat:main')}
  const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
  const schedule=await host.schedules.create('create',{title:'Review',goal:'Read todos and summarize',acceptance:['Report current todos'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context},{user_scope:'test',source:'ui',origin_ref:'test',source_refs:[],allowed_context:context})
  const run=await host.schedules.runNow('now',schedule.id,1);await host.scheduledTaskTick()
  const deadline=Date.now()+3000;while(Date.now()<deadline&&!(failure?host.tasks.findByRun(run.run_id)?.phase==='waiting':host.schedules.getRun(run.run_id).terminal_summary?.published))await new Promise(resolve=>setTimeout(resolve,10))
  const task=host.tasks.findByRun(run.run_id)!
  if(failure){assert.equal(task.phase,'waiting');assert.equal(task.waiting_reason,'delivery_interrupted');assert.equal(task.pending_delivery,undefined);assert.equal(responses,1);const ack=await host.command({type:'personal.command',method:'tasks.continue',request_id:'retry',params:{task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}},{client_id:'test'});assert.equal((ack as {ok:boolean}).ok,true);const retryDeadline=Date.now()+3000;while(Date.now()<retryDeadline&&!host.schedules.getRun(run.run_id).terminal_summary?.published)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(host.tasks.get(task.id).phase,'completed','explicit retry renews the scoped run authority');assert.equal(responses,3);return}
  assert.equal(task.phase,'completed');assert.equal(responses,2)
  assert.equal(host.tasks.evidence(task.id).filter(row=>row.kind==='context').length,1)
  assert.equal(host.schedules.getRun(run.run_id).terminal_summary?.published,true)
  assert.equal(host.conversationSnapshot().messages.filter(row=>row.role==='user').length,1)
  await host.submitConversationText('chat:main','解释刚才的报告','follow-up');await host.waitConversation('chat:main')
  assert.equal(mainContexts.length,2);assert.ok(!mainContexts[0]?.includes('previous_scheduled_results_for_follow_up'));assert.match(mainContexts[1]??'',/previous_scheduled_results_for_follow_up/u);assert.ok(mainContexts[1]?.includes('当前没有待办。'))
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
