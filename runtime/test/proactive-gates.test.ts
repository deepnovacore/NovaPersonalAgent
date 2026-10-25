import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState,type PersonalState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {FeedItem} from '../src/personal-agent/contracts.js'

const HOUR=3600000
// 10:00 in Shanghai on 2026-10-12.
const start=Date.parse('2026-10-12T02:00:00Z')
const ref=(id:string)=>'message:chat:main:'+id
const message=(id:string,text:string,at:number)=>({id,conversation_id:'chat:main',role:'user' as const,text,created_at:new Date(at).toISOString()})
const candidate=(title:string,quotes:{id:string;quote:string}[])=>({title,success_criteria:'每天做一点',cadence:'daily',ask_text:title+'，要不要设为目标？',evidence_refs:quotes.map(q=>({message_id:ref(q.id),quote:q.quote})),memory_refs:[]})
const m1={id:'m1',quote:'想把英语口'},m2={id:'m2',quote:'明天要讨论'}

async function fixture(options:{cap?:number;quiet?:[string,string];candidates:ReturnType<typeof candidate>[]}){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-proactive-gates-')),path=join(dir,'state.json'),store=new PersonalStore(path);let clock=start
 const state=initialState();state.settings={discovery_enabled:true,discovery_interval_minutes:30,timezone:'Asia/Shanghai',quiet_start:options.quiet?.[0]??'00:00',quiet_end:options.quiet?.[1]??'00:00',proactive_daily_cap:options.cap??5}
 state.conversations.items[0]!.messages=[message('m1','我想把英语口语练好，以后每天都练一点',start-HOUR),message('m2','明天要讨论报销',start-HOUR/2)];await store.write(state)
 const pool=new SuggestionPool(),pooled:string[]=[],delivered:string[]=[],add=pool.add.bind(pool)
 pool.add=input=>{const s=add(input);const id=input.content.personal_feed_id;if(typeof id==='string')pooled.push(id);return s}
 let requests=0
 const make=()=>new PersonalAgentHost({path,userScope:'u',pool,memory:()=>undefined,evidence:()=>null,now:()=>new Date(clock),proposeGoals:()=>Promise.resolve(options.candidates)})
 const f={host:make(),store,pooled,delivered,setClock:(v:number)=>{clock=v},
  runtime(){f.host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:''}),deliverSuggestion:s=>{delivered.push(s.content.personal_feed_id as string)},close:()=>Promise.resolve()}),()=>{ /* no renderer */ })},
  async reopen(change:(state:PersonalState)=>void=()=>{ /* unchanged */ }){await f.host.close();const saved=await store.read();change(saved);await store.write(saved);f.host=make();await f.host.open();f.runtime()},
  command:(method:string,params:Record<string,unknown>)=>f.host.command({type:'personal.command',request_id:'r'+(++requests),method,params}) as Promise<{ok:boolean;error?:string}>,
  feed:()=>f.host.snapshot().feed.filter(item=>item.goal_proposal),
  status:(item:FeedItem)=>f.host.notifications.snapshot().deliveries.find(d=>d.title===item.title)?.status,
  orb:()=>f.command('presentation.set',{mode:'orb'}),
  async route(item:FeedItem){const s=pool.add({origin:'surrogate',kind:'notify',content:{summary:item.title,personal_feed_id:item.id},salience:40,expires_at:1e15});pooled.pop();f.host.routePersonalSuggestion(s,{kind:'suggestion_selected',priority:40,routing_class:'ambient',origin:null,selected_suggestion:s.id});for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve))},
  async close(){await f.host.close();await rm(dir,{recursive:true,force:true})}}
 await f.host.open();f.runtime();await f.host.runGoalProposer();return f
}
const two=[candidate('学习英语口语',[m1]),candidate('每天跑步',[m1])]

