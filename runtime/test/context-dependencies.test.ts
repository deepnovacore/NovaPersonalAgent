import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {contextDependenciesSchema,mergeContextDependencies} from '../src/personal-agent/context-dependencies.js'
import {createConversation,conversationMessageSchema} from '../src/personal-agent/conversations.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'

test('context dependency schema is optional, strict, bounded and portable through PersonalStore',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-context-deps-')),store=new PersonalStore(join(directory,'personal.json'))
 try{
  const state=initialState(),message={id:'answer',conversation_id:'chat:main',role:'assistant' as const,text:'Derived app fact',created_at:new Date().toISOString()}
  assert.equal(conversationMessageSchema.parse(message).context_dependencies,undefined)
  const dependencies={state:'tracked' as const,items:[{kind:'app_record' as const,section:'todos' as const,id:'todo',version:1}]}
  state.conversations.items[0]!.messages=[{...message,context_dependencies:dependencies}]
  await store.write(state);assert.deepEqual((await store.read()).conversations.items[0]!.messages[0]!.context_dependencies,dependencies)
  for(const invalid of [{state:'tracked',items:[],extra:true},{state:'tracked',items:[{kind:'app_record',section:'todos',id:'todo',version:-1}]},{state:'unavailable',items:[]}])assert.equal(contextDependenciesSchema.safeParse(invalid).success,false)
  const overflow=mergeContextDependencies({state:'tracked',items:Array.from({length:65},(_,i)=>({kind:'scheduled',run_id:'run-'+i}))})
  assert.deepEqual(overflow,{state:'unavailable'})
  assert.deepEqual(mergeContextDependencies(overflow,dependencies),overflow)
 }finally{await rm(directory,{recursive:true,force:true})}
})

test('unknown legacy descendants inherit app dependencies; standalone legacy chat remains compatible',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-legacy-deps-')),host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();await host.life.mutate({op:'create',kind:'todo',title:'Original app fact'},'todo')
  const row=host.life.snapshot().todos[0]!,conversation=createConversation('chat','History'),at=new Date().toISOString()
  conversation.messages=[{id:'app',conversation_id:conversation.id,role:'assistant',text:'Original app fact',context_dependencies:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},created_at:at},{id:'legacy',conversation_id:conversation.id,role:'assistant',text:'Unmarked legacy answer repeats app fact',created_at:at}]
  assert.equal((await host.productConversation(conversation,null)).messages.length,2)
  await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed app fact'},'change')
  assert.equal((await host.productConversation(conversation,null)).messages.length,0)
  const standalone=createConversation('chat','Standalone');standalone.messages=[{id:'old',conversation_id:standalone.id,role:'assistant',text:'Unrelated legacy reply',created_at:at}]
  assert.equal((await host.productConversation(standalone,null)).messages.length,1)
  conversation.messages.push({id:'overflow',conversation_id:conversation.id,role:'assistant',text:'Untracked overflow must not reenter context',context_dependencies:{state:'unavailable'},created_at:at})
  assert.equal((await host.productConversation(conversation,null)).messages.length,0)
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})

test('product history validates each inherited dependency once per pass',async t=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-history-deps-')),host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();await host.life.mutate({op:'create',kind:'todo',title:'Original app fact'},'todo')
  const row=host.life.snapshot().todos[0]!,conversation=createConversation('chat','History'),at=new Date().toISOString()
  // Every unmarked descendant inherits the app record, so a long chat re-presents the same dependency per message.
  conversation.messages=[{id:'app',conversation_id:conversation.id,role:'assistant',text:'Original app fact',context_dependencies:{state:'tracked',items:[{kind:'app_record',section:'todos',id:row.id,version:row.version}]},created_at:at},
   ...Array.from({length:40},(_,index)=>({id:'legacy-'+index,conversation_id:conversation.id,role:index%2?'assistant' as const:'user' as const,text:'Legacy turn '+index,created_at:at}))]
  const validate=t.mock.method(host.appContext,'validateRecord')
  assert.equal((await host.productConversation(conversation,null)).messages.length,41)
  assert.equal(validate.mock.callCount(),1)
  await host.life.mutate({op:'update',kind:'todo',id:row.id,expected_version:row.version,title:'Changed app fact'},'change')
  assert.equal((await host.productConversation(conversation,null)).messages.filter(message=>message.role==='assistant').length,0,'a fresh pass still sees the changed record')
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})

