import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState,type PersonalState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {goalTopicKey,groundGoalCandidates,proposeGoals,type GoalProposerInput} from '../src/model/goal-writer.js'
import type {CompleteRequest,ModelGateway} from '../src/model/model-gateway.js'
import type {FeedItem} from '../src/personal-agent/contracts.js'

const DAY=86400000
// 10:00 in Shanghai.
const start=Date.parse('2026-10-12T02:00:00Z')
const ref=(id:string)=>'message:chat:main:'+id
const message=(id:string,text:string,at:number)=>({id,conversation_id:'chat:main',role:'user' as const,text,created_at:new Date(at).toISOString()})
const candidate=(over:Record<string,unknown>={})=>({title:'学习英语口语',success_criteria:'能用英语聊十分钟',cadence:'daily',ask_text:'你最近几次说想练英语口语，要不要设为目标？每天陪你练一点。',evidence_refs:[{message_id:ref('m1'),quote:'想把英语口语练好'}],memory_refs:[],...over})

test('grounding keeps only candidates whose citations exist in the user messages and memories',()=>{
 const input={messages:[{id:ref('m1'),text:'我想把英语口语练好，每天都练',at:''}],memories:[{entry_id:'mem1',version:3,text:'用户在准备雅思'}],blocked_topic_keys:[goalTopicKey('每天跑步')]}
 const kept=groundGoalCandidates([
  candidate({title:'无证据',evidence_refs:[]}),
  candidate({title:'伪造消息',evidence_refs:[{message_id:ref('m9'),quote:'想把英语口语练好'}]}),
  candidate({title:'伪造引文',evidence_refs:[{message_id:ref('m1'),quote:'我要学法语'}]}),
  candidate({title:'伪造记忆',memory_refs:[{entry_id:'mem1',version:2}]}),
  candidate({title:'每天 跑步！'}),
  candidate({memory_refs:[{entry_id:'mem1',version:3}]}),
  candidate({title:'学习英语口语。'}),
  candidate({title:'第二个',cadence:'progress'}),
  candidate({title:'第三个'}),
 ],input)
 assert.deepEqual(kept.map(c=>c.title),['学习英语口语','第二个'],'fabricated or missing citations, blocked topics, duplicates and a third candidate are dropped')
})

test('the generator asks without reasoning, repairs one malformed reply and drops ungrounded output',async()=>{
 const requests:CompleteRequest[]=[]
 const replies=['not json',JSON.stringify({candidates:[candidate(),candidate({title:'别的',evidence_refs:[{message_id:ref('m1'),quote:'编出来的'}]})]})]
 const gateway={complete:(request:CompleteRequest)=>{requests.push(request);return Promise.resolve({text:replies[requests.length-1]})},stream(){throw Error('unused')}} as unknown as ModelGateway
 const input:GoalProposerInput={local_date:'2026-10-12',timezone:'UTC',messages:[{id:ref('m1'),text:'我想把英语口语练好',at:'2026-10-12T00:00:00.000Z'}],memories:[],existing_goals:['写完论文'],declined_topics:['每天跑步'],blocked_topic_keys:[goalTopicKey('写完论文')]}
 const result=await proposeGoals(gateway,'fixture',input,new AbortController().signal)
 assert.equal(requests.length,2);assert.equal(requests[0]!.reasoning,'disabled');assert.ok(requests[0]!.maxTokens);assert.match(requests[1]!.prompt,/上次输出格式无效/u)
 assert.match(requests[0]!.prompt,/写完论文/u);assert.match(requests[0]!.prompt,/每天跑步/u);assert.doesNotMatch(requests[0]!.prompt,/blocked_topic_keys/u)
 assert.deepEqual(result.map(c=>c.title),['学习英语口语'])
})

