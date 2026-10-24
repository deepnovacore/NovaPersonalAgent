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
import type {RealtimeProvider} from '../src/realtime/protocol.js'

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
   assert.ok(frames.some(frame=>frame.type==='conversation.capabilities'&&frame.conversation_id===conversation.id&&frame.conversation_generation===conversation.generation))
   release()
   if(boundary!=='idle'){
    for(let count=0;count<50&&audioFrames===0;count++)await new Promise(resolve=>setTimeout(resolve,10))
    assert.ok(audioFrames>0,'actual native response reaches playback')
   }
   if(boundary==='disconnect'){
    await assert.rejects(runtime.bridgeService!.discardInputAudio!(),/native_session_requires_restart/)
    assert.equal(connects,1,'disconnect must not silently open a replacement')
   }else await runtime.parkVoice?.()
   assert.ok(closes>0)
  }finally{await runtime.close()}
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
