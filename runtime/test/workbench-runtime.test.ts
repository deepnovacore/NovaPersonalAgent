import {conversationToolBridge} from '../src/personal-agent/conversation-tool-bridge.js'
import {buildAssembly} from '../src/composition/assembly.js'
import {buildRealtimeAssembly,configuredMemoryConsumer} from '../src/composition/realtime-assembly.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {memoryDocuments} from '../src/memory-substrate/memory-documents.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'
import {FULL_MEMORY_TOOLS, NO_MEMORY_TOOLS} from '../src/memory/tool-capabilities.js'
import {parseCapabilityRegistry} from '../src/config/capability-registry.js'
import type {RealtimeProvider} from '../src/realtime/protocol.js'
import {retrievalPrerecall} from '../src/memory/prerecall-port.js'
import {UnifiedRetrieval} from '../src/memory/retrieval.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {createWorkbenchRuntime} from '../src/personal-agent/workbench-runtime.js'
import {WorkbenchStore} from '../src/personal-agent/workbench-store.js'
import type {ConversationRuntime} from '../src/personal-agent/conversations.js'
import type {CascadedLlmFactory,CascadedLlmSession} from '../src/realtime/cascaded/llm.js'
import type {JsonValue} from '../src/core/events.js'
import {acquireTaskResources,taskResourcesBusy} from '../src/executors/task-resources.js'
import {projectResourceKey} from '../src/personal-agent/local-tools.js'
import {approvedPlanWorkOrder} from '../src/executors/codex/app-server-transport.js'
import {createChatCompletionsLlmFactory} from '../src/realtime/cascaded/chat-completions-llm.js'
import {PLAN_LLM_TRANSPORT} from '../src/realtime/cascaded/llm-stream-limits.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import type {ComputerObservation,ToolImage} from '../src/personal-agent/computer-use/contract.js'
import {workbenchInstructions} from '../src/personal-agent/workbench-instructions.js'
import {loadSettings,settingsSchema} from '../src/config/config.js'

function observation(image:ToolImage):ComputerObservation{return {id:'test-observation',captured_at:image.captured_at,image,space:{logical_width:image.width,logical_height:image.height,scale:1},target:null,focus:null,foreground:true,ax:{status:image.native_ui?'truncated':'unavailable',...(image.native_ui?{summary:image.native_ui}:{}),...(image.native_editor?{editor:image.native_editor}:{})}}}
type Request=Parameters<CascadedLlmSession['stream']>[0]
interface Reply {text?:string;reasoning?:string;call?:{name:string;arguments:Record<string,JsonValue>;id?:string};calls?:{name:string;arguments:Record<string,JsonValue>;id:string}[];failure?:{code:string;detail?:string}}
function scripted(reply:(request:Request,step:number)=>Reply|Promise<Reply>){
 const requests:Request[]=[],restores:JsonValue[]=[]
 const factory:CascadedLlmFactory={open:()=>{
  let step=0
  return {setHistoryLimits:()=>{ /* scripted model has no trimming */ },checkpoint:()=>({step}),restoreCheckpoint:value=>{restores.push(value);step=(value as {step:number}).step},
   async *stream(request){requests.push(request);const next=await reply(request,step);request.signal.throwIfAborted();if(next.reasoning!==undefined)yield {kind:'reasoning_delta',text:next.reasoning};yield {kind:'response_started',response_id:'r'+step};if(next.failure){if(next.text!==undefined&&next.text!=='')yield {kind:'text_delta',text:next.text};step++;yield {kind:'response_failed',response_id:'r'+(step-1),code:next.failure.code,...(next.failure.detail?{detail:next.failure.detail}:{})};return}const calls=next.calls??(next.call?[{...next.call,id:next.call.id??'c'+step}]:[]);for(const call of calls)yield {kind:'tool_call',item_id:'i'+step+':'+call.id,call_id:call.id,name:call.name,arguments:call.arguments};if(!calls.length)yield {kind:'text_delta',text:next.text??'done'};step++;yield {kind:'response_completed',response_id:'r'+(step-1)}},
   abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
  }
 }}
 return {factory,requests,restores}
}
async function until<T>(read:()=>T,predicate:(value:T)=>boolean):Promise<T>{
 for(let count=0;count<500;count++){const value=read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,10))}throw Error('state wait expired')
}
async function fixture(reply:(request:Request,step:number)=>Reply|Promise<Reply>,approval:'ask'|'never'='ask',factory?:CascadedLlmFactory,computerSession?:Parameters<typeof createWorkbenchRuntime>[0]['computerSession'],reasoning?:boolean,telemetry?:Parameters<typeof createWorkbenchRuntime>[0]['telemetry']){
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-loop-')),script=scripted(reply),invocations:{name:string;arguments:Record<string,JsonValue>}[]=[],frames:Record<string,unknown>[]=[]
 const host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const bridge:NonNullable<ConversationRuntime['toolBridge']>={tools:[{name:'monitor',parameters:{type:'object'}},{name:'dispatch',parameters:{type:'object',properties:{executor:{enum:['codex']}}}}],readonlyNames:['monitor'],origin:()=>Promise.resolve('memory:test-user'),invoke:(_text,call,_signal,grant)=>{invocations.push(call);if(call.name!=='dispatch'||!grant)return Promise.resolve({accepted:true});const delegate_id='fixture-work-'+invocations.length;return host.tasks.bindWork(grant.fence,delegate_id).then(()=>({accepted:true,delegate_id}))}}
 const plain:ConversationRuntime={runTurn:()=>Promise.resolve({assistant:'chat'}),close:()=>Promise.resolve(),toolBridge:bridge}
 const runtime=()=>host.setConversationRuntime(async(conversation,emit,_mode,lifetime)=>conversation.kind==='build'||conversation.mode==='plan'?createWorkbenchRuntime({...(telemetry?{telemetry}:{}),conversation,host,factory:factory??script.factory,createBridge:()=>Promise.resolve(plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:()=>host.localToolApproval??approval,...(computerSession?{computerSession}:{}),...(reasoning===undefined?{}:{reasoning})}):plain,frame=>frames.push(frame))
 let request=0
 const raw=(method:string,params:Record<string,unknown>={},local=true)=>host.command({type:'personal.command',request_id:'r'+request++,method,params},{client_id:local?'desktop:local':'remote:test'}) as Promise<{ok:boolean;error?:string;data:unknown}>
 const command=async(method:string,params:Record<string,unknown>={})=>{const result=await raw(method,params);if(!result.ok)throw Error(result.error);return result.data}
 await host.open();runtime();host.setWorkbenchExecutors(['codex']);await command('presentation.set',{mode:'workbench'})
 const plan=async(content='完整计划：先读取项目，再完成修改并验证。')=>{await command('conversations.mode',{id:'chat:main',mode:'plan'});return host.publishPlan('chat:main',0,'测试计划',content)}
 const build=async()=>{const p=await plan();await command('build.start',{id:'chat:main',plan_id:p.id,version:p.version,project:root});return host.conversationSnapshot().selected_id}
 return {root,host,script,frames,invocations,bridge,plain,command,raw,plan,build,runtime,close:async()=>{await host.close();await rm(root,{recursive:true,force:true})}}
}
const buildView=(host:PersonalAgentHost,id:string)=>host.conversationSnapshot().items.find(item=>item.id===id)!.build!
const toolOutputs=(request:Request)=>request.inputs.flatMap(input=>input.kind==='tool_result'?[input.output as unknown as {status:string;message?:string}]:[])
const supported=['darwin','win32'].includes(process.platform)

test('production Plan factory admits batched wire calls through the real conversation tool bridge',async context=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-plan-production-')),requests:Record<string,unknown>[]=[],frames:Record<string,unknown>[]=[]
 const host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'production-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 context.mock.method(globalThis,'fetch',(_url:unknown,init?:RequestInit)=>{
  const body=JSON.parse(init!.body as string) as Record<string,unknown>;requests.push(body)
  assert.equal(body.model,'deepseek-flash');assert.equal(body.parallel_tool_calls,true)
  const messages=body.messages as {role:string;tool_call_id?:string}[]
  if(requests.length===2)assert.deepEqual(messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),['query-one','query-two'])
  const calls=requests.length===1?[0,1].map(index=>({index,id:index===0?'query-one':'query-two',function:{name:'memory__recall',arguments:JSON.stringify({query:index===0?'项目目标':'项目进展',scope:'session'})}})):[{index:0,id:'publish',function:{name:'publish_plan',arguments:JSON.stringify({title:'核实进展',content:'在本地 Build 中检查仓库实际状态和测试结果。'})}}]
  const event={id:'response-'+requests.length,choices:[{delta:requests.length===3?{content:'计划已经发布，请选择执行方式。'}:{tool_calls:calls},finish_reason:requests.length===3?'stop':'tool_calls'}]}
  return Promise.resolve(new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}}))
 })
 try{
  await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,pipeline_mode:'cascaded',cascade_llm_provider:'deepseek',cascade_llm_model:'deepseek-flash',deepseek_api_key:'test'}),searchTransport:{search:()=>Promise.reject(Error('unexpected search'))},gateway:{complete:()=>Promise.reject(Error('unexpected support model')),async *stream(){await Promise.resolve();throw Error('unexpected support model')}},onDiagnostic:()=>{ /* assertions inspect durable state instead */ }}),frame=>frames.push(frame))
  for(const [method,params] of [['presentation.set',{mode:'workbench'}],['conversations.mode',{id:'chat:main',mode:'plan'}]] as const){const result=await host.command({type:'personal.command',request_id:method,method,params},{client_id:'desktop:local'}) as {ok:boolean;error?:string};assert.equal(result.ok,true,result.error)}
  await host.submitConversationText('chat:main','先查询项目目标和进展，再制定核实计划');await host.waitConversation('chat:main')
  assert.equal(requests.length,3);assert.equal(frames.some(frame=>frame.type==='conversation.error'),false)
  assert.ok(host.conversationSnapshot().items[0]!.plan)
  assert.equal(host.conversationSnapshot().messages.at(-1)!.text,'计划已经发布，请选择执行方式。')
  const state=await host.workbench.checkpoint('chat:main',0);assert.equal(state.calls.length,3);assert.equal(state.status,'completed')
  assert.equal(host.tasks.list().length,0);assert.equal(host.life.snapshot().todos.length,0)
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})

test('a provider account failure reaches the conversation as a specific reason without its body',async()=>{
 for(const [body,status,reason] of [[{error:{code:'Arrearage',message:'Access denied secret prompt'}},400,'model_http_quota'],[{error:{code:'invalid_api_key'}},401,'model_http_auth'],[{},429,'model_http_rate_limited'],[{error:{code:'leak me'}},500,'model_http']] as const){
  const factory=createChatCompletionsLlmFactory({provider:'qwen',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Plan',...PLAN_LLM_TRANSPORT,fetchImpl:()=>Promise.resolve(new Response(JSON.stringify(body),{status}))})
  const f=await fixture(()=>({}),'ask',factory)
  try{
   await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
   await f.host.submitConversationText('chat:main','请制定计划');await f.host.waitConversation('chat:main')
   const error=f.frames.find(frame=>frame.type==='conversation.error')
   assert.equal(error?.reason,reason);assert.doesNotMatch(JSON.stringify(f.frames),/Access denied|secret prompt|leak me/u)
  }finally{await f.close()}
 }
})

test('a trickling provider error body is abandoned quickly and classified by status',async()=>{
 let timer:ReturnType<typeof setInterval>|undefined
 const body=new ReadableStream<Uint8Array>({start(controller){timer=setInterval(()=>controller.enqueue(new Uint8Array([32])),20)},cancel(){clearInterval(timer)}})
 const factory=createChatCompletionsLlmFactory({provider:'qwen',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Plan',...PLAN_LLM_TRANSPORT,fetchImpl:()=>Promise.resolve(new Response(body,{status:402}))})
 const f=await fixture(()=>({}),'ask',factory)
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  const started=performance.now()
  await f.host.submitConversationText('chat:main','请制定计划');await f.host.waitConversation('chat:main')
  assert.ok(performance.now()-started<10_000,'a slow error body must not hold the turn')
  assert.equal(f.frames.find(frame=>frame.type==='conversation.error')?.reason,'model_http_quota')
 }finally{clearInterval(timer);await f.close()}
})

test('Plan recovers from malformed wire arguments, accepts a batch and continues to publish_plan',async()=>{
 let requests=0
 const factory=createChatCompletionsLlmFactory({provider:'deepseek',baseUrl:'https://example.test',apiKey:'test',model:'test',instructions:'Plan',...PLAN_LLM_TRANSPORT,fetchImpl:(_url,init)=>{
  const body=JSON.parse(init!.body as string) as {parallel_tool_calls:boolean;messages:{role:string;tool_call_id?:string}[]};requests++
  assert.equal(body.parallel_tool_calls,true)
  if(requests===3)assert.deepEqual(body.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id),['first','second'])
  const calls=requests<3?[{index:0,id:'first',function:{name:'monitor',arguments:'{"project":"One"}'}},{index:1,id:'second',function:{name:'monitor',arguments:requests===1?'{':'{"project":"Two"}'}}]:[{index:0,id:'plan',function:{name:'publish_plan',arguments:JSON.stringify({title:'项目进展核实计划',content:'在 Build 中读取项目，核实进展，补充测试。'})}}]
  const event={id:'response-'+requests,choices:[{delta:requests===4?{content:'请确认计划并选择 Build。'}:{tool_calls:calls},finish_reason:requests===4?'stop':'tool_calls'}]}
  return Promise.resolve(new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}}))
 }})
 const f=await fixture(()=>({}),'ask',factory)
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','请核实项目进展并制定计划');await f.host.waitConversation('chat:main')
  assert.equal(f.host.conversationSnapshot().messages.at(-1)!.generation_status,'failed');assert.equal(f.invocations.length,0)
  assert.equal((await f.host.workbench.checkpoint('chat:main',0)).reason,'model_protocol_tool_arguments_json')
  assert.deepEqual((await f.host.workbench.checkpoint('chat:main',0)).model_failure,{code:'protocol',detail:'tool_arguments_json',tool_call_count:2})
  assert.ok(f.frames.some(frame=>frame.type==='conversation.error'&&frame.reason==='model_protocol_tool_arguments_json'))
  await f.host.submitConversationText('chat:main','请重试');await f.host.waitConversation('chat:main')
  assert.equal(f.invocations.length,2);assert.equal(requests,4)
  assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,'请确认计划并选择 Build。')
  assert.ok(f.host.conversationSnapshot().items[0]!.plan);assert.equal(f.host.tasks.list().length,0)
  const saved=await f.host.workbench.checkpoint('chat:main',0);assert.equal(saved.status,'completed');assert.equal(saved.calls.length,3)
 }finally{await f.close()}
})

test('Plan executes independent queries concurrently, bounds concurrency and preserves result order',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let active=0,started=0,maximum=0
 const f=await fixture((request,step)=>{
  if(step===0)return {calls:Array.from({length:6},(_,i)=>({id:'read-'+i,name:'monitor',arguments:{index:i}}))}
  assert.deepEqual(request.inputs.filter(input=>input.kind==='tool_result').map(input=>input.call_id),Array.from({length:6},(_,i)=>'read-'+i))
  return {text:'并行查询已完成'}
 })
 f.bridge.invoke=async()=>{started++;active++;maximum=Math.max(maximum,active);try{await gate;return {status:'observed'}}finally{active--}}
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'});await f.host.submitConversationText('chat:main','检查六个项目')
  await until(()=>started,value=>value===4);assert.equal(maximum,4)
  const running=await f.host.workbench.checkpoint('chat:main',0);assert.equal(running.calls.filter(call=>call.state==='running').length,4)
  release();await f.host.waitConversation('chat:main')
  assert.equal(started,6);assert.equal(maximum,4);assert.equal(active,0)
  assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,'并行查询已完成')
 }finally{release();await f.close()}
})

test('Stop settles an entire batch and Resume never repeats cancelled or completed queries',{skip:!supported},async()=>{
 let started=0,settled=0
 const f=await fixture((_request,step)=>step===0?{calls:Array.from({length:6},(_,i)=>({id:'query-'+i,name:'monitor',arguments:{index:i}}))}:{text:'已核实并恢复'},'never')
 f.bridge.invoke=async(_text,_call,signal)=>{started++;await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})});settled++;return {status:'cancelled'}}
 try{
  const id=await f.build();await until(()=>started,value=>value===4);await f.command('build.stop',{id})
  assert.equal(settled,4);assert.equal(started,4);assert.equal(buildView(f.host,id).status,'paused')
  const stopped=await f.host.workbench.checkpoint(id,0);assert.ok(stopped.calls.every(call=>call.state==='completed'))
  await f.command('build.resume',{id});await f.host.waitConversation(id)
  assert.equal(started,4);assert.equal(buildView(f.host,id).status,'completed');assert.equal(f.host.tasks.list().length,0)
 }finally{await f.close()}
})

test('Plan counts every batched call toward its limit and continues on the next user message',async()=>{
 const f=await fixture((request,step)=>{
  if(step===0)return {calls:Array.from({length:24},(_,i)=>({id:'query-'+i,name:'monitor',arguments:{index:i}}))}
  assert.equal(request.inputs.filter(input=>input.kind==='tool_result').length,24)
  return {text:'计划已补充'}
 })
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'});await f.host.submitConversationText('chat:main','查询并制定计划');await f.host.waitConversation('chat:main')
  assert.equal(f.invocations.length,24);assert.equal((await f.host.workbench.checkpoint('chat:main',0)).reason,'round_limit')
  assert.match(f.host.conversationSnapshot().messages.at(-1)!.text,/Plan.*发送消息/u)
  await f.host.submitConversationText('chat:main','继续');await f.host.waitConversation('chat:main')
  assert.equal(f.invocations.length,24);assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,'计划已补充')
 }finally{await f.close()}
})