/** Cites the latest user message that mentions English, as a grounded model would. */
const cite=(input:GoalProposerInput)=>{const m=input.messages.findLast(m=>m.text.includes('英语'))!;return [{message_id:m.id,quote:m.text.slice(0,4)}]}
interface Fixture {host:PersonalAgentHost;store:PersonalStore;calls:GoalProposerInput[];setClock(value:number):void;addMessage(id:string,text:string):Promise<void>;edit(change:(state:PersonalState)=>void):Promise<void>;command(method:string,params:Record<string,unknown>):Promise<{ok:boolean;error?:string;data?:unknown}>;goalFeed():FeedItem[];close():Promise<void>}
async function fixture(options:{proposer?:(input:GoalProposerInput)=>Promise<readonly unknown[]>;settings?:Partial<PersonalState['settings']>}={}):Promise<Fixture>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-goal-proposer-')),path=join(dir,'state.json'),store=new PersonalStore(path);let clock=start
 const state=initialState();state.settings={discovery_enabled:true,discovery_interval_minutes:30,timezone:'Asia/Shanghai',quiet_start:'00:00',quiet_end:'00:00',proactive_daily_cap:5,...options.settings}
 state.conversations.items[0]!.messages=[message('m1','我想把英语口语练好，以后每天都练一点',start-3600000),message('m2','明天要讨论报销',start-1800000)];await store.write(state)
 const calls:GoalProposerInput[]=[];let requests=0
 const make=()=>new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>new Date(clock),proposeGoals:input=>{calls.push(input);return options.proposer?options.proposer(input):Promise.resolve([candidate({evidence_refs:cite(input)})])}})
 const f:Fixture={host:make(),store,calls,setClock:v=>{clock=v},
  async edit(change){await f.host.close();const saved=await store.read();change(saved);await store.write(saved);f.host=make();await f.host.open()},
  addMessage:(id,text)=>f.edit(saved=>{saved.conversations.items.find(c=>c.id==='chat:main')!.messages.push(message(id,text,clock))}),
  command:(method,params)=>f.host.command({type:'personal.command',request_id:'r'+(++requests),method,params}) as Promise<{ok:boolean;error?:string;data?:unknown}>,
  goalFeed:()=>f.host.snapshot().feed.filter(item=>item.goal_proposal),
  async close(){await f.host.close();await rm(dir,{recursive:true,force:true})}}
 await f.host.open();return f
}