test('an unadmitted quota-bound feed is neither pooled on orb entry nor deliverable, while the admitted one at exactly the cap still is, and it speaks once after admission',async()=>{
 const f=await fixture({cap:1,candidates:two});try{
  const [first,second]=f.feed().sort((a,b)=>f.status(a)==='accepted'?-1:f.status(b)==='accepted'?1:0) as [FeedItem,FeedItem]
  assert.equal(f.status(first),'accepted','the first card reaches exactly the daily cap');assert.equal(f.status(second),'pending','the second is deferred by the cap')
  f.pooled.length=0;await f.orb()
  assert.deepEqual(f.pooled,[first.id],'only the admitted card enters the announcement pool; the deferred one does not')
  assert.equal(await f.host.canDeliver(first.id),true,'the card that itself reached the cap is not blocked by the cap');assert.equal(await f.host.canDeliver(second.id),false)
  await f.route(second);assert.deepEqual(f.delivered,[],'the deferred card is not spoken');await f.route(first);assert.deepEqual(f.delivered,[first.id])
  f.pooled.length=0;await f.reopen();await f.orb()
  assert.ok(!f.pooled.includes(second.id),'startup recovery does not pool the deferred card either');assert.ok(f.pooled.includes(first.id))
  f.pooled.length=0;f.setClock(start+20*HOUR);await f.host.flushNotifications()
  assert.equal(f.status(second),'accepted','the next local date admits it');assert.deepEqual(f.pooled,[second.id])
  assert.equal(f.host.conversationSnapshot().messages.filter(m=>m.id==='feed:'+second.id).length,1,'one chat message, no duplicate')
  assert.equal(await f.host.canDeliver(second.id),true);f.delivered.length=0;await f.route(second);assert.deepEqual(f.delivered,[second.id],'spoken once after admission')
 }finally{await f.close()}
})

test('task results and priority-100 feeds are not bound to the quota when pooled',async()=>{
 const f=await fixture({cap:1,candidates:two});try{
  const item=f.feed()[0]!,base=(id:string,over:Partial<FeedItem>):FeedItem=>({...structuredClone(item),id,subject_key:'x:'+id,...over})
  await f.reopen(saved=>{saved.feed.push(base('tr',{kind:'task_result'}),base('hi',{priority:100}))})
  f.pooled.length=0;await f.orb()
  assert.ok(f.pooled.includes('tr'));assert.ok(f.pooled.includes('hi'))
 }finally{await f.close()}
})

test('a goal card whose source conversation was cleared is neither sent nor adoptable',async()=>{
 const f=await fixture({quiet:['09:00','11:00'],candidates:[candidate('学习英语口语',[m1])]});try{
  const card=f.feed()[0]!;assert.equal(f.status(card),'pending','the quiet hour defers it')
  assert.equal((await f.command('conversations.clear',{id:'chat:main'})).ok,true)
  f.setClock(start+2*HOUR);await f.host.flushNotifications()
  assert.notEqual(f.status(card),'accepted','not sent after the source is cleared');assert.ok(!f.host.conversationSnapshot().messages.some(m=>m.id==='feed:'+card.id))
  assert.equal((await f.command('feed.action',{id:card.id,action:'adopt_goal',goal_revision:card.goal_proposal!.revision})).error,'stale')
  assert.equal(f.host.life.snapshot().goals.length,0);assert.equal(f.feed()[0]!.lifecycle,'invalidated')
 }finally{await f.close()}
})

test('a goal card citing several messages is invalidated when any one is gone',async()=>{
 const f=await fixture({quiet:['09:00','11:00'],candidates:[candidate('学习英语口语',[m1,m2])]});try{
  const card=f.feed()[0]!;assert.equal(card.goal_proposal!.evidence_refs.length,2)
  await f.reopen(saved=>{const c=saved.conversations.items.find(c=>c.id==='chat:main')!;c.messages=c.messages.filter(m=>m.id!=='m2')})
  f.setClock(start+2*HOUR);await f.host.flushNotifications()
  assert.notEqual(f.status(card),'accepted');assert.equal(f.feed()[0]!.lifecycle,'invalidated')
  assert.equal((await f.command('feed.action',{id:card.id,action:'adopt_goal',goal_revision:card.goal_proposal!.revision})).error,'stale');assert.equal(f.host.life.snapshot().goals.length,0)
 }finally{await f.close()}
})

test('control: an intact source conversation still sends and adopts the goal card',async()=>{
 const f=await fixture({quiet:['09:00','11:00'],candidates:[candidate('学习英语口语',[m1,m2])]});try{
  const card=f.feed()[0]!;f.setClock(start+2*HOUR);await f.host.flushNotifications()
  assert.equal(f.status(card),'accepted');assert.equal((await f.command('feed.action',{id:card.id,action:'adopt_goal',goal_revision:card.goal_proposal!.revision})).ok,true)
  assert.equal(f.host.life.snapshot().goals.length,1)
 }finally{await f.close()}
})
