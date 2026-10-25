import type {CascadedLlmSession} from '../src/realtime/cascaded/llm.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,realpath,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost,type PersonalSources} from '../src/personal-agent/host.js'
import type {CodingTargetPort} from '../src/personal-agent/coding-targets.js'
import type {ConversationTurnContext} from '../src/personal-agent/conversations.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {PersonalStore} from '../src/personal-agent/store.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'

interface Result {ok:boolean;error?:string;data?:{accepted:boolean;conversation_id:string}}
const local={client_id:'desktop:local'}
async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-start-')),turns:{id:string;text:string;context:ConversationTurnContext|undefined}[]=[]
 const fileText='The release checklist is still open for the demo.'
 const entries:PersonalSources['contextEntries']=()=>[{kind:'file',id:'source:f1',version:'1',content:fileText,source_id:'s1',file_id:'f1',root:dir,rel_path:'proj/README.md',role:'document',mtime_ms:Date.now(),priority:2}]
 const sources:PersonalSources={contextEntries:()=>entries(),list:()=>[],command:()=>Promise.resolve(null)}
 const memory={timelineEvidence:()=>Promise.resolve([])} as unknown as PersonalMemoryResource
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null,
  generateTimeline:()=>Promise.resolve({cards:[{category:'Release',title:'Release checklist open',why_now:'It was edited recently',facts:[{text:fileText,quote:'release checklist is still open',ref:'source:f1'}],uncertainty:'',actions:[{label:'Draft a status note',kind:'draft'}],refs:['source:f1']}]})})
 host.setSources(sources)
 await host.open({deferBackground:true})
 host.setConversationRuntime(conversation=>Promise.resolve({runTurn:(text,_signal,context)=>{turns.push({id:conversation.id,text,context});return Promise.resolve({assistant:'ok'})},close:()=>Promise.resolve()}),()=>undefined)
 let n=0
 const start=(params:Record<string,unknown>,request_id?:string,context?:{client_id:string})=>host.command({type:'personal.command',request_id:request_id??'start-'+n++,method:'conversations.start',params},context) as Promise<Result>
 const todo=(title='Prepare release')=>host.life.mutate({op:'create',kind:'todo',title,note:'note'},'todo-'+n++)
 const card=async()=>{await host.refreshTimeline();await host.timeline.refresh();return host.snapshot().timeline.cards[0]!}
 const ids=()=>host.conversationSnapshot().items.map(item=>item.id)
 const workbench=async()=>{const r=await host.command({type:'personal.command',request_id:'presentation',method:'presentation.set',params:{mode:'workbench'}},local) as Result;assert.equal(r.ok,true,r.error)}
 return {dir,host,turns,start,todo,card,ids,workbench,sources,close:async()=>{await host.close();await rm(dir,{recursive:true,force:true})}}
}

test('start creates one conversation whose first message carries the card reference, then selects it',async()=>{
 const f=await fixture()
 try{
  const item=await f.todo(),references=[{kind:'todo' as const,id:item.id,version:item.version}]
  const result=await f.start({title:'Prepare release',text:'Plan the next step',references})
  assert.equal(result.ok,true,result.error)
  const snapshot=f.host.conversationSnapshot(),id=result.data!.conversation_id
  assert.deepEqual(f.ids(),['chat:main',id]);assert.equal(snapshot.selected_id,id)
  const created=snapshot.items.find(value=>value.id===id)!;assert.equal(created.title,'Prepare release');assert.equal(created.mode,'chat')
  await f.host.waitConversation(id)
  assert.equal(f.host.conversationSnapshot().messages[0]!.text,'Plan the next step');assert.deepEqual(f.host.conversationSnapshot().messages[0]!.references,references)
  assert.deepEqual(f.turns.map(turn=>turn.id),[id]);assert.deepEqual(f.turns[0]!.context?.source_todo,item)
  assert.match(f.turns[0]!.context?.prepared?.text??'',/Prepare release/)
  assert.deepEqual(f.host.conversationSnapshot().home_messages,[],'chat:main is not touched')
 }finally{await f.close()}
})