test('concurrent checkpoint receipts and log readers keep atomic, ordered snapshots',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-journal-'))
 try{
  const writer=new WorkbenchStore(root),reader=new WorkbenchStore(root),state=await writer.checkpoint('plan',0)
  await writer.saveCheckpoint(state)
  const pending:Promise<unknown>[]=[]
  for(let version=1;version<=40;version++){
   state.run_version=version;pending.push(writer.saveCheckpoint(state))
   pending.push(reader.checkpoint('plan',0).then(snapshot=>assert.equal(snapshot.run_version,version)))
  }
  await Promise.all(pending);assert.equal((await reader.checkpoint('plan',0)).run_version,40)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('long Build replies are stored intact and returned as bounded UTF-8-safe pages',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-long-reply-'))
 try{
  const store=new WorkbenchStore(root),original=('长回复：😀代码、中文与 Markdown。\n').repeat(5000),messageId='reply-message'
  await store.saveReply('build',0,messageId,original)
  let offset=0,joined=''
  do{const page=await store.reply('build',0,messageId,offset);assert.ok(Buffer.byteLength(page.text)<=24000*4);joined+=page.text;offset=page.next_offset??-1}while(offset>=0)
  assert.equal(joined,original)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('Plan exposes read-only tools, refuses forged local/dispatch calls and publishes full versions',async()=>{
 const full='详细计划\n'+'实现与验收要求。'.repeat(2000)
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_write',arguments:{path:'forbidden',content:'bad'}}}:step===1?{call:{name:'dispatch',arguments:{executor:'codex',instruction:'bad'}}}:step===2?{call:{name:'publish_plan',arguments:{title:'完整计划',content:full}}}:{text:'请审阅计划'})
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'});await f.host.submitConversationText('chat:main','计划需求');await f.host.waitConversation('chat:main')
  assert.ok(f.script.requests.every(request=>request.tools.every(tool=>['monitor','publish_plan'].includes(tool.name))))
  const publish=f.script.requests[0]!.tools.find(tool=>tool.name==='publish_plan')
  assert.ok(publish);assert.equal('$schema' in publish.parameters,false);assert.deepEqual(publish.parameters.required,['title','content'])
  assert.equal(f.invocations.length,0);await assert.rejects(readFile(join(f.root,'forbidden')))
  assert.equal(f.host.tasks.list().length,0);assert.equal(f.host.life.snapshot().todos.length,0)
  const plan=f.host.conversationSnapshot().items[0]!.plan!;assert.equal((await f.host.workbench.plan(plan.id,plan.version)).content,full)
  const receipt=await f.host.publishPlan('chat:main',0,'完整计划',full,'stable-call'),again=await f.host.publishPlan('chat:main',0,'完整计划',full,'stable-call')
  assert.equal(receipt.version,again.version)
  await f.command('conversations.mode',{id:'chat:main',mode:'chat'});await f.host.submitConversationText('chat:main','中间新需求');await f.host.waitConversation('chat:main');await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  const state=await f.host.workbench.checkpoint('chat:main',0);assert.equal(state.model,null)
 }finally{await f.close()}
})

test('Build requires approval before side effects, stops on denial and does not create task or Todo',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_write',arguments:{path:'new.txt',content:'批准后写入'}}}:{text:'已完成'})
 try{
  const id=await f.build(),view=await until(()=>buildView(f.host,id),view=>view.status==='awaiting_approval')
  await assert.rejects(readFile(join(f.root,'new.txt')))
  assert.equal((await f.raw('build.approve',{id,approval_id:view.approval!.id,approved:true},false)).ok,false)
  assert.equal((await f.raw('build.approve',{id,approval_id:'stale',approved:true})).ok,false)
  assert.equal((await f.raw('conversations.create',{})).ok,true)
  const created=f.host.conversationSnapshot()
  assert.equal(created.items.some(item=>item.id!=='chat:main'&&item.kind==='chat'),true)
  await f.command('conversations.select',{id})
  const started=await f.raw('conversations.start',{title:'x',text:'x',references:[{kind:'todo',id:'any-todo',version:1}]})
  assert.notEqual(started.error,'build_stop_required')
  await f.command('conversations.select',{id})
  assert.equal(f.host.conversationSnapshot().selected_id,id)
  await assert.rejects(f.host.submitConversationText(id,'double',undefined,undefined,{local_desktop:true}),/conversation_busy/)
  await f.command('build.approve',{id,approval_id:view.approval!.id,approved:false});await f.host.waitConversation(id)
  // A denial is a tool result, not a pause: the model carries on without the declined action.
  assert.equal(buildView(f.host,id).status,'completed');assert.equal(buildView(f.host,id).reason,null)
  await assert.rejects(readFile(join(f.root,'new.txt')));assert.equal(f.script.requests.length,2)
  const denied=toolOutputs(f.script.requests[1]!)[0]!
  assert.equal(denied.status,'denied');assert.match(denied.message!,/declined/);assert.match(denied.message!,/Do not retry/)
  await f.host.submitConversationText(id,'请重新写入',undefined,undefined,{local_desktop:true});await f.host.waitConversation(id)
  assert.deepEqual(f.script.requests[2]!.inputs.filter(input=>input.kind==='user_text').map(input=>input.text),['请重新写入'])
  assert.equal(f.host.tasks.list().length,0);assert.equal(f.host.life.snapshot().todos.length,0)
 }finally{await f.close()}
})

test('switching the local tool approval at runtime applies to the next call without a restart',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_write',arguments:{path:'live.txt',content:'无需确认'}}}:{text:'已完成'})
 try{
  assert.equal((await f.raw('settings.local_tool_approval',{mode:'never'},false)).error,'local_workbench_required')
  assert.deepEqual(await f.command('settings.local_tool_approval',{mode:'never'}),{mode:'never'})
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status==='awaiting_approval',false)
  assert.equal(await readFile(join(f.root,'live.txt'),'utf8'),'无需确认')
  assert.equal((await f.raw('settings.local_tool_approval',{mode:'sometimes'})).ok,false)
 }finally{await f.close()}
})

test('Build reads inside the project without approval',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_read',arguments:{path:'inside.txt'}}}:{text:'已读取'})
 try{
  await writeFile(join(f.root,'inside.txt'),'内容')
  const id=await f.build();await f.host.waitConversation(id)
  assert.notEqual(buildView(f.host,id).status,'awaiting_approval');assert.equal(f.script.requests.length,2)
 }finally{await f.close()}
})

test('Build asks before a read leaves the project and stops on denial',{skip:!supported},async()=>{
 const outside=await mkdtemp(join(await realpath(tmpdir()),'nova-outside-'))
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_read',arguments:{path:join(outside,'secret.txt')}}}:{text:'完成'})
 try{
  await writeFile(join(outside,'secret.txt'),'secret')
  const id=await f.build(),view=await until(()=>buildView(f.host,id),view=>view.status==='awaiting_approval')
  assert.ok(view.approval)
  await f.command('build.approve',{id,approval_id:view.approval.id,approved:false});await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'completed');assert.equal(f.script.requests.length,2)
  assert.equal(toolOutputs(f.script.requests[1]!)[0]!.status,'denied')
 }finally{await f.close();await rm(outside,{recursive:true,force:true})}
})

test('a denial skips the rest of its batch and the model hears about both',{skip:!supported},async()=>{
  const f=await fixture((_request,step)=>step===0?{calls:[{name:'file_write',arguments:{path:'a.txt',content:'a'},id:'call-a'},{name:'file_write',arguments:{path:'b.txt',content:'b'},id:'call-b'}]}:{text:'done'})
  try{
    const id=await f.build(),view=await until(()=>buildView(f.host,id),view=>view.status==='awaiting_approval')
    await f.command('build.approve',{id,approval_id:view.approval!.id,approved:false});await f.host.waitConversation(id)
    assert.equal(buildView(f.host,id).status,'completed');assert.equal(f.script.requests.length,2)
    assert.deepEqual(toolOutputs(f.script.requests[1]!).map(output=>output.status),['denied','cancelled_before_execution'])
    await assert.rejects(readFile(join(f.root,'a.txt')));await assert.rejects(readFile(join(f.root,'b.txt')))
  }finally{await f.close()}
})

test('a denied class is refused without asking again, two denials pause with an explanation and Resume continues',{skip:!supported},async()=>{
  const f=await fixture((_request,step)=>step<2?{call:{name:'file_write',arguments:{path:'x.txt',content:'x'},id:'call-'+step}}:{text:'carried on'})
  try{
    const id=await f.build(),view=await until(()=>buildView(f.host,id),view=>view.status==='awaiting_approval')
    await f.command('build.approve',{id,approval_id:view.approval!.id,approved:false});await f.host.waitConversation(id)
    const paused=buildView(f.host,id)
    assert.equal(paused.status,'paused');assert.equal(paused.reason,'approval_denied');assert.equal(paused.approval,null)
    assert.match(paused.reason_detail!,/x\.txt/);assert.equal(f.script.requests.length,2)
    assert.deepEqual(toolOutputs(f.script.requests[1]!).map(output=>output.status),['denied'])
    const text=f.host.conversationSnapshot().messages.at(-1)!.text
    assert.match(text,/你拒绝了/);assert.match(text,/x\.txt/);assert.match(text,/点|回复「继续」/);assert.doesNotMatch(text,/Build 已暂停。$/)
    await f.command('build.resume',{id});await f.host.waitConversation(id)
    assert.equal(f.script.requests.length,3)
    assert.deepEqual(toolOutputs(f.script.requests[2]!).map(output=>output.status),['denied_previously'])
    assert.ok(f.script.requests[2]!.inputs.some(input=>input.kind==='host_context'&&input.content.includes('denial_resume')))
    const done=buildView(f.host,id);assert.equal(done.status,'completed');assert.equal(done.reason,null);assert.equal(done.reason_detail??null,null)
    await assert.rejects(readFile(join(f.root,'x.txt')))
  }finally{await f.close()}
})

test('approval is scoped to exact call, native Build stays separate and local authority is rechecked',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_write',arguments:{path:'new.txt',content:'批准后写入'}}}:{text:'已完成'})
 try{
  const id=await f.build(),view=await until(()=>buildView(f.host,id),view=>!!view.approval)
  await f.command('build.approve',{id,approval_id:view.approval!.id,approved:true});await f.host.waitConversation(id)
  assert.equal(await readFile(join(f.root,'new.txt'),'utf8'),'批准后写入');assert.equal(buildView(f.host,id).status,'completed')
  assert.equal(f.host.conversationSnapshot().items[0]!.mode,'plan');assert.equal(f.host.tasks.list().length,0)
  assert.equal((await f.raw('build.approve',{id,approval_id:view.approval!.id,approved:true})).ok,false)
  await assert.rejects(f.host.submitConversationText(id,'forged'),/local_build_not_authorized/)
  const store=await f.host.workbench.checkpoint(id,0);assert.equal(store.calls[0]!.state,'completed');assert.equal(store.pending_calls.length,0)
 }finally{await f.close()}
})

test('returning to the workbench does not resume Build, but a new text request can continue it',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>({text:step===0?'first pass':'continued'}),'never')
 try{
  const id=await f.build();await f.host.waitConversation(id);assert.equal(buildView(f.host,id).status,'completed');assert.equal(f.script.requests.length,1)
  await f.command('presentation.set',{mode:'orb'});await f.command('presentation.set',{mode:'workbench'});assert.equal(f.script.requests.length,1)
  await f.host.submitConversationText(id,'Continue with one more change.',undefined,undefined,{local_desktop:true});await f.host.waitConversation(id)
  assert.equal(f.script.requests.length,2);assert.equal((await f.host.workbench.checkpoint(id,0)).status,'completed')
 }finally{await f.close()}
})

for(const reason of ['model_timeout','model_overflow'])test(`Build pauses with an actionable ${reason} and Resume does not repeat completed tools`,{skip:!supported},async()=>{
 let fail=true
 const f=await fixture((_request,step)=>{if(step===0)return {call:{name:'file_write',arguments:{path:'once.txt',content:'once'}}};if(fail){fail=false;throw Error(reason)}return {text:'Recovered'}},'never')
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'paused');assert.equal(buildView(f.host,id).reason,reason)
  const messages=f.host.conversationSnapshot().messages
  assert.equal(messages.find(message=>message.role==='user')?.generation_status,'completed');assert.match(messages.at(-1)!.text,/点「继续」/);assert.doesNotMatch(messages.at(-1)!.text,/Resume|model_/);assert.equal(buildView(f.host,id).reason_detail,reason==='model_timeout'?'模型等待数据超时':'模型回复超出流容量限制')
  await writeFile(join(f.root,'once.txt'),'user change')
  await f.command('build.resume',{id});await f.host.waitConversation(id)
  assert.equal(await readFile(join(f.root,'once.txt'),'utf8'),'user change');assert.equal(buildView(f.host,id).status,'completed')
  assert.equal(f.host.conversationSnapshot().messages.filter(message=>message.role==='user').length,1)
  assert.equal(f.host.conversationSnapshot().messages.some(message=>message.text==='Resume'),false)
  assert.equal((await f.host.workbench.checkpoint(id,0)).calls.length,1);assert.equal(f.host.tasks.list().length,0)
 }finally{await f.close()}
})

test('Build call pages show durable tool state, bounded previews and owning user messages',{skip:!supported},async()=>{
 const content='日志预览'.repeat(1000),f=await fixture((_request,step)=>step===0?{call:{name:'file_write',arguments:{path:'logged.txt',content}}}:{text:'done'})
 try{
  const id=await f.build(),pending=await until(()=>buildView(f.host,id).approval,Boolean),revision=buildView(f.host,id).log_revision
  const before=await f.command('build.details',{id,view:'calls'}) as {items:{sequence:number;state:string;message_id:string;input:string;input_truncated:boolean}[];next_offset:number|null;total:number}
  assert.equal(before.total,1);assert.equal(before.items[0]!.state,'awaiting_approval');assert.equal(before.items[0]!.sequence,0)
  assert.equal(before.items[0]!.message_id,f.host.conversationSnapshot().messages.find(message=>message.role==='user')!.id)
  assert.equal(before.items[0]!.input_truncated,true);assert.ok(before.items[0]!.input.length<=500)
  assert.equal((await f.raw('build.details',{id,view:'calls'},false)).ok,false)
  await f.command('build.approve',{id,approval_id:pending!.id,approved:true});await f.host.waitConversation(id)
  assert.ok(buildView(f.host,id).log_revision>revision)
  const after=await f.command('build.details',{id,view:'calls'}) as {items:{status:string;output:string;finished_at:string}[];total:number;next_offset:number|null}
  assert.equal(after.items[0]!.status,'completed');assert.match(after.items[0]!.output,/written_bytes/);assert.ok(after.items[0]!.finished_at);assert.equal(after.next_offset,null)
  await f.host.close();await f.host.open();f.runtime();await f.command('presentation.set',{mode:'workbench'})
  const restored=await f.command('build.details',{id,view:'calls'}) as typeof after
  assert.deepEqual(restored.items,after.items)
 }finally{await f.close()}
})

test('Plan reasoning is captured once per model round and never enters model inputs or personal state',async()=>{
 const hidden='隐藏推理：先核对项目状态',second='隐藏推理：第二轮'
 const f=await fixture((_request,step)=>step===0?{reasoning:hidden,call:{name:'monitor',arguments:{project:'One'}}}:{reasoning:second,text:'计划完成'},'never',undefined,undefined,true)
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','先检查再制定计划');await f.host.waitConversation('chat:main')
  assert.equal(f.script.requests[0]!.reasoning,'enabled')
  const state=await f.host.workbench.checkpoint('chat:main',0)
  assert.deepEqual(state.thoughts!.map(item=>item.text),[hidden,second])
  const userId=f.host.conversationSnapshot().messages.find(message=>message.role==='user')!.id
  assert.ok(state.thoughts!.every(item=>item.message_id===userId))
  assert.ok(state.thoughts!.every(item=>typeof item.id==='string'&&item.id.length>0))
  for(const request of f.script.requests)assert.doesNotMatch(JSON.stringify(request.inputs),/隐藏推理/u)
  assert.doesNotMatch(JSON.stringify(state.model),/隐藏推理/u)
  assert.doesNotMatch(JSON.stringify(f.host.snapshot()),/隐藏推理/u)
  assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,'计划完成')
  assert.ok(state.thoughts!.every(item=>[...item.text].length<=8000))
 }finally{await f.close()}
})

test('workbench reasoning is disabled unless the runtime enables it',async()=>{
 const f=await fixture(()=>({text:'直接完成'}))
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','直接回答');await f.host.waitConversation('chat:main')
  assert.equal(f.script.requests[0]!.reasoning,'disabled')
  assert.deepEqual((await f.host.workbench.checkpoint('chat:main',0)).thoughts,[])
 }finally{await f.close()}
})

test('a single reasoning thought is capped at the per-entry bound',async()=>{
 const long='🤔'.repeat(9000)
 const f=await fixture(()=>({reasoning:long,text:'完成'}),'never',undefined,undefined,true)
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','长思考');await f.host.waitConversation('chat:main')
  const thoughts=(await f.host.workbench.checkpoint('chat:main',0)).thoughts!
  assert.equal(thoughts.length,1);assert.equal([...thoughts[0]!.text].length,8000)
 }finally{await f.close()}
})

test('aborting a model round keeps the reasoning that already arrived',{skip:!supported},async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve})
 const factory:CascadedLlmFactory={open:()=>({setHistoryLimits:()=>{ /* the fixture model has no history */ },checkpoint:()=>({step:0}),restoreCheckpoint:()=>{ /* fresh fixture session */ },async *stream(request){entered();yield {kind:'reasoning_delta',text:'先想一半'};await new Promise<void>((_resolve,reject)=>{if(request.signal.aborted){reject(Error('aborted'));return}request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})})},abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()})}
 const f=await fixture(()=>({}),'never',factory,undefined,true)
 try{
  const id=await f.build();await started;await f.command('build.stop',{id});await f.host.waitConversation(id)
  const state=await f.host.workbench.checkpoint(id,0)
  assert.equal(state.thoughts!.length,1);assert.equal(state.thoughts![0]!.text,'先想一半')
 }finally{await f.close()}
})

test('a failed model round still persists the reasoning that already arrived',async()=>{
 const hidden='失败回合的推理'
 const factory:CascadedLlmFactory={open:()=>({setHistoryLimits:()=>{ /* the fixture model has no history */ },checkpoint:()=>({step:0}),restoreCheckpoint:()=>{ /* fresh fixture session */ },async *stream(){await Promise.resolve();yield {kind:'reasoning_delta',text:hidden};yield {kind:'response_started',response_id:'r1'};yield {kind:'response_failed',response_id:'r1',code:'timeout'}},abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()})}
 const f=await fixture(()=>({}),'never',factory,undefined,true)
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','失败回合');await f.host.waitConversation('chat:main')
  const state=await f.host.workbench.checkpoint('chat:main',0)
  assert.equal(state.thoughts!.length,1);assert.equal(state.thoughts![0]!.text,hidden)
  assert.equal(state.model_failure?.code,'timeout')
  assert.doesNotMatch(JSON.stringify(state.model),/失败回合的推理/u)
  assert.doesNotMatch(JSON.stringify(state.inputs),/失败回合的推理/u)
  assert.doesNotMatch(JSON.stringify(f.host.snapshot()),/失败回合的推理/u)
  assert.doesNotMatch(JSON.stringify(f.host.conversationSnapshot().messages),/失败回合的推理/u)
 }finally{await f.close()}
})

