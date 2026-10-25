import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState,type PersonalState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {dueGoalCheckins,goalCheckinJitterMs,localDateEnd,localDateOf,GOAL_CHECKIN_JITTER_MS,type CheckinGoal} from '../src/personal-agent/goal-checkin.js'
import {groundGoalCheckins,writeGoalCheckins,type GoalCheckinInput,type GoalProgressUpdate,type GoalProgressUpdateInput} from '../src/model/goal-checkin-writer.js'
import type {CompleteRequest,ModelGateway} from '../src/model/model-gateway.js'
import type {FeedItem} from '../src/personal-agent/contracts.js'
import {goalCheckinSource,type NotificationInput} from '../src/notifications/contracts.js'
import type {ConversationTurnContext} from '../src/personal-agent/conversations.js'

const DAY=86400000,MIN=60000
// 10:00 in Shanghai on 2026-10-12.
const start=Date.parse('2026-10-12T02:00:00Z'),DATE='2026-10-12'
const tz='Asia/Shanghai'

// --- due logic ---
const g=(over:Partial<CheckinGoal>={}):CheckinGoal=>({id:'g',status:'active',cadence:'daily',created_at:new Date(start-30*DAY).toISOString(),...over})
const due=(over:Partial<Parameters<typeof dueGoalCheckins>[0]>={})=>dueGoalCheckins({discovery_enabled:true,timezone:tz,now:start,goals:[g()],todos:[],last_checkin_at:{},last_progress_at:{},...over})

test('daily goals are due once per local date; muted, inactive and discovery-off goals never are',()=>{
 assert.deepEqual(due(),['g'])
 assert.deepEqual(due({last_checkin_at:{g:new Date(start-3600000).toISOString()}}),[],'already checked in earlier today (local date)')
 assert.deepEqual(due({last_checkin_at:{g:new Date(start-11*3600000).toISOString()}}),['g'],'23:00 yesterday local time is a different date')
 assert.deepEqual(due({goals:[g({cadence:'off'})]}),[])
 for(const status of ['paused','completed','archived'])assert.deepEqual(due({goals:[g({status})]}),[],status)
 assert.deepEqual(due({discovery_enabled:false}),[])
})
test('progress goals are due after a linked todo is completed since the last check-in, or after seven quiet days',()=>{
 const last=new Date(start-2*DAY).toISOString(),goals=[g({cadence:'progress',created_at:new Date(start-3*DAY).toISOString()})]
 assert.deepEqual(due({goals,last_checkin_at:{g:last}}),[],'recent check-in, no new completion')
 assert.deepEqual(due({goals,last_checkin_at:{g:last},todos:[{goal_id:'g',status:'done',updated_at:new Date(start-DAY).toISOString()}]}),['g'])
 assert.deepEqual(due({goals,last_checkin_at:{g:last},todos:[{goal_id:'g',status:'done',updated_at:new Date(start-3*DAY).toISOString()}]}),[],'completed before the last check-in')
 assert.deepEqual(due({goals,last_checkin_at:{g:last},todos:[{goal_id:'g',status:'open',updated_at:new Date(start-DAY).toISOString()},{goal_id:'other',status:'done',updated_at:new Date(start-DAY).toISOString()}]}),[],'open or unrelated todos do not count')
 const old=[g({cadence:'progress',created_at:new Date(start-30*DAY).toISOString()})]
 assert.deepEqual(due({goals:old,last_checkin_at:{g:new Date(start-7*DAY).toISOString()}}),['g'],'seven quiet days')
 assert.deepEqual(due({goals:old,last_checkin_at:{g:new Date(start-8*DAY).toISOString()},last_progress_at:{g:new Date(start-2*DAY).toISOString()}}),[],'recent progress is activity')
 assert.deepEqual(due({goals:[g({cadence:'progress',created_at:new Date(start-2*DAY).toISOString()})]}),[],'a new goal is not quiet yet')
 assert.deepEqual(due({goals:old,silence_ms:DAY,last_checkin_at:{g:new Date(start-2*DAY).toISOString()}}),['g'],'the silence window is injectable')
})
test('the summary is ordered by importance and holds at most five goals; jitter and the date end are deterministic',()=>{
 const goals=Array.from({length:7},(_,i)=>g({id:'g'+i,created_at:new Date(start-(10-i)*DAY).toISOString(),...(i===6?{importance:'high' as const}:{})}))
 assert.deepEqual(due({goals}),['g6','g0','g1','g2','g3'])
 const jitter=goalCheckinJitterMs(DATE);assert.equal(jitter,goalCheckinJitterMs(DATE));assert.ok(jitter>=0&&jitter<=GOAL_CHECKIN_JITTER_MS)
 assert.equal(new Date(localDateEnd(tz,start)).toISOString(),'2026-10-12T16:00:00.000Z','midnight in Shanghai')
 assert.equal(new Date(localDateEnd('America/New_York',Date.parse('2026-11-01T12:00:00Z'))).toISOString(),'2026-11-02T05:00:00.000Z','a 25-hour DST day')
})

