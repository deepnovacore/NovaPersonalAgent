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
 const {VirtualClock}=await import('../src/core/clock.js');const clock=new VirtualClock()
 const {conversationRuntimeFactory}=await import('../src/personal-agent/conversation-runtime.js')
 const {settingsSchema}=await import('../src/config/config.js')
 const {buildCascadedTextProvider}=await import('../src/cascaded-text-provider.js')
 const {cascadedProviderRegistries}=await import('../src/composition/cascaded-realtime-assembly.js')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-conversation-graph-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();const factory=conversationRuntimeFactory({host,clock,memory:()=>undefined,
  settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
  searchTransport:{search:()=>Promise.reject(Error('unexpected search'))},
  gateway:{complete:()=>Promise.reject(Error('unexpected model')),async *stream(){await Promise.resolve();throw Error('unexpected stream')}},
  onDiagnostic:()=>{ /* test diagnostics not user output */ },
  createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>({
    async *stream(){await Promise.resolve();yield {kind:'response_started',response_id:'response'};yield {kind:'text_delta',text:'scoped reply'};yield {kind:'response_completed',response_id:'response'}},
    restoreHistory:()=>Promise.resolve(),abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve(),
  })})}}),
 });const runtime=await factory(createConversation('chat','A'),()=>{ /* no renderer */ });
 try{
  const service=runtime.bridgeService!;assert.ok(typeof service.submitText==='function')
  const transitions:boolean[]=[]
  const disconnect=service.playbackDisconnected.bind(service)
  service.playbackDisconnected=options=>{transitions.push(options?.resumeDelivery===true);return disconnect(options)}
  for(const mode of ['background','workbench','orb'])await host.command({type:'personal.command',request_id:mode,method:'presentation.set',params:{mode}})
  assert.deepEqual(transitions,[false,true],'foreground restores delivery; workbench/orb switching does not interrupt it')
  const submit=service.submitText.bind(service)
  service.submitText=()=>Promise.reject(Error('synthetic_submit_failed'))
  await assert.rejects(runtime.runTurn('rejected',AbortSignal.timeout(5000)),/synthetic_submit_failed/)
  const switchableAfterFailure=runtime.canSwitch?.()
  service.submitText=submit
  // A real retry also settles the failed implementation's abandoned pending slot before teardown.
  const result=await runtime.runTurn('hello',AbortSignal.timeout(5000))
  assert.equal(switchableAfterFailure,true,'a rejected submit must release the pending turn')
  assert.equal(result.assistant,'scoped reply');assert.match(result.turn_id??'',/:assistant:cascaded-response-1-1$/)
  const {RealtimeService}=await import('../src/realtime/service.js');assert.ok(service instanceof RealtimeService)
  let cleared=0,clearing=Promise.resolve()
  const clear=service.clearConversation.bind(service)
  service.clearConversation=()=>{cleared++;clearing=clear();return clearing}
  service.submitText=()=>Promise.resolve()
  const timed=assert.rejects(runtime.runTurn('never started',new AbortController().signal),{name:'TimeoutError'})
  clock.advanceTo(clock.now()+121);await timed;await clearing
  assert.equal(cleared,1,'a timeout before response_started still installs the provider epoch fence')
  service.submitText=submit
  assert.equal((await runtime.runTurn('retry after timeout',AbortSignal.timeout(5000))).assistant,'scoped reply')

 }finally{await runtime.close()}
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
 await host.command({type:'personal.command',request_id:'hide',method:'presentation.set',params:{mode:'background'}})
 await assert.rejects(host.sendConversationAudio('chat:main',new Uint8Array([0,0])),/presentation_hidden/)
 assert.equal(host.conversationSnapshot().voice_id,'chat:main')
 await host.command({type:'personal.command',request_id:'show',method:'presentation.set',params:{mode:'workbench'}})
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


