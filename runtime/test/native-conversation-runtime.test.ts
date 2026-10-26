import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {SuggestionPool} from '../src/core/suggestions.js'
import {settingsSchema} from '../src/config/config.js'
import {conversationRuntimeFactory} from '../src/personal-agent/conversation-runtime.js'
import {createConversation} from '../src/personal-agent/conversations.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {realtimeCapabilities} from '../src/realtime/capabilities.js'
import type {RealtimeProvider,HostContextItem} from '../src/realtime/protocol.js'
import {RealtimeService} from '../src/realtime/service.js'

for(const boundary of ['idle','playing','disconnect'] as const)test(`native conversation ${boundary}: capabilities, no context injection, and explicit fresh close`,{timeout:5000},async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-native-runtime-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let closes=0,connects=0,audioFrames=0
 let release!:()=>void
 const active=new Promise<void>(resolve=>{release=resolve})
 const unsupported=()=>Promise.reject(Error('unsupported operation invoked'))
 const provider:RealtimeProvider={capabilities:realtimeCapabilities['sglang-personaplex'],
  connect:({tools})=>{connects++;assert.deepEqual(tools,[]);return Promise.resolve({epoch:connects,provider_session_id:'native'})},
  sendAudio:()=>Promise.resolve(),injectHostItem:unsupported,createResponse:unsupported,cancelResponse:unsupported,
  async *events(signal){await active;if(boundary!=='idle'){yield {kind:'response_started',session_epoch:1,response_id:'r',origin:{kind:'unknown'}};yield {kind:'response_audio_delta',session_epoch:1,response_id:'r',pcm:new Uint8Array(640)}}await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})});yield* []},
  close:()=>{closes++;return Promise.resolve()},
 }
 try{
  await host.open()
  const frames:Record<string,unknown>[]=[]
  const conversation=createConversation('chat','Native');conversation.prepared={trust:'untrusted_external',text:'context',evidence_refs:[]}
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,pipeline_mode:'integrated',integrated_provider:'personaplex'}),onAudioFrame:()=>{audioFrames++},createVoiceProvider:()=>provider,searchTransport:{search:unsupported}})
  const runtime=await factory(conversation,frame=>{frames.push(frame)},'voice')
  try{
   assert.deepEqual(runtime.capabilities,provider.capabilities)
   assert.ok(runtime.bridgeService instanceof RealtimeService)
   const suggestion=host.options.pool.add({origin:'surrogate',kind:'notify',content:{summary:'Ready'},salience:40,expires_at:1e15})
   runtime.bridgeService.onSuggestionSelected(suggestion,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:suggestion.id})
   assert.deepEqual(runtime.bridgeService.queuedHostItems(),[],'an active native session never queues unsupported announcements')
   assert.ok(frames.some(frame=>frame.type==='conversation.capabilities'&&frame.conversation_id===conversation.id&&frame.conversation_generation===conversation.generation))
   release()
   if(boundary!=='idle'){
    for(let count=0;count<50&&audioFrames===0;count++)await new Promise(resolve=>setTimeout(resolve,10))
    assert.ok(audioFrames>0,'actual native response reaches playback')
   }
   if(boundary==='disconnect'){
    await assert.rejects(runtime.bridgeService.discardInputAudio(),/native_session_requires_restart/)
    assert.equal(connects,1,'disconnect must not silently open a replacement')
   }else await runtime.parkVoice?.()
   assert.ok(closes>0)
  }finally{await runtime.close()}
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