// --- grounding ---
const input:GoalCheckinInput={local_date:DATE,timezone:tz,goals:[
 {goal_id:'a',goal_version:2,title:'学英语口语',success_criteria:'',cadence:'daily',progress:{summary:'上周练了三次跟读',next_step:'每天十分钟',last_progress_at:null},messages:[]},
 {goal_id:'b',goal_version:1,title:'做完个人网站',success_criteria:'上线',cadence:'progress',progress:null,messages:[{id:'message:chat:main:m1',text:'首页的样式改好了',at:''}]},
]}
test('grounding drops lines for unknown goals and fabricated recollections, and keeps input order',()=>{
 const lines=groundGoalCheckins([
  {goal_id:'z',text:'不存在的目标',recalled:null},
  {goal_id:'b',text:'网站进展如何？',recalled:'首页的样式改好了'},
  {goal_id:'a',text:'今天练了吗？',recalled:'上周练了五次'},
  {goal_id:'a',text:'今天练口语了吗？',recalled:'练了三次跟读'},
  {goal_id:'a',text:'重复',recalled:null},
  {goal_id:'b',text:'多余字段',recalled:null,extra:true},
 ],input)
 assert.deepEqual(lines,[{goal_id:'a',goal_version:2,text:'今天练口语了吗？',recalled:'练了三次跟读'},{goal_id:'b',goal_version:1,text:'网站进展如何？',recalled:'首页的样式改好了'}])
 assert.deepEqual(groundGoalCheckins([{goal_id:'b',text:'x',recalled:'上周练了三次跟读'}],input),[],'another goal\'s progress cannot be recalled')
})
test('the check-in writer asks without reasoning, repairs one malformed reply and returns the raw items for the host to ground',async()=>{
 const requests:CompleteRequest[]=[],replies=['{',JSON.stringify({items:[{goal_id:'a',text:'今天练了吗？',recalled:null},{goal_id:'fake',text:'x',recalled:null}]})]
 const gateway={complete:(request:CompleteRequest)=>{requests.push(request);return Promise.resolve({text:replies[requests.length-1]})},stream(){throw Error('unused')}} as unknown as ModelGateway
 const lines=await writeGoalCheckins(gateway,'fixture',input,new AbortController().signal)
 assert.equal(requests.length,2);assert.equal(requests[0]!.reasoning,'disabled');assert.ok(requests[0]!.maxTokens);assert.match(requests[1]!.prompt,/上次输出格式无效/u);assert.match(requests[0]!.system,/中文/u)
 assert.deepEqual(lines,[{goal_id:'a',text:'今天练了吗？',recalled:null},{goal_id:'fake',text:'x',recalled:null}],'unbound: no goal_version, grounding is the host\'s job')
 assert.deepEqual(groundGoalCheckins(lines,input).map(line=>line.goal_id),['a'])
})

// --- host ---
type Writer=(input:GoalCheckinInput,signal:AbortSignal)=>Promise<readonly unknown[]>
interface Fixture {host:PersonalAgentHost;calls:GoalCheckinInput[];clock:{value:number};writer:{fn:Writer};progress:{fn:(input:GoalProgressUpdateInput)=>Promise<GoalProgressUpdate>;calls:GoalProgressUpdateInput[];settled:number};diagnostics:string[];
 command(method:string,params:Record<string,unknown>):Promise<{ok:boolean;error?:string;data?:unknown}>;life(params:Record<string,unknown>):Promise<{id:string;version:number}>;online():Promise<void>;background():Promise<void>;
 restart(change?:(state:PersonalState)=>void):Promise<void>;checkins():FeedItem[];sent():string[];afterJitter():void;close():Promise<void>}