test('failed voice initialization aborts its lifetime and leaves host text usable',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-voice-init-failure-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const frames:Record<string,unknown>[]=[],lifetimes:AbortSignal[]=[];let lateEmit:(frame:Record<string,unknown>)=>void=()=>{/* assigned by failed factory */}
 try{
  await host.open();host.setConversationRuntime((_conversation,emit,mode,lifetime)=>{
   if(mode==='voice'){lateEmit=emit;lifetimes.push(lifetime!);return Promise.reject(Error('synthetic_voice_init_failed'))}
   return Promise.resolve({runTurn:text=>Promise.resolve({assistant:'Recovered: '+text}),close:()=>Promise.resolve()})
  },frame=>frames.push(frame))
  const result=await host.command({type:'personal.command',request_id:'voice-fails',method:'conversations.voice',params:{id:'chat:main',enabled:true}}) as {ok:boolean;error:string}
  assert.equal(result.ok,false);assert.equal(result.error,'synthetic_voice_init_failed');assert.equal(host.conversationSnapshot().voice_id,null)
  assert.equal(lifetimes[0]?.aborted,true,'host must not retain a failed factory lifetime')
  lateEmit({type:'executor.progress',text:'obsolete runtime'});assert.equal(frames.length,0)
  await host.submitConversationText('chat:main','try text');await host.waitConversation('chat:main')
  assert.equal(host.conversationSnapshot().messages.at(-1)?.text,'Recovered: try text')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('failed text initialization also aborts stale emitters before retry',async()=>{
 const lifetimes:AbortSignal[]=[],emissions:Record<string,unknown>[]=[],emitters:((frame:Record<string,unknown>)=>void)[]=[]
 const pool=new ConversationRuntimePool((_conversation,emit,_mode,lifetime)=>{
  lifetimes.push(lifetime!);emitters.push(emit)
  return lifetimes.length===1?Promise.reject(Error('synthetic_text_init_failed')):Promise.resolve({runTurn:text=>Promise.resolve({assistant:text}),close:()=>Promise.resolve()})
 },frame=>emissions.push(frame))
 const conversation=createConversation('chat','Retry',null,'retry')
 try{
  await assert.rejects(pool.run(conversation,'first'),/synthetic_text_init_failed/)
  assert.equal(lifetimes[0]?.aborted,true)
  emitters[0]!({type:'executor.progress'});assert.equal(emissions.length,0)
  assert.deepEqual(await pool.run(conversation,'second'),{assistant:'second'})
 }finally{await pool.close()}
})


test('presentation policy is validated and never changes conversation or work ownership',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-presence-'))
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{await host.open();await host.rememberWorkOwner('work-a','chat:main','approval-a')
 for(const mode of ['background','orb','workbench']){
  const result=await host.command({type:'personal.command',request_id:mode,method:'presentation.set',params:{mode}}) as {ok:boolean}
  assert.equal(result.ok,true)
  assert.equal((host.snapshot() as unknown as {presentation_mode:string}).presentation_mode,mode)
  assert.equal(host.conversationSnapshot().selected_id,'chat:main');assert.equal(host.workConversation('work-a'),'chat:main')
 }
 const result=await host.command({type:'personal.command',request_id:'bad-mode',method:'presentation.set',params:{mode:'loud'}}) as {ok:boolean}
 assert.equal(result.ok,false)
 assert.equal((host.snapshot() as unknown as {presentation_mode:string}).presentation_mode,'workbench')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('host coding defaults are per conversation and reject changing a busy runtime',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-target-host-'))
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const target={workspace_id:'workspace-a',session_id:'session-a',project:'Alpha',title:'Fix',executor:'codex' as const}
 try{await host.open();
  host.setCodingTargets({list:()=>Promise.resolve([target]),validate:selection=>selection.session_id==='session-a'?Promise.resolve(target):Promise.reject(Error('session_unavailable')),resolve:()=>Promise.reject(Error('unused'))})
  const result=await host.command({type:'personal.command',request_id:'target',method:'conversations.target',params:{id:'chat:main',target:{workspace_id:'workspace-a',session_id:'session-a'}}}) as {ok:boolean};assert.equal(result.ok,true)
  await host.command({type:'personal.command',request_id:'create-b',method:'conversations.create',params:{title:'B'}})
  const items=host.conversationSnapshot().items as unknown as {id:string;coding_target:unknown}[]
  assert.deepEqual(items.find(i=>i.id==='chat:main')?.coding_target,target)
  assert.equal(items.find(i=>i.id===host.conversationSnapshot().selected_id)?.coding_target,null)
  host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'ok'}),canSwitch:()=>false,close:()=>Promise.resolve()}),()=>{ /* no renderer */ })
  await host.submitConversationText('chat:main','start');await host.waitConversation('chat:main')
  const busy=await host.command({type:'personal.command',request_id:'busy',method:'conversations.target',params:{id:'chat:main',target:null}}) as {ok:boolean};assert.equal(busy.ok,false)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('orb announcements use one output runtime without claiming microphone or changing selected chat',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-announcements-')),pool=new SuggestionPool()
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'test',memory:()=>undefined,pool,evidence:()=>null})
 const created:string[]=[],delivered:string[]=[]
 try{await host.open();host.setConversationRuntime((c,_emit,mode)=>{created.push(c.id+':'+mode);return Promise.resolve({runTurn:()=>Promise.resolve({assistant:''}),deliverSuggestion:s=>{delivered.push(s.id)},close:()=>Promise.resolve()})},()=>{ /* no renderer */ })
 const suggestion=pool.add({origin:'surrogate',kind:'notify',content:{summary:'Ready'},salience:40,expires_at:1e15})
 const reason={kind:'suggestion_selected',priority:40,routing_class:'ambient' as const,origin:null,selected_suggestion:suggestion.id}
 await host.command({type:'personal.command',request_id:'mode-w',method:'presentation.set',params:{mode:'workbench'}})
 host.routePersonalSuggestion(suggestion,reason);await new Promise(resolve=>setImmediate(resolve));assert.equal(delivered.length,0)
 await host.command({type:'personal.command',request_id:'mode-o',method:'presentation.set',params:{mode:'orb'}})
 host.routePersonalSuggestion(suggestion,reason);host.routePersonalSuggestion({...suggestion,id:'next'},reason)
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(created,['chat:proactive:voice']);assert.deepEqual(delivered,[suggestion.id,'next'])
 assert.equal(host.conversationSnapshot().selected_id,'chat:main');assert.equal(host.conversationSnapshot().voice_id,null)
 await host.command({type:'personal.command',request_id:'voice-on',method:'conversations.voice',params:{id:'chat:main',enabled:true}})
 await host.command({type:'personal.command',request_id:'voice-off',method:'conversations.voice',params:{id:'chat:main',enabled:false}})
 host.routePersonalSuggestion({...suggestion,id:'after-voice'},reason)
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
 assert.equal(delivered.at(-1),'after-voice');assert.deepEqual(created,['chat:proactive:voice','chat:main:voice','chat:proactive:voice'])
 await host.submitConversationText('chat:proactive','Tell me more');await host.waitConversation('chat:proactive')
 assert.equal(created.at(-1),'chat:proactive:text')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})


