import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NewsService} from '../src/news/service.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {MemoryEntry,PersonalMemoryResource} from '../src/memory/personal-memory.js'
const now=new Date('2026-11-04T12:00:00Z')
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check())}
const entry=(content:string):MemoryEntry=>({id:'stated',version:1,content,kind:'preference',origin:'stated',source_refs:[],evidence_refs:['evidence:1'],observed_at:now.toISOString(),recorded_at:now.toISOString(),topic:'reading',status:'active',corrected_to:null,confidence_note:null})
test('host seeds lifestyle cues outside Profile from own recent chat, not assistant or old messages, without Life writes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-chat-seed-')),path=join(dir,'state.json')
 const state=initialState(),chat=state.conversations.items[0]!
 chat.messages=[{id:'u',conversation_id:chat.id,role:'user',text:'I enjoy cooking',created_at:now.toISOString()},
  {id:'a',conversation_id:chat.id,role:'assistant',text:'Try sports and music',created_at:now.toISOString()},
  {id:'old',conversation_id:chat.id,role:'user',text:'I enjoy gardening',created_at:new Date(now.getTime()-15*86400000).toISOString()}]
 await new PersonalStore(path).write(state)
 const host=new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>now})
 try{
  await host.open();await until(()=>host.news.snapshot().interests.length>0)
  assert.deepEqual(host.news.snapshot().interests.map(i=>i.text),['Food']);assert.equal(host.news.snapshot().interests_seeded,true)
  assert.equal(host.profileWarmup.snapshot().draft,null,'no Profile generator supplied')
  assert.deepEqual(host.news.pushCandidates(),[]);assert.equal(host.life.snapshot().ideas.length,0);assert.equal(host.life.snapshot().goals.length,0);assert.equal(host.life.snapshot().todos.length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
for(const revoked of [false,true])test(`memory lifestyle seeding re-reads current content and extraction consent (revoked=${revoked})`,async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-memory-seed-'));let reads=0,consentChecks=0,writes=0
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),productSurfaces:true,
  recall:()=>Promise.resolve({source:'personal',state:'empty',scope:'recent',hits:[],degraded:false}),
  list:()=>Promise.resolve({entries:[entry('I like health news')],cursor:null}),
  getMany:ids=>{reads++;return Promise.resolve(ids.map(()=>entry('I like gardening')))},
  canProcessEvidenceMany:ids=>{consentChecks++;return Promise.resolve(revoked&&reads>0?[]:[...ids])},
  observeSource:()=>{writes++;throw Error('news must not write memory')},remember:()=>{writes++;throw Error('news must not write memory')}}
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>memory,evidence:()=>null,now:()=>now})
 try{
  await host.open();await until(()=>reads>0&&consentChecks>1)
  // Allow the queued seed store write to settle without a live RSS/model dependency.
  for(let i=0;i<20&&!host.news.snapshot().interests.length&&!revoked;i++)await new Promise(r=>setTimeout(r,5))
  assert.deepEqual(host.news.snapshot().interests.map(i=>i.text),revoked?[]:['Gardening']);assert.equal(writes,0)
  assert.equal(host.life.snapshot().ideas.length,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('a recall-only memory backend never seeds Feeds',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-nonproduct-seed-'));let reads=0
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),
  recall:()=>Promise.resolve({source:'personal',state:'empty',scope:'recent',hits:[],degraded:false}),
  list:()=>Promise.resolve({entries:[entry('I like health news')],cursor:null}),
  getMany:ids=>{reads++;return Promise.resolve(ids.map(()=>entry('I like gardening')))},
  canProcessEvidenceMany:ids=>Promise.resolve([...ids])}
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>memory,evidence:()=>null,now:()=>now})
 try{
  await host.open();await new Promise(r=>setTimeout(r,300))
  assert.equal(reads,0);assert.deepEqual(host.news.snapshot().interests,[])
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('the compact interests row confirms only added words; resubmitted mined interests stay mined and out of push',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-confirm-'))
 const news=new NewsService({path:join(dir,'news.json'),firstRefreshMs:null,now:()=>now})
 try{
  await news.open();assert.equal(await news.seedInterests(['Food','Travel']),true)
  const shown=news.snapshot().interests.map(i=>i.text)
  await news.configure({enabled:true,explore:true,interests:[...shown,'Chess'],keep_mined:true})
  const byText=Object.fromEntries(news.snapshot().interests.map(i=>[i.text,i.seeded===true]))
  assert.deepEqual(byText,{Food:true,Travel:true,Chess:false})
  assert.equal(news.snapshot().interests_seeded,false)
  await news.configure({enabled:true,explore:true,interests:news.snapshot().interests.map(i=>i.text),keep_mined:true})
  assert.equal(news.snapshot().interests_seeded,false,'Chess is still confirmed after another row save')
  await news.configure({enabled:true,explore:true,interests:shown.filter(t=>t!=='Chess'),keep_mined:true})
  assert.equal(news.snapshot().interests_seeded,true,'only mined interests remain, so push stays closed')
  await news.configure({enabled:true,explore:true,interests:shown})
  assert.equal(news.snapshot().interests_seeded,false,'a settings save without keep_mined confirms what it submits')
 }finally{await news.close();await rm(dir,{recursive:true,force:true})}
})