const lineFor=(input:GoalCheckinInput)=>input.goals.map(goal=>({goal_id:goal.goal_id,text:'今天在「'+goal.title+'」上怎么样？',recalled:null}))
async function fixture(options:{settings?:Partial<PersonalState['settings']>;state?:(state:PersonalState)=>void}={}):Promise<Fixture>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-goal-checkin-')),path=join(dir,'state.json'),store=new PersonalStore(path)
 const state=initialState();state.settings={discovery_enabled:true,discovery_interval_minutes:30,timezone:tz,quiet_start:'00:00',quiet_end:'00:00',proactive_daily_cap:5,...options.settings};options.state?.(state);await store.write(state)
 let requests=0
 const f:Fixture={calls:[],clock:{value:start},writer:{fn:input=>Promise.resolve(lineFor(input))},progress:{fn:()=>Promise.resolve({summary:'练了跟读',next_step:'明天再练',made_progress:true}),calls:[],settled:0},diagnostics:[],
  host:undefined as unknown as PersonalAgentHost,
  command:(method,params)=>f.host.command({type:'personal.command',request_id:'r'+(++requests),method,params}) as Promise<{ok:boolean;error?:string;data?:unknown}>,
  async life(params){const r=await f.command('life.mutate',params);assert.equal(r.ok,true,r.error);return r.data as {id:string;version:number}},
  async online(){assert.equal((await f.command('presentation.set',{mode:'workbench'})).ok,true)},
  async background(){assert.equal((await f.command('presentation.set',{mode:'background'})).ok,true)},
  async restart(change){await f.host.close();if(change){const saved=await store.read();change(saved);await store.write(saved)}f.host=make();await f.host.open()},
  checkins:()=>f.host.snapshot().feed.filter(item=>item.goal_checkin),
  sent:()=>f.host.conversationSnapshot().messages.filter(m=>m.origin==='proactive').map(m=>m.id),
  afterJitter(){f.clock.value+=goalCheckinJitterMs(new Date(f.clock.value).toLocaleDateString('en-CA',{timeZone:tz}))+1},
  async close(){await f.host.close();await rm(dir,{recursive:true,force:true})}}
 const make=()=>new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>new Date(f.clock.value),onDiagnostic:code=>f.diagnostics.push(code),
  prepareGoalCheckin:(input,signal)=>{f.calls.push(input);return f.writer.fn(input,signal)},
  updateGoalProgress:input=>{f.progress.calls.push(input);return f.progress.fn(input).finally(()=>{f.progress.settled++})}})
 f.host=make();await f.host.open();return f
}
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
const until=async(check:()=>boolean)=>{for(let i=0;i<300&&!check();i++)await new Promise(resolve=>setTimeout(resolve,5))}

test('the summary waits for the first foreground moment plus the date jitter, lands once in chat:main and counts toward the daily allowance',async()=>{
 const f=await fixture();try{
  const a=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'}),b=await f.life({op:'create',kind:'goal',title:'做完个人网站',cadence:'progress'}),off=await f.life({op:'create',kind:'goal',title:'没有节奏',cadence:'off'})
  // Life stamps goals with the wall clock, so the host clock moves a week past it: the progress goal has been quiet for a week.
  f.clock.value=Date.parse(f.host.snapshot().life.goals[0]!.created_at)+8*DAY;const date=localDateOf(tz,f.clock.value)
  assert.equal(await f.host.runGoalCheckins(),'waiting','not before the user is in the foreground');assert.equal(f.calls.length,0)
  await f.online();if(goalCheckinJitterMs(date)>0)assert.equal(await f.host.runGoalCheckins(),'waiting','not before the jitter elapses')
  f.afterJitter();assert.equal(await f.host.runGoalCheckins(),'admitted');assert.equal(f.calls.length,1)
  assert.deepEqual(f.calls[0]!.goals.map(goal=>goal.goal_id),[a.id,b.id],'only goals with a cadence');assert.ok(!f.calls[0]!.goals.some(goal=>goal.goal_id===off.id))
  const [item]=f.checkins();assert.ok(item);assert.equal(item.goal_checkin!.local_date,date);assert.deepEqual(item.goal_checkin!.items.map(line=>[line.goal_id,line.goal_version]),[[a.id,1],[b.id,1]])
  assert.equal(item.expires_at,new Date(localDateEnd(tz,f.clock.value)).toISOString(),'expires at the end of the local date');assert.equal(localDateOf(tz,Date.parse(item.expires_at)),localDateOf(tz,f.clock.value+DAY))
  assert.deepEqual(f.sent(),['feed:'+item.id],'one summary message in chat:main, rendered from its feed item')
  assert.equal(f.host.notifications.deliveredToday(['brief','suggestion'],tz,f.clock.value),1,'it uses one slot of the daily allowance')
  for(let i=0;i<3;i++){f.clock.value+=MIN;assert.equal(await f.host.runGoalCheckins(),'done')}
  await f.host.scheduledTick();assert.equal(f.calls.length,1);assert.equal(f.sent().length,1)
 }finally{await f.close()}
})