test('a failing playback listener cannot prevent another runtime from parking its approvals',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-mode-listeners-'))
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const seen:string[]=[]
 try{await host.open();host.subscribePresentation(()=>{throw Error('playback_failed')});host.subscribePresentation(mode=>{seen.push(mode)})
  const result=await host.command({type:'personal.command',request_id:'hide',method:'presentation.set',params:{mode:'background'}}) as {ok:boolean}
  assert.equal(result.ok,false);assert.deepEqual(seen,['background']);assert.equal(host.presentationMode,'background')
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('Todo source is canonical per submission, survives exact retry, and never leaks into a later turn',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-source-todo-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 const contexts:unknown[]=[]
 try{await host.open();await host.command({type:'personal.command',request_id:'todo',method:'life.mutate',params:{op:'create',kind:'todo',title:'Linked todo',note:''}});const todo=host.life.snapshot().todos[0]!,source={id:todo.id,version:todo.version}
 host.setConversationRuntime(()=>Promise.resolve({runTurn:(_text,_signal,context)=>{contexts.push(context);return Promise.resolve({assistant:'ack'})},close:()=>Promise.resolve()}),()=>{/* no renderer transport */})
 await host.submitConversationText('chat:main','Handle this','source',source);await host.waitConversation('chat:main');await host.submitConversationText('chat:main','Handle this','source',source)
 assert.deepEqual(host.conversationSnapshot().messages[0]!.source_todo,source);assert.deepEqual(contexts,[{source_todo:source}])
 await assert.rejects(host.submitConversationText('chat:main','Handle this','source'),/request_id_conflict/)
 await assert.rejects(host.submitConversationText('chat:main','Handle this','different',{...source,version:source.version+1}),/source_todo_conflict/)
 await host.submitConversationText('chat:main','Unrelated','later');await host.waitConversation('chat:main');assert.deepEqual(contexts[1],{})
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('authenticated task approval retains original ID and routes to retired runtime without presentation exit',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-retired-approval-')),host=new PersonalAgentHost({path:join(dir,'host.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});const decisions:unknown[]=[]
 try{await host.open();host.setConversationRuntime(conversation=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'ack'}),retainTasks:()=>true,approvalDecision:(id,approved)=>{if(conversation.generation!==0)return Promise.reject(Error('not_owned'));decisions.push({id,approved,generation:conversation.generation});return Promise.resolve()},close:()=>Promise.resolve()}),()=>{/* no renderer transport */})
 await host.submitConversationText('chat:main','Start');await host.waitConversation('chat:main');const task=await host.tasks.delegate('task',{conversation_id:'chat:main',conversation_generation:0,goal:'Task',acceptance:[],origin_ref:'conversation:1'});await host.tasks.bindWork({task_id:task.id,goal_revision:0,control_revision:0},'work')
 await host.command({type:'personal.command',request_id:'clear',method:'conversations.clear',params:{id:'chat:main',expected_generation:0}})
 await host.submitConversationText('chat:main','Later');await host.waitConversation('chat:main')
 host.recordTaskApproval('chat:main',0,{pending_approval:true,pending_approval_busy:false,pending_approval_id:'original',kind:'command_execution',local_detail:null,operation_summary:'Run command',expires_at:null,work:{work_id:'work',project:'P',title:'Task'},queued:0})
 assert.equal(host.snapshot().pending_approvals[0]!.task_id,task.id)
 const raw={type:'personal.command',request_id:'approve',method:'conversations.approve',params:{id:'chat:main',approval_id:'original',approved:true}}
 assert.equal((await host.command(raw) as {ok:boolean}).ok,false);const mode=host.presentationMode;assert.equal((await host.command(raw,{client_id:'A'}) as {ok:boolean}).ok,true);assert.deepEqual(decisions,[{id:'original',approved:true,generation:0}]);assert.equal(host.presentationMode,mode)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