test('build.details steps merges thinking and tool steps chronologically',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{reasoning:'先读文件',call:{name:'file_write',arguments:{path:'steps.txt',content:'x'}}}:{reasoning:'继续说明',text:'完成'},'never',undefined,undefined,true)
 try{
  const id=await f.build();await f.host.waitConversation(id)
  const page=await f.command('build.details',{id,view:'steps'}) as {items:{kind:string;id:string;created_at:string|null;text?:string;name?:string}[];total:number;next_offset:number|null;generation:number;first_id:string|null}
  assert.equal(page.total,3);assert.equal(page.next_offset,null);assert.equal(page.generation,0)
  assert.equal(page.first_id,page.items[0]?.id)
  assert.deepEqual(page.items.map(item=>item.kind),['thinking','tool','thinking'])
  assert.equal(page.items[0]?.text,'先读文件')
  assert.equal(page.items[1]?.name,'file_write')
  assert.equal(page.items[2]?.text,'继续说明')
  const times=page.items.map(item=>Date.parse(item.created_at!))
  assert.deepEqual(times,[...times].sort((left,right)=>left-right))
  assert.equal((await f.raw('build.details',{id,view:'steps',offset:-1})).error,'invalid_params')
 }finally{await f.close()}
})

test('NOVA_BUILD_REASONING is a boolean settings override enabled by default',()=>{
 assert.equal(settingsSchema.parse({executors:[]}).build_reasoning,true)
 assert.equal(loadSettings({}).build_reasoning,true)
 assert.equal(loadSettings({NOVA_BUILD_REASONING:'1'}).build_reasoning,true)
 assert.equal(loadSettings({NOVA_BUILD_REASONING:'true'}).build_reasoning,true)
 assert.equal(loadSettings({NOVA_BUILD_REASONING:'off'}).build_reasoning,false)
 assert.equal(loadSettings({NOVA_BUILD_REASONING:'0'}).build_reasoning,false)
})

test('batched calls require separate approvals showing the actual pending arguments',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{calls:[{id:'first',name:'file_write',arguments:{path:'first.txt',content:'one'}},{id:'second',name:'file_write',arguments:{path:'second.txt',content:'two'}}]}:{text:'done'})
 try{
  const id=await f.build(),first=await until(()=>buildView(f.host,id).approval,pending=>pending?.call_id==='first')
  await f.command('build.approve',{id,approval_id:first!.id,approved:true})
  const second=await until(()=>buildView(f.host,id).approval,pending=>pending?.call_id==='second')
  assert.match(second!.preview,/second.txt/);assert.doesNotMatch(second!.preview,/first.txt/)
  await assert.rejects(readFile(join(f.root,'second.txt')))
  assert.equal((await f.raw('build.approve',{id,approval_id:first!.id,approved:true})).ok,false)
  await f.command('build.approve',{id,approval_id:second!.id,approved:true});await f.host.waitConversation(id)
  assert.equal(await readFile(join(f.root,'first.txt'),'utf8'),'one');assert.equal(await readFile(join(f.root,'second.txt'),'utf8'),'two')
 }finally{await f.close()}
})

test('Stop during model streaming pauses; explicit Resume restores context and ignores late output',{skip:!supported},async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});let block=true
 const f=await fixture(async(request)=>{if(block){entered();await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));return {call:{name:'file_write',arguments:{path:'late',content:'bad'}}}}return {text:'恢复后的完成回复'}},'never')
 try{
  const id=await f.build();await started;await f.command('build.stop',{id});assert.equal(buildView(f.host,id).status,'paused');await assert.rejects(readFile(join(f.root,'late')))
  await f.command('presentation.set',{mode:'orb'});assert.equal((await f.raw('build.resume',{id})).error,'local_workbench_required');block=false
  await f.command('presentation.set',{mode:'workbench'});await f.command('build.resume',{id});await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'completed');assert.equal(f.host.tasks.list().length,0)
  // Resume is a control action: no literal user bubble and no synthesized user turn reaches the model.
  const messages=f.host.conversationSnapshot().messages
  assert.equal(messages.filter(message=>message.role==='user').length,1)
  assert.equal(messages.some(message=>message.text==='Resume'),false)
  assert.equal(f.script.requests.at(-1)!.inputs.some(input=>input.kind==='user_text'&&input.text==='Resume'),false)
 }finally{await f.close()}
})

test('restart restores tool pairs and receipts without replaying completed or interrupted file writes',{skip:!supported},async()=>{
 let block=true,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve})
 const f=await fixture(async(request,step)=>{if(step===0)return {call:{name:'file_write',arguments:{path:'once',content:'first'}}};if(block){entered();await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}))}return {text:'done'}},'never')
 try{
  const id=await f.build();await started;await f.command('build.stop',{id});await writeFile(join(f.root,'once'),'external update')
  await f.host.close();block=false
  const reopened=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  try{
   await reopened.open();reopened.setConversationRuntime((conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation,host:reopened,factory:f.script.factory,createBridge:()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:''}),close:()=>Promise.resolve(),toolBridge:{tools:[],readonlyNames:[],origin:()=>Promise.resolve('origin'),invoke:()=>Promise.resolve({})}}),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:'never'}),()=>{ /* no renderer after restart */ })
   assert.equal(reopened.localBuildAuthorized(id),false);assert.equal(buildView(reopened,id).status,'paused')
   for(const [method,params] of [['presentation.set',{mode:'workbench'}],['build.resume',{id}]] as const){const result=await reopened.command({type:'personal.command',request_id:'restart-'+method,method,params},{client_id:'desktop:local'}) as {ok:boolean;error?:string};assert.equal(result.ok,true,result.error)}
   await reopened.waitConversation(id);assert.equal(await readFile(join(f.root,'once'),'utf8'),'external update');assert.ok(f.script.restores.length>0);assert.equal(buildView(reopened,id).status,'completed')
  }finally{await reopened.close()}
 }finally{await f.close()}
})

test('128 executed Build tool rounds pause and Resume continues with results already paired',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step<129?{call:{name:'file_read',arguments:{path:'readme'}}}:{text:'done'},'never')
 try{
  await writeFile(join(f.root,'readme'),'test');const id=await f.build();await f.host.waitConversation(id)
  let checkpoint=await f.host.workbench.checkpoint(id,0);assert.equal(checkpoint.reason,'round_limit');assert.equal(checkpoint.calls.length,128);assert.equal(checkpoint.inputs[0]!.kind,'tool_result')
  await f.command('build.resume',{id});await f.host.waitConversation(id);checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.equal(checkpoint.status,'completed');assert.equal(checkpoint.calls.length,129);assert.equal(f.host.tasks.list().length,0)
 }finally{await f.close()}
})

test('Build queues user messages while running and finish_build permanently locks the conversation',{skip:!supported},async()=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
 const f=await fixture(async(request,step)=>{
  if(step===0){started();await gate;return {text:'已先处理当前步骤。'}}
  assert.ok(request.inputs.some(input=>input.kind==='user_text'&&input.text==='继续，并在完成后结束'))
  return {call:{name:'finish_build',arguments:{summary:'已完成并验证用户要求。'}}}
 },'never')
 try{
  const id=await f.build();await entered
  await f.host.submitConversationText(id,'继续，并在完成后结束',undefined,undefined,{local_desktop:true})
  release();await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'finished')
  assert.equal((await f.host.workbench.checkpoint(id,0)).status,'finished')
  assert.equal((await f.host.workbench.checkpoint(id,0)).calls.at(-1)?.name,'finish_build')
  assert.equal(f.host.conversationSnapshot().messages.at(-1)?.text,'已完成并验证用户要求。')
  assert.deepEqual(f.host.conversationSnapshot().messages.map(message=>message.text),['执行已确认的完整计划。','已先处理当前步骤。','继续，并在完成后结束','已完成并验证用户要求。'])
  assert.equal(f.script.requests.at(-1)?.tools.some(tool=>tool.name==='finish_build'),true)
  await assert.rejects(f.host.submitConversationText(id,'再改一点',undefined,undefined,{local_desktop:true}),/build_finished/u)
  assert.equal((await f.raw('build.resume',{id})).error,'build_finished')
  assert.equal(f.host.tasks.list().length,0)
 }finally{release();await f.close()}
})

test('Plan handoff binds the complete selected version and delegates idempotently',async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const content='完整验收\n'+'长计划细节。'.repeat(3000),plan=await f.plan(content),params={id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'}
  assert.equal((await f.raw('plans.delegate',{...params,executor:'missing'})).error,'executor_unavailable');assert.equal(f.host.conversationSnapshot().items[0]!.mode,'plan')
  await f.command('plans.delegate',params);await f.command('plans.delegate',params)
  const tasks=f.host.tasks.list();assert.equal(tasks.length,1);assert.equal(tasks[0]!.approved_plan!.content,content);assert.equal(tasks[0]!.work_ids.length,1);assert.equal(f.invocations.length,1);assert.equal(f.host.conversationSnapshot().items[0]!.mode,'chat')
  const prompt=approvedPlanWorkOrder({instruction:'execute',workOrder:'short',approvedPlan:plan} as Parameters<typeof approvedPlanWorkOrder>[0]);assert.ok(prompt.includes(content))
 }finally{await f.close()}
})

test('delegate preflight failure keeps Plan, while an uncertain admitted dispatch is never repeated',async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const plan=await f.plan(),params={id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'},origin=f.bridge.origin
  f.bridge.origin=()=>Promise.reject(Error('fixture_preflight_failed'))
  assert.equal((await f.raw('plans.delegate',params)).error,'fixture_preflight_failed');assert.equal(f.host.conversationSnapshot().items[0]!.mode,'plan');assert.equal(f.host.tasks.list().length,0)
  f.bridge.origin=origin;let attempts=0;f.bridge.invoke=()=>{attempts++;return Promise.reject(Error('transport_lost'))}
  assert.equal((await f.raw('plans.delegate',params)).error,'transport_lost');assert.equal(f.host.tasks.list().length,1)
  assert.equal(f.host.tasks.pendingEffect(f.host.tasks.list()[0]!.id)?.status,'unknown')
  assert.equal((await f.raw('plans.delegate',params)).error,'plan_delegation_unknown');assert.equal(attempts,1)
 }finally{await f.close()}
})

test('a definite dispatch refusal returns to Plan and only retries on a new user action',async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const plan=await f.plan(),params={id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'};let attempts=0
  f.bridge.invoke=(_text,_call,_signal,grant)=>{attempts++;if(attempts===1)return Promise.resolve({accepted:false,code:'executor_busy',delegate_id:null});const work='retry-work';return f.host.tasks.bindWork(grant!.fence,work).then(()=>({accepted:true,delegate_id:work}))}
  assert.equal((await f.raw('plans.delegate',params)).error,'plan_delegation_refused');assert.equal(f.host.conversationSnapshot().items[0]!.mode,'plan')
  const refused=f.host.tasks.list()[0]!;assert.equal(refused.waiting_reason,'plan_delegation_refused');assert.equal(refused.work_ids.length,0)
  await f.command('plans.delegate',params);assert.equal(attempts,2);assert.equal(f.host.conversationSnapshot().items[0]!.mode,'chat')
  const retried=f.host.tasks.list()[0]!;assert.equal(retried.id,refused.id);assert.deepEqual(retried.work_ids,['retry-work'])
 }finally{await f.close()}
})

test('accepted executor delegation must have a durable task work binding',async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const plan=await f.plan(),params={id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'}
  f.bridge.invoke=()=>Promise.resolve({accepted:true,delegate_id:'not-bound'})
  assert.equal((await f.raw('plans.delegate',params)).error,'plan_delegation_unknown');assert.equal(f.host.conversationSnapshot().items[0]!.mode,'chat')
  const task=f.host.tasks.list()[0]!;assert.equal(task.work_ids.length,0);assert.equal(f.host.tasks.pendingEffect(task.id)?.status,'unknown')
  assert.equal((await f.raw('plans.delegate',params)).error,'plan_delegation_unknown')
 }finally{await f.close()}
})

test('project occupancy prevents overlapping Build and executor writes',{skip:!supported},async()=>{
 const f=await fixture(()=>({text:'done'}),'never')
 try{
  const plan=await f.plan(),release=await acquireTaskResources([projectResourceKey(f.root)],new AbortController().signal)
  try{assert.equal(taskResourcesBusy([projectResourceKey(f.root)]),true);assert.equal((await f.raw('build.start',{id:'chat:main',plan_id:plan.id,version:plan.version,project:f.root})).error,'project_busy')}finally{release()}
 }finally{await f.close()}
})

test('checkpoint read preserves shared call identity and treats crash receipts conservatively',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-checkpoint-')),store=new WorkbenchStore(root)
 try{
  const state=await store.checkpoint('build',0),call={id:'call',name:'file_write',arguments:{path:'x',content:'a'},state:'running' as const}
  state.calls=[call];state.pending_calls=[call];state.status='running';await store.saveCheckpoint(state)
  const loaded=await store.checkpoint('build',0);assert.equal(loaded.calls[0],loaded.pending_calls[0])
 }finally{await rm(root,{recursive:true,force:true})}
})


test('failed Build admission removes its empty conversation and allows the same plan to retry',{skip:!supported},async context=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const plan=await f.plan(),before=f.host.conversationSnapshot(),params={id:'chat:main',plan_id:plan.id,version:plan.version,project:f.root}
  let failedId=''
  const submission=context.mock.method(f.host,'submitConversationText',(id:string)=>{failedId=id;return Promise.reject(Error('injected_admission_failure'))})
  assert.equal((await f.raw('build.start',params)).error,'injected_admission_failure')
  assert.deepEqual(f.host.conversationSnapshot().items.map(item=>item.id),before.items.map(item=>item.id))
  assert.equal(f.host.conversationSnapshot().selected_id,before.selected_id);assert.equal(f.host.localBuildAuthorized(failedId),false)
  submission.mock.restore()
  await f.command('build.start',params);const id=f.host.conversationSnapshot().selected_id
  assert.notEqual(id,failedId);await f.host.waitConversation(id);assert.equal(f.script.requests.length,1)
 }finally{await f.close()}
})

test('authority lost after durable intent records an unexecuted call rather than an unknown outcome',{skip:!supported},async context=>{
 const f=await fixture(()=>({call:{name:'file_write',arguments:{path:'must-not-exist',content:'bad'}}}),'never')
 try{
  let revoked=false
  const authorized=f.host.localBuildAuthorized.bind(f.host),save=f.host.workbench.saveCheckpoint.bind(f.host.workbench)
  context.mock.method(f.host,'localBuildAuthorized',(id:string)=>!revoked&&authorized(id))
  context.mock.method(f.host.workbench,'saveCheckpoint',async (state:Parameters<WorkbenchStore['saveCheckpoint']>[0])=>{await save(state);if(state.pending_calls.some(call=>call.state==='running'))revoked=true})
  const id=await f.build();await f.host.waitConversation(id)
  await assert.rejects(readFile(join(f.root,'must-not-exist')),/ENOENT/)
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.equal((checkpoint.calls[0]!.result as {status:string}).status,'cancelled_before_execution')
 }finally{await f.close()}
})


test('Build admission errors preserve a conversation once its user message is durable',{skip:!supported},async context=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const plan=await f.plan(),submit=f.host.submitConversationText.bind(f.host)
  let id=''
  context.mock.method(f.host,'submitConversationText',async (...args:Parameters<PersonalAgentHost['submitConversationText']>)=>{
   id=args[0];await submit(...args);throw Error('injected_after_admission')
  })
  assert.equal((await f.raw('build.start',{id:'chat:main',plan_id:plan.id,version:plan.version,project:f.root})).error,'injected_after_admission')
  await f.host.waitConversation(id)
  const saved=f.host.conversationSnapshot().items.find(item=>item.id===id)
  assert.ok(saved);assert.ok(f.host.conversationSnapshot().messages.some(message=>message.role==='user'));assert.equal(f.host.localBuildAuthorized(id),false)
 }finally{await f.close()}
})

test('Build rejects disabled computer calls and Plan never exposes computer tools',{timeout:10000},async()=>{
 const f=await fixture((request,step)=>{
  assert.equal(request.tools?.some(tool=>tool.name.startsWith('computer_')),false)
  if(step===0)return {call:{name:'computer_click',arguments:{observationId:'test-observation',x:1,y:1}}}
  assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code?:string})?.code,'computer_use_disabled')
  return {text:'disabled'}
 },'never',undefined,()=>{throw Error('real backend must not start')})
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','plan');await f.host.waitConversation('chat:main')
  if(supported){const id=await f.build();await f.host.waitConversation(id)}
  assert.equal(f.frames.some(frame=>frame.type==='computer_use'),false)
 }finally{await f.close()}
})