test('background pauses the summary until the user is back; a summary queued past the local date is never sent late',async()=>{
 const f=await fixture();try{
  await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'})
  await f.online();await f.background();f.afterJitter()
  assert.equal(await f.host.runGoalCheckins(),'waiting','background pauses generation');assert.equal(f.calls.length,0)
  // The user leaves while the model is writing: the summary is admitted but held back.
  const gate=deferred<readonly unknown[]>();f.writer.fn=input=>gate.promise.then(()=>lineFor(input))
  await f.online();const running=f.host.runGoalCheckins();await until(()=>f.calls.length===1);await f.background();gate.resolve([])
  assert.equal(await running,'admitted');assert.deepEqual(f.sent(),[],'not shown while in the background')
  const [held]=f.checkins(),message=f.host.notifications.snapshot().deliveries.find(d=>d.source.type===goalCheckinSource)!;assert.equal(message.status,'pending')
  f.clock.value=start+DAY+MIN // the next local date
  f.writer.fn=input=>Promise.resolve(lineFor(input))
  await f.online();await f.host.flushNotifications()
  assert.deepEqual(f.sent(),[],'the previous date\'s summary expired instead of being sent late')
  assert.equal(f.host.notifications.snapshot().deliveries.find(d=>d.id===message.id)!.status,'expired')
  f.afterJitter();assert.equal(await f.host.runGoalCheckins(),'admitted');const fresh=f.checkins().find(item=>item.id!==held!.id)!
  assert.equal(fresh.goal_checkin!.local_date,'2026-10-13');assert.deepEqual(f.sent(),['feed:'+fresh.id],'only today\'s summary is delivered')
 }finally{await f.close()}
})

test('a full daily allowance skips the model call entirely',async()=>{
 const f=await fixture({settings:{proactive_daily_cap:1}});try{
  await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'});await f.online()
  const other:NotificationInput={event_key:'other',revision:'1',occurrence:'initial',kind:'suggestion',title:'别的提醒',body:'正文',source:{type:'test',id:'x'},created_at:f.clock.value,expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[]}
  await f.host.notifications.publish(other);await f.host.notifications.dispatch()
  assert.equal(f.host.notifications.deliveredToday(['brief','suggestion'],tz,f.clock.value),1)
  f.afterJitter();assert.equal(await f.host.runGoalCheckins(),'capped');assert.equal(f.calls.length,0,'no model call when the summary would only be deferred');assert.equal(f.checkins().length,0)
 }finally{await f.close()}
})

test('proactive discovery off means no check-in at all, and voids a queued one',async()=>{
 const f=await fixture();try{
  await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'});await f.online();f.afterJitter()
  assert.equal((await f.command('discovery.configure',{enabled:false})).ok,true)
  assert.equal(await f.host.runGoalCheckins(),'skipped');assert.equal(f.calls.length,0)
  const queued:NotificationInput={event_key:'q',revision:'1',occurrence:'initial',kind:'suggestion',title:'t',body:'b',guard:{goal_ids:[f.host.snapshot().life.goals[0]!.id]},source:{type:goalCheckinSource,id:DATE},created_at:f.clock.value,expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[]}
  assert.equal(await f.host.notificationValidity(queued),'invalid')
 }finally{await f.close()}
})

test('race: a goal paused before the run is never sent to the model; one paused during generation discards the result without using the date',async()=>{
 const f=await fixture();try{
  const a=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'}),b=await f.life({op:'create',kind:'goal',title:'每天跑步',cadence:'daily'})
  await f.life({op:'update',kind:'goal',id:b.id,expected_version:1,status:'paused'})
  await f.online();f.afterJitter()
  const gate=deferred<void>();f.writer.fn=input=>gate.promise.then(()=>lineFor(input))
  const running=f.host.runGoalCheckins();await until(()=>f.calls.length===1)
  assert.deepEqual(f.calls[0]!.goals.map(goal=>goal.goal_id),[a.id],'the paused goal is filtered before generation')
  await f.life({op:'update',kind:'goal',id:a.id,expected_version:1,status:'paused'});gate.resolve()
  assert.equal(await running,'discarded');assert.equal(f.checkins().length,0,'nothing is admitted');assert.deepEqual(f.sent(),[])
  await f.life({op:'update',kind:'goal',id:a.id,expected_version:2,status:'active'});f.writer.fn=input=>Promise.resolve(lineFor(input))
  assert.equal(await f.host.runGoalCheckins(),'admitted','a discarded result does not use the date');assert.equal(f.sent().length,1)
 }finally{await f.close()}
})