test('goal discovery runs at most once per local date and only after new user messages; the scheduler starts it',async()=>{
 const f=await fixture();try{
  await f.host.scheduledTick();for(let i=0;i<300&&!f.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(f.calls.length,1,'the scheduler tick starts discovery');await f.host.runGoalProposer();assert.equal(await f.host.runGoalProposer(),'skipped','the tick already ran today');assert.equal(f.calls.length,1)
  assert.deepEqual(f.calls[0]!.messages.map(m=>m.id),[ref('m1'),ref('m2')],'recent user messages across the chat are the input');assert.deepEqual(f.calls[0]!.memories,[],'no memory resource means conversation only')
  assert.equal(f.goalFeed().length,1)
  f.setClock(start+DAY);assert.equal(await f.host.runGoalProposer(),'skipped','a new date without new user messages does not run');assert.equal(f.calls.length,1)
  await f.addMessage('m3','英语今天又练了半小时');assert.equal(await f.host.runGoalProposer(),'empty','a topic asked about this week is not asked again');assert.equal(f.calls.length,2)
  assert.equal(await f.host.runGoalProposer(),'skipped','second run on the same date')
 }finally{await f.close()}
})

test('goal discovery does not run when proactive discovery is off',async()=>{
 const f=await fixture({settings:{discovery_enabled:false}});try{
  assert.equal(await f.host.runGoalProposer(),'skipped');await f.host.scheduledTick();assert.equal(f.calls.length,0);assert.equal(f.goalFeed().length,0)
 }finally{await f.close()}
})

test('a failed run is not retried on that date but does not consume the messages, so the next date retries them',async()=>{
 let fail=true
 const f=await fixture({proposer:input=>fail?Promise.reject(Error('model down')):Promise.resolve([candidate({evidence_refs:cite(input)})])});try{
  assert.equal(await f.host.runGoalProposer(),'failed');assert.equal(f.goalFeed().length,0)
  const saved=await f.store.read();assert.equal(saved.goal_proposer.last_outcome,'failed');assert.equal(saved.goal_proposer.consumed_through,null,'failure leaves the watermark');assert.equal(saved.dedupe.length,0)
  fail=false;assert.equal(await f.host.runGoalProposer(),'skipped','no same-day retry storm');assert.equal(f.calls.length,1)
  f.setClock(start+DAY);assert.equal(await f.host.runGoalProposer(),'admitted','the same messages are still new on the next date');assert.equal(f.calls.length,2)
 }finally{await f.close()}
})

test('"set as goal" creates one goal with the proposed cadence and criteria, idempotently',async()=>{
 const f=await fixture();try{
  await f.host.runGoalProposer();const card=f.goalFeed()[0]!
  assert.equal(card.kind,'question');assert.equal(card.priority,40);assert.equal(card.title,candidate().ask_text);assert.deepEqual({...card.goal_proposal,revision:undefined,topic_key:undefined},{title:'学习英语口语',success_criteria:'能用英语聊十分钟',cadence:'daily',evidence_refs:[ref('m1')],revision:undefined,topic_key:undefined})
  assert.ok(f.host.conversationSnapshot().messages.some(m=>m.id==='feed:'+card.id&&m.origin==='proactive'),'the card is a proactive message in chat:main')
  for(let i=0;i<2;i++){const result=await f.command('feed.action',{id:card.id,action:'adopt_goal',goal_revision:card.goal_proposal!.revision});assert.equal(result.ok,true,result.error)}
  const goals=f.host.life.snapshot().goals;assert.equal(goals.length,1,'a repeated click does not create a second goal')
  assert.equal(goals[0]!.title,'学习英语口语');assert.equal(goals[0]!.cadence,'daily');assert.equal(goals[0]!.success_criteria,'能用英语聊十分钟')
  assert.equal(f.goalFeed()[0]!.lifecycle,'resolved')
  f.setClock(start+8*DAY);await f.addMessage('m3','英语继续练');assert.equal(await f.host.runGoalProposer(),'empty','an active goal of the same topic is not proposed again')
 }finally{await f.close()}
})

test('stale, tampered or expired goal cards are refused',async()=>{
 const f=await fixture();try{
  await f.host.runGoalProposer();const card=f.goalFeed()[0]!,revision=card.goal_proposal!.revision
  assert.equal((await f.command('feed.action',{id:card.id,action:'adopt_goal'})).error,'stale_goal_proposal')
  assert.equal((await f.command('feed.action',{id:card.id,action:'adopt_goal',goal_revision:'0'.repeat(32)})).error,'stale_goal_proposal')
  await f.edit(saved=>{saved.feed.find(item=>item.id===card.id)!.goal_proposal!.cadence='progress'})
  assert.equal((await f.command('feed.action',{id:card.id,action:'adopt_goal',goal_revision:revision})).error,'stale_goal_proposal','a card changed after display is refused')
  f.setClock(start+DAY+1000);assert.equal((await f.command('feed.action',{id:card.id,action:'adopt_goal',goal_revision:revision})).ok,false,'an expired card is refused')
  assert.equal(f.host.life.snapshot().goals.length,0)
 }finally{await f.close()}
})

test('"no thanks" records a 30-day rejection for the topic, which then expires',async()=>{
 const f=await fixture({proposer:input=>Promise.resolve([candidate({title:'学习 英语口语！',evidence_refs:cite(input)})])});try{
  await f.host.runGoalProposer();const card=f.goalFeed()[0]!
  assert.equal((await f.command('feed.action',{id:card.id,action:'decline_goal'})).ok,true)
  const saved=await f.store.read(),rejection=saved.goal_proposal_rejections[0]!
  assert.equal(saved.goal_proposal_rejections.length,1);assert.equal(rejection.topic_key,goalTopicKey('学习英语口语'));assert.equal(Date.parse(rejection.until)-Date.parse(rejection.rejected_at),30*DAY)
  assert.equal(f.goalFeed()[0]!.user_state,'dismissed');assert.equal(f.host.life.snapshot().goals.length,0)
  f.setClock(start+29*DAY);await f.addMessage('m3','英语还是想练');assert.equal(await f.host.runGoalProposer(),'empty','the declined topic is filtered within 30 days')
  assert.deepEqual(f.calls.at(-1)!.declined_topics,['学习 英语口语！']);assert.ok(f.calls.at(-1)!.blocked_topic_keys.includes(rejection.topic_key))
  f.setClock(start+31*DAY);await f.addMessage('m4','英语口语这周继续');assert.equal(await f.host.runGoalProposer(),'admitted','an expired rejection allows the topic again')
  assert.equal((await f.store.read()).goal_proposal_rejections.length,0,'expired records are removed')
 }finally{await f.close()}
})

test('goal proposals are suggestions counted against proactive_daily_cap',async()=>{
 const f=await fixture({settings:{proactive_daily_cap:1}});try{
  await f.host.publishNotification({event_key:'other',revision:'1',occurrence:'initial',kind:'suggestion',title:'other',body:'other',source:{type:'runtime',id:'other'},created_at:start,expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[],guard:{requires_runtime:true}},()=>true)
  await f.host.runGoalProposer();const card=f.goalFeed()[0]!
  const delivery=f.host.notifications.snapshot().deliveries.find(d=>d.title===card.title)
  assert.equal(delivery?.status,'pending','the cap defers the goal proposal');assert.ok(!f.host.conversationSnapshot().messages.some(m=>m.id==='feed:'+card.id))
 }finally{await f.close()}
})

test('goals default to cadence off; only goals accept a cadence and the user can change it',async()=>{
 const f=await fixture();try{
  const created=await f.command('life.mutate',{op:'create',kind:'goal',title:'读完一本书',note:''});assert.equal(created.ok,true)
  const goal=f.host.life.snapshot().goals[0]!;assert.equal(goal.cadence,'off','a manually created goal is never checked in on by default')
  assert.equal((await f.command('life.mutate',{op:'update',kind:'goal',id:goal.id,expected_version:goal.version,cadence:'progress'})).ok,true);assert.equal(f.host.life.snapshot().goals[0]!.cadence,'progress')
  assert.equal((await f.command('life.mutate',{op:'create',kind:'todo',title:'买书',note:'',cadence:'daily'})).error,'cadence_only_for_goal')
 }finally{await f.close()}
})
