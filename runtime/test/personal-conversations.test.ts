import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ConversationRuntimePool,createConversation} from '../src/personal-agent/conversations.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'

test('conversation pool permits parallel conversations and orders one conversation',async()=>{
 const calls:string[]=[],releases:(()=>void)[]=[]
 const pool=new ConversationRuntimePool(conversation=>Promise.resolve({runTurn:async(text)=>{calls.push(conversation.id+text);await new Promise<void>(resolve=>releases.push(resolve));return {assistant:text}},close:()=>Promise.resolve()}),()=>{ /* no transport in this test */ })
 const a=createConversation('chat','A',null,'a'),b=createConversation('chat','B',null,'b')
 const first=pool.run(a,'1'),second=pool.run(a,'2'),other=pool.run(b,'1')
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['a1','b1'])
 releases.shift()!();await first;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['a1','b1','a2'])
 for(const release of releases)release();await Promise.all([second,other]);await pool.close()
})
test('conversation clear aborts only its own runtime',async()=>{
 const closed:string[]=[]
 const pool=new ConversationRuntimePool(conversation=>Promise.resolve({runTurn:(_text,signal)=>new Promise((resolve,reject)=>{if(conversation.id==='b')resolve({assistant:'B'});else signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})}),close:()=>{closed.push(conversation.id);return Promise.resolve()}}),()=>{ /* no transport in this test */ })
 const a=pool.run(createConversation('chat','A',null,'a'),'1');const rejected=assert.rejects(a,/aborted/)
 await new Promise(resolve=>setImmediate(resolve));await pool.clear('a');await rejected
 assert.deepEqual(await pool.run(createConversation('chat','B',null,'b'),'1'),{assistant:'B'});assert.deepEqual(closed,['a']);await pool.close()
})
test('host persists selection and messages and clears selected conversation only',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-conversations-'))
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 let host=make()
 try{await host.open();host.setConversationRuntime(()=>Promise.resolve({runTurn:text=>Promise.resolve({assistant:'reply '+text}),close:()=>Promise.resolve()}),()=>{ /* no transport in this test */ })
 await host.submitConversationText('chat:main','hello','once')
 await host.submitConversationText('chat:main','hello','once')
 await host.waitConversation('chat:main')
 assert.equal(host.conversationSnapshot().messages.length,2)
 const created=await host.command({type:'personal.command',request_id:'create',method:'conversations.create',params:{title:'Second'}}) as {ok:boolean};assert.equal(created.ok,true)
 const second=host.conversationSnapshot().selected_id;await host.submitConversationText(second,'other');await host.waitConversation(second)
 await host.command({type:'personal.command',request_id:'clear',method:'conversations.clear',params:{id:second,expected_generation:0}})
 assert.equal(host.conversationSnapshot().messages.length,0)
 await host.close();host=make();await host.open();assert.equal(host.conversationSnapshot().selected_id,second)
 await host.command({type:'personal.command',request_id:'select',method:'conversations.select',params:{id:'chat:main'}})
 assert.deepEqual(host.conversationSnapshot().messages.map(m=>m.text),['hello','reply hello'])
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('production scoped graph completes a real text adapter turn without closing global host',async()=>{
 const {conversationRuntimeFactory}=await import('../src/personal-agent/conversation-runtime.js')
 const {settingsSchema}=await import('../src/config/config.js')
 const {buildCascadedTextProvider}=await import('../src/cascaded-text-provider.js')
 const {cascadedProviderRegistries}=await import('../src/composition/cascaded-realtime-assembly.js')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-conversation-graph-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const factory=conversationRuntimeFactory({host,memory:()=>undefined,
  settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
  searchTransport:{search:()=>Promise.reject(Error('unexpected search'))},
  gateway:{complete:()=>Promise.reject(Error('unexpected model')),async *stream(){await Promise.resolve();throw Error('unexpected stream')}},
  onDiagnostic:()=>{ /* test diagnostics not user output */ },
  createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({
    async *stream(){await Promise.resolve();yield {kind:'response_started',response_id:'response'};yield {kind:'text_delta',text:'scoped reply'};yield {kind:'response_completed',response_id:'response'}},
    restoreHistory:()=>Promise.resolve(),abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
  })})}}),
 });const runtime=await factory(createConversation('chat','A'),()=>{ /* no renderer */ });
 try{const result=await runtime.runTurn('hello',AbortSignal.timeout(5000));assert.equal(result.assistant,'scoped reply');assert.match(result.turn_id??'',/:assistant:cascaded-response-1-1$/)}finally{await runtime.close()}
 const result=await host.command({type:'personal.command',request_id:'still-open',method:'state',params:{}}) as {ok:boolean};assert.equal(result.ok,true)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('voice belongs to one conversation while other conversations still accept text',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-conversation-voice-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const audio:string[]=[],modes:string[]=[]
 try{await host.open();host.setConversationRuntime((conversation,_emit,mode)=>{modes.push(mode??'text');return Promise.resolve({runTurn:text=>Promise.resolve({assistant:text}),sendAudio:()=>{audio.push(conversation.id);return Promise.resolve()},close:()=>Promise.resolve()})},()=>{ /* no renderer */ })
 const command=(id:string,enabled:boolean)=>host.command({type:'personal.command',request_id:crypto.randomUUID(),method:'conversations.voice',params:{id,enabled}}) as Promise<{ok:boolean}>
 assert.equal((await command('chat:main',true)).ok,true)
 await assert.rejects(host.submitConversationText('chat:main','blocked'),/voice_active/)
 assert.equal((await command('chat:proactive',true)).ok,false)
 await host.sendConversationAudio('chat:main',new Uint8Array([0,0]));assert.deepEqual(audio,['chat:main'])
 await host.submitConversationText('chat:proactive','allowed');await host.waitConversation('chat:proactive')
 assert.equal((await command('chat:main',false)).ok,true)
 await assert.rejects(host.sendConversationAudio('chat:main',new Uint8Array([0,0])),/voice_not_owned/)
 assert.deepEqual(modes,['voice','text'])
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('scoped approval hides and cannot mutate another conversations head',async()=>{
 const {scopeApprovalController}=await import('../src/personal-agent/approval-scope.js')
 const mutations:string[]=[]
 const view={pending_approval:true,pending_approval_busy:false,pending_approval_id:'p',kind:'command_execution' as const,local_detail:null,operation_summary:'command',expires_at:1,work:{work_id:'other',project:'P',title:'T'},queued:0}
 const broker={view,pending:true,observe:()=>()=>undefined,acceptDecision:()=>{mutations.push('accept');return true},invalidate:()=>{mutations.push('invalidate');return true},hold:()=>{mutations.push('hold');return true},release:()=>{mutations.push('release');return true}}
 const own=scopeApprovalController(broker,v=>v.work?.work_id==='mine')
 assert.equal(own.pending,false);assert.equal(own.view.pending_approval,false)
 assert.equal(own.acceptDecision({approvalId:'p',decision:'accept'}),false);assert.equal(own.invalidate('clear'),false);assert.equal(own.hold(),false);assert.equal(own.release(),false);assert.deepEqual(mutations,[])
 view.work.work_id='mine';assert.equal(own.acceptDecision({approvalId:'p',decision:'accept'}),true);assert.deepEqual(mutations,['accept'])
})

test('cleared runtime emissions are fenced before replacement and busy voice parking preserves work',async()=>{
 const emissions:Record<string,unknown>[]=[],emitters:((frame:Record<string,unknown>)=>void)[]=[]
 let busy=true,closed=0,parked=0
 const pool=new ConversationRuntimePool((_conversation,emit)=>{emitters.push(emit);return Promise.resolve({runTurn:()=>Promise.resolve({assistant:'reply'}),canSwitch:()=>!busy,parkVoice:()=>{parked++;return Promise.resolve()},close:()=>{closed++;return Promise.resolve()}})},frame=>emissions.push(frame))
 const conversation=createConversation('chat','A',null,'a')
 await pool.startVoice(conversation);await pool.stopVoice('a');assert.equal(parked,1);assert.equal(closed,0)
 assert.equal(pool.acceptsText('a'),false);await assert.rejects(pool.run(conversation,'blocked'),/conversation_busy/)
 busy=false;await pool.run(conversation,'now text');assert.equal(closed,1)
 emitters[0]!({type:'caption',text:'old'});emitters[1]!({type:'caption',text:'new'});assert.deepEqual(emissions.map(frame=>frame.text),['new'])
 await pool.clear('a');emitters[1]!({type:'executor.approval'});assert.equal(emissions.length,1);await pool.close()
})

test('playback epoch allocation spans independent conversation registries',async()=>{
 const {PlaybackRegistry}=await import('../src/realtime/playback.js')
 let epoch=0
 const options={idFactory:()=>crypto.randomUUID(),nextGenerationEpoch:()=>++epoch,onFrame:()=>{ /* no audio device */ },onClear:()=>{ /* no audio device */ }}
 const first=new PlaybackRegistry(options),second=new PlaybackRegistry(options)
 assert.equal(first.openResponse({sessionEpoch:1,responseId:'a'}).generation_epoch,1)
 assert.equal(second.openResponse({sessionEpoch:1,responseId:'b'}).generation_epoch,2)
})
