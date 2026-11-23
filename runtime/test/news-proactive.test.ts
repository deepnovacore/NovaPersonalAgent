import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NewsService} from '../src/news/service.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {Score} from '../src/news/ranking.js'
import {feedNotification} from '../src/notifications/feed.js'
// Quiet hours (default 22:00-08:00) follow the machine's zone unless a test sets one. These fixtures use fixed clocks
// (or the real clock) and expect delivery, so pin the zone instead of depending on where and when the suite runs.
process.env.TZ = 'UTC'

const NOW=new Date('2026-09-20T11:00:00Z')
const source={id:'bbc',name:'BBC',url:'https://feeds.bbci.co.uk/news/rss.xml'}
const item=(n:number,hoursAgo=1)=>`<item><title>Voice model ${n}</title><link>https://example.com/n${n}</link><description>Voice models ${n} improve latency</description><pubDate>${new Date(NOW.getTime()-hoursAgo*3600_000).toUTCString()}</pubDate></item>`
const feed=(...items:string[])=>`<rss><channel>${items.join('')}</channel></rss>`
type Verdict={score:number;substance?:'concrete'|'thin'|'promotional'}|null
type Judge=(n:number)=>Verdict
async function service(xml:string,judge:Judge){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-push-'))
 const svc=new NewsService({path:join(dir,'news.json'),sources:[source],now:()=>NOW,firstRefreshMs:null,fetcher:()=>Promise.resolve(new Response(xml)),
  rank:(interests,articles)=>Promise.resolve(articles.map<Score>(a=>{const n=Number(/Voice model (\d+)/.exec(a.title)![1]);const j=judge(n)
   return {id:a.id,matches:j?[{interest_id:interests[0]!.id,score:j.score,quote:a.title}]:[],reason:j?'相关':'',...(j?.substance?{judgment:{provider:'jev' as const,substance:j.substance,confidence:0.9,probabilities:{}}}:{})}}))})
 await svc.open();await svc.configure({enabled:true,interests:['Voice AI'],explore:false});await svc.refresh()
 return {svc,close:async()=>{await svc.close();await rm(dir,{recursive:true,force:true})}}
}

test('only strong, concrete, fresh matches become push candidates, best first',async()=>{
 const f=await service(feed(item(1),item(2),item(3),item(4),item(5),item(6,60)),n=>({1:{score:0.95,substance:'concrete'},2:{score:0.9},3:{score:0.7,substance:'concrete'},4:{score:0.95,substance:'promotional'},5:null,6:{score:0.99,substance:'concrete'}} satisfies Record<number,Verdict>)[n as 1|2|3|4|5|6]??null)
 try{assert.deepEqual(f.svc.pushCandidates().map(a=>a.title),['Voice model 1','Voice model 2'],'0.7 is too weak, promotional is out, unmatched is out, a 60 hour old article is stale')}finally{await f.close()}
})
test('a thin article does not clear the bar even with a perfect match',async()=>{
 const f=await service(feed(item(1)),()=>({score:1,substance:'thin'}));try{assert.deepEqual(f.svc.pushCandidates(),[])}finally{await f.close()}
})
test('interests only guessed from the profile never push, and neither does a blocked source or a disabled service',async()=>{
 const f=await service(feed(item(1)),()=>({score:1,substance:'concrete'}))
 try{
  assert.equal(f.svc.pushCandidates().length,1)
  await f.svc.action({action:'block',source_id:'bbc',value:true});assert.deepEqual(f.svc.pushCandidates(),[])
  await f.svc.action({action:'block',source_id:'bbc',value:false});assert.equal(f.svc.pushCandidates().length,1)
  await f.svc.configure({enabled:false,interests:[],explore:false});assert.deepEqual(f.svc.pushCandidates(),[])
 }finally{await f.close()}
})
test('the service reports every completed ranking so the host can act on new candidates',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-ranked-'));let ranked=0
 const svc=new NewsService({path:join(dir,'news.json'),sources:[source],now:()=>NOW,firstRefreshMs:null,ranked:()=>{ranked++},fetcher:()=>Promise.resolve(new Response(feed(item(1)))),
  rank:(interests,articles)=>Promise.resolve(articles.map<Score>(a=>({id:a.id,matches:[{interest_id:interests[0]!.id,score:1,quote:a.title}],reason:'相关'})))})
 await svc.open()
 try{await svc.configure({enabled:true,interests:['Voice AI'],explore:false});assert.equal(ranked,0);await svc.refresh();assert.ok(ranked>=1)}finally{await svc.close();await rm(dir,{recursive:true,force:true})}
})