test('Build computer observation and verification gates survive calls and preserve image refs',{skip:!supported,timeout:10000},async()=>{
 let actions=0,closed=0
 const f=await fixture((request,step)=>{
  const sequence=[
   {name:'computer_click',arguments:{observationId:'test-observation',x:1,y:1}},
   {name:'computer_screenshot',arguments:{}},
   {name:'computer_click',arguments:{observationId:'test-observation',x:1,y:1}},
   {name:'finish_build',arguments:{summary:'too early'}},
   {name:'computer_screenshot',arguments:{}},
   {name:'finish_build',arguments:{summary:'verified'}},
  ]
  const results=request.inputs.filter(input=>input.kind==='tool_result')
  if(step===1)assert.equal((results[0]?.output as {code:string}).code,'observe_required')
  if(step===2){assert.equal(results[0]?.images?.length,1);assert.ok((results[0]?.output as {image_ref:string}).image_ref)}
  if(step===4)assert.equal((results[0]?.output as {code:string}).code,'verification_required')
  return sequence[step]?{call:sequence[step]}:{text:'done'}
 },'never',undefined,()=>({
  observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
  action:()=>{actions++;return Promise.resolve({executionMode:'background' as const})},close:()=>{closed++;return Promise.resolve()},
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(actions,1);assert.equal(closed,1);assert.equal(buildView(f.host,id).status,'finished')
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.equal(JSON.stringify(checkpoint.calls).includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII='),false)
  assert.ok(f.frames.some(frame=>frame.type==='computer_use'&&frame.state==='idle'))
 }finally{await f.close()}
})

test('Build Connect approval is required even when per-input approval is never',{skip:!supported,timeout:10000},async()=>{
 let connected=false,actions=0
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:step===1?{call:{name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}}}:{text:'done'},
 'never',undefined,options=>({
  observe:async()=>{
   assert.equal(await options.approve('Connect',{displayId:'fake'}),true);connected=true
   return observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})
  },action:async()=>{assert.equal(await options.approve('Tap',{}),true);options.acting('computer_click',{x:0,y:0});actions++;return {executionMode:'background' as const}},close:()=>Promise.resolve(),
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build()
  const pending=await until(()=>buildView(f.host,id).approval,value=>!!value)
  assert.equal(pending!.name,'computer_connect');assert.equal(connected,false)
  assert.ok(f.frames.some(frame=>frame.type==='computer_use'&&frame.state==='active'))
  await f.command('build.approve',{id,approval_id:pending!.id,approved:true})
  await f.host.waitConversation(id);assert.equal(connected,true);assert.equal(actions,1)
  const frames=f.frames.filter(frame=>frame.type==='computer_use');assert.ok(frames.every(frame=>frame.conversation_id===id));assert.deepEqual(frames.map(frame=>frame.state),['active','acting','active','idle']);assert.deepEqual(frames[1]?.point,{x:0,y:0})
 }finally{await f.close()}
})

test('ask-mode computer approvals identify the current write, not the earlier screenshot',{skip:!supported,timeout:10000},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:step===1?{call:{name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}}}:{text:'done'},
 'ask',undefined,options=>({
  observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
  action:async()=>{assert.equal(await options.approve('Tap',{}),true);return {executionMode:'background' as const}},close:()=>Promise.resolve(),
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build(),pending=await until(()=>buildView(f.host,id).approval,value=>!!value)
  assert.equal(pending!.name,'computer_click');assert.equal(pending!.call_id,'c1')
  const checkpoint=await f.host.workbench.checkpoint(id,0);assert.equal(checkpoint.calls.at(-1)?.state,'awaiting_approval')
  await f.command('build.approve',{id,approval_id:pending!.id,approved:true});await f.host.waitConversation(id)
 }finally{await f.close()}
})

test('uncertain computer cleanup cannot permanently finish Build',{skip:!supported,timeout:10000},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:{call:{name:'finish_build',arguments:{summary:'not yet safe'}}},
 'never',undefined,()=>({
  observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
  action:()=>Promise.resolve({executionMode:'background' as const}),close:()=>Promise.reject(Error('cleanup_unknown')),
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'outcome_unknown')
  assert.equal((await f.host.workbench.checkpoint(id,0)).reason,'cleanup_unknown')
 }finally{await f.close()}
})

test('Stop interrupts a computer input and Resume observes before writing without replay',{skip:!supported,timeout:10000},async()=>{
 let actions=0,closed=0,started=false
 const f=await fixture((request,step)=>{
  const sequence=[
   {name:'computer_screenshot',arguments:{}},
   {name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}},
   {name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}},
   {name:'computer_screenshot',arguments:{}},
   {name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}},
  ]
  if(step===3)assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code:string}).code,'observe_required')
  return sequence[step]?{call:sequence[step]}:{text:'resumed'}
 },'never',undefined,options=>({
  observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
  action:async()=>{
   options.acting('computer_click',{x:0,y:0});actions++
   if(actions===1){started=true;await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}));options.signal.throwIfAborted()}
   return {executionMode:'background' as const}
  },close:()=>{closed++;return Promise.resolve()},
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build();await until(()=>started,value=>value);await f.command('build.stop',{id})
  assert.equal(actions,1);assert.equal(closed,1)
  const stopped=await f.host.workbench.checkpoint(id,0)
  assert.equal((stopped.calls[1]?.result as {status:string}).status,'outcome_unknown')
  await f.command('build.resume',{id});await f.host.waitConversation(id)
  assert.equal(actions,2);assert.equal(closed,2)
 }finally{await f.close()}
})

test('nonvision Build desktop calls return an explicit capability limitation',{skip:!supported,timeout:10000},async()=>{
 const f=await fixture((request,step)=>{
  assert.equal(request.tools.some(tool=>tool.name.startsWith('computer_')),false)
  if(step===0)return {call:{name:'computer_screenshot',arguments:{}}}
  const result=request.inputs.find(input=>input.kind==='tool_result')?.output as {code:string;message:string}
  assert.equal(result.code,'vision_model_required');assert.match(result.message,/视觉/)
  return {text:'switch model'}
 })
 f.host.computerUseState=()=>({enabled:true,direct:false})
 try{const id=await f.build();await f.host.waitConversation(id);assert.equal(f.script.requests.length,2)}finally{await f.close()}
})

test('screen change discards the failed session before the next observation',{skip:!supported,timeout:10000},async()=>{
 let sessions=0,closed=0
 const f=await fixture((_request,step)=>step<2?{call:{name:'computer_screenshot',arguments:{}}}:{text:'observed'},
 'never',undefined,()=>{
  const first=++sessions===1
  return {observe:()=>first?Promise.reject(Error('screen_changed')):Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
   action:()=>Promise.resolve({executionMode:'background' as const}),close:()=>{closed++;return Promise.resolve()}}
 })
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{const id=await f.build();await f.host.waitConversation(id);assert.equal(sessions,2);assert.equal(closed,2)}
 finally{await f.close()}
})

test('Stop while finish waits for device cleanup cannot lock the Build',{skip:!supported,timeout:10000},async()=>{
 let closing=false,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:{call:{name:'finish_build',arguments:{summary:'finish'}}},
 'never',undefined,()=>({
  observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
  action:()=>Promise.resolve({executionMode:'background' as const}),close:()=>{closing=true;return gate},
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build();await until(()=>closing,value=>value)
  const stopping=f.command('build.stop',{id});await new Promise(resolve=>setImmediate(resolve));release();await stopping
  assert.notEqual(buildView(f.host,id).status,'finished')
  assert.equal((await f.host.workbench.checkpoint(id,0)).reason,'stopped')
 }finally{release();await f.close()}
})

test('restart marks an interrupted computer write unknown and requires observation without replay',{skip:!supported,timeout:10000},async()=>{
 let actions=0
 const f=await fixture((request,step)=>{
  if(step===0)return {text:'ready'}
  if(step===1){assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {status:string}).status,'outcome_unknown');return {call:{name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}}}}
  if(step===2){assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code:string}).code,'observe_required');return {call:{name:'computer_screenshot',arguments:{}}}}
  if(step===3)return {call:{name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}}}
  return {text:'recovered'}
 },'never')
 let reopened:PersonalAgentHost|undefined
 try{
  const id=await f.build();await f.host.waitConversation(id);await f.host.close()
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  const interrupted={id:'interrupted',name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0},state:'running' as const,started_at:new Date().toISOString()}
  checkpoint.status='running';checkpoint.calls.push(interrupted);checkpoint.pending_calls.push(interrupted)
  await f.host.workbench.saveCheckpoint(checkpoint)
  reopened=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  const host=reopened;await host.open();host.computerUseState=()=>({enabled:true,direct:true})
  host.setConversationRuntime((conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation,host,factory:f.script.factory,createBridge:()=>Promise.resolve(f.plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:'never',computerSession:()=>({
   observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
   action:()=>{actions++;return Promise.resolve({executionMode:'background' as const})},close:()=>Promise.resolve(),
  })}),()=>{ /* no physical renderer */ })
  for(const [method,params] of [['presentation.set',{mode:'workbench'}],['build.resume',{id}]] as const){
   const result=await host.command({type:'personal.command',request_id:method,method,params},{client_id:'desktop:local'}) as {ok:boolean;error?:string}
   assert.equal(result.ok,true,result.error)
  }
  await host.waitConversation(id);assert.equal(actions,1);assert.equal(buildView(host,id).status,'completed')
  assert.equal((await host.workbench.checkpoint(id,0)).calls.filter(call=>call.id==='interrupted').length,1)
 }finally{await reopened?.close();await f.close()}
})

test('revocation immediately before input prevents the write even with never approval',{skip:!supported,timeout:10000},async()=>{
 let enabled=true,writes=0
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:step===1?{call:{name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}}}:{text:'stopped'},
 'never',undefined,options=>({
  observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
  action:async()=>{
   assert.equal(await options.approve('Tap',{}),true)
   enabled=false;options.acting('computer_click',{x:0,y:0});writes++
   return {executionMode:'background' as const}
  },close:()=>Promise.resolve(),
 }))
 f.host.computerUseState=()=>({enabled,direct:true})
 try{const id=await f.build();await f.host.waitConversation(id);assert.equal(writes,0);assert.equal(f.frames.some(frame=>frame.type==='computer_use'&&frame.state==='acting'),false)}
 finally{await f.close()}
})

test('every successful input requires a new observation, including typing and Enter',{skip:!supported,timeout:10000},async()=>{
 const actions:string[]=[]
 const sequence=[
  {name:'computer_screenshot',arguments:{}},
  {name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}},
  {name:'computer_type',arguments:{observationId:'test-observation',text:'hello'}},
  {name:'computer_key',arguments:{observationId:'test-observation',keys:'Enter'}},
  {name:'computer_click',arguments:{observationId:'test-observation',x:0,y:0}},
 ]
 const f=await fixture((request,step)=>{
  if(step===5)assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code:string}).code,'observe_required')
  return sequence[step]?{call:sequence[step]}:{text:'done'}
 },'never',undefined,()=>({
  observe:()=>Promise.resolve(observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})),
  action:(name)=>{actions.push(name);return Promise.resolve({executionMode:'background' as const})},close:()=>Promise.resolve(),
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.deepEqual(actions,['computer_click'])
 }finally{await f.close()}
})


test('Build rejects async dispatch and refreshes computer tools after an in-turn switch change',{skip:!supported,timeout:10000},async t=>{
 let enabled=false
 const f=await fixture((request,step)=>{
  assert.equal(request.tools.some(tool=>tool.name==='dispatch'),false)
  if(step===0){assert.equal(request.tools.some(tool=>tool.name==='computer_screenshot'),false);return {call:{name:'monitor',arguments:{}}}}
  assert.equal(request.tools.some(tool=>tool.name==='computer_screenshot'),true)
  if(step===1)return {call:{name:'dispatch',arguments:{executor:'computer',instruction:'must not run'}}}
  assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code?:string})?.code,'tool_not_authorized')
  return {text:'ready for synchronous computer use'}
 },'never')
 t.mock.method(f.host,'computerUseState',()=>({enabled,direct:enabled}))
 f.bridge.invoke=()=>{enabled=true;return Promise.resolve({status:'observed'})}
 try{const id=await f.build();await f.host.waitConversation(id);assert.equal(f.script.requests.length,3);assert.equal(f.host.tasks.list().length,0)}finally{await f.close()}
})

for(const operation of ['computer_screenshot','computer_click'] as const){
 test(`Stop before ${operation} input is a clean pause`,{skip:!supported,timeout:10000},async()=>{
  let pending=false,writes=0
  const f=await fixture((_request,step)=>({call:{name:step===0?'computer_screenshot':'computer_click',arguments:step===0?{}:{x:0,y:0,observationId:'test-observation'}}}),
  'ask',undefined,options=>({
   observe:async()=>{
    if(operation==='computer_screenshot'){pending=true;await options.approve('Connect',{});options.signal.throwIfAborted()}
    return observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})
   },
   action:async()=>{pending=true;await options.approve('Tap',{});options.signal.throwIfAborted();options.acting('computer_click',{x:0,y:0});writes++;return {executionMode:'background' as const}},
   close:()=>Promise.resolve(),
  }))
  f.host.computerUseState=()=>({enabled:true,direct:true})
  try{
   const id=await f.build();await until(()=>pending,value=>value);await f.command('build.stop',{id})
   assert.equal(writes,0);assert.equal(buildView(f.host,id).status,'paused')
   const checkpoint=await f.host.workbench.checkpoint(id,0)
   assert.equal((checkpoint.calls.at(-1)?.result as {status:string}).status,'cancelled_before_execution')
  }finally{await f.close()}
 })
}

for(const decision of ['allow','always','deny','remembered'] as const)test(`native application consent ${decision} is scoped to binding and app identity`,{skip:!supported,timeout:15000},async()=>{
 const app={name:'Fixture Editor',bundleId:'test.fixture.editor',path:'/Applications/Fixture Editor.app'}
 let actions=0,observations=0
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{application:app.name}}}:step===1?{call:{name:'computer_type',arguments:{observationId:'test-observation',text:'test'}}}:{text:'done'},'ask',undefined,options=>({
  observe:async application=>{
   assert.equal(application,app.name);observations++
   if(!await options.approve('Connect',{mode:'background',application:app,window:{pid:123,windowId:456}}))throw Error('declined')
   return observation({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString(),native_editor:{role:'AXTextField',value:'今日美食',source:'accessibility'},native_ui:{source:'accessibility',content:Array.from({length:80},()=>({role:'AXStaticText',text:'x'.repeat(300),url:'https://example.test/results'})),truncated:true}})
  },action:async()=>{assert.equal(await options.approve('Input',{value:'test'}),true);actions++;return {executionMode:'background' as const}},close:()=>Promise.resolve(),
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  if(decision==='remembered')await f.host.workbench.allowComputerApplication(app)
  const id=await f.build()
  if(decision!=='remembered'){
   const pending=await until(()=>buildView(f.host,id).approval,value=>!!value)
   assert.equal(pending!.name,'computer_connect');assert.equal(actions,0)
   await f.command('build.approve',{id,approval_id:pending!.id,approved:decision!=='deny',...(decision==='always'?{always:true}:{})})
  }
  await f.host.waitConversation(id)
  assert.equal(observations,1);assert.equal(actions,decision==='deny'?0:1)
  if(decision!=='deny'){const checkpoint=await f.host.workbench.checkpoint(id,0);assert.deepEqual((checkpoint.calls[0]?.result as {ax:{editor:unknown}}).ax.editor,{role:'AXTextField',value:'今日美食',source:'accessibility'});assert.equal((checkpoint.calls[0]?.result as {ax:{summary:{content:{url:string}[]}}}).ax.summary.content[0]?.url,'https://example.test/results')}
  const persisted=new WorkbenchStore(f.host.workbench.root)
  assert.equal(await persisted.computerApplicationAllowed(app),decision==='always'||decision==='remembered')
  assert.equal(await persisted.computerApplicationAllowed({...app,path:'/Other/Fixture Editor.app'}),false)
  assert.equal(await persisted.computerApplicationAllowed({...app,bundleId:'test.other'}),false)
 }finally{await f.close()}
})


test('finished Build remains locked after restart',{skip:!supported},async()=>{
 const f=await fixture(()=>({call:{name:'finish_build',arguments:{summary:'Verified and finished.'}}}),'never')
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'finished');await f.host.close()
  const reopened=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  try{
   await reopened.open()
   assert.equal(buildView(reopened,id).status,'finished');assert.equal(reopened.localBuildAuthorized(id),false)
   await assert.rejects(reopened.submitConversationText(id,'run again'),/build_finished/)
   await reopened.command({type:'personal.command',request_id:'finished-presentation',method:'presentation.set',params:{mode:'workbench'}},{client_id:'desktop:local'})
   const resumed=await reopened.command({type:'personal.command',request_id:'finished-resume',method:'build.resume',params:{id}},{client_id:'desktop:local'}) as {ok:boolean;error?:string}
   assert.equal(resumed.ok,false);assert.equal(resumed.error,'build_finished')
  }finally{await reopened.close()}
 }finally{await f.close()}
})


test('direct Build admits one concurrent request without a plan and retains project context',{skip:!supported},async()=>{
 const f=await fixture(async request=>{await new Promise<void>(resolve=>request.signal.addEventListener('abort',()=>resolve(),{once:true}));return {text:'stopped'}})
 try{
  assert.equal((await f.raw('build.begin',{text:'work',project:join(f.root,'missing')})).ok,false)
  const release=await acquireTaskResources([projectResourceKey(f.root)],new AbortController().signal)
  try{assert.equal((await f.raw('build.begin',{text:'work',project:f.root})).error,'project_busy')}finally{release()}
  const results=await Promise.all([f.raw('build.begin',{text:'implement directly',project:f.root}),f.raw('build.begin',{text:'duplicate',project:f.root})])
  assert.equal(results.filter(result=>result.ok).length,1)
  assert.equal(results.find(result=>!result.ok)?.error,'build_stop_required')
  const id=f.host.conversationSnapshot().selected_id
  await until(()=>f.script.requests.length,count=>count>0)
  assert.equal(buildView(f.host,id).plan_id,undefined)
  assert.deepEqual(JSON.parse(f.script.requests[0]!.workspaceContext!),{project:f.root})
  assert.equal((await f.raw('build.begin',{text:'duplicate',project:f.root})).error,'build_stop_required')
  assert.notEqual((await f.raw('conversations.voice',{id,enabled:true})).error,'build_stop_required')
  const other=await f.raw('conversations.select',{id:'chat:main'})
  assert.equal(other.ok,true)
  assert.equal(f.host.conversationSnapshot().selected_id,'chat:main')
  await f.command('conversations.select',{id})
  await f.command('build.stop',{id})
 }finally{await f.close()}
})

test('direct Build restores checkpoint and resumes without a confirmed plan',{skip:!supported},async()=>{
 const f=await fixture(()=>({text:'verified'}))
 try{
  await f.command('build.begin',{text:'implement directly',project:f.root,title:'Direct'})
  const id=f.host.conversationSnapshot().selected_id;await f.host.waitConversation(id)
  await f.host.close()
  const reopened=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  try{
   await reopened.open();reopened.setConversationRuntime((conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation,host:reopened,factory:f.script.factory,createBridge:()=>Promise.resolve(f.plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:'never'}),()=>{ /* no renderer */ })
   for(const [method,params] of [['presentation.set',{mode:'workbench'}],['build.resume',{id}]] as const){const result=await reopened.command({type:'personal.command',request_id:method,method,params},{client_id:'desktop:local'}) as {ok:boolean;error?:string};assert.equal(result.ok,true,result.error)}
   await reopened.waitConversation(id)
   assert.ok(f.script.restores.length>0);assert.equal(buildView(reopened,id).plan_id,undefined)
  }finally{await reopened.close()}
 }finally{await f.close()}
})