test('race: one goal paused while the summary is queued voids the whole summary; the next tick rewrites it for the rest',async()=>{
 const f=await fixture();try{
  const a=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'}),b=await f.life({op:'create',kind:'goal',title:'每天跑步',cadence:'daily'})
  const gate=deferred<void>();f.writer.fn=input=>gate.promise.then(()=>lineFor(input))
  await f.online();f.afterJitter();const running=f.host.runGoalCheckins();await until(()=>f.calls.length===1);await f.background();gate.resolve()
  assert.equal(await running,'admitted');const [queued]=f.checkins()
  const notification=f.host.notifications.snapshot().deliveries.find(d=>d.source.type===goalCheckinSource)!;assert.deepEqual(notification.source,{type:goalCheckinSource,id:DATE,version:queued!.id})
  await f.life({op:'update',kind:'goal',id:b.id,expected_version:1,status:'paused'})
  f.writer.fn=input=>Promise.resolve(lineFor(input))
  await f.online();await f.host.flushNotifications();assert.deepEqual(f.sent(),[],'the summary naming the paused goal is not sent')
  assert.equal(f.host.notifications.snapshot().deliveries.find(d=>d.id===notification.id)!.status,'cancelled')
  assert.equal(await f.host.runGoalCheckins(),'invalidated');assert.equal(f.checkins().find(item=>item.id===queued!.id)!.lifecycle,'invalidated')
  assert.equal(await f.host.runGoalCheckins(),'admitted');assert.deepEqual(f.calls.at(-1)!.goals.map(goal=>goal.goal_id),[a.id],'rewritten for the remaining goal')
  const fresh=f.checkins().find(item=>item.lifecycle==='active')!;assert.deepEqual(f.sent(),['feed:'+fresh.id]);assert.equal(f.host.notifications.deliveredToday(['suggestion'],tz,f.clock.value),1,'the voided summary used no slot')
 }finally{await f.close()}
})

test('race: repeated ticks send once; a restart resumes an interrupted attempt after the backoff and never resends',async()=>{
 const attempted=start+goalCheckinJitterMs(DATE)+1
 const f=await fixture({state:state=>{state.goal_checkins.runs[DATE]={status:'processing',attempts:1,last_attempt_at:new Date(attempted).toISOString(),feed_id:null}}});try{
  await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'});await f.online();f.afterJitter()
  assert.equal(await f.host.runGoalCheckins(),'none','an attempt interrupted by a restart waits out the backoff');assert.equal(f.calls.length,0)
  f.clock.value=attempted+5*MIN
  const results=await Promise.all([f.host.runGoalCheckins(),f.host.runGoalCheckins(),f.host.scheduledTick().then(()=>f.host.runGoalCheckins())])
  assert.equal(f.calls.length,1,'concurrent ticks share one run');assert.ok(results.includes('admitted'));assert.equal(f.sent().length,1)
  await f.restart();await f.online();assert.equal(await f.host.runGoalCheckins(),'waiting','the first foreground moment is kept in memory, so a restart waits out the jitter again');f.afterJitter()
  assert.equal(await f.host.runGoalCheckins(),'done');await f.host.flushNotifications();assert.equal(f.sent().length,1,'not resent after a restart');assert.equal(f.calls.length,1)
 }finally{await f.close()}
})

test('race: a goal paused for days and resumed gets one check-in today, nothing for the paused days',async()=>{
 const f=await fixture();try{
  const a=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'});await f.life({op:'update',kind:'goal',id:a.id,expected_version:1,status:'paused'})
  await f.online()
  for(let day=0;day<3;day++){f.clock.value=start+day*DAY;await f.online();f.afterJitter();assert.equal(await f.host.runGoalCheckins(),'none')}
  f.clock.value=start+3*DAY;await f.life({op:'update',kind:'goal',id:a.id,expected_version:2,status:'active'});await f.online();f.afterJitter()
  assert.equal(await f.host.runGoalCheckins(),'admitted');assert.equal(f.calls.length,1);assert.equal(f.sent().length,1);assert.deepEqual(f.checkins().map(item=>item.goal_checkin!.local_date),['2026-10-15'])
 }finally{await f.close()}
})