async function host(dir:string,options:Record<string,unknown>={}){
 await writeFile(join(dir,'state.json.news.json'),JSON.stringify({version:1,profile_version:1,enabled:true,explore:false,interests:[{id:'voice',text:'Voice AI',weight:1}],blocked:[],sources:[],rank_error:null,items:[1,2,3,4].map(n=>({...article(n),ranking:{id:'a'+n,matches:[{interest_id:'voice',score:1,quote:article(n).title}],reason:reason(n),profile_version:1,ready_at:NOW.toISOString()}}))}),{mode:0o600})
 const h=new PersonalAgentHost({discoveryWindow:{quietMs:0,maxMs:0},path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>NOW,...options})
 await h.open();return h
}
const article=(n:number)=>({id:'a'+n,source_id:'bbc',title:'Voice model '+n,summary:'Voice models '+n+' improve latency',url:'https://example.com/n'+n,published_at:NOW.toISOString(),first_seen:NOW.toISOString(),content_hash:'h'+n,read:false,saved:false,ranking:null})
const reason=(n:number)=>'与你关注的 Voice AI 相关（'+n+'）'

test('an admitted article becomes one news feed item that reaches the main conversation, once',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-host-'));const h=await host(dir)
 try{
  assert.equal(await h.admitNews(article(1),reason(1)),'admitted');assert.equal(await h.admitNews(article(1),reason(1)),'suppressed_duplicate')
  const feedItem=h.snapshot().feed.find(f=>f.subject_key==='news:a1')!;assert.equal(feedItem.kind,'notify');assert.equal(feedItem.title,'Voice model 1')
  assert.match(feedItem.prepared!.text,/example\.com\/n1/);assert.equal(feedItem.prepared!.trust,'untrusted_external')
  const main=h.snapshot().conversations.messages.filter(m=>m.conversation_id==='chat:main'&&m.origin==='proactive')
  assert.equal(main.length,1);assert.match(main[0]!.text,/Voice model 1/)
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('news has its own daily allowance and never uses up the one for briefs and suggestions',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-quota-'));const h=await host(dir)
 try{
  assert.equal(await h.admitNews(article(1),reason(1)),'admitted');assert.equal(await h.admitNews(article(2),reason(2)),'admitted')
  assert.equal(await h.admitNews(article(3),reason(3)),'capped','the third one today waits for tomorrow')
  const messages=()=>h.snapshot().conversations.messages.filter(m=>m.conversation_id==='chat:main'&&m.origin==='proactive').length
  assert.equal(messages(),2)
  assert.equal(h.notifications.deliveredToday(['brief','suggestion'],'UTC',NOW.getTime()),0,'the shared proactive allowance is untouched')
  assert.equal(h.notifications.deliveredToday(['news'],'UTC',NOW.getTime()),2)
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('turning proactive discovery off silences news pushes too',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-off-'));const h=await host(dir)
 try{
  await h.command({type:'personal.command',request_id:'off',method:'discovery.configure',params:{enabled:false}})
  assert.equal(await h.admitNews(article(1),reason(1)),'disabled');assert.equal(h.snapshot().feed.filter(f=>f.subject_key.startsWith('news:')).length,0)
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('news keeps flowing when the shared allowance for briefs and suggestions is set to one',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-shared-'));const h=await host(dir)
 try{
  await h.command({type:'personal.command',request_id:'cap',method:'discovery.configure',params:{proactive_daily_cap:1}})
  assert.equal(await h.admitNews(article(1),reason(1)),'admitted');assert.equal(await h.admitNews(article(2),reason(2)),'admitted')
  const delivered=h.snapshot().conversations.messages.filter(m=>m.conversation_id==='chat:main'&&m.origin==='proactive').length
  assert.equal(delivered,2,'a shared cap of one would have deferred the second article')
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('a completed ranking in the real service pushes its candidates through the host',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-wire-'));const h=await host(dir)
 try{
  const candidate={...article(1),ranking:{id:'a1',matches:[],reason:'与你关注的 Voice AI 相关（依据标题与摘要）',profile_version:1,ready_at:NOW.toISOString()}}
  h.news.pushCandidates=()=>[candidate]
  // Wait for the host's own call instead of sleeping, so the test is the same on a loaded machine.
  const admit=h.admitNews.bind(h);let settle:()=>void=()=>undefined
  h.admitNews=async(...args)=>{const result=await admit(...args);settle();return result}
  const ranked=()=>{const done=new Promise<void>(resolve=>{settle=resolve});h.news.options.ranked!();return done}
  await ranked()
  const pushed=h.snapshot().feed.find(f=>f.subject_key==='news:a1');assert.ok(pushed,'the ranked hook reached admitNews')
  assert.equal(pushed.why_now,candidate.ranking.reason)
  await ranked()
  assert.equal(h.snapshot().feed.filter(f=>f.subject_key==='news:a1').length,1,'ranking again never pushes the same article twice')
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('a next-day refresh pushes already-ranked fresh backlog without another model call',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-nextday-'));let current=NOW,rankCalls=0
 const h=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>current,
  rankNews:(interests,articles)=>{rankCalls++;return Promise.resolve(articles.map(a=>({id:a.id,matches:[{interest_id:interests[0]!.id,score:1,quote:a.title}],reason:'相关'})))}})
 h.news.options.now=()=>current;h.news.options.firstRefreshMs=null;h.news.options.fetcher=()=>Promise.resolve(new Response(feed(item(1),item(2),item(3))))
 const admit=h.admitNews.bind(h);let capped!:()=>void;const hitCap=new Promise<void>(resolve=>{capped=resolve})
 h.admitNews=async(...args)=>{const result=await admit(...args);if(result==='capped')capped();return result}
 const news=()=>h.snapshot().feed.filter(row=>row.source.type==='news')
 const waitFor=async(count:number)=>{for(let i=0;i<200&&news().length<count;i++)await new Promise(resolve=>setTimeout(resolve,10));await h.flushNotifications()}
 try{
  await h.open();await h.command({type:'personal.command',request_id:'tz',method:'discovery.configure',params:{timezone:'UTC'}});await h.news.configure({enabled:true,interests:['Voice AI'],explore:false})
  await h.news.refresh();await hitCap;await new Promise(resolve=>setImmediate(resolve));await waitFor(2);assert.equal(news().length,2,'today admits only two');assert.equal(rankCalls,1)
  current=new Date('2026-09-21T09:00:00Z');await h.news.refresh();await waitFor(3)
  assert.equal(news().length,3,'the remaining article is still fresh after the daily allowance resets');assert.equal(rankCalls,1,'cached rankings do not need another model call')
  assert.equal(h.snapshot().conversations.messages.filter(row=>row.conversation_id==='chat:main'&&row.origin==='proactive').length,3)
  await h.news.refresh();await h.flushNotifications();assert.equal(news().length,3,'a later refresh does not push the same article twice')
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('a refresh recovers cached rankings after discovery is re-enabled and the host restarts',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-restart-'));let rankCalls=0
 const make=()=>{
  const h=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>NOW,
   rankNews:(interests,articles)=>{rankCalls++;return Promise.resolve(articles.map(a=>({id:a.id,matches:[{interest_id:interests[0]!.id,score:1,quote:a.title}],reason:'相关'})))}})
  h.news.options.now=()=>NOW;h.news.options.firstRefreshMs=null;h.news.options.fetcher=()=>Promise.resolve(new Response(feed(item(1))))
  return h
 }
 let h=make()
 try{
  await h.open();await h.command({type:'personal.command',request_id:'off',method:'discovery.configure',params:{enabled:false,timezone:'UTC'}});await h.news.configure({enabled:true,interests:['Voice AI'],explore:false});await h.news.refresh();await h.flushNotifications();assert.equal(h.snapshot().feed.length,0)
  await h.close();h=make();await h.open();await h.command({type:'personal.command',request_id:'on',method:'discovery.configure',params:{enabled:true}});await h.news.refresh()
  for(let i=0;i<200&&!h.snapshot().feed.length;i++)await new Promise(resolve=>setTimeout(resolve,10))
  await h.flushNotifications();assert.equal(h.snapshot().feed.length,1);assert.equal(rankCalls,1,'restart and re-enable reuse the saved ranking')
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('articles held back overnight cannot add up to more than the daily news allowance when they are delivered',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-overnight-'));let current=new Date('2026-09-19T23:00:00Z')
 const h=await host(dir,{now:()=>current})
 try{
  await h.command({type:'personal.command',request_id:'tz',method:'discovery.configure',params:{timezone:'UTC'}})
  const delivered=()=>h.snapshot().conversations.messages.filter(m=>m.conversation_id==='chat:main'&&m.origin==='proactive').length
  assert.equal(await h.admitNews(article(1),reason(1)),'admitted');assert.equal(await h.admitNews(article(2),reason(2)),'admitted')
  assert.equal(delivered(),0,'quiet hours hold both back')
  current=new Date('2026-09-20T09:00:00Z')
  assert.equal(await h.admitNews(article(3),reason(3)),'admitted');assert.equal(await h.admitNews(article(4),reason(4)),'admitted')
  await h.flushNotifications()
  assert.equal(delivered(),2,'four were admitted across two days, but only two may reach the user on one day')
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
test('articles ranked while an earlier push is still running are not lost',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-overlap-'));const h=await host(dir)
 try{
  const rank=(n:number)=>({...article(n),ranking:{id:'a'+n,matches:[],reason:'相关'+n,profile_version:1,ready_at:NOW.toISOString()}})
  let candidates=[rank(1)];h.news.pushCandidates=()=>candidates
  const admit=h.admitNews.bind(h);let release:()=>void=()=>undefined;const gate=new Promise<void>(resolve=>{release=resolve});let first=true,entered:()=>void=()=>undefined;const started=new Promise<void>(resolve=>{entered=resolve})
  h.admitNews=async(...args)=>{if(first){first=false;entered();await gate}return admit(...args)}
  h.news.options.ranked!();await started
  candidates=[rank(1),rank(2)];h.news.options.ranked!()
  release()
  for(let i=0;i<200&&!h.snapshot().feed.some(f=>f.subject_key==='news:a2');i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.ok(h.snapshot().feed.some(f=>f.subject_key==='news:a2'),'the article ranked during the first push was still pushed')
 }finally{await h.close();await rm(dir,{recursive:true,force:true})}
})
const at=(iso:string)=>({...article(1),published_at:iso,first_seen:iso})
async function overnight(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-night-'));let current=new Date('2026-09-20T22:30:00Z')
 const h=await host(dir,{now:()=>current})
 await h.command({type:'personal.command',request_id:'tz',method:'discovery.configure',params:{timezone:'UTC'}})
 return {h,dir,at:(iso:string)=>{current=new Date(iso)},delivered:()=>h.snapshot().conversations.messages.filter(m=>m.conversation_id==='chat:main'&&m.origin==='proactive').length,close:async()=>{await h.close();await rm(dir,{recursive:true,force:true})}}
}
test('an article whose text was edited after a push is the same article, so a dismissal stands',async()=>{
 const f=await overnight()
 try{
  f.at('2026-09-20T12:00:00Z');assert.equal(await f.h.admitNews({...article(1),published_at:'2026-09-20T11:00:00Z'},reason(1)),'admitted')
  const id=f.h.snapshot().feed.find(x=>x.subject_key==='news:a1')!.id
  await f.h.command({type:'personal.command',request_id:'d',method:'feed.action',params:{id,action:'dismiss'}})
  const edited={...article(1),content_hash:'edited',title:'Voice model 1 (updated)',published_at:'2026-09-20T11:00:00Z'}
  assert.equal(await f.h.admitNews(edited,reason(1)),'suppressed_duplicate')
  assert.equal(f.h.snapshot().feed.filter(x=>x.subject_key==='news:a1').length,1)
 }finally{await f.close()}
})
test('news admitted during quiet hours is not delivered once discovery or news has been turned off',async()=>{
 for(const off of ['discovery','news'] as const){
  const f=await overnight()
  try{
   assert.equal(await f.h.admitNews(at('2026-09-20T22:00:00Z'),reason(1)),'admitted');assert.equal(f.delivered(),0,'quiet hours hold it')
   if(off==='discovery')await f.h.command({type:'personal.command',request_id:'off',method:'discovery.configure',params:{enabled:false}})
   else await f.h.news.configure({enabled:false,interests:[],explore:false})
   f.at('2026-09-21T09:00:00Z');await f.h.flushNotifications()
   assert.equal(f.delivered(),0,off+' off: the held article stays undelivered')
  }finally{await f.close()}
 }
})
test('news keeps the age it had when it was published, so a night in quiet hours cannot make it fresh again',async()=>{
 const f=await overnight()
 try{
  assert.equal(await f.h.admitNews(at('2026-09-20T01:00:00Z'),reason(1)),'admitted','23 hours old at admission')
  assert.equal(f.h.snapshot().feed.find(x=>x.subject_key==='news:a1')!.expires_at,'2026-09-21T01:00:00.000Z','expires 24 hours after publication, not after admission')
  f.at('2026-09-21T09:00:00Z');await f.h.flushNotifications()
  assert.equal(f.delivered(),0,'by the time quiet hours end it is 32 hours old and is dropped')
 }finally{await f.close()}
})

test('blocking the source invalidates queued news before quiet hours end',async()=>{
 const f=await overnight()
 try{
  await f.h.admitNews(at('2026-09-20T22:00:00Z'),reason(1))
  const message=feedNotification(f.h.snapshot().feed.find(x=>x.subject_key==='news:a1')!)
  assert.equal(await f.h.notificationValidity(message),'defer')
  await f.h.news.action({action:'block',source_id:'bbc',value:true})
  assert.equal(f.h.news.pushEligibility('a1'),'ineligible')
  assert.equal(await f.h.notificationValidity(message),'invalid')
  f.at('2026-09-21T09:00:00Z');await f.h.flushNotifications();assert.equal(f.delivered(),0)
 }finally{await f.close()}
})

for(const matches of [false,true])test(`interest edits hold queued news until current-profile ranking finishes (matches=${matches})`,async()=>{
 const f=await overnight()
 try{
  await f.h.admitNews(at('2026-09-20T22:00:00Z'),reason(1))
  const message=feedNotification(f.h.snapshot().feed.find(x=>x.subject_key==='news:a1')!)
  await f.h.news.configure({enabled:true,interests:['Astronomy'],explore:false})
  assert.equal(f.h.news.pushEligibility('a1'),'pending')
  f.at('2026-09-21T09:00:00Z')
  assert.equal(await f.h.notificationValidity(message),'defer')
  await f.h.flushNotifications();assert.equal(f.delivered(),0)
  f.h.news.options.now=()=>NOW
  f.h.news.options.fetcher=()=>Promise.resolve(new Response('<rss><channel></channel></rss>'))
  f.h.news.options.rank=(interests,articles)=>Promise.resolve(articles.map(a=>({id:a.id,matches:matches?[{interest_id:interests[0]!.id,score:1,quote:a.title}]:[],reason:matches?'相关':''})))
  await f.h.news.refresh()
  assert.equal(f.h.news.pushEligibility('a1'),matches?'eligible':'ineligible')
  assert.equal(await f.h.notificationValidity(message),matches?'valid':'invalid')
  await f.h.flushNotifications();assert.equal(f.delivered(),matches?1:0)
 }finally{await f.close()}
})

test('disabled, expired and missing news is invalid even during quiet hours',async()=>{
 for(const invalid of ['discovery','news','expired','missing']){
  const f=await overnight()
  try{
   await f.h.admitNews({...at(invalid==='expired'?'2026-09-19T22:00:00Z':'2026-09-20T22:00:00Z'),id:invalid==='missing'?'missing':'a1'},reason(1))
   const message=feedNotification(f.h.snapshot().feed.find(x=>x.subject_key.startsWith('news:'))!)
   if(invalid==='discovery')await f.h.command({type:'personal.command',request_id:'off',method:'discovery.configure',params:{enabled:false}})
   if(invalid==='news')await f.h.news.configure({enabled:false,interests:[],explore:false})
   assert.equal(await f.h.notificationValidity(message),'invalid',invalid)
   await f.h.flushNotifications();assert.equal(f.delivered(),0)
  }finally{await f.close()}
 }
})