test('resource replacement cannot reuse a compact token from the same backend owner',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-owner-deps-'))
 const {emptyLifeState}=await import('../src/personal-agent/life.js')
 const state=emptyLifeState(),backend={authorizationRevision:()=>Promise.resolve('stable-owner-token'),peek:()=>Promise.resolve({state,revision:1}),load:()=>Promise.resolve({state,revision:1}),mutate:()=>Promise.reject(Error('unused'))}
 const first:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.reject(Error('unused')),lifeBackend:()=>backend},replacement:PersonalMemoryResource={...{open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.reject(Error('unused'))},lifeBackend:()=>backend}
 let resource:PersonalMemoryResource|undefined
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>resource,pool:new SuggestionPool(),evidence:()=>null})
 try{
  resource=first;await host.open();const original=await host.contextAuthorizationRevision();host.recordConfirmation('ui',{pending_confirmation:false,pending_confirmation_busy:false,workspace_display_name:null,session_title:null})
  assert.equal(await host.contextAuthorizationRevision(),original,'generic UI notifications do not invalidate compact authority')
  resource=replacement
  await assert.rejects(host.contextAuthorizationRevision(),/context_authorization_changed/)
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})

test('source-backed direct records use targeted live evidence checks even without a metadata write',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-temporal-deps-'))
 let allowed=true
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.reject(Error('unused')),canReadConversationEvidence:()=>Promise.resolve(allowed)}
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>memory,pool:new SuggestionPool(),evidence:()=>null})
 try{
  await host.open();const row=await host.life.mutate({op:'from_suggestion',kind:'todo',suggestion_id:'source',title:'Derived record',note:'Synthetic fact',due:null,todo_id:null,sources:[],provenance_refs:['source:temporal']},'source')
  const dependencies={state:'tracked' as const,items:[{kind:'app_record' as const,section:'todos' as const,id:row.id,version:row.version}]}
  assert.equal(host.contextDependenciesCacheable(dependencies),false)
  assert.equal(await host.contextDependenciesAuthorized(dependencies,'consumer'),true)
  allowed=false
  assert.equal(await host.contextDependenciesAuthorized(dependencies,'consumer'),false,'time-only permission changes are not hidden behind a stable revision')
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})

test('versioned plan provenance is optional for local legacy reads and strictly bounded',async()=>{
 const {planSchema}=await import('../src/personal-agent/workbench-store.js')
 const plan={id:'plan',version:1,title:'Plan',content:'User-visible complete plan',conversation_id:'chat:main',generation:0,created_at:new Date().toISOString()}
 assert.equal(planSchema.parse(plan).context_dependencies,undefined)
 assert.deepEqual(planSchema.parse({...plan,context_dependencies:{state:'unavailable'}}).context_dependencies,{state:'unavailable'})
 assert.equal(planSchema.safeParse({...plan,context_dependencies:{state:'tracked',items:Array.from({length:65},(_,i)=>({kind:'scheduled',run_id:'run-'+i}))}}).success,false)
 assert.equal(planSchema.safeParse({...plan,context_dependencies:{state:'tracked',items:[],trusted:true}}).success,false)
})

test('delivery receipts preserve feed context while source invalidation still revokes it',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'nova-feed-receipts-'))
 let at=new Date('2026-11-14T12:00:00Z'),available=true
 const host=new PersonalAgentHost({path:join(directory,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),now:()=>at,
  evidence:ref=>available&&ref==='conversation:1'?{subject_key:ref,source:{type:'conversation',ref}}:null,evidenceRefs:()=>['conversation:1']})
 try{
  await host.open()
  await host.admit({kind:'question',summary:'Reply to the invitation?',why_now:'A reply is due',evidence_refs:['conversation:1'],memory_refs:[]},await host.discoverySnapshot())
  const feed=host.snapshot().feed[0]!,dependencies=host.feedContextDependencies(feed.id)
  assert.equal(await host.contextDependenciesAuthorized(dependencies),true)
  for(const action of ['presented','notified','spoken','open'] as const){
   at=new Date(at.getTime()+1000)
   if(action==='spoken')await host.spoken(feed.suggestion_id!)
   else await host.action({id:feed.id,action})
   assert.equal(await host.contextDependenciesAuthorized(dependencies),true,action+' must not invalidate the next voice turn')
  }
  assert.ok(host.snapshot().feed[0]!.delivery.spoken_at)
  at=new Date(at.getTime()+1000);available=false;await host.revalidate()
  assert.equal(await host.contextDependenciesAuthorized(dependencies),false,'real source withdrawal remains fail-closed')
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})