test('start retains goal, todo and timeline references; two todos derive no source todo',async()=>{
 const f=await fixture()
 try{
  const goal=await f.host.life.mutate({op:'create',kind:'goal',title:'Ship v1',success_criteria:'Released'},'goal')
  const g=await f.start({title:'Goal',text:'Plan next',references:[{kind:'goal',id:goal.id,version:goal.version}]});assert.equal(g.ok,true,g.error)
  assert.deepEqual(f.host.conversationSnapshot().messages[0]!.references,[{kind:'goal',id:goal.id,version:goal.version}])
  const brief=await f.card(),timeline={kind:'timeline' as const,id:brief.id,version:brief.version,interaction:'draft' as const}
  const t=await f.start({title:'Brief',text:'Draft it',references:[timeline]});assert.equal(t.ok,true,t.error)
  assert.deepEqual(f.host.conversationSnapshot().messages[0]!.references,[timeline])
  const a=await f.todo('A'),b=await f.todo('B')
  const two=await f.start({title:'Two',text:'Compare',references:[{kind:'todo',id:a.id,version:a.version},{kind:'todo',id:b.id,version:b.version}]});assert.equal(two.ok,true,two.error)
  await f.host.waitConversation(two.data!.conversation_id)
  assert.equal(f.turns.at(-1)!.context?.source_todo,undefined)
 }finally{await f.close()}
})

test('start is idempotent for one request id and conflicts for a different payload',async()=>{
 const f=await fixture()
 try{
  const item=await f.todo(),params={title:'Once',text:'Plan',references:[{kind:'todo',id:item.id,version:item.version}]}
  const first=await f.start(params,'same-request',local),again=await f.start(params,'same-request',local)
  assert.equal(first.ok,true,first.error);assert.deepEqual(again,first)
  assert.equal(f.ids().length,2);await f.host.waitConversation(first.data!.conversation_id);assert.equal(f.turns.length,1)
  const conflict=await f.start({...params,text:'Other'},'same-request',local);assert.equal(conflict.ok,false);assert.equal(f.ids().length,2)
 }finally{await f.close()}
})

