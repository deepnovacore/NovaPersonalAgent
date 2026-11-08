import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import type {PersonalAgentHost} from '../src/personal-agent/host.js'

test('identical reused draft advances cache revision without a new publication or timestamp',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:reuse:',provider='fixture',source_id=prefix+'file',id=prefix+'e:one',now='2026-11-01T00:00:00.000Z'
 const process=(q:Record<string,unknown>)=>memoryOperation(db,'source_processing',{prefix,provider,...q})
 try{
  memoryOperation(db,'append_evidence',{id,source_id,source_kind:'file',locator:'synthetic',raw_text:'Synthetic portrait evidence',hash:'v1',observed_at:now,recorded_at:now,trust:'untrusted_external'})
  memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
  const batch=process({action:'claim'}) as {id:string;items:unknown[]},owner={batch_id:batch.id,task_id:'task',run_id:'run'}
  process({action:'bind',...owner});process({action:'read',batch_id:batch.id})
  const draft={about:{text:'Synthetic portrait',refs:[{entry_id:id,version:'v1'}]},work:[],interests:[]}
  const request={action:'publish',...owner,draft,refs:batch.items,products:{projects:[],suggestions:[]}}
  assert.deepEqual(process({...request,expected_revision:0}),{applied:true,revision:1})
  const before=db.prepare('SELECT payload_json FROM processing_publications').get()!.payload_json
  db.prepare("UPDATE processing_batches SET payload_json=json_set(payload_json,'$.created_at','2026-11-02T00:00:00.000Z') WHERE id=?").run(batch.id)
  assert.deepEqual(process({...request,expected_revision:1}),{applied:true,revision:2})
  assert.equal(db.prepare('SELECT count(*) n FROM processing_publications').get()!.n,1)
  assert.equal(db.prepare('SELECT payload_json FROM processing_publications').get()!.payload_json,before)
  assert.equal(JSON.parse(String(db.prepare('SELECT payload_json FROM processing_profiles').get()!.payload_json)).generated_at,JSON.parse(String(before)).generated_at)
  initializeMemory(db)
  assert.equal(db.prepare('SELECT count(*) n FROM processing_publications').get()!.n,1,'startup backfill must not archive the reused cache as a new publication')
  assert.deepEqual(process({...request,expected_revision:2,defer_profile:true}),{applied:true,revision:3})
  assert.equal(db.prepare('SELECT count(*) n FROM processing_publications').get()!.n,1)
 }finally{db.close()}
})
test('prior recipe profile is reported as needing an update without exposing or migrating its content',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:profile-update:',provider='fixture',products=()=>memoryOperation(db,'source_processing',{prefix,provider,action:'products'}) as {profile_needs_update:boolean;draft:unknown;sources:unknown[]}
 const old=JSON.stringify({generation_version:'understanding-v7',draft:{about:{text:'Private previous profile',refs:[]},work:[],interests:[]},refs:[]})
 try{
  assert.equal(products().profile_needs_update,false)
  db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run('personal:other:','old-recipe',1,old)
  assert.equal(products().profile_needs_update,false,'another user scope does not count')
  db.prepare('INSERT INTO processing_profiles VALUES(?,?,?,?)').run(prefix,'old-recipe',1,old)
  const current=products();assert.equal(current.profile_needs_update,true);assert.equal(current.draft,null);assert.deepEqual(current.sources,[])
  assert.equal(db.prepare('SELECT payload_json FROM processing_profiles WHERE prefix=?').get(prefix)?.payload_json,old,'old cache is retained verbatim')
 }finally{db.close()}
})


test('temporary read failure preserves only same-account published display and clears executable products',async()=>{
 const {SourceProcessingAgent}=await import('../src/personal-agent/source-processing-agent.js')
 const {emptyUnderstanding}=await import('../src/personal-agent/understanding-products.js')
 let fail=false,account='first';const published={draft:{about:{text:'Last successful portrait',refs:[{entry_id:'s',version:'v'}]},work:[],interests:[]},generation_version:'understanding-v7',generated_at:'2026-10-18T00:00:00Z',read_only:true as const,unavailable_sources:0,sources:[],projects:[],suggestions:[]}
 const host={options:{memory:()=>({sourceProcessing:()=>fail?Promise.reject(Error('temporary')):Promise.resolve({...emptyUnderstanding(),last_success:published})})},snapshot:()=>({feishu:{account_id:account}}),life:{snapshot:()=>({todos:[],ideas:[],goals:[]})},schedules:{activeRuns:()=>[],terminalRuns:()=>[]}}
 const agent=new SourceProcessingAgent(host as unknown as PersonalAgentHost)
 await agent.reload();assert.deepEqual(agent.profileSnapshot().last_success,published);assert.equal(agent.profileSnapshot().draft,null)
 fail=true;await agent.reload();assert.deepEqual(agent.profileSnapshot().last_success,published);assert.equal(agent.profileSnapshot().status,'failed');assert.deepEqual(agent.snapshot().suggestions,[])
 account='second';agent.setPresentationAccount(account);assert.equal(agent.profileSnapshot().draft,null);assert.equal(agent.profileSnapshot().last_success,undefined);assert.deepEqual(agent.snapshot().suggestions,[]);await agent.reload();assert.equal(agent.profileSnapshot().last_success,null)
})