test('model failures do not use the date: three attempts with a five-minute backoff; an all-empty reply sends nothing',async()=>{
 const f=await fixture();try{
  await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'});await f.online();f.afterJitter()
  f.writer.fn=()=>Promise.reject(Error('model_down'))
  assert.equal(await f.host.runGoalCheckins(),'failed');assert.equal(await f.host.runGoalCheckins(),'none','backoff');assert.equal(f.calls.length,1)
  f.clock.value+=5*MIN;assert.equal(await f.host.runGoalCheckins(),'failed');f.clock.value+=5*MIN
  f.writer.fn=input=>Promise.resolve(lineFor(input));assert.equal(await f.host.runGoalCheckins(),'admitted','the same date can still succeed');assert.equal(f.calls.length,3)
  assert.equal(f.sent().length,1)
 }finally{await f.close()}
 const g2=await fixture();try{
  await g2.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'});await g2.online();g2.afterJitter();g2.writer.fn=()=>Promise.reject(Error('model_down'))
  for(let i=0;i<4;i++){await g2.host.runGoalCheckins();g2.clock.value+=5*MIN+1}
  assert.equal(g2.calls.length,3,'at most three attempts per date')
 }finally{await g2.close()}
 const e=await fixture();try{
  await e.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'});await e.online();e.afterJitter()
  e.writer.fn=()=>Promise.resolve([{goal_id:'forged',text:'编造的目标',recalled:null}])
  assert.equal(await e.host.runGoalCheckins(),'empty','forged goals are dropped, leaving nothing');assert.deepEqual(e.sent(),[]);assert.equal(e.checkins().length,0)
  assert.equal(e.host.notifications.deliveredToday(['brief','suggestion'],tz,e.clock.value),0,'an empty run uses no slot');assert.equal(await e.host.runGoalCheckins(),'done')
 }finally{await e.close()}
})

test('"stop reminding" mutes the goal at its current version, is idempotent, and reports a missing goal',async()=>{
 const f=await fixture();try{
  const a=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'}),b=await f.life({op:'create',kind:'goal',title:'每天跑步',cadence:'daily'})
  await f.online();f.afterJitter();assert.equal(await f.host.runGoalCheckins(),'admitted');const [item]=f.checkins()
  await f.life({op:'update',kind:'goal',id:a.id,expected_version:1,title:'练英语口语'}) // the card still shows version 1
  const mute=(goal_id:string)=>f.command('feed.action',{id:item!.id,action:'goal_checkin_mute',goal_id})
  assert.equal((await mute(a.id)).ok,true);const muted=f.host.snapshot().life.goals.find(goal=>goal.id===a.id)!;assert.equal(muted.cadence,'off');assert.equal(muted.version,3)
  assert.equal((await mute(a.id)).ok,true,'a repeated click succeeds');assert.equal(f.host.snapshot().life.goals.find(goal=>goal.id===a.id)!.version,3,'and changes nothing')
  assert.equal((await f.command('feed.action',{id:item!.id,action:'goal_checkin_mute',goal_id:'other'})).error,'not_goal_checkin')
  await f.life({op:'delete',kind:'goal',id:b.id,expected_version:1})
  assert.equal((await mute(b.id)).error,'goal_not_found','a deleted goal is an explicit error, not a silent success')
 }finally{await f.close()}
})