test('a retry whose receipt was lost reuses the conversation that already holds the request message',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-start-crash-')),path=join(dir,'personal.json'),runs:string[]=[]
 const open=async()=>{const host=new PersonalAgentHost({path,userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});await host.open();host.setConversationRuntime(conversation=>Promise.resolve({runTurn:()=>{runs.push(conversation.id);return Promise.resolve({assistant:'ok'})},close:()=>Promise.resolve()}),()=>undefined);return host}
 let host=await open()
 try{
  const item=await host.life.mutate({op:'create',kind:'todo',title:'T'},'t'),command={type:'personal.command' as const,request_id:'lost-receipt',method:'conversations.start' as const,params:{title:'Crash',text:'Plan',references:[{kind:'todo',id:item.id,version:item.version}]}}
  const first=await host.command(command,local) as Result;assert.equal(first.ok,true,first.error);await host.waitConversation(first.data!.conversation_id);await host.close()
  // The crash window: the conversation and message are durable but the command receipt is not.
  const store=new PersonalStore(path),state=await store.read();state.receipts={};await store.write(state)
  host=await open();const retry=await host.command(command,local) as Result
  assert.equal(retry.ok,true,retry.error);assert.equal(retry.data!.conversation_id,first.data!.conversation_id)
  assert.equal(host.conversationSnapshot().items.length,2);assert.deepEqual(runs,[first.data!.conversation_id])
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('invalid references fail with a clear error and leave no empty conversation',async()=>{
 const f=await fixture()
 try{
  const item=await f.todo(),ref={kind:'todo' as const,id:item.id,version:item.version},other=await f.todo('Other')
  const wrongVersion=await f.start({title:'x',text:'x',references:[{...ref,version:ref.version+7}]});assert.equal(wrongVersion.ok,false);assert.match(wrongVersion.error??'',/stale_reference/)
  const missingTimeline=await f.start({title:'x',text:'x',references:[{kind:'timeline',id:'nope',version:'1'}]});assert.equal(missingTimeline.ok,false)
  const three=await f.start({title:'x',text:'x',references:[ref,{...ref,id:other.id,version:other.version},{kind:'goal',id:'g',version:1}]});assert.equal(three.ok,false)
  const duplicate=await f.start({title:'x',text:'x',references:[ref,ref]});assert.equal(duplicate.ok,false);assert.match(duplicate.error??'',/duplicate_reference/)
  const none=await f.start({title:'x',text:'x',references:[]});assert.equal(none.ok,false)
  await f.host.life.mutate({op:'update',kind:'todo',id:item.id,expected_version:item.version,status:'cancelled'},'cancel')
  const done=await f.start({title:'x',text:'x',references:[ref]});assert.equal(done.ok,false);assert.match(done.error??'',/stale_reference/)
  assert.deepEqual(f.ids(),['chat:main']);assert.equal(f.turns.length,0)
 }finally{await f.close()}
})

test('a failure after the conversation was created removes it and keeps the previous selection',async context=>{
 const f=await fixture()
 try{
  const item=await f.todo();context.mock.method(f.host,'submitConversationText',()=>Promise.reject(Error('conversation_busy')))
  const result=await f.start({title:'x',text:'x',references:[{kind:'todo',id:item.id,version:item.version}]})
  assert.equal(result.ok,false);assert.equal(result.error,'conversation_busy')
  assert.deepEqual(f.ids(),['chat:main']);assert.equal(f.host.conversationSnapshot().selected_id,'chat:main')
 }finally{await f.close()}
})

test('start without a conversation runtime fails before creating anything',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-start-none-')),host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();const todo=await host.life.mutate({op:'create',kind:'todo',title:'T'},'t')
  const result=await host.command({type:'personal.command',request_id:'no-runtime',method:'conversations.start',params:{title:'x',text:'x',references:[{kind:'todo',id:todo.id,version:todo.version}]}}) as Result
  assert.equal(result.ok,false);assert.equal(host.conversationSnapshot().items.length,1)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('explicit plan with references stays in chat and retains the local workbench guard',async()=>{
 const f=await fixture()
 try{
  const item=await f.todo(),params={title:'Plan it',text:'Plan',references:[{kind:'todo',id:item.id,version:item.version}],mode:'plan'}
  const remote=await f.start(params,undefined,{client_id:'remote:test'});assert.equal(remote.ok,false);assert.equal(remote.error,'local_workbench_required')
  const orb=await f.start(params,undefined,local);assert.equal(orb.ok,false);assert.equal(orb.error,'local_workbench_required')
  assert.deepEqual(f.ids(),['chat:main'])
  await f.workbench()
  const planned=await f.start(params,undefined,local);assert.equal(planned.ok,true,planned.error)
  assert.equal(f.host.conversationSnapshot().items.find(value=>value.id===planned.data!.conversation_id)!.mode,'chat')
  const chat=await f.start({...params,mode:'chat'},undefined,local);assert.equal(chat.ok,true)
  assert.equal(f.host.conversationSnapshot().items.find(value=>value.id===chat.data!.conversation_id)!.mode,'chat')
 }finally{await f.close()}
})

test('a card with prepared references stays in chat even when its project matches',async()=>{
 const f=await fixture()
 try{
  // Probe: the source root and the registered directory can be different spellings of one directory.
  const real=join(f.dir,'real-project'),link=join(f.dir,'link-project');await mkdir(real);await symlink(real,link)
  assert.notEqual(link,real);assert.equal(await realpath(link),real)
  const entries=f.sources.contextEntries!()[0]!;assert.ok('root' in entries)
  f.sources.contextEntries=()=>[{...(entries),root:link}]
  const target=(directory:string,project='Demo App'):Awaited<ReturnType<CodingTargetPort['list']>>[number]=>({workspace_id:'w1',session_id:null,project,title:project,executor:'codex',directory})
  const setTargets=(list:()=>ReturnType<CodingTargetPort['list']>)=>f.host.setCodingTargets({list,validate:()=>Promise.reject(Error('unused')),resolve:()=>Promise.reject(Error('unused'))})
  const brief=await f.card(),ref={kind:'timeline' as const,id:brief.id,version:brief.version,interaction:'draft' as const},params={title:'Brief',text:'Draft it',references:[ref]}
  await f.workbench()
  const modeOf=(result:Result)=>f.host.conversationSnapshot().items.find(value=>value.id===result.data!.conversation_id)!.mode

  // Unavailable targets fall back to chat.
  const unavailable=await f.start(params,undefined,local);assert.equal(unavailable.ok,true,unavailable.error);assert.equal(modeOf(unavailable),'chat')
  // Directory registered under the real spelling matches the symlinked root.
  setTargets(()=>Promise.resolve([target(real)]))
  const matched=await f.start(params,undefined,local);assert.equal(matched.ok,true,matched.error);assert.equal(modeOf(matched),'chat')
  await f.host.waitConversation(matched.data!.conversation_id)
  assert.match(f.host.conversationSnapshot().messages[0]!.text,/\[project: Demo App\]/u)
  // A different directory, an unreadable one and a failing port all stay chat.
  for(const list of [()=>Promise.resolve([target(join(f.dir,'elsewhere'))]),()=>Promise.resolve([target(join(f.dir,'missing-dir'))]),()=>Promise.reject(Error('codex unavailable'))]){
   setTargets(list);const result=await f.start(params,undefined,local);assert.equal(result.ok,true,result.error);assert.equal(modeOf(result),'chat')
  }
  // Two different matching projects are ambiguous: no guess.
  const other=join(f.dir,'other-project');await mkdir(other)
  f.sources.contextEntries=()=>[{...(entries),root:link},{...(entries),id:'source:f1',file_id:'f2',root:other}]
  setTargets(()=>Promise.resolve([target(real),target(other,'Other')]))
  const ambiguous=await f.start(params,undefined,local);assert.equal(ambiguous.ok,true);assert.equal(modeOf(ambiguous),'chat')
  // Explicit chat wins over a match; a non-workbench client never gets Plan automatically.
  f.sources.contextEntries=()=>[{...(entries),root:link}];setTargets(()=>Promise.resolve([target(real)]))
  const explicit=await f.start({...params,mode:'chat'},undefined,local);assert.equal(modeOf(explicit),'chat')
  const remote=await f.start(params,undefined,{client_id:'remote:test'});assert.equal(remote.ok,true);assert.equal(modeOf(remote),'chat')
  // A todo-only reference has no project to match.
  const item=await f.todo();const todoStart=await f.start({title:'T',text:'T',references:[{kind:'todo',id:item.id,version:item.version}]},undefined,local);assert.equal(modeOf(todoStart),'chat')
 }finally{await f.close()}
})

test('a referenced Plan request reaches the real chat adapter with card facts and an untrusted envelope',async()=>{
 const {conversationRuntimeFactory}=await import('../src/personal-agent/conversation-runtime.js')
 const {settingsSchema}=await import('../src/config/config.js'),{VirtualClock}=await import('../src/core/clock.js')
 const {buildCascadedTextProvider}=await import('../src/cascaded-text-provider.js'),{cascadedProviderRegistries}=await import('../src/composition/cascaded-realtime-assembly.js')
 const f=await fixture(),requests:string[]=[]
 const llm:CascadedLlmSession={
  async *stream(input){requests.push(JSON.stringify(input.inputs));await Promise.resolve();yield {kind:'response_started',response_id:'r'};yield {kind:'text_delta',text:'Draft ready'};yield {kind:'response_completed',response_id:'r'}},
  restoreHistory:()=>Promise.resolve(),abandonPendingResponse:()=>Promise.resolve(),close:()=>Promise.resolve()
 }
 try{
  f.host.setConversationRuntime(conversationRuntimeFactory({host:f.host,clock:new VirtualClock(),memory:()=>undefined,
   settings:settingsSchema.parse({executors:[],camera_module_enabled:false,cascade_llm_provider:'qwen',dashscope_api_key:'test'}),
   searchTransport:{search:()=>Promise.reject(Error('unexpected search'))},gateway:{complete:()=>Promise.reject(Error('unexpected model')),async *stream(){await Promise.resolve();throw Error('unused')}},
   createTextProvider:options=>buildCascadedTextProvider(options,{...cascadedProviderRegistries,llm:{...cascadedProviderRegistries.llm,qwen:()=>({open:()=>llm})}})
  }),()=>undefined)
  await f.workbench();const card=await f.todo('The release checklist is still open')
  const started=await f.start({title:'Draft',text:'Write the draft from the reference',mode:'plan',references:[{kind:'todo',id:card.id,version:card.version}]},undefined,local)
  assert.equal(started.ok,true,started.error);await f.host.waitConversation(started.data!.conversation_id)
  assert.ok(requests.length,JSON.stringify(f.host.conversationSnapshot().messages));assert.match(requests.join('\n'),/release checklist is still open/);assert.match(requests.join('\n'),/untrusted_external/)
 }finally{await f.close()}
})