test('Plan delegate selects explicit codex project and rejects busy or invalid directories',async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const plan=await f.plan(),params={id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex',project:f.root}
  const target={workspace_id:'selected-workspace',session_id:null,project:'selected',title:'selected',executor:'codex' as const}
  let running:string|undefined,validated=0
  f.host.setCodingTargets({list:()=>Promise.resolve([{...target,directory:f.root,...(running?{running}:{})}]),validate:selection=>{validated++;assert.deepEqual(selection,{workspace_id:target.workspace_id,session_id:null});return Promise.resolve(target)},resolve:()=>{throw Error('unused')}})
  assert.equal((await f.raw('plans.delegate',{...params,project:'relative'})).error,'invalid_project_directory')
  running='active';assert.equal((await f.raw('plans.delegate',params)).error,'project_busy');running=undefined
  const release=await acquireTaskResources([projectResourceKey(f.root)],new AbortController().signal)
  try{assert.equal((await f.raw('plans.delegate',params)).error,'project_busy')}finally{release()}
  await f.command('plans.delegate',params)
  assert.equal(validated,1);assert.deepEqual(f.host.conversationSnapshot().items[0]!.coding_target,target);assert.equal(f.invocations.length,1)
 }finally{await f.close()}
})

for(const mode of ['plan','build'] as const)test(`${mode} text-voice-text preserves transcripts and imports each voice message once`,{skip:!supported},async()=>{
 const f=await fixture(()=>({text:'text reply'}))
 let emitVoice:(frame:Record<string,unknown>)=>void=()=>{throw Error('voice not started')}
 try{
  if(mode==='plan')await f.plan();else await f.command('build.begin',{text:'direct work',project:f.root})
  const id=f.host.conversationSnapshot().selected_id;await f.host.waitConversation(id)
  f.host.setConversationRuntime((conversation,emit,runtimeMode,lifetime)=>{
   if(runtimeMode==='voice'){emitVoice=emit;return Promise.resolve({runTurn:()=>Promise.resolve({assistant:'voice'}),parkVoice:()=>Promise.resolve(),close:()=>Promise.resolve()})}
   return createWorkbenchRuntime({conversation,host:f.host,factory:f.script.factory,createBridge:()=>Promise.resolve(f.plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:'never'})
  },()=>{ /* no renderer */ })
  await f.host.submitConversationText(id,'text before voice',undefined,undefined,{local_desktop:true});await f.host.waitConversation(id)
  for(let round=0;round<2;round++){
   await f.command('conversations.voice',{id,enabled:true})
   assert.equal(f.host.conversationSnapshot().voice_id,id)
   const item=f.host.conversationSnapshot().items.find(item=>item.id===id)!
   assert.equal(mode==='plan'?item.mode:item.kind,mode)
   emitVoice({type:'caption',role:'user',text:'spoken clarification '+round,turn_id:'voice-user-'+round,final:true})
   emitVoice({type:'conversation.delivered',role:'assistant',text:'spoken answer '+round,turn_id:'voice-assistant-'+round,delivery:'completed',final:true})
   await until(()=>f.host.conversationSnapshot().messages,messages=>messages.some(message=>message.text==='spoken answer '+round))
   await f.command('conversations.voice',{id,enabled:false})
   await f.host.submitConversationText(id,'continue '+round,undefined,undefined,{local_desktop:true});await f.host.waitConversation(id)
   const inputs=f.script.requests.at(-1)!.inputs
   assert.ok(inputs.some(input=>input.kind==='host_context'&&input.content.includes('spoken clarification '+round)))
   assert.ok(inputs.some(input=>input.kind==='host_context'&&input.content.includes('spoken answer '+round)))
   await f.host.submitConversationText(id,'next '+round,undefined,undefined,{local_desktop:true});await f.host.waitConversation(id)
   assert.ok(!f.script.requests.at(-1)!.inputs.some(input=>input.kind==='host_context'&&input.content.includes('spoken clarification')))
  }
  assert.equal((await f.host.workbench.checkpoint(id,0)).voice_message_ids?.length,4)
 }finally{await f.close()}
})


test('direct Build instructions skip planning but retain approval and completion boundaries',()=>{
 const direct=workbenchInstructions('build','en',false)
 assert.match(direct,/Do not first produce a plan/);assert.match(direct,/missing information blocks/);assert.match(direct,/Approval is enforced by the host/);assert.match(direct,/finish_build/)
 assert.doesNotMatch(direct,/executing the user-confirmed plan/)
 assert.match(workbenchInstructions('build','en',true),/executing the user-confirmed plan/)
})

test('Workbench previews grow and Build records narration before tools', async () => {
 for(const mode of ['plan','build'] as const){
  const script=scripted((_request,step)=>step===0?{call:{name:mode==='plan'?'monitor':'file_read',arguments:mode==='plan'?{}:{path:'missing.txt'}}}:{text:'final answer'})
  const factory:CascadedLlmFactory={open:()=>{const base=script.factory.open();let round=0;return {...base,async *stream(request){
   assert.equal(request.previewText,true)
   for await(const event of base.stream(request)){yield event;if(event.kind==='response_started'){yield {kind:'text_preview' as const,text:round===0?'discard':'final '};yield {kind:'text_preview' as const,text:round===0?' me':'answer'}}}
   round++
  }}}}
  const f=await fixture(()=>({}),'ask',factory)
  try{
   let id:string
   if(mode==='build')id=await f.build()
   else{await f.command('conversations.mode',{id:'chat:main',mode:'plan'});id='chat:main';await f.host.submitConversationText(id,'test')}
   await f.host.waitConversation(id)
   const captions=f.frames.filter(x=>x.type==='caption'),merged=mode==='build'?'final answer':'discard me\n\nfinal answer'
   if(mode==='build'){
    const checkpoint=await f.host.workbench.checkpoint(id,0)
    assert.equal(checkpoint.calls[0]?.narration,'discard me')
    assert.equal(checkpoint.thoughts?.length,0)
    assert.deepEqual(captions.map(x=>[x.text,x.final]),[['discard',false],['discard me',false],['',true],['final ',false],['final answer',false],['final answer',false]])
   }else assert.deepEqual(captions.map(x=>[x.text,x.final]),[['discard',false],['discard me',false],['discard me\n\nfinal ',false],['discard me\n\nfinal answer',false],['discard me\n\nfinal answer',false]])
   // The turn identity survives the tool round; every caption belongs to the same reply.
   assert.equal(new Set(captions.map(x=>x.turn_id)).size,1)
   const message=f.host.conversationSnapshot().messages.at(-1)!
   assert.equal(message.text,merged);assert.equal(message.turn_id,captions.at(-1)!.turn_id)
  }finally{await f.close()}
 }
})

test('Plan and Build keep authoritative narration before a tool call', async () => {
 for(const mode of ['plan','build'] as const){
  const script=scripted((_request,step)=>step===0?{call:{name:mode==='plan'?'monitor':'file_read',arguments:mode==='plan'?{}:{path:'missing.txt'}}}:{text:'final answer'})
  const factory:CascadedLlmFactory={open:()=>{const base=script.factory.open();let round=0;return {...base,async *stream(request){
   for await(const event of base.stream(request)){yield event;if(event.kind==='response_started'&&round===0)yield {kind:'text_delta' as const,text:'narration before the tool'}}
   round++
  }}}}
  const f=await fixture(()=>({}),'ask',factory)
  try{
   let id:string
   if(mode==='build')id=await f.build()
   else{await f.command('conversations.mode',{id:'chat:main',mode:'plan'});id='chat:main';await f.host.submitConversationText(id,'test')}
   await f.host.waitConversation(id)
   const captions=f.frames.filter(x=>x.type==='caption'),merged=mode==='build'?'final answer':'narration before the tool\n\nfinal answer'
   if(mode==='build'){
    const page=await f.command('build.details',{id,view:'steps'}) as {items:{narration?:string}[]}
    assert.equal(page.items[0]?.narration,'narration before the tool')
    assert.deepEqual(captions.map(x=>[x.text,x.final]),[['narration before the tool',false],['',true],[merged,false]])
   }else assert.deepEqual(captions.map(x=>[x.text,x.final]),[['narration before the tool',false],[merged,false]])
   assert.equal(new Set(captions.map(x=>x.turn_id)).size,1)
   assert.equal(f.frames.some(x=>x.type==='conversation.error'),false)
   assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,merged)
  }finally{await f.close()}
 }
})

test('a model output limit continues the reply twice and keeps one turn identity', async () => {
 let attempts=0
 const f=await fixture((request)=>{
  attempts++
  const continuations=request.inputs.filter(input=>input.kind==='host_context'&&input.content.includes('output_limit_continuation')).length
  if(attempts===1)return {text:'第一段',failure:{code:'output_limit',detail:'length'}}
  if(attempts===2){assert.equal(continuations,1);return {text:'第二段',failure:{code:'output_limit',detail:'length'}}}
  assert.equal(continuations,2)
  return {text:'完成'}
 })
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','写一份很长的计划');await f.host.waitConversation('chat:main')
  assert.equal(attempts,3)
  const message=f.host.conversationSnapshot().messages.at(-1)!
  assert.equal(message.text,'第一段\n\n第二段\n\n完成')
  const checkpoint=await f.host.workbench.checkpoint('chat:main',0)
  assert.equal(checkpoint.status,'completed');assert.equal(checkpoint.model_failure,undefined)
  const captions=f.frames.filter(x=>x.type==='caption')
  assert.ok(captions.length>0);assert.equal(new Set(captions.map(x=>x.turn_id)).size,1)
  assert.equal(f.frames.some(x=>x.type==='conversation.error'),false)
 }finally{await f.close()}
})

test('exhausted output-limit continuations pause with a readable label', async () => {
 let attempts=0
 const f=await fixture(()=>{attempts++;return {text:'仍被截断',failure:{code:'output_limit',detail:'length'}}})
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','写一份很长的计划');await f.host.waitConversation('chat:main')
  assert.equal(attempts,3)
  const checkpoint=await f.host.workbench.checkpoint('chat:main',0)
  assert.equal(checkpoint.status,'paused');assert.equal(checkpoint.reason,'model_output_limit')
  const message=f.host.conversationSnapshot().messages.at(-1)!
  assert.match(message.text,/输出长度上限/u);assert.match(message.text,/发送新消息/u);assert.doesNotMatch(message.text,/Resume/u)
  assert.equal(f.frames.some(frame=>frame.type==='conversation.error'),false)
 }finally{await f.close()}
})

test('truncated tool-call JSON is never executed and retries once with split-write guidance',{skip:!supported},async()=>{
 let attempts=0
 const f=await fixture((request)=>{
  attempts++
  if(attempts===1)return {failure:{code:'output_limit',detail:'tool_arguments'}}
  if(attempts===2){
   assert.ok(request.inputs.some(input=>input.kind==='host_context'&&input.content.includes('output_limit_tool_split')))
   return {call:{name:'file_write',arguments:{path:'big.txt',content:'完整内容'}}}
  }
  return {text:'写入完成'}
 },'never')
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(attempts,3)
  assert.equal(await readFile(join(f.root,'big.txt'),'utf8'),'完整内容')
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.equal(checkpoint.status,'completed');assert.deepEqual(checkpoint.calls.map(call=>call.name),['file_write'])
  assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,'写入完成')
  assert.equal(f.frames.some(frame=>frame.type==='conversation.error'),false)
 }finally{await f.close()}
})

test('a second truncated tool-call JSON pauses without executing or retrying again',{skip:!supported},async()=>{
 let attempts=0
 const f=await fixture((request)=>{
  attempts++
  if(attempts===2)assert.ok(request.inputs.some(input=>input.kind==='host_context'&&input.content.includes('output_limit_tool_split')))
  return {failure:{code:'output_limit',detail:'tool_arguments'}}
 },'never')
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(attempts,2)
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.equal(checkpoint.status,'paused');assert.equal(checkpoint.reason,'model_output_limit')
  assert.deepEqual(checkpoint.calls,[])
  const message=f.host.conversationSnapshot().messages.at(-1)!
  assert.match(message.text,/未执行/u)
  assert.equal(f.frames.some(frame=>frame.type==='conversation.error'),false)
 }finally{await f.close()}
})

test('Plan captions keep the head of a long reply instead of its tail', async () => {
 const opening='开头：'+'内容😀'.repeat(1600)
 const script=scripted(()=>({text:opening}))
 const factory:CascadedLlmFactory={open:()=>{const base=script.factory.open();return {...base,async *stream(request){
  for await(const event of base.stream(request)){yield event;if(event.kind==='response_started')yield {kind:'text_preview' as const,text:opening}}
 }}}}
 const f=await fixture(()=>({}),'ask',factory)
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','给我一份长计划');await f.host.waitConversation('chat:main')
  const captions=f.frames.filter(x=>x.type==='caption')
  const full=String(captions.at(-1)!.full_text)
  assert.ok([...full].length===4001);assert.ok(full.startsWith('开头：'));assert.ok(full.endsWith('…'))
  const message=f.host.conversationSnapshot().messages.at(-1)!
  assert.ok(message.text.startsWith('开头：'));assert.ok(message.text.includes('😀'))
  assert.equal(message.text,opening)
 }finally{await f.close()}
})

test('managed workspace commands validate names, hide paths and resolve Build defaults and IDs', {skip:!supported},async()=>{
 const f=await fixture(()=>({text:'done'})),resolved:(string|undefined)[]=[],created:string[]=[]
 const workspace={workspace_id:'w-default',name:'default',is_default:true}
 f.host.setCodingTargets({list:()=>Promise.resolve([]),validate:()=>Promise.reject(Error('unused')),resolve:()=>Promise.reject(Error('unused')),workspaces:{list:()=>Promise.resolve([workspace]),create:name=>{created.push(name);return Promise.resolve({...workspace,workspace_id:'w-new',name,is_default:false})},resolve:id=>{resolved.push(id);if(id&&id!=='w-default')return Promise.reject(Error('unknown_workspace'));return Promise.resolve(f.root)}}})
 try{
  assert.deepEqual(await f.command('workspaces.list'),[workspace])
  assert.equal((await f.raw('workspaces.list',{},false)).error,'local_workbench_required')
  for(const name of ['', '.', '..', '../escape','a/b','x'.repeat(81),'bad\nname']){const failed=await f.raw('workspaces.create',{name});assert.equal(failed.ok,false);assert.equal(failed.error,'invalid_params');assert.match(failed.error??'',/^[a-z][a-z0-9_]{0,63}$/u)}
  assert.equal((await f.command('workspaces.create',{name:'Notes'}) as {workspace_id:string}).workspace_id,'w-new');assert.deepEqual(created,['Notes'])
  assert.equal((await f.raw('build.begin',{text:'work',workspace_id:'w-default',project:f.root})).error,'workspace_project_conflict')
  assert.equal((await f.raw('build.begin',{text:'work',workspace_id:'missing'})).error,'unknown_workspace')
  await f.command('build.begin',{text:'work'});await f.host.waitConversation(f.host.conversationSnapshot().selected_id)
  assert.equal(buildView(f.host,f.host.conversationSnapshot().selected_id).project,f.root);assert.equal(resolved.at(-1),undefined)
 }finally{await f.close()}
})

test('published Build accepts managed workspace ID and rejects mixed directory authority', {skip:!supported},async()=>{
 const f=await fixture(()=>({text:'done'})),resolved:string[]=[]
 f.host.setCodingTargets({list:()=>Promise.resolve([]),validate:()=>Promise.reject(Error('unused')),resolve:()=>Promise.reject(Error('unused')),workspaces:{list:()=>Promise.resolve([]),create:()=>Promise.reject(Error('unused')),resolve:id=>{resolved.push(id!);return Promise.resolve(f.root)}}})
 try{
  const plan=await f.plan(),ref={id:'chat:main',plan_id:plan.id,version:plan.version}
  assert.equal((await f.raw('build.start',{...ref,workspace_id:'w',project:f.root})).error,'workspace_project_conflict')
  await f.command('build.start',{...ref,workspace_id:'w'});await f.host.waitConversation(f.host.conversationSnapshot().selected_id);assert.deepEqual(resolved,['w'])
 }finally{await f.close()}
})

test('direct Build resolves a selected managed ID before canonical resource checks', {skip:!supported},async()=>{
 const f=await fixture(()=>({text:'done'})),resolved:string[]=[]
 f.host.setCodingTargets({list:()=>Promise.resolve([]),validate:()=>Promise.reject(Error('unused')),resolve:()=>Promise.reject(Error('unused')),workspaces:{list:()=>Promise.resolve([]),create:()=>Promise.reject(Error('unused')),resolve:id=>{resolved.push(id!);return Promise.resolve(f.root)}}})
 try{await f.command('build.begin',{text:'work',workspace_id:'selected'});await f.host.waitConversation(f.host.conversationSnapshot().selected_id);assert.deepEqual(resolved,['selected']);assert.equal(buildView(f.host,f.host.conversationSnapshot().selected_id).project,f.root)}finally{await f.close()}
})


test('a stopped completed Build accepts a new instruction without Resume',{skip:!supported},async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'completed')
  await f.command('build.stop',{id})
  await f.host.submitConversationText(id,'Stop 后的新要求',undefined,undefined,{local_desktop:true})
  await f.host.waitConversation(id)
  assert.ok(f.host.conversationSnapshot().messages.some(message=>message.text==='Stop 后的新要求'))
  assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,'done')
 }finally{await f.close()}
})

test('a completed Build accepts a new instruction after a restart',{skip:!supported},async()=>{
 const f=await fixture(()=>({text:'done'}))
 const id=await f.build();await f.host.waitConversation(id)
 assert.equal(buildView(f.host,id).status,'completed')
 await f.host.close()
 const host=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const bridge:NonNullable<ConversationRuntime['toolBridge']>={tools:[],readonlyNames:[],origin:()=>Promise.resolve('memory:test-user'),invoke:()=>Promise.resolve(null)}
 const plain:ConversationRuntime={runTurn:()=>Promise.resolve({assistant:'chat'}),close:()=>Promise.resolve(),toolBridge:bridge}
 const frames:Record<string,unknown>[]=[]
 host.setConversationRuntime(async(conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation,host,factory:f.script.factory,createBridge:()=>Promise.resolve(plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:()=> 'never'}),frame=>frames.push(frame))
 try{
  await host.open();host.setWorkbenchExecutors(['codex'])
  const shown=await host.command({type:'personal.command',request_id:'restart-workbench',method:'presentation.set',params:{mode:'workbench'}},{client_id:'desktop:local'}) as {ok:boolean}
  assert.equal(shown.ok,true)
  assert.equal(host.conversationSnapshot().selected_id,id)
  await host.submitConversationText(id,'继续补充新的要求',undefined,undefined,{local_desktop:true})
  await host.waitConversation(id)
  const failed=await host.workbench.checkpoint(id,0)
  assert.equal(buildView(host,id).status,'completed',JSON.stringify({reason:failed.reason,model_failure:failed.model_failure,frames:frames.filter(frame=>frame.type==='conversation.error')}))
  assert.ok(host.conversationSnapshot().messages.some(message=>message.text==='继续补充新的要求'))
  assert.equal(host.conversationSnapshot().messages.at(-1)!.text,'done')
 }finally{await host.close();await f.close()}
})