test('switching accounts clears profile history before reload and after a read failure',async()=>{
 const {SourceProcessingAgent}=await import('../src/personal-agent/source-processing-agent.js')
 const {emptyUnderstanding}=await import('../src/personal-agent/understanding-products.js')
 let account='first',fail=false
 const history=[{draft:{about:{text:'Private first account portrait',refs:[]},work:[],interests:[]},generation_version:'v',generated_at:'2026-10-18T00:00:00Z',read_only:true,unavailable_sources:0,sources:[]}]
 const host={options:{memory:()=>({sourceProcessing:()=>fail?Promise.reject(Error('offline')):Promise.resolve({...emptyUnderstanding(),history,refresh_pending:true})})},snapshot:()=>({feishu:{account_id:account}}),life:{snapshot:()=>({todos:[],ideas:[],goals:[]})},schedules:{activeRuns:()=>[],terminalRuns:()=>[]}}
 const agent=new SourceProcessingAgent(host as unknown as PersonalAgentHost)
 await agent.reload();assert.equal(agent.profileSnapshot().history.length,1)
 account='second';agent.setPresentationAccount(account)
 assert.deepEqual(agent.profileSnapshot().history,[]);assert.equal(agent.profileSnapshot().last_success_at,null);assert.equal(agent.profileSnapshot().status,'idle')
 fail=true;await agent.reload()
 assert.deepEqual(agent.profileSnapshot().history,[]);assert.equal(agent.profileSnapshot().last_success_at,null)
})

for(const invalidation of ['revoke','project'] as const)test(`profile keywords disappear after ${invalidation} invalidates all their references`,()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 const prefix='personal:keyword-filter:',provider='fixture',now='2026-11-01T00:00:00.000Z'
 const process=(q:Record<string,unknown>)=>memoryOperation(db,'source_processing',{prefix,provider,...q}) as {id:string;items:unknown[];draft:{about:{text:string};keywords?:unknown[]}}
 try{
  for(const key of ['about','keyword']){
   const source_id=prefix+key,id=prefix+'e:'+key
   memoryOperation(db,'append_evidence',{id,source_id,source_kind:'file',locator:key,raw_text:'Synthetic '+key+' evidence',hash:'v1',observed_at:now,recorded_at:now,trust:'untrusted_external'})
   memoryOperation(db,'source_grant',{source_id,expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null}})
  }
  const batch=process({action:'claim'}),owner={batch_id:batch.id,task_id:'task',run_id:'run'}
  process({action:'bind',...owner});process({action:'read',batch_id:batch.id})
  const refs=[{entry_id:prefix+'e:keyword',version:'v1'}]
  process({action:'publish',...owner,expected_revision:0,refs:batch.items,draft:{about:{text:'Synthetic portrait',refs:[{entry_id:prefix+'e:about',version:'v1'}]},work:[],interests:[],keywords:[{text:'Testing',refs}]},products:{projects:[{id:'sample-project',name:'Sample',relation:'participating',status:'current',summary:'Test project',as_of:null,refs}],suggestions:[]}})
  assert.equal(process({action:'products'}).draft.keywords?.length,1)
  if(invalidation==='revoke')memoryOperation(db,'source_grant',{source_id:prefix+'keyword',expected_revision:1,grant:{revision:2,scope_revision:0,extraction_provider:null,embedding_provider:null,conversation_providers:[]}})
  else process({action:'correct_project',id:'sample-project',value:'reference'})
  const current=process({action:'products'}).draft
  assert.equal(current.about.text,'Synthetic portrait')
  assert.deepEqual(current.keywords??[],[])
 }finally{db.close()}
})