for(const provider of ['minicpm-o','personaplex'] as const)test(`${provider} orb reminders do not open a hidden voice session`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-native-announcement-')),pool=new SuggestionPool()
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool,evidence:()=>null})
 let starts=0
 try{
  await host.open()
  host.setConversationRuntime(conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,pipeline_mode:'integrated',integrated_provider:provider}),createVoiceProvider:()=>{starts++;throw Error('unexpected_native_announcement')}}),()=>{ /* no renderer */ })
  await host.command({type:'personal.command',request_id:'orb',method:'presentation.set',params:{mode:'orb'}})
  const suggestion=pool.add({origin:'surrogate',kind:'notify',content:{summary:'Ready'},salience:40,expires_at:1e15})
  host.routePersonalSuggestion(suggestion,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:suggestion.id})
  for(let tick=0;tick<10;tick++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(starts,0,'unsupported announcements must not even connect the native provider')
  assert.equal(host.sourceProcessingForegroundBusy(),false)
  assert.equal(host.conversationSnapshot().voice_id,null)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

for(const mode of ['chat','plan','build'] as const)test(`${mode} voice factory injects bounded handoff context and workbench tools are unavailable`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-voice-context-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const injected:HostContextItem[]=[]
 let schemas:readonly unknown[]=[]
 let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const provider:RealtimeProvider={
  connect:options=>{schemas=options.tools;return Promise.resolve({epoch:1,provider_session_id:'context-test'})},sendAudio:()=>Promise.resolve(),
  injectHostItem:item=>{injected.push(item);return Promise.resolve()},createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
  async *events(signal){await gate;if(mode!=='chat'){yield {kind:'user_transcript_final',session_epoch:1,item_id:'voice-input',text:'execute work'};yield {kind:'response_started',session_epoch:1,response_id:'forged',origin:{kind:'user_item',item_id:'voice-input'}};yield {kind:'tool_call_ready',session_epoch:1,response_id:'forged',item_id:'forged-item',call_id:'forged-call',name:'task',arguments:{action:'declare',goal:'must not execute'}}}await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})});yield* []},
 }
 try{
  await host.open()
  const conversation=createConversation(mode==='build'?'build':'chat','Context');conversation.mode=mode==='plan'?'plan':'chat'
  if(mode==='plan')conversation.plan={id:'plan',version:3,title:'Current plan'}
  if(mode==='build')conversation.build={project:dir,status:'paused',approval:null,reason:null,log_revision:0,source_conversation_id:'chat:main'}
  conversation.messages=Array.from({length:20},(_,index)=>({id:'m'+index,conversation_id:conversation.id,role:index%2?'assistant' as const:'user' as const,text:'message '+index+'\n'.repeat(1000),created_at:new Date().toISOString()}))
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),createVoiceProvider:()=>provider,searchTransport:{search:()=>Promise.reject(Error('unused'))}})
  const runtime=await factory(conversation,()=>{ /* no renderer */ },'voice')
  try{
   const item=injected.find(item=>item.kind==='dialogue_context'&&(JSON.parse(item.content) as {purpose?:string}).purpose==='conversation_handoff')!
   assert.ok(item);assert.ok([...item.content].length<=4000)
   const content=JSON.parse(item.content) as {summary:string;recent_messages:{text:string}[];state:{mode:string;plan?:{title:string;version:number};build?:{project:string;status:string;pending_approval:boolean}}}
   assert.equal(content.recent_messages.length,12);assert.ok(content.summary);assert.equal(content.state.mode,mode)
   if(mode==='plan')assert.deepEqual(content.state.plan,{title:'Current plan',version:3})
   if(mode==='build')assert.deepEqual(content.state.build,{project:dir,status:'paused',pending_approval:false})
   if(mode!=='chat'){
    assert.deepEqual(schemas,[]);release()
    const service=runtime.bridgeService as RealtimeService
    for(let count=0;count<100&&!service.toolCallAcceptances().length;count++)await new Promise(resolve=>setTimeout(resolve,10))
    const refusal=service.toolCallAcceptances().find(item=>item.call_id==='forged-call')
    assert.ok(refusal);assert.equal(refusal.acceptance.accepted,false);assert.equal(refusal.acceptance.code,'workbench_voice_readonly');assert.equal(host.tasks.list().length,0)
   }
  }finally{release();await runtime.close()}
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

for(const mode of ['plan','build'] as const)test(`${mode} voice fails closed when provider cannot accept context`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-voice-unsupported-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let closed=false
 const provider:RealtimeProvider={capabilities:realtimeCapabilities['sglang-personaplex'],connect:()=>Promise.resolve({epoch:1,provider_session_id:'unsupported'}),sendAudio:()=>Promise.resolve(),injectHostItem:()=>Promise.reject(Error('must not inject')),createResponse:()=>Promise.resolve(),cancelResponse:()=>Promise.resolve(),close:()=>{closed=true;return Promise.resolve()},async *events(signal){await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})});yield* []}}
 try{
  await host.open();const conversation=createConversation(mode==='build'?'build':'chat','Unsupported');conversation.mode=mode==='plan'?'plan':'chat'
  const factory=conversationRuntimeFactory({host,memory:()=>undefined,settings:settingsSchema.parse({executors:[],camera_module_enabled:false,pipeline_mode:'integrated',integrated_provider:'personaplex'}),createVoiceProvider:()=>provider,searchTransport:{search:()=>Promise.reject(Error('unused'))}})
  await assert.rejects(factory(conversation,()=>{ /* no renderer */ },'voice'),/voice_context_unavailable/);assert.equal(closed,true)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