for(const [status,reason] of [['paused','approval_denied'],['completed',null],['failed','model_timeout'],['outcome_unknown','cleanup_unknown'],['idle',null]] as const)test(`restart preserves the durable ${status} Build state`,{skip:!supported},async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  const id=await f.build();await f.host.waitConversation(id)
  await f.host.updateLocalBuild(id,0,{status,reason,approval:null});await f.host.close()
  const reopened=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  try{await reopened.open();assert.equal(buildView(reopened,id).status,status);assert.equal(buildView(reopened,id).reason,reason);assert.equal(reopened.localBuildAuthorized(id),false)}finally{await reopened.close()}
 }finally{await f.close()}
})

test('restart repairs a previously overwritten pause reason from its durable checkpoint',{skip:!supported},async()=>{
 const f=await fixture(()=>({call:{name:'file_write',arguments:{path:'denied.txt',content:'do not write'}}}))
 try{
  const id=await f.build(),pending=await until(()=>buildView(f.host,id).approval,value=>!!value)
  await f.command('build.approve',{id,approval_id:pending!.id,approved:false});await f.host.waitConversation(id)
  assert.equal((await f.host.workbench.checkpoint(id,0)).reason,'approval_denied')
  await f.host.updateLocalBuild(id,0,{status:'paused',reason:'restart_requires_resume',approval:null});await f.host.close()
  const reopened=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  try{await reopened.open();assert.equal(buildView(reopened,id).reason,'approval_denied');assert.equal(buildView(reopened,id).status,'paused');assert.equal(reopened.localBuildAuthorized(id),false)}finally{await reopened.close()}
  assert.equal(f.script.requests.length,2)
  await assert.rejects(readFile(join(f.root,'denied.txt')), {code:'ENOENT'})
 }finally{await f.close()}
})


test('Chat uses a restricted runtime while host plan dispatch is awaiting admission',async()=>{
 const f=await fixture(()=>({text:'unused'})),used:string[]=[],closed:string[]=[]
 let release!:()=>void,entered!:()=>void
 const blocked=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 let delegation:Promise<unknown>|undefined
 try{
  const plan=await f.plan(),invoke=f.bridge.invoke
  f.bridge.invoke=async(...args)=>{entered();await blocked;return invoke(...args)}
  f.host.setConversationRuntime((_c,_e,_m,_l,_r,_x,overrides)=>{
   const kind=overrides?.chat===false?'host-only':'chat'
   return Promise.resolve({...f.plain,runTurn:()=>{used.push(kind);return Promise.resolve({assistant:'race reply'})},close:()=>{closed.push(kind);return Promise.resolve()}})
  },()=>{ /* no renderer */ })
  delegation=f.command('plans.delegate',{id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'})
  await started
  assert.equal(f.host.conversationSnapshot().items[0]!.mode,'chat')
  await f.host.submitConversationText('chat:main','ordinary Chat turn');await f.host.waitConversation('chat:main')
  assert.deepEqual(used,['chat'])
  release();await delegation
  assert.deepEqual(closed,['host-only'],'dispatch cleanup must leave the foreground Chat runtime open')
  await f.host.submitConversationText('chat:main','another Chat turn');await f.host.waitConversation('chat:main')
  assert.deepEqual(used,['chat','chat'])
 }finally{release();await delegation?.catch(()=>undefined);await f.close()}
})

test('exhausted long output retains full text and a visible pause notice', {skip:!supported},async()=>{
 let attempts=0
 const f=await fixture(()=>({text:String(++attempts).repeat(17000),failure:{code:'output_limit',detail:'length'}}))
 try{
  const id=await f.build();await f.host.waitConversation(id)
  const message=f.host.conversationSnapshot().messages.at(-1)!
  assert.equal(attempts,3);assert.equal(message.full_text_ref,true)
  const page=await f.command('build.details',{id,view:'reply',message_id:message.turn_id,offset:16000}) as {text:string}
  assert.ok(page.text.length>0,'paused output must be durably readable')
  assert.match(message.text,/输出长度上限/u);assert.match(message.text,/点「继续」/u);assert.doesNotMatch(message.text,/Resume/u)
  const first=await f.command('build.details',{id,view:'reply',message_id:message.turn_id,offset:0}) as {text:string}
  assert.ok(first.text.startsWith('1'.repeat(17000)))
  const last=await f.command('build.details',{id,view:'reply',message_id:message.turn_id,offset:51000}) as {text:string}
  assert.match(last.text,/点「继续」/u)
 }finally{await f.close()}
})


test('refused plan dispatch preserves a concurrent user Chat turn and its restricted runtime',async()=>{
 const f=await fixture(()=>({text:'unused'})),used:string[]=[],closed:string[]=[]
 let release!:()=>void,entered!:()=>void
 const blocked=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
 let delegation:Promise<unknown>|undefined
 try{
  const plan=await f.plan()
  f.bridge.invoke=async()=>{entered();await blocked;return {accepted:false,delegate_id:null}}
  f.host.setConversationRuntime((_c,_e,_m,_l,_r,_x,overrides)=>{
   const kind=overrides?.chat===false?'host-only':'chat'
   return Promise.resolve({...f.plain,runTurn:()=>{used.push(kind);return Promise.resolve({assistant:'Chat reply'})},close:()=>{closed.push(kind);return Promise.resolve()}})
  },()=>{ /* no renderer */ })
  delegation=f.command('plans.delegate',{id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'})
  await started
  await f.host.submitConversationText('chat:main','I am continuing in Chat');await f.host.waitConversation('chat:main')
  release();await assert.rejects(delegation,/plan_delegation_refused/u)
  assert.equal(f.host.conversationSnapshot().items[0]!.mode,'chat','a refused older command must not undo the user continuing in Chat')
  assert.deepEqual(closed,['host-only'])
  await f.host.submitConversationText('chat:main','another Chat instruction');await f.host.waitConversation('chat:main')
  assert.deepEqual(used,['chat','chat'])
 }finally{release();await delegation?.catch(()=>undefined);await f.close()}
})


test('a long paused Plan keeps full output and directs the user to send another message',async()=>{
 let attempts=0,limited=true
 const f=await fixture(()=>limited?{text:String(++attempts).repeat(17000),failure:{code:'output_limit',detail:'length'}}:{text:'Plan continued'})
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','a long plan');await f.host.waitConversation('chat:main')
  const message=f.host.conversationSnapshot().messages.at(-1)!
  assert.match(message.text,/发送新消息/u);assert.doesNotMatch(message.text,/Resume/u)
  const first=await f.host.workbench.reply('chat:main',0,message.turn_id!,0)
  assert.ok(first.text.startsWith('1'.repeat(17000)))
  const last=await f.host.workbench.reply('chat:main',0,message.turn_id!,51000)
  assert.match(last.text,/发送新消息/u)
  limited=false;await f.host.submitConversationText('chat:main','continue the plan');await f.host.waitConversation('chat:main')
  assert.ok(f.host.conversationSnapshot().messages.at(-1)!.text.endsWith('Plan continued'))
  assert.equal((await f.host.workbench.checkpoint('chat:main',0)).status,'completed')
 }finally{await f.close()}
})

async function memoryBridgeFixture(f: Awaited<ReturnType<typeof fixture>>, full = true) {
 const gateway={complete:()=>Promise.reject(Error('automatic learning is forbidden')),async *stream(){await Promise.reject(Error('automatic learning is forbidden'))}}
 const client=new MemoryLedgerClient(join(f.root,'memory.sqlite'))
 const memory=new SubstrateMemoryResource({client,userId:'workbench-test',model:'fixture',gateway,inputConsent:true,conversationProviders:['workbench-model']})
 await memory.open({deferBackground:true})
 const core=buildAssembly({settings:settingsSchema.parse({executors:[]}),gateway,memoryTools:full?FULL_MEMORY_TOOLS:{...NO_MEMORY_TOOLS,recall:true,engine:'mem0'},blackboard:{path:join(f.root,'board.sqlite'),ownerId:'fixture'},capabilities:parseCapabilityRegistry({version:1,modules:{search:{enabled:false},camera:{enabled:false},coding:{enabled:false},knowledge:{enabled:false}}})})
 const provider:RealtimeProvider={connect:()=>Promise.resolve({epoch:1,provider_session_id:'workbench'}),sendAudio:()=>Promise.resolve(),replaceResponseAdaptation:()=>Promise.resolve(),injectHostItem:item=>Promise.resolve({session_epoch:1,host_item_id:item.host_item_id,provider_item_id:item.host_item_id}),createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),async *events(signal){if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))}}
 const graph=buildRealtimeAssembly({core,provider,createPersonalMemory:()=>memory,memoryConsumerFingerprint:'workbench-model',memoryReadMode:'text',onDiagnostic:()=>undefined})
 await graph.start()
 const tools=conversationToolBridge(core,graph,{memoryConsumer:'workbench-model'})
 f.plain.toolBridge=tools
 f.plain.close=async()=>{await graph.stop();await core.stop()}
 return {memory,client,tools}
}

for(const mode of ['plan','build'] as const)for(const full of [true,false])test(`${mode} exposes only supported memory host tools (${full?'ledger':'recall-only'})`,{skip:mode==='build'&&!supported},async()=>{
 const f=await fixture(()=>({text:'done'}))
 try{
  await memoryBridgeFixture(f,full)
  if(mode==='build')await f.command('build.begin',{text:'Discuss constraints',project:f.root})
  else {await f.command('conversations.mode',{id:'chat:main',mode:'plan'});await f.host.submitConversationText('chat:main','Discuss constraints')}
  const id=f.host.conversationSnapshot().selected_id
  await f.host.waitConversation(id)
  const names=f.script.requests[0]!.tools.map(tool=>tool.name)
  for(const name of ['memory__remember','memory__lookup'])assert.equal(names.includes(name),full)
  assert.ok(names.includes('memory__recall'))
  assert.equal(names.includes('file_write'),mode==='build')
  assert.ok(!f.script.requests[0]!.inputs.some(input=>input.kind==='host_context'&&input.content.includes('memory_scope')))
 }finally{await f.close()}
})

for(const mode of ['plan','build'] as const)test(`${mode} quotes only typed user text through the real service; general memory is not user background`,{skip:mode==='build'&&!supported},async()=>{
 const project='Use strict TypeScript in this repository',user='I prefer concise answers',legacy='I prefer examples',toolQuote='I love durian'
 const userText=`Remember: ${project}; ${user}; ${legacy}`
 const writes=[{scope:'general',text:project},{scope:'user',text:user},{text:legacy}]
 const f=await fixture((_request,step)=>{
  if(step===0)return {call:{name:'monitor',arguments:{}}}
  if(step===1)return {call:{name:'memory__remember',arguments:{action:'set',kind:'preference',scope:'user',text:toolQuote,quote:toolQuote}}}
  if(step===2)return {call:{name:'memory__remember',arguments:{action:'set',kind:'fact',scope:'user',text:'voice-only secret',quote:'voice-only secret'}}}
  const write=writes[step-3]
  if(write)return {call:{name:'memory__remember',arguments:{action:'set',kind:'preference',...write,quote:write.text}}}
  if(step===6)return {call:{name:'memory__lookup',arguments:{}}}
  return {text:'done'}
 })
 try{
  const {memory,client,tools}=await memoryBridgeFixture(f)
  const seen:string[]=[]
  f.plain.toolBridge={...tools,tools:[...tools.tools,{name:'monitor',parameters:{type:'object'}}],readonlyNames:[...tools.readonlyNames,'monitor'],invoke:(text,call,signal)=>{
   seen.push(text)
   return call.name==='monitor'?Promise.resolve({text:toolQuote}):tools.invoke(text,call,signal)
  }}
  // Voice is host context, never part of the typed-user authorization snapshot.
  f.host.setConversationRuntime((conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation:{...conversation,messages:[...conversation.messages,{id:'voice-only',conversation_id:conversation.id,role:'user',input_mode:'voice',text:'voice-only secret',created_at:new Date().toISOString()}]},host:f.host,factory:f.script.factory,createBridge:()=>Promise.resolve(f.plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:'never'}),frame=>f.frames.push(frame))
  if(mode==='build')await f.command('build.begin',{text:userText,project:f.root})
  else {await f.command('conversations.mode',{id:'chat:main',mode:'plan'});await f.host.submitConversationText('chat:main',userText)}
  const id=f.host.conversationSnapshot().selected_id
  await f.host.waitConversation(id)
  const state=await f.host.workbench.checkpoint(id,0)
  assert.equal(state.status,'completed',JSON.stringify(state))
  assert.equal(state.last_user,userText)
  assert.ok(seen.length>0);assert.ok(seen.every(text=>text===userText))
  const results=state.calls.map(call=>call.result as {code?:string;result?:{state?:string;entries?:{text:string}[]}})
  assert.equal(results[1]?.code,'invalid_source_quote');assert.equal(results[2]?.code,'invalid_source_quote')
  for(const result of results.slice(3,6))assert.equal(result.result?.state,'committed','same-invoke userTurn must pass superseded check')
  const saved=await memory.lookupExplicit({},'workbench-model')
  assert.deepEqual(saved.entries.map(entry=>entry.text).sort(),[project,user,legacy].sort())
  assert.ok(results[6]?.result?.entries?.some(entry=>entry.text===project),'lookup keeps general facts readable')
  assert.ok((await memory.recall('strict TypeScript',{scope:'any'})).hits.some(hit=>hit.text===project),'recall keeps general facts readable')
  const rows=await client.memory('conversation_snapshot',{entry_prefix:memory.prefix,consumer:'workbench-model'}) as EntryRevision[]
  const docs=memoryDocuments(rows)
  assert.doesNotMatch(docs.get('USER.md')!,/strict TypeScript/)
  assert.match(docs.get('MEMORY.md')!,/strict TypeScript/)
  assert.match(docs.get('USER.md')!,/concise answers/);assert.match(docs.get('USER.md')!,/prefer examples/)
  for(const adaptation of [memory.responseAdaptation(),await memory.prepareResponseAdaptation('workbench-model')]){
   assert.doesNotMatch(adaptation.memoryContext!.voice,/strict TypeScript/)
   assert.match(adaptation.memoryContext!.voice,/concise answers/);assert.match(adaptation.memoryContext!.voice,/prefer examples/)
   assert.deepEqual(adaptation.replyPreferences.map(entry=>entry.text).sort(),[user,legacy].sort())
   const [userContext,directory]=adaptation.memoryContext!.text.split('Memory directory')
   assert.doesNotMatch(userContext!,/strict TypeScript/);assert.match(directory!,/strict TypeScript/)
  }
  const sources=JSON.stringify(await memory.lookupExplicit({},'workbench-model'))
  assert.ok(!sources.includes(toolQuote));assert.ok(!sources.includes('voice-only secret'))
 }finally{await f.close()}
})

for(const outcome of ['relevant','irrelevant','timeout','failure','revoked'] as const)test(`workbench background memory ${outcome} is bounded, authorized and never user input`,async()=>{
 const events:{kind:string;payload:Readonly<Record<string,JsonValue>>}[]=[]
 const f=await fixture(()=>({text:'done'}),'ask',undefined,undefined,undefined,{record:(kind,payload)=>events.push({kind,payload}),close:()=>undefined})
 try{
  let allowed=true,recalls=0,authorizationChecks=0,recallSignal:AbortSignal|undefined
  const text=outcome==='irrelevant'?'unrelated tea':'TypeScript project constraints'
  const resource:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:(_query,options)=>{
   recalls++;recallSignal=options?.signal
   if(outcome==='timeout')return new Promise(()=>{ /* ignores cancellation to exercise the outer budget */ })
   if(outcome==='failure')return Promise.reject(Error('unavailable'))
   return Promise.resolve({source:'personal',state:'ok',scope:'any',degraded:false,hits:[{memoryId:'project',text,revision:1,evidenceIds:['source'],score:1}]})
  },get:()=>Promise.resolve({memory_scope:'user',id:'project',version:1,status:'active',kind:'fact',origin:'stated',content:text,source_refs:[],observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),topic:'',corrected_to:null,confidence_note:null}),canReadConversationEvidence:(_ref,consumer)=>{authorizationChecks++;assert.equal(consumer,'configured-text-model');return Promise.resolve(allowed)}}
  const retrieval=new UnifiedRetrieval({memory:()=>resource})
  const prepare=retrievalPrerecall(()=>retrieval,()=> 'configured-text-model')
  f.plain.toolBridge={...f.bridge,prerecall:async(query,signal)=>{
   const prepared=await prepare(query,signal)
   if(outcome==='revoked')allowed=false
   return prepared
  }}
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  const start=performance.now()
  await f.host.submitConversationText('chat:main','TypeScript project constraints');await f.host.waitConversation('chat:main')
  assert.ok(performance.now()-start<2000)
  assert.equal(recalls,1)
  const inputs=f.script.requests[0]!.inputs,index=inputs.findIndex(input=>input.kind==='host_context'&&input.content.includes('possible_memory'))
  assert.equal(index>=0,outcome==='relevant')
  if(index>=0){assert.ok(index<inputs.findIndex(input=>input.kind==='user_text'));assert.match(JSON.stringify(inputs[index]),/untrusted_external/)}
  assert.equal((await f.host.workbench.checkpoint('chat:main',0)).last_user,'TypeScript project constraints')
  assert.deepEqual(events,[{kind:'workbench.memory.injected',payload:{injected:outcome==='relevant'}}])
  if(outcome==='timeout')assert.equal(recallSignal?.aborted,true)
  if(['relevant','revoked'].includes(outcome))assert.ok(authorizationChecks>=2,'authorization is rechecked at consumption')
 }finally{await f.close()}
})

