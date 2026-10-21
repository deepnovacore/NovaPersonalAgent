import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import type {PersonalAgentHost} from '../src/personal-agent/host.js'

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
