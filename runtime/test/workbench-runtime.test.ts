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
import {settingsSchema} from '../src/config/config.js'

type Request=Parameters<CascadedLlmSession['stream']>[0]
interface Reply {text?:string;call?:{name:string;arguments:Record<string,JsonValue>;id?:string};calls?:{name:string;arguments:Record<string,JsonValue>;id:string}[]}
function scripted(reply:(request:Request,step:number)=>Reply|Promise<Reply>){
 const requests:Request[]=[],restores:JsonValue[]=[]
 const factory:CascadedLlmFactory={open:()=>{
  let step=0
  return {setHistoryLimits:()=>{ /* scripted model has no trimming */ },checkpoint:()=>({step}),restoreCheckpoint:value=>{restores.push(value);step=(value as {step:number}).step},
   async *stream(request){requests.push(request);const next=await reply(request,step);request.signal.throwIfAborted();yield {kind:'response_started',response_id:'r'+step};const calls=next.calls??(next.call?[{...next.call,id:next.call.id??'c'+step}]:[]);for(const call of calls)yield {kind:'tool_call',item_id:'i'+step+':'+call.id,call_id:call.id,name:call.name,arguments:call.arguments};if(!calls.length)yield {kind:'text_delta',text:next.text??'done'};step++;yield {kind:'response_completed',response_id:'r'+(step-1)}},
   abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
  }
 }}
 return {factory,requests,restores}
}
async function until<T>(read:()=>T,predicate:(value:T)=>boolean):Promise<T>{
 for(let count=0;count<500;count++){const value=read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,10))}throw Error('state wait expired')
}
async function fixture(reply:(request:Request,step:number)=>Reply|Promise<Reply>,approval:'ask'|'never'='ask',factory?:CascadedLlmFactory,computerSession?:Parameters<typeof createWorkbenchRuntime>[0]['computerSession']){
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-loop-')),script=scripted(reply),invocations:{name:string;arguments:Record<string,JsonValue>}[]=[],frames:Record<string,unknown>[]=[]
 const host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const bridge:NonNullable<ConversationRuntime['toolBridge']>={tools:[{name:'monitor',parameters:{type:'object'}},{name:'dispatch',parameters:{type:'object',properties:{executor:{enum:['codex']}}}}],readonlyNames:['monitor'],origin:()=>Promise.resolve('memory:test-user'),invoke:(_text,call,_signal,grant)=>{invocations.push(call);if(call.name!=='dispatch'||!grant)return Promise.resolve({accepted:true});const delegate_id='fixture-work-'+invocations.length;return host.tasks.bindWork(grant.fence,delegate_id).then(()=>({accepted:true,delegate_id}))}}
 const plain:ConversationRuntime={runTurn:()=>Promise.resolve({assistant:'chat'}),close:()=>Promise.resolve(),toolBridge:bridge}
 const runtime=()=>host.setConversationRuntime(async(conversation,emit,_mode,lifetime)=>conversation.kind==='build'||conversation.mode==='plan'?createWorkbenchRuntime({conversation,host,factory:factory??script.factory,createBridge:()=>Promise.resolve(plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval,...(computerSession?{computerSession}:{})}):plain,frame=>frames.push(frame))
 let request=0
 const raw=(method:string,params:Record<string,unknown>={},local=true)=>host.command({type:'personal.command',request_id:'r'+request++,method,params},{client_id:local?'desktop:local':'remote:test'}) as Promise<{ok:boolean;error?:string;data:unknown}>
 const command=async(method:string,params:Record<string,unknown>={})=>{const result=await raw(method,params);if(!result.ok)throw Error(result.error);return result.data}
 await host.open();runtime();host.setWorkbenchExecutors(['codex']);await command('presentation.set',{mode:'workbench'})
 const plan=async(content='完整计划：先读取项目，再完成修改并验证。')=>{await command('conversations.mode',{id:'chat:main',mode:'plan'});return host.publishPlan('chat:main',0,'测试计划',content)}
 const build=async()=>{const p=await plan();await command('build.start',{id:'chat:main',plan_id:p.id,version:p.version,project:root});return host.conversationSnapshot().selected_id}
 return {root,host,script,frames,invocations,bridge,plain,command,raw,plan,build,runtime,close:async()=>{await host.close();await rm(root,{recursive:true,force:true})}}
}
const buildView=(host:PersonalAgentHost,id:string)=>host.conversationSnapshot().items.find(item=>item.id===id)!.build!
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

test('an explicit Chat tool request changes to Plan only after its reply settles and creates no task',{skip:!supported},async()=>{
 const f=await fixture(()=>({text:'Chat reply'}))
 try{
  f.plain.runTurn=async()=>{
   assert.equal(f.host.conversationSnapshot().items[0]!.mode??'chat','chat')
   await f.host.requestPlanModeFromTool('chat:main',0,'enter-plan-call','conversation:origin',()=>true)
   return {assistant:'已切换到 Plan 模式。'}
  }
  await f.host.submitConversationText('chat:main','我们先进入 plan 梳理需求。');await f.host.waitConversation('chat:main')
  await until(()=>f.host.conversationSnapshot().items[0]!.mode==='plan',Boolean)
  assert.equal(f.host.tasks.list().length,0)
  assert.equal(f.host.conversationSnapshot().messages.at(-1)?.text,'已切换到 Plan 模式。')
 }finally{await f.close()}
})

test('Build requires approval before side effects, stops on denial and does not create task or Todo',{skip:!supported},async()=>{
 const f=await fixture((_request,step)=>step===0?{call:{name:'file_write',arguments:{path:'new.txt',content:'批准后写入'}}}:{text:'已完成'})
 try{
  const id=await f.build(),view=await until(()=>buildView(f.host,id),view=>view.status==='awaiting_approval')
  await assert.rejects(readFile(join(f.root,'new.txt')))
  assert.equal((await f.raw('build.approve',{id,approval_id:view.approval!.id,approved:true},false)).ok,false)
  assert.equal((await f.raw('build.approve',{id,approval_id:'stale',approved:true})).ok,false)
  assert.equal((await f.raw('conversations.create',{})).error,'build_stop_required')
  const before=f.host.conversationSnapshot().items.length
  assert.equal((await f.raw('conversations.start',{title:'x',text:'x',references:[{kind:'todo',id:'any-todo',version:1}]})).error,'build_stop_required')
  assert.equal(f.host.conversationSnapshot().items.length,before);assert.equal(f.host.conversationSnapshot().selected_id,id)
  await assert.rejects(f.host.submitConversationText(id,'double',undefined,undefined,{local_desktop:true}),/conversation_busy/)
  await f.command('build.approve',{id,approval_id:view.approval!.id,approved:false});await f.host.waitConversation(id)
  assert.equal(buildView(f.host,id).reason,'approval_denied');await f.command('build.resume',{id});await f.host.waitConversation(id)
  await assert.rejects(readFile(join(f.root,'new.txt')));assert.equal(f.script.requests.length,1)
  await f.host.submitConversationText(id,'请重新写入',undefined,undefined,{local_desktop:true});await f.host.waitConversation(id)
  assert.deepEqual(f.script.requests[1]!.inputs.filter(input=>input.kind==='user_text').map(input=>input.text),['请重新写入'])
  assert.equal(f.host.tasks.list().length,0);assert.equal(f.host.life.snapshot().todos.length,0)
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
  assert.equal(buildView(f.host,id).reason,'approval_denied');assert.equal(f.script.requests.length,1)
 }finally{await f.close();await rm(outside,{recursive:true,force:true})}
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
  assert.equal(messages.find(message=>message.role==='user')?.generation_status,'completed');assert.match(messages.at(-1)!.text,/Resume/);assert.match(messages.at(-1)!.text,new RegExp(reason))
  await writeFile(join(f.root,'once.txt'),'user change')
  await f.command('build.resume',{id});await f.host.waitConversation(id)
  assert.equal(await readFile(join(f.root,'once.txt'),'utf8'),'user change');assert.equal(buildView(f.host,id).status,'completed')
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
  if(step===0)return {call:{name:'computer_click',arguments:{x:1,y:1}}}
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
   {name:'computer_click',arguments:{x:1,y:1}},
   {name:'computer_screenshot',arguments:{}},
   {name:'computer_click',arguments:{x:1,y:1}},
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
  screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
  action:()=>{actions++;return Promise.resolve()},close:()=>{closed++;return Promise.resolve()},
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
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:step===1?{call:{name:'computer_click',arguments:{x:0,y:0}}}:{text:'done'},
 'never',undefined,options=>({
  screenshot:async()=>{
   assert.equal(await options.approve('Connect',{displayId:'fake'}),true);connected=true
   return {media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}
  },action:async()=>{assert.equal(await options.approve('Tap',{}),true);options.acting('computer_click',{x:0,y:0});actions++},close:()=>Promise.resolve(),
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
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:step===1?{call:{name:'computer_click',arguments:{x:0,y:0}}}:{text:'done'},
 'ask',undefined,options=>({
  screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
  action:async()=>{assert.equal(await options.approve('Tap',{}),true)},close:()=>Promise.resolve(),
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
  screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
  action:()=>Promise.resolve(),close:()=>Promise.reject(Error('cleanup_unknown')),
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
   {name:'computer_click',arguments:{x:0,y:0}},
   {name:'computer_click',arguments:{x:0,y:0}},
   {name:'computer_screenshot',arguments:{}},
   {name:'computer_click',arguments:{x:0,y:0}},
  ]
  if(step===3)assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code:string}).code,'observe_required')
  return sequence[step]?{call:sequence[step]}:{text:'resumed'}
 },'never',undefined,options=>({
  screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
  action:async()=>{
   options.acting('computer_click',{x:0,y:0});actions++
   if(actions===1){started=true;await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}));options.signal.throwIfAborted()}
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

test('computer_run releases direct lease before delegation and returns final observation',{skip:!supported,timeout:10000},async()=>{
 let held=false,delegated=0
 const f=await fixture((request,step)=>{
  if(step===0)return {call:{name:'computer_screenshot',arguments:{}}}
  if(step===1)return {call:{name:'computer_run',arguments:{instruction:'inspect fake interface'}}}
  assert.equal(request.inputs.find(input=>input.kind==='tool_result')?.images?.length,1)
  return {call:{name:'finish_build',arguments:{summary:'observed'}}}
 },'never',undefined,()=>({
  screenshot:()=>{held=true;return Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()})},
  action:()=>Promise.resolve(),close:()=>{held=false;return Promise.resolve()},
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 f.bridge.computerRun=()=>{assert.equal(held,false);delegated++;return Promise.resolve({outcome:'ok',verified:false})}
 try{const id=await f.build();await f.host.waitConversation(id);assert.equal(delegated,1);assert.equal(held,false);assert.equal(buildView(f.host,id).status,'finished')}
 finally{await f.close()}
})

test('screen change discards the failed session before the next observation',{skip:!supported,timeout:10000},async()=>{
 let sessions=0,closed=0
 const f=await fixture((_request,step)=>step<2?{call:{name:'computer_screenshot',arguments:{}}}:{text:'observed'},
 'never',undefined,()=>{
  const first=++sessions===1
  return {screenshot:()=>first?Promise.reject(Error('screen_changed')):Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
   action:()=>Promise.resolve(),close:()=>{closed++;return Promise.resolve()}}
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
  screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
  action:()=>Promise.resolve(),close:()=>{closing=true;return gate},
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
  if(step===1){assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {status:string}).status,'outcome_unknown');return {call:{name:'computer_click',arguments:{x:0,y:0}}}}
  if(step===2){assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code:string}).code,'observe_required');return {call:{name:'computer_screenshot',arguments:{}}}}
  if(step===3)return {call:{name:'computer_click',arguments:{x:0,y:0}}}
  return {text:'recovered'}
 },'never')
 let reopened:PersonalAgentHost|undefined
 try{
  const id=await f.build();await f.host.waitConversation(id);await f.host.close()
  const checkpoint=await f.host.workbench.checkpoint(id,0)
  const interrupted={id:'interrupted',name:'computer_click',arguments:{x:0,y:0},state:'running' as const,started_at:new Date().toISOString()}
  checkpoint.status='running';checkpoint.calls.push(interrupted);checkpoint.pending_calls.push(interrupted)
  await f.host.workbench.saveCheckpoint(checkpoint)
  reopened=new PersonalAgentHost({path:join(f.root,'personal.json'),userScope:'local-test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
  const host=reopened;await host.open();host.computerUseState=()=>({enabled:true,direct:true})
  host.setConversationRuntime((conversation,emit,_mode,lifetime)=>createWorkbenchRuntime({conversation,host,factory:f.script.factory,createBridge:()=>Promise.resolve(f.plain),emit,lifetime:lifetime??new AbortController().signal,language:'zh-CN',approval:'never',computerSession:()=>({
   screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
   action:()=>{actions++;return Promise.resolve()},close:()=>Promise.resolve(),
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
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{}}}:step===1?{call:{name:'computer_click',arguments:{x:0,y:0}}}:{text:'stopped'},
 'never',undefined,options=>({
  screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
  action:async()=>{
   assert.equal(await options.approve('Tap',{}),true)
   enabled=false;options.acting('computer_click',{x:0,y:0});writes++
  },close:()=>Promise.resolve(),
 }))
 f.host.computerUseState=()=>({enabled,direct:true})
 try{const id=await f.build();await f.host.waitConversation(id);assert.equal(writes,0);assert.equal(f.frames.some(frame=>frame.type==='computer_use'&&frame.state==='acting'),false)}
 finally{await f.close()}
})

test('successful click allows typing and Enter but requires observation for another click',{skip:!supported,timeout:10000},async()=>{
 const actions:string[]=[]
 const sequence=[
  {name:'computer_screenshot',arguments:{}},
  {name:'computer_click',arguments:{x:0,y:0}},
  {name:'computer_type',arguments:{text:'hello'}},
  {name:'computer_key',arguments:{keys:'Enter'}},
  {name:'computer_click',arguments:{x:0,y:0}},
 ]
 const f=await fixture((request,step)=>{
  if(step===5)assert.equal((request.inputs.find(input=>input.kind==='tool_result')?.output as {code:string}).code,'observe_required')
  return sequence[step]?{call:sequence[step]}:{text:'done'}
 },'never',undefined,()=>({
  screenshot:()=>Promise.resolve({media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}),
  action:(name)=>{actions.push(name);return Promise.resolve()},close:()=>Promise.resolve(),
 }))
 f.host.computerUseState=()=>({enabled:true,direct:true})
 try{
  const id=await f.build();await f.host.waitConversation(id)
  assert.deepEqual(actions,['computer_click','computer_type','computer_key'])
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
  const f=await fixture((_request,step)=>({call:{name:step===0?'computer_screenshot':'computer_click',arguments:step===0?{}:{x:0,y:0}}}),
  'ask',undefined,options=>({
   screenshot:async()=>{
    if(operation==='computer_screenshot'){pending=true;await options.approve('Connect',{});options.signal.throwIfAborted()}
    return {media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString()}
   },
   action:async()=>{pending=true;await options.approve('Tap',{});options.signal.throwIfAborted();options.acting('computer_click',{x:0,y:0});writes++},
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
 const f=await fixture((_request,step)=>step===0?{call:{name:'computer_screenshot',arguments:{application:app.name}}}:step===1?{call:{name:'computer_type',arguments:{text:'test'}}}:{text:'done'},'ask',undefined,options=>({
  screenshot:async application=>{
   assert.equal(application,app.name);observations++
   if(!await options.approve('Connect',{mode:'background',application:app,window:{pid:123,windowId:456}}))throw Error('declined')
   return {media_type:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS00AAAAASUVORK5CYII=',width:1,height:1,captured_at:new Date().toISOString(),native_editor:{role:'AXTextField',value:'今日美食',source:'accessibility'},native_ui:{source:'accessibility',content:Array.from({length:80},()=>({role:'AXStaticText',text:'x'.repeat(300),url:'https://example.test/results'})),truncated:true}}
  },action:async()=>{assert.equal(await options.approve('Input',{value:'test'}),true);actions++},close:()=>Promise.resolve(),
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
  if(decision!=='deny'){const checkpoint=await f.host.workbench.checkpoint(id,0);assert.deepEqual((checkpoint.calls[0]?.result as {native_editor:unknown}).native_editor,{role:'AXTextField',value:'今日美食',source:'accessibility'});assert.equal((checkpoint.calls[0]?.result as {native_ui:{content:{url:string}[]}}).native_ui.content[0]?.url,'https://example.test/results')}
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
   await assert.rejects(reopened.submitConversationText(id,'run again'),/local_build_not_authorized/)
   await reopened.command({type:'personal.command',request_id:'finished-presentation',method:'presentation.set',params:{mode:'workbench'}},{client_id:'desktop:local'})
   const resumed=await reopened.command({type:'personal.command',request_id:'finished-resume',method:'build.resume',params:{id}},{client_id:'desktop:local'}) as {ok:boolean;error?:string}
   assert.equal(resumed.ok,false);assert.equal(resumed.error,'build_finished')
  }finally{await reopened.close()}
 }finally{await f.close()}
})