for(const mode of ['chat','plan','build'] as const)test(`production ${mode} text memory capture and Workbench authorized retrieval with prerecall flag off`,{skip:mode==='build'&&!supported},async context=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-workbench-memory-'))
 const settings=settingsSchema.parse({executors:[],camera_module_enabled:false,pipeline_mode:'cascaded',cascade_llm_provider:'deepseek',cascade_llm_model:'deepseek-flash',deepseek_api_key:'test',memory_prerecall_enabled:false})
 const consumer=configuredMemoryConsumer(settings,'text'),text='TypeScript project constraints',requests:Record<string,unknown>[]=[],consumers:string[]=[]
 let rememberCalls=0,observedSources=0
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.resolve({source:'personal',state:'ok',scope:'any',hits:[{memoryId:'project',revision:1,text,evidenceIds:['source'],score:1}],degraded:false}),get:()=>Promise.resolve({memory_scope:'user',id:'project',version:1,content:text,kind:'fact',origin:'stated',source_refs:[],observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),topic:'',status:'active',corrected_to:null,confidence_note:null}),canReadConversationEvidence:(_id,recipient)=>{consumers.push(recipient);return Promise.resolve(recipient===consumer)},remember:()=>{rememberCalls++;return Promise.resolve({sourceId:'text',state:'stored'})},observeSource:()=>{observedSources++;return Promise.resolve(null)}}
 const host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 context.mock.method(globalThis,'fetch',(_url:unknown,init?:RequestInit)=>{
  requests.push(JSON.parse(init!.body as string) as Record<string,unknown>)
  return Promise.resolve(new Response('data: '+JSON.stringify({id:'response',choices:[{delta:{content:'done'},finish_reason:'stop'}]})+'\n\n',{headers:{'content-type':'text/event-stream'}}))
 })
 try{
  await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>memory,settings,gateway:{complete:()=>Promise.reject(Error('automatic learning forbidden')),async *stream(){await Promise.reject(Error('automatic learning forbidden'))}},onDiagnostic:()=>undefined}),()=>undefined)
  for(const [method,params] of [['presentation.set',{mode:'workbench'}],['conversations.mode',{id:'chat:main',mode:mode==='chat'?'chat':'plan'}]] as const){const result=await host.command({type:'personal.command',request_id:method,method,params},{client_id:'desktop:local'}) as {ok:boolean};assert.equal(result.ok,true)}
  if(mode==='build'){
   const result=await host.command({type:'personal.command',request_id:'build',method:'build.begin',params:{text,project:root}},{client_id:'desktop:local'}) as {ok:boolean}
   assert.equal(result.ok,true)
  }else await host.submitConversationText('chat:main',text)
  await host.waitConversation(host.conversationSnapshot().selected_id)
  assert.equal(requests.length,1)
  if(mode!=='chat'){
   assert.match(JSON.stringify(requests[0]!.messages),/possible_memory/)
   assert.ok(consumers.length>=2);assert.ok(consumers.every(value=>value===consumer))
   const messages=requests[0]!.messages as {role:string;content:string}[]
   assert.equal(messages[0]!.role,'system')
   assert.match(messages[0]!.content,/scope=general.*scope=user/u)
  }
  assert.equal(rememberCalls,mode==='chat'?1:0)
  assert.equal(observedSources,0)
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})

for(const restart of [false,true])test(`Build Resume drops pending memory without re-retrieval or replacing typed user text (restart=${restart})`,{skip:!supported},async()=>{
 let attempts=0,recalls=0
 const text='Original typed Build goal'
 const f=await fixture(()=>++attempts===1?{failure:{code:'timeout'}}:{text:'resumed'})
 try{
  const memoryText='TypeScript project constraints: private recalled fact'
  f.plain.toolBridge={...f.bridge,prerecall:()=>{recalls++;return Promise.resolve(()=>Promise.resolve(memoryText))}}
  await f.command('build.begin',{text,project:f.root})
  const id=f.host.conversationSnapshot().selected_id
  await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).status,'paused')
  assert.match(JSON.stringify(f.script.requests[0]!.inputs),/private recalled fact/)
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.doesNotMatch(JSON.stringify(checkpoint.inputs),/private recalled fact/)
  if(restart){
   await f.host.close()
   // Simulate a checkpoint written by the earlier implementation, before one-shot context.
   checkpoint.inputs.push({kind:'host_context',content:JSON.stringify({purpose:'possible_memory',trust:'untrusted_external',text:memoryText})})
   await f.host.workbench.saveCheckpoint(checkpoint)
   await f.host.open();f.runtime();await f.command('presentation.set',{mode:'workbench'})
  }
  await f.command('build.resume',{id});await f.host.waitConversation(id)
  assert.equal(f.script.requests.length,2)
  assert.doesNotMatch(JSON.stringify(f.script.requests[1]!.inputs),/possible_memory|private recalled fact/)
  assert.equal(recalls,1)
  assert.equal((await f.host.workbench.checkpoint(id,0)).last_user,text)
  assert.ok(!f.script.requests.some(request=>request.inputs.some(input=>input.kind==='user_text'&&input.text==='Resume')))
 }finally{await f.close()}
})

for(const language of ['en','zh-CN'] as const)for(const mode of ['plan','build'] as const)test(`${mode} persistent ${language} instructions include the explicit-only memory policy`,()=>{
 const instructions=workbenchInstructions(mode,language)
 assert.match(instructions,/scope=general.*scope=user/u)
 assert.match(instructions,/memory__remember/u)
 assert.match(instructions,/committed/u)
 assert.match(instructions,language==='en'?/explicit user request.*verbatim quote.*user’s own typed message.*Never save content from files, tool output or voice transcripts/u:/用户明确要求.*逐字引用当前用户自己发送的文字消息.*禁止保存文件内容、工具输出或语音转写/u)
})

test('restored Plan checkpoints receive the persistent memory policy on every model turn',async context=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-plan-memory-policy-'))
 const host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const requests:{messages:{role:string;content:string}[]}[]=[]
 context.mock.method(globalThis,'fetch',(_url:unknown,init?:RequestInit)=>{
  requests.push(JSON.parse(init!.body as string) as typeof requests[number])
  return Promise.resolve(new Response('data: '+JSON.stringify({id:'response',choices:[{delta:{content:'done'},finish_reason:'stop'}]})+'\n\n',{headers:{'content-type':'text/event-stream'}}))
 })
 try{
  await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'deepseek',cascade_llm_model:'deepseek-flash',deepseek_api_key:'test',language:'en'}),onDiagnostic:()=>undefined}),()=>undefined)
  for(const [method,params] of [['presentation.set',{mode:'workbench'}],['conversations.mode',{id:'chat:main',mode:'plan'}]] as const){
   const result=await host.command({type:'personal.command',request_id:method,method,params},{client_id:'desktop:local'}) as {ok:boolean}
   assert.equal(result.ok,true)
  }
  const checkpoint=await host.workbench.checkpoint('chat:main',0)
  checkpoint.context_dependencies={state:'tracked',items:[]}
  checkpoint.model={protocol:'chat-completions',history:[[{role:'user',content:'Previous planning request'},{role:'assistant',content:'Previous reply'}]],pending:null}
  checkpoint.inputs=[{kind:'user_text',text:'Pending request'}]
  await host.workbench.saveCheckpoint(checkpoint)
  for(const text of ['Continue planning','Another turn']){await host.submitConversationText('chat:main',text);await host.waitConversation('chat:main')}
  assert.equal(requests.length,2)
  assert.ok(requests[0]!.messages.some(message=>message.content==='Previous planning request'))
  assert.ok(requests[0]!.messages.some(message=>message.content==='Pending request'))
  for(const request of requests){
   assert.equal(request.messages[0]!.role,'system')
   assert.match(request.messages[0]!.content,/explicit user request.*scope=general.*scope=user.*verbatim quote/u)
   assert.doesNotMatch(JSON.stringify(request.messages),/"purpose":"memory_scope"/u)
  }
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})

for(const failure of ['timeout','output_limit'] as const)test(`Plan drops pending memory before ${failure==='timeout'?'a new turn':'an automatic output-limit retry'}`,async()=>{
 let attempts=0,recalls=0
 const f=await fixture(()=>++attempts===1?{failure:{code:failure}}:{text:'done'})
 try{
  f.plain.toolBridge={...f.bridge,prerecall:()=>Promise.resolve(++recalls===1?()=>Promise.resolve('one-shot recalled secret'):null)}
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','Plan the project');await f.host.waitConversation('chat:main')
  if(failure==='timeout'){await f.host.submitConversationText('chat:main','Continue');await f.host.waitConversation('chat:main')}
  assert.equal(f.script.requests.length,2)
  assert.match(JSON.stringify(f.script.requests[0]!.inputs),/one-shot recalled secret/)
  assert.doesNotMatch(JSON.stringify(f.script.requests[1]!.inputs),/possible_memory|one-shot recalled secret/)
  assert.equal(recalls,failure==='timeout'?2:1)
 }finally{await f.close()}
})

for(const legacy of [false,true])test(`app-informed Workbench checkpoint persists dependencies and rejects revoked model reuse (${legacy?'legacy':'tracked'})`,async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-workbench-deps-')),path=join(directory,'personal.json'),secret='Synthetic checkpoint app fact L-917'
 const make=()=>new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=make(),runtime:ConversationRuntime|undefined
 const first=scripted(()=>({text:secret})),next=scripted(()=>({text:'Current valid answer'})),rejected=scripted(()=>({text:'Must not run'}))
 const bridge:ConversationRuntime={runTurn:()=>Promise.resolve({assistant:''}),close:()=>Promise.resolve(),toolBridge:{tools:[],readonlyNames:[],origin:()=>Promise.resolve('conversation:1'),invoke:()=>Promise.reject(Error('must not replay tools'))}}
 try{
  await host.open();await host.life.mutate({op:'create',kind:'todo',title:secret},'source')
  const row=host.life.snapshot().todos[0]!,at=new Date().toISOString(),conversation={id:'chat:main',kind:'chat' as const,mode:'plan' as const,title:'Plan',subject_key:null,coding_target:null,created_at:at,updated_at:at,generation:0,messages:[{id:'user',conversation_id:'chat:main',role:'user' as const,text:'Previous question',created_at:at},{id:'answer',conversation_id:'chat:main',role:'assistant' as const,text:secret,context_dependencies:{state:'tracked' as const,items:[{kind:'app_record' as const,section:'todos' as const,id:row.id,version:row.version}]},created_at:at}],feed_ids:[],prepared:null,read_through_id:null}
  const open=(factory:CascadedLlmFactory)=>createWorkbenchRuntime({conversation,host,factory,contextConsumer:null,createBridge:()=>Promise.resolve(bridge),emit:()=>{/* local */},lifetime:new AbortController().signal,language:'en',approval:'never'})
  runtime=await open(first.factory);const result=await runtime.runTurn('Plan from report',new AbortController().signal)
  assert.equal(result.assistant,secret);assert.ok(JSON.stringify(first.requests).includes(secret))
  const checkpoint=await host.workbench.checkpoint(conversation.id,0)
  assert.deepEqual(checkpoint.context_dependencies,result.context_dependencies)
  await runtime.close();runtime=undefined;await host.close();host=make();await host.open()
  runtime=await open(next.factory);await runtime.runTurn('Continue authorized plan',new AbortController().signal)
  assert.equal(next.restores.length,1,'valid model state survives restart')
  assert.equal(next.requests.length,1)
  await runtime.close();runtime=undefined
  const saved=await host.workbench.checkpoint(conversation.id,0)
  saved.calls.push({id:'already-executed',name:'file_write',arguments:{path:'evidence.txt'},state:'completed',result:{status:'ok'}})
  saved.pending_calls=[saved.calls.at(-1)!]
  if(legacy)delete saved.context_dependencies
  await host.workbench.saveCheckpoint(saved)
  await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed app authority'},'revoke')
  await host.close();host=make();await host.open();runtime=await open(rejected.factory)
  await assert.rejects(runtime.runTurn('Resume old plan',new AbortController().signal),/context_authorization_changed/)
  assert.equal(rejected.restores.length,0);assert.equal(rejected.requests.length,0,'no revoked model/inputs reach the actual model port')
  const withheld=await host.workbench.checkpoint(conversation.id,0)
  assert.equal(withheld.reason,'context_authorization_changed')
  assert.deepEqual(withheld.calls,saved.calls);assert.deepEqual(withheld.pending_calls,saved.pending_calls,'tool receipts survive invalidation without replay/reset')
  assert.deepEqual(withheld.model,saved.model,'private model checkpoint remains locally preserved')
 }finally{await runtime?.close();await host.close();await rm(directory,{recursive:true,force:true})}
})

test('owned legacy no-app Workbench checkpoint remains resumable without dependency fields',async()=>{
 const f=await fixture(()=>({text:'Independent plan reply'}),'never')
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','Independent planning request','legacy-user');await f.host.waitConversation('chat:main')
  const checkpoint=await f.host.workbench.checkpoint('chat:main',0)
  delete checkpoint.context_dependencies;await f.host.workbench.saveCheckpoint(checkpoint)
  await f.host.close();await f.host.open();f.runtime()
  await f.host.submitConversationText('chat:main','Continue unrelated plan','legacy-resume');await f.host.waitConversation('chat:main')
  assert.equal(f.script.requests.length,2)
  assert.equal(f.script.restores.length,1)
  assert.deepEqual((await f.host.workbench.checkpoint('chat:main',0)).context_dependencies,{state:'tracked',items:[]})
 }finally{await f.close()}
})

test('unverifiable legacy Workbench model text is not treated as an empty dependency set',async()=>{
 const f=await fixture(()=>({text:'Independent planning reply'}),'never')
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','Owned planning request','first');await f.host.waitConversation('chat:main')
  const checkpoint=await f.host.workbench.checkpoint('chat:main',0)
  delete checkpoint.context_dependencies;checkpoint.model={unknown_history:'Unattributed synthetic app fact'}
  await f.host.workbench.saveCheckpoint(checkpoint);await f.host.close();await f.host.open();f.runtime()
  await f.host.submitConversationText('chat:main','Do not reconstruct unknown text','next');await f.host.waitConversation('chat:main')
  assert.equal(f.script.requests.length,1);assert.equal(f.script.restores.length,0)
  assert.equal((await f.host.workbench.checkpoint('chat:main',0)).reason,'context_authorization_changed')
 }finally{await f.close()}
})

for(const scenario of ['revoked','valid','no-app','legacy'] as const)test(`confirmed Plan provenance follows a fresh empty-history Build (${scenario})`,{skip:!supported},async()=>{
 const secret='Synthetic confirmed app plan L-917'
 const f=await fixture((request,step)=>request.tools.some(tool=>tool.name==='finish_build')?{text:'Build checked current context'}:step===0?{call:{name:'publish_plan',arguments:{title:'Versioned plan',content:secret}}}:{text:'Plan ready'},'never')
 try{
  await f.host.life.mutate({op:'create',kind:'todo',title:secret},'source')
  const row=f.host.life.snapshot().todos[0]!
  if(scenario!=='no-app'){
   await f.host.close()
   const {PersonalStore}=await import('../src/personal-agent/store.js'),store=new PersonalStore(join(f.root,'personal.json')),state=await store.read(),at=new Date().toISOString()
   state.conversations.items[0]!.messages=[{id:'report-user',conversation_id:'chat:main',role:'user',text:'Review app source',created_at:at},{id:'report-answer',conversation_id:'chat:main',role:'assistant',text:secret,context_dependencies:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},created_at:at}]
   await store.write(state);await f.host.open();f.runtime()
  }
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main',scenario==='no-app'?'Publish the complete plan: '+secret:'Publish the complete plan','plan');await f.host.waitConversation('chat:main')
  const reference=f.host.conversationSnapshot().items.find(item=>item.id==='chat:main')!.plan!
  let plan=await f.host.workbench.plan(reference.id,reference.version)
  assert.deepEqual(plan.context_dependencies,scenario==='no-app'?{state:'tracked',items:[]}:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]})
  assert.ok(JSON.stringify(f.script.requests).includes(secret),'actual Plan request/publication chain carries synthetic plan text')
  if(scenario==='valid'){const firstVersion=plan.version;const edited=await f.host.publishPlan('chat:main',0,plan.title,plan.content+'\nUser clarification');assert.equal(edited.id,plan.id);assert.equal(edited.version,firstVersion+1);assert.deepEqual(edited.context_dependencies,plan.context_dependencies);assert.deepEqual((await f.host.workbench.plan(plan.id,firstVersion)).context_dependencies,plan.context_dependencies);plan=edited}
  if(scenario==='legacy'){
   delete plan.context_dependencies;await f.host.workbench.savePlan(plan)
   const checkpoint=await f.host.workbench.checkpoint('chat:main',0);delete checkpoint.context_dependencies;await f.host.workbench.saveCheckpoint(checkpoint)
  }
  if(scenario==='revoked'||scenario==='legacy')await f.host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed source'},'revoke')
  const count=f.script.requests.length
  await f.command('build.start',{id:'chat:main',plan_id:plan.id,version:plan.version,project:f.root})
  const id=f.host.conversationSnapshot().selected_id;assert.notEqual(id,'chat:main');await f.host.waitConversation(id)
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.ok(!f.host.conversationSnapshot().messages.some(message=>message.id==='report-answer'),'fresh Build contains no source transcript')
  if(scenario==='valid'||scenario==='no-app'){
   assert.equal(f.script.requests.length,count+1)
   assert.ok(f.script.requests.at(-1)!.workspaceContext?.includes(secret),'actual Build model input receives the authorized confirmed plan')
   assert.deepEqual(checkpoint.context_dependencies,plan.context_dependencies)
  }else{
   assert.equal(f.script.requests.length,count,'no revoked plan reaches any fresh Build model request')
   assert.equal(checkpoint.reason,'context_authorization_changed')
  }
  const retained=await f.host.workbench.plan(plan.id,plan.version)
  assert.equal(retained.content,plan.content);assert.equal(retained.id,plan.id);assert.equal(retained.version,plan.version)
 }finally{await f.close()}
})