// --- reply → progress ---
function withConversation(f:Fixture){f.host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'好的，记下了'}),sendAudio:()=>Promise.resolve(),close:()=>Promise.resolve()}),()=>{/* no observer */})}
const reply=async(f:Fixture,text:string,references?:ConversationTurnContext['references'])=>{const settled=f.progress.settled;await f.host.submitConversationText('chat:main',text,undefined,undefined,references?{references}:{});await f.host.waitConversation('chat:main');if(references?.length){await until(()=>f.progress.settled>settled);await new Promise(resolve=>setTimeout(resolve,50))}}
test('a reply that references a goal updates its progress from that message alone; made_progress controls last_progress_at',async()=>{
 const f=await fixture();try{
  withConversation(f);const goal=await f.life({op:'create',kind:'goal',title:'学英语口语',success_criteria:'能聊十分钟',cadence:'daily'})
  await reply(f,'今天跟读了二十分钟',[{kind:'goal',id:goal.id,version:1}])
  const sent=f.host.conversationSnapshot().messages.find(m=>m.role==='user'&&m.text==='今天跟读了二十分钟')!
  assert.equal(f.progress.calls.length,1);assert.deepEqual(f.progress.calls[0]!.goal,{title:'学英语口语',success_criteria:'能聊十分钟',status:'active'});assert.equal(f.progress.calls[0]!.previous,null);assert.equal(f.progress.calls[0]!.message.text,'今天跟读了二十分钟')
  let row=f.host.goalProgress(goal.id)!
  assert.deepEqual(row.evidence_refs,['message:chat:main:'+sent.id],'the only evidence is the reply');assert.equal(row.last_progress_at,sent.created_at);assert.equal(row.goal_version,1);assert.equal(row.summary,'练了跟读')
  f.clock.value+=DAY;f.progress.fn=()=>Promise.resolve({summary:'今天没练',next_step:'明早补上',made_progress:false})
  await reply(f,'今天太忙没练',[{kind:'goal',id:goal.id,version:1}])
  row=f.host.goalProgress(goal.id)!;assert.equal(row.summary,'今天没练');assert.equal(row.last_progress_at,sent.created_at,'no progress keeps the previous time')
  assert.deepEqual(f.progress.calls[1]!.previous,{summary:'练了跟读',next_step:'明天再练',last_progress_at:sent.created_at})
  await reply(f,'随便聊聊');assert.equal(f.progress.calls.length,2,'a message without a goal reference triggers nothing')
 }finally{await f.close()}
})
test('progress updates skip a goal deleted meanwhile and fail silently',async()=>{
 const f=await fixture();try{
  withConversation(f);const goal=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'})
  const gate=deferred<void>();f.progress.fn=()=>gate.promise.then(()=>({summary:'练了',next_step:'',made_progress:true}))
  await f.host.submitConversationText('chat:main','练了',undefined,undefined,{references:[{kind:'goal',id:goal.id,version:1}]});await f.host.waitConversation('chat:main');await until(()=>f.progress.calls.length===1)
  await f.life({op:'delete',kind:'goal',id:goal.id,expected_version:1});gate.resolve();for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.host.goalProgress(goal.id),null);assert.deepEqual(f.host.snapshot().life.goals,[])
  const other=await f.life({op:'create',kind:'goal',title:'每天跑步',cadence:'daily'});f.progress.fn=()=>Promise.reject(Error('model_down'))
  const errors:unknown[]=[];f.host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'好'}),sendAudio:()=>Promise.resolve(),close:()=>Promise.resolve()}),frame=>errors.push(frame))
  await reply(f,'跑了五公里',[{kind:'goal',id:other.id,version:1}])
  assert.equal(f.host.goalProgress(other.id),null);assert.deepEqual(errors.filter(frame=>(frame as {type?:string}).type==='conversation.error'),[],'no error reaches the user');assert.ok(f.diagnostics.includes('goal_progress_update_failed'))
  assert.equal(f.host.conversationSnapshot().messages.at(-1)!.text,'好','the reply itself is unaffected')
 }finally{await f.close()}
})

// --- production chain: the real writer behind the host, only the model gateway mocked ---
async function realWriterRun(items:(ids:string[])=>unknown[],versionBump=false){
 const f=await fixture(),ids:string[]=[]
 const gateway={complete:()=>Promise.resolve({text:JSON.stringify({items:items(ids)})}),stream(){throw Error('unused')}} as unknown as ModelGateway
 f.writer.fn=(input,signal)=>writeGoalCheckins(gateway,'fixture',input,signal)
 const a=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'}),b=await f.life({op:'create',kind:'goal',title:'做完个人网站',cadence:'daily'})
 if(versionBump)await f.life({op:'update',kind:'goal',id:a.id,expected_version:1,title:'学英语口语（改）'})
 ids.push(a.id,b.id);await f.online();f.afterJitter()
 return {f,a,b,outcome:await f.host.runGoalCheckins()}
}
test('chain: the real writer behind the host delivers a summary whose items carry the current goal versions',async()=>{
 const {f,a,b,outcome}=await realWriterRun(([x,y])=>[{goal_id:x,text:'今天练口语了吗？',recalled:null},{goal_id:y,text:'网站进展如何？',recalled:null}],true);try{
  assert.equal(outcome,'admitted');const [item]=f.checkins();assert.ok(item)
  assert.deepEqual(item.goal_checkin!.items.map(line=>[line.goal_id,line.goal_version]),[[a.id,2],[b.id,1]])
  assert.deepEqual(f.sent(),['feed:'+item.id])
 }finally{await f.close()}
})
test('chain: a non-verbatim recollection drops only that line; an unknown goal_id is dropped',async()=>{
 const {f,b,outcome}=await realWriterRun(([x,y])=>[{goal_id:x,text:'上次练得不错',recalled:'编造的上次进展'},{goal_id:y,text:'网站进展如何？',recalled:null},{goal_id:'not-in-input',text:'x',recalled:null}]);try{
  assert.equal(outcome,'admitted');assert.deepEqual(f.checkins()[0]!.goal_checkin!.items.map(line=>[line.goal_id,line.goal_version,line.text]),[[b.id,1,'网站进展如何？']])
 }finally{await f.close()}
})
test('chain: when every line is invalid the day is recorded empty and nothing is sent',async()=>{
 const {f,outcome}=await realWriterRun(()=>[{goal_id:'not-in-input',text:'x',recalled:null}]);try{
  assert.equal(outcome,'empty');assert.deepEqual(f.sent(),[])
 }finally{await f.close()}
})