for(const scenario of ['manual','no-app','source-backed','revoked-during-preparation','revoked-after-reservation'] as const)test(`external confirmed plan revalidates canonical dependencies before bridge invocation (${scenario})`,async()=>{
 const f=await fixture(()=>({text:'unused'}),'never')
 try{
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  const row=scenario==='source-backed'?await f.host.life.mutate({op:'from_suggestion',kind:'todo',suggestion_id:'source',title:'Private source record',note:'Private plan fact',due:null,todo_id:null,sources:[],provenance_refs:['source:private']},'source'):await f.host.life.mutate({op:'create',kind:'todo',title:'Manual plan record'},'manual')
  const dependencies=scenario==='no-app'?{state:'tracked' as const,items:[]}:{state:'tracked' as const,items:[{kind:'app_record' as const,section:'todos' as const,id:row.id,version:row.version}]}
  const plan=await f.host.publishPlan('chat:main',0,'Delegation plan','Complete local plan text',undefined,dependencies)
  if(scenario==='revoked-during-preparation')f.bridge.origin=async()=>{await f.host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed while preparing'},'change');return 'memory:test-user'}
  if(scenario==='revoked-after-reservation'){const mark=f.host.tasks.markEffectDispatching.bind(f.host.tasks);f.host.tasks.markEffectDispatching=async id=>{await mark(id);await f.host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed after reservation'},'change-reservation')}}
  const result=await f.raw('plans.delegate',{id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'})
  if(scenario==='source-backed'||scenario==='revoked-during-preparation'||scenario==='revoked-after-reservation'){
   assert.equal(result.ok,false);assert.equal(result.error,'context_authorization_changed');assert.equal(f.invocations.length,0)
   assert.equal(f.host.conversationSnapshot().items[0]!.mode,'plan')
   assert.ok(f.host.tasks.list().every(task=>!task.work_ids.length),'authorization denial cannot claim external delivery')
   if(scenario==='revoked-after-reservation')for(const task of f.host.tasks.list()){assert.equal(task.waiting_reason,'plan_delegation_refused');assert.equal(f.host.tasks.pendingEffect(task.id),null)}
  }else{
   assert.equal(result.ok,true);assert.equal(f.invocations.length,1)
   assert.ok(f.host.tasks.list().some(task=>task.work_ids.length===1))
   assert.ok(!JSON.stringify(f.invocations).includes('context_dependencies'),'executor tool arguments contain no provenance/guard callback')
  }
  assert.equal((await f.host.workbench.plan(plan.id,plan.version)).content,plan.content)
 }finally{await f.close()}
})

for(const receiver of ['build-a','build-b'])test(`confirmed source-backed plan uses the actual Build recipient (${receiver})`,{skip:!supported},async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-build-recipient-')),script=scripted(()=>({text:'Current Build result'}))
 const memory={open:()=>Promise.resolve(),close:()=>Promise.resolve(),canReadConversationEvidence:(_ref:string,consumer:string)=>Promise.resolve(consumer==='build-a')} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 const bridge:ConversationRuntime={runTurn:()=>Promise.resolve({assistant:''}),close:()=>Promise.resolve(),toolBridge:{tools:[],readonlyNames:[],origin:()=>Promise.resolve('conversation:1'),invoke:()=>Promise.reject(Error('unused'))}}
 try{
  await host.open()
  host.setConversationRuntime((conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation,host,contextConsumer:receiver,factory:script.factory,createBridge:()=>Promise.resolve(bridge),emit,lifetime:lifetime??new AbortController().signal,language:'en',approval:'never'}),()=>{/* local */})
  for(const [method,params] of [['presentation.set',{mode:'workbench'}],['conversations.mode',{id:'chat:main',mode:'plan'}]] as const){const ack=await host.command({type:'personal.command',request_id:method,method,params},{client_id:'desktop:local'}) as {ok:boolean};assert.equal(ack.ok,true)}
  const row=await host.life.mutate({op:'from_suggestion',kind:'todo',suggestion_id:'source',title:'Receiver-scoped app plan fact',note:'Private source',due:null,todo_id:null,sources:[],provenance_refs:['source:private']},'source')
  const plan=await host.publishPlan('chat:main',0,'Scoped plan','Receiver-scoped app plan fact',undefined,{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]})
  const ack=await host.command({type:'personal.command',request_id:'confirm',method:'build.start',params:{id:'chat:main',plan_id:plan.id,version:plan.version,project:directory}},{client_id:'desktop:local'}) as {ok:boolean}
  assert.equal(ack.ok,true);const id=host.conversationSnapshot().selected_id;await host.waitConversation(id)
  assert.equal(script.requests.length,receiver==='build-a'?1:0)
  if(receiver==='build-a')assert.ok(script.requests[0]!.workspaceContext?.includes(plan.content))
  else assert.equal((await host.workbench.checkpoint(id,0)).reason,'context_authorization_changed')
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})

test('a direct Build with no references never reads global context authorization',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_write',arguments:{path:'work.txt',content:'done'}}}:{text:'Verified'},'never')
 try{
  let checks=0
  f.host.contextAuthorizationRevision=()=>{checks++;return Promise.resolve(String(checks))}
  await f.command('build.begin',{text:'Write work.txt',project:f.root})
  const id=f.host.conversationSnapshot().selected_id
  await f.host.waitConversation(id)
  assert.equal(checks,0)
  assert.equal(buildView(f.host,id).status,'completed')
  assert.equal(await readFile(join(f.root,'work.txt'),'utf8'),'done')
 }finally{await f.close()}
})

test('a running Build drops invalidated plan context and continues with durable tool receipts',{skip:!supported},async()=>{
 const secret='Synthetic revoked plan content L-918'
 const f=await fixture(async(request,step)=>{
  if(step===0&&request.workspaceContext?.includes(secret)){
   await revoke()
   return {call:{name:'file_write',arguments:{path:'work.txt',content:'done'},id:'write-once'}}
  }
  return {text:'Continued with available context'}
 },'never')
 let revoke:()=>Promise<unknown>
 try{
  const row=await f.host.life.mutate({op:'create',kind:'todo',title:secret},'create')
  revoke=()=>f.host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed context'},'change')
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  const plan=await f.host.publishPlan('chat:main',0,'Context-bound plan',secret,undefined,{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]})
  await f.command('build.start',{id:'chat:main',plan_id:plan.id,version:plan.version,project:f.root})
  const id=f.host.conversationSnapshot().selected_id
  await f.host.waitConversation(id)
  assert.equal(f.script.requests.length,2)
  assert.doesNotMatch(JSON.stringify(f.script.requests[1]),/L-918|work\.txt/)
  assert.equal(f.script.restores.length,0)
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  assert.equal(checkpoint.status,'completed')
  assert.deepEqual(checkpoint.calls.map(call=>call.id),['write-once'])
  assert.equal(await readFile(join(f.root,'work.txt'),'utf8'),'done')
  await f.host.close();await f.host.open();f.runtime()
  await f.command('build.resume',{id});await f.host.waitConversation(id)
  assert.equal(f.script.requests.length,3)
  assert.doesNotMatch(JSON.stringify(f.script.requests[2]),/L-918/)
  assert.deepEqual((await f.host.workbench.checkpoint(id,0)).calls.map(call=>call.id),['write-once'])
 }finally{await f.close()}
})

test('excluded non-product report does not taint an independent Plan publication, fresh Build or delegation',{skip:!supported},async()=>{
 const excluded='Synthetic retained non-product scheduled report L-917',content='Independent no-app plan: inspect the local project'
 const f=await fixture((request,step)=>request.tools.some(tool=>tool.name==='finish_build')?{text:'Independent Build reply'}:step===0?{call:{name:'publish_plan',arguments:{title:'Independent plan',content}}}:{text:'Independent plan ready'},'never')
 try{
  const context={todos:true,goals:false,tasks:false,memory:false,knowledge:false,search:false}
  const schedule=await f.host.schedules.create('create',{title:'Retained report',goal:'Review todos',acceptance:['Report'],rule:{kind:'daily',timezone:'UTC',time:'09:00'},context},{user_scope:'local-test',source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context})
  const run=await f.host.schedules.runNow('run',schedule.id,1),task=await f.host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:task.control_revision,goal_revision:task.goal_revision}
  await f.host.schedules.bindTask(run.run_id,task.id);await f.host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id)
  const page=await f.host.readAppContext('todos',null,f.host.scheduledRunGrant(run.run_id,new AbortController().signal,null))
  await f.host.tasks.recordDelivery(fence,'report',excluded);await f.host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:report'],criteria:[{index:0,evidence_refs:['task-delivery:report']}]})
  await f.host.schedules.markFinished(run.run_id,{memory_origin:'non_product',outcome:'completed',text:excluded,evidence_refs:page.evidence_refs,consumer:null,published:false})
  await f.host.publishScheduledResult(run.run_id)
  assert.equal(await f.host.scheduledResultAuthorized(run.run_id),false)
  const report=f.host.conversationSnapshot().messages.find(message=>message.schedule_ref?.run_id===run.run_id)!
  assert.equal(report.memory_origin,'non_product');assert.ok(report.text.includes(excluded))
  await f.command('conversations.mode',{id:'chat:main',mode:'plan'})
  await f.host.submitConversationText('chat:main','Publish an independent no-app plan','independent');await f.host.waitConversation('chat:main')
  const reference=f.host.conversationSnapshot().items.find(item=>item.id==='chat:main')!.plan!
  const published=await f.host.workbench.plan(reference.id,reference.version)
  assert.deepEqual(published.context_dependencies,{state:'tracked',items:[]},'host publication preserves actual filtered-input provenance')
  const plan=await f.host.publishPlan('chat:main',0,published.title,published.content+'\nUser clarification')
  assert.equal(plan.version,published.version+1);assert.deepEqual(plan.context_dependencies,published.context_dependencies,'host-only edit fallback also excludes non-product history')
  const count=f.script.requests.length
  await f.command('build.start',{id:'chat:main',plan_id:plan.id,version:plan.version,project:f.root})
  const build=f.host.conversationSnapshot().selected_id;await f.host.waitConversation(build)
  assert.equal(f.script.requests.length,count+1);assert.equal((JSON.parse(f.script.requests.at(-1)!.workspaceContext!) as {confirmed_plan:{content:string}}).confirmed_plan.content,plan.content,'actual fresh Build receives the independent confirmed plan')
  assert.deepEqual((await f.host.workbench.checkpoint(build,0)).context_dependencies,{state:'tracked',items:[]})
  await f.command('plans.delegate',{id:'chat:main',plan_id:plan.id,version:plan.version,executor:'codex'})
  assert.equal(f.invocations.length,1)
  const delegated=f.host.tasks.list().find(task=>task.approved_plan?.id===plan.id)!
  assert.equal(delegated.approved_plan!.content,plan.content);assert.equal(delegated.work_ids.length,1);assert.equal(f.host.tasks.pendingEffect(delegated.id),null)
  const executorInput=approvedPlanWorkOrder({workOrder:'Execute confirmed plan',approvedPlan:delegated.approved_plan!})
  assert.ok(executorInput.includes(plan.content))
  assert.ok(!JSON.stringify(f.script.requests).includes(excluded),'neither actual Plan nor Build model inputs contain the excluded report')
  assert.ok(!JSON.stringify(f.invocations).includes(excluded)&&!executorInput.includes(excluded),'executor inputs contain no excluded report')
  await f.command('conversations.select',{id:'chat:main'})
  assert.ok(f.host.conversationSnapshot().messages.some(message=>message.id===report.id&&message.text.includes(excluded)),'original report remains locally visible')
 }finally{await f.close()}
})

/** Reopens the fixture's host with a Build runtime whose shell process probe is injected. */
async function reopenWithLeftover(f:Awaited<ReturnType<typeof fixture>>,id:string,state:()=>'gone'|'alive'|'unknown',platform:'darwin'|'win32'=process.platform==='win32'?'win32':'darwin'){
 const checkpoint=await f.host.workbench.checkpoint(id,0)
 checkpoint.calls.push({id:'shell-left',name:'shell_execute',arguments:{command:'sleep 1'},state:'completed',result:{status:'completed',exit_code:0,cleanup_confirmed:false},process:{platform,pid:2**30}})
 await f.host.workbench.saveCheckpoint(checkpoint);await f.host.close()
 const host=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const bridge:NonNullable<ConversationRuntime['toolBridge']>={tools:[],readonlyNames:[],origin:()=>Promise.resolve('memory:test-user'),invoke:()=>Promise.resolve(null)}
 const plain:ConversationRuntime={runTurn:()=>Promise.resolve({assistant:'chat'}),close:()=>Promise.resolve(),toolBridge:bridge}
 host.setConversationRuntime(async(conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation,host,factory:f.script.factory,createBridge:()=>Promise.resolve(plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:()=>'never',shell:{processState:state}}),()=>{ /* no renderer */ })
 await host.open();host.setWorkbenchExecutors(['codex'])
 const shown=await host.command({type:'personal.command',request_id:'reopen-workbench',method:'presentation.set',params:{mode:'workbench'}},{client_id:'desktop:local'}) as {ok:boolean};assert.equal(shown.ok,true)
 return host
}

test('a leftover that cannot be verified pauses plainly, and Resume is the acknowledgement that releases it',{skip:!supported},async()=>{
 let calls=0
 const f=await fixture(()=>{calls++;return calls===1?{text:'done'}:calls===2?{call:{name:'file_write',arguments:{path:'after.txt',content:'ok'}}}:{text:'carried on'}},'never')
 const id=await f.build();await f.host.waitConversation(id)
 const host=await reopenWithLeftover(f,id,()=>'unknown')
 try{
  await host.submitConversationText(id,'再改一处',undefined,undefined,{local_desktop:true});await host.waitConversation(id)
  const paused=buildView(host,id)
  assert.equal(paused.status,'paused');assert.equal(paused.reason,'cleanup_unconfirmed');assert.match(paused.reason_detail!,/没法确认「sleep 1」/)
  assert.match(host.conversationSnapshot().messages.at(-1)!.text,/Nova 没法确认「sleep 1」留下的进程是否已退出。你确认没问题后点「继续」，Nova 会接着做。/)
  await assert.rejects(readFile(join(f.root,'after.txt')),{code:'ENOENT'})
  const result=await host.command({type:'personal.command',request_id:'ack',method:'build.resume',params:{id}},{client_id:'desktop:local'}) as {ok:boolean;error?:string};assert.equal(result.ok,true,result.error)
  await host.waitConversation(id)
  assert.equal(buildView(host,id).status,'completed');assert.equal(await readFile(join(f.root,'after.txt'),'utf8'),'ok')
  const left=(await host.workbench.checkpoint(id,0)).calls.find(call=>call.id==='shell-left')!.result as {cleanup_confirmed:boolean;cleanup_acknowledged?:boolean}
  assert.equal(left.cleanup_confirmed,true);assert.equal(left.cleanup_acknowledged,true)
 }finally{await host.close();await f.close()}
})

test('a leftover that is provably alive is never released by Resume',{skip:!supported},async()=>{
 let calls=0
 const f=await fixture(()=>{calls++;return calls===1?{text:'done'}:{call:{name:'file_write',arguments:{path:'after.txt',content:'ok'},id:'w'+calls}}},'never')
 const id=await f.build();await f.host.waitConversation(id)
 const host=await reopenWithLeftover(f,id,()=>'alive')
 try{
  await host.submitConversationText(id,'再改一处',undefined,undefined,{local_desktop:true});await host.waitConversation(id)
  assert.equal(buildView(host,id).reason,'cleanup_unconfirmed');assert.match(host.conversationSnapshot().messages.at(-1)!.text,/还有进程没确认退出/)
  await host.command({type:'personal.command',request_id:'again',method:'build.resume',params:{id}},{client_id:'desktop:local'});await host.waitConversation(id)
  assert.equal(buildView(host,id).reason,'cleanup_unconfirmed');await assert.rejects(readFile(join(f.root,'after.txt')),{code:'ENOENT'})
 }finally{await host.close();await f.close()}
})

test('parallel reads that reacquire the project share one acquisition instead of failing with project_busy',{skip:!supported},async()=>{
 let calls=0,gone=false
 const f=await fixture(()=>{calls++;if(calls===1)return {text:'done'};if(calls===2){gone=true;return {calls:[{name:'file_read',arguments:{path:'a.txt'},id:'ra'},{name:'file_read',arguments:{path:'b.txt'},id:'rb'}]}};return {text:'both read'}},'never')
 await writeFile(join(f.root,'a.txt'),'A');await writeFile(join(f.root,'b.txt'),'B')
 const id=await f.build();await f.host.waitConversation(id)
 const host=await reopenWithLeftover(f,id,()=>gone?'gone':'alive')
 try{
  await host.submitConversationText(id,'读两个文件',undefined,undefined,{local_desktop:true});await host.waitConversation(id)
  const state=await host.workbench.checkpoint(id,0)
  assert.equal(buildView(host,id).status,'completed',JSON.stringify({reason:state.reason}))
  assert.deepEqual(state.calls.filter(call=>call.name==='file_read').map(call=>(call.result as {code?:string}).code),[undefined,undefined])
 }finally{await host.close();await f.close()}
})

test('a denied compound shell command also denies a respelling of its destructive part, and a new message starts clean',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'shell_execute',arguments:{command:'echo x; rm target.txt'},id:'c0'}}:step===1?{call:{name:'shell_execute',arguments:{command:"sh -c 'rm ./target.txt'",cwd:'.'},id:'c1'}}:step===2?{call:{name:'shell_execute',arguments:{command:'rm target.txt'},id:'c2'}}:{text:'ok'})
 try{
  const id=await f.build(),view=await until(()=>buildView(f.host,id),value=>value.status==='awaiting_approval')
  await f.command('build.approve',{id,approval_id:view.approval!.id,approved:false});await f.host.waitConversation(id)
  const paused=await f.host.workbench.checkpoint(id,0)
  assert.equal(paused.reason,'approval_denied');assert.deepEqual(paused.calls.map(call=>(call.result as {status:string}).status),['denied','denied_previously'])
  assert.ok(paused.denied_classes!.some(klass=>klass.startsWith('shell:rm@rel:target.txt')))
  // a new typed message is a new authorization turn: the old denials are not restored
  await f.host.submitConversationText(id,'再试一次',undefined,undefined,{local_desktop:true})
  const asked=await until(()=>buildView(f.host,id),value=>value.status==='awaiting_approval')
  assert.ok(asked.approval)
  await f.command('build.approve',{id,approval_id:asked.approval!.id,approved:false});await f.host.waitConversation(id)
 }finally{await f.close()}
})

test('Resume restores only the denials of the current authorization turn',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step<2?{call:{name:'file_write',arguments:{path:'x.txt',content:'x'},id:'w'+step}}:step===2?{call:{name:'file_write',arguments:{path:'y.txt',content:'y'},id:'w2'}}:{text:'ok'})
 try{
  const id=await f.build(),view=await until(()=>buildView(f.host,id),value=>value.status==='awaiting_approval')
  await f.command('build.approve',{id,approval_id:view.approval!.id,approved:false});await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).reason,'approval_denied')
  const stored=(await f.host.workbench.checkpoint(id,0)).denied_classes!
  assert.equal(stored.length,1);assert.ok(stored[0]!.endsWith('x.txt'))
  await f.command('build.resume',{id})
  const next=await until(()=>buildView(f.host,id),value=>value.status==='awaiting_approval')
  await f.command('build.approve',{id,approval_id:next.approval!.id,approved:true});await f.host.waitConversation(id)
  assert.equal(await readFile(join(f.root,'y.txt'),'utf8'),'y');await assert.rejects(readFile(join(f.root,'x.txt')))
 }finally{await f.close()}
})