// --- progress update races ---
const submit=async(f:Fixture,text:string,refs:ConversationTurnContext['references'])=>{await f.host.submitConversationText('chat:main',text,undefined,undefined,refs?{references:refs}:{});await f.host.waitConversation('chat:main')}
const settle=()=>new Promise(resolve=>setTimeout(resolve,100))
test('progress race: a goal edited while the update is generated discards it instead of stamping the new version',async()=>{
 const f=await fixture();try{
  withConversation(f);const goal=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'})
  const gate=deferred<void>();f.progress.fn=()=>gate.promise.then(()=>({summary:'按旧标题写的',next_step:'',made_progress:true}))
  await submit(f,'练了',[{kind:'goal',id:goal.id,version:1}]);await until(()=>f.progress.calls.length===1)
  await f.life({op:'update',kind:'goal',id:goal.id,expected_version:1,title:'学法语口语'});gate.resolve();await settle()
  assert.equal(f.host.goalProgress(goal.id),null,'not recorded at version 2')
 }finally{await f.close()}
})
test('progress race: a goal edited after the user referenced it, before the reply finished, triggers no update',async()=>{
 const f=await fixture();try{
  const gate=deferred<void>();f.host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>gate.promise.then(()=>({assistant:'好'})),sendAudio:()=>Promise.resolve(),close:()=>Promise.resolve()}),()=>{/* no observer */})
  const goal=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'})
  await f.host.submitConversationText('chat:main','练了',undefined,undefined,{references:[{kind:'goal',id:goal.id,version:1}]})
  await f.life({op:'update',kind:'goal',id:goal.id,expected_version:1,title:'学法语口语'});gate.resolve();await f.host.waitConversation('chat:main');await settle()
  assert.equal(f.progress.calls.length,0,'the user referenced version 1, which is no longer current');assert.equal(f.host.goalProgress(goal.id),null)
  withConversation(f);await reply(f,'又练了',[{kind:'goal',id:goal.id,version:2}]);assert.equal(f.host.goalProgress(goal.id)!.goal_version,2)
 }finally{await f.close()}
})
test('progress race: updates for one goal run in reply order; the later reply sees the earlier result and wins',async()=>{
 const f=await fixture();try{
  withConversation(f);const goal=await f.life({op:'create',kind:'goal',title:'学英语口语',cadence:'daily'}),ref=[{kind:'goal' as const,id:goal.id,version:1}]
  const slow=deferred<void>()
  f.progress.fn=input=>input.message.text==='A'?slow.promise.then(()=>({summary:'A的结果',next_step:'a',made_progress:true})):Promise.resolve({summary:'B的结果',next_step:'b',made_progress:false})
  await submit(f,'A',ref);await until(()=>f.progress.calls.length===1)
  f.clock.value+=MIN;await submit(f,'B',ref);await settle()
  assert.equal(f.progress.calls.length,1,'B waits for A instead of starting concurrently')
  slow.resolve();await until(()=>f.progress.calls.length===2);await settle()
  const a=f.host.conversationSnapshot().messages.find(m=>m.text==='A')!
  assert.deepEqual(f.progress.calls[1]!.previous,{summary:'A的结果',next_step:'a',last_progress_at:a.created_at},'previous is read when B runs')
  const row=f.host.goalProgress(goal.id)!;assert.equal(row.summary,'B的结果');assert.equal(row.evidence_refs[0],'message:chat:main:'+f.host.conversationSnapshot().messages.find(m=>m.text==='B')!.id)
  assert.equal(row.last_progress_at,a.created_at,'last_progress_at is not rolled back')
 }finally{await f.close()}
})
