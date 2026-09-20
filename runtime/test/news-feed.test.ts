import type {ModelGateway} from '../src/model/model-gateway.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseFeed} from '../src/news/feeds.js'
import {NewsService} from '../src/news/service.js'
const source={id:'bbc',name:'BBC',url:'https://feeds.bbci.co.uk/news/rss.xml'}
const xml='<rss><channel><item><title>AI research</title><link>https://www.bbc.com/news/one?utm_source=rss</link><description><![CDATA[<b>Voice models</b> improve latency]]></description><pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>'
test('RSS and Atom normalize safe text, links and dates; HTML and DTD are rejected',()=>{
 const a=parseFeed(xml,source,new Date('2026-09-20T11:00:00Z'))
 assert.equal(a.length,1);assert.equal(a[0]!.url,'https://www.bbc.com/news/one');assert.equal(a[0]!.summary,'Voice models improve latency')
 assert.equal(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>One</title><link href="https://example.com/one"/><summary>News</summary></entry></feed>',source,new Date())[0]!.published_at,null)
 assert.throws(()=>parseFeed('<html><body>Access denied</body></html>',source,new Date()),/feed/)
 assert.throws(()=>parseFeed('<!DOCTYPE rss><rss/>',source,new Date()),/doctype/)
 assert.equal(parseFeed('<rss><channel><item><title>X</title><link>javascript:alert(1)</link></item></channel></rss>',source,new Date()).length,0)
})
test('real service persists explicit interests, dedupes refresh, applies idempotent feedback and survives source failure',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-'));let broken=false,calls=0
 const make=()=>new NewsService({path:join(dir,'news.json'),sources:[source],fetcher:()=>{calls++;return Promise.resolve(new Response(broken?'<html>blocked</html>':xml))},rank:(interests,articles)=>Promise.resolve(articles.map(a=>({id:a.id,matches:[{interest_id:interests[0]!.id,score:0.9,quote:'AI research'}],reason:'与你关注的 AI 研究相关'})))})
 let service=make();await service.open()
 try{
  await service.refresh();assert.equal(calls,0,'no silent fetch before explicit enable')
  await service.configure({enabled:true,interests:['AI'],explore:false});await service.refresh()
  const row=service.snapshot().items[0]!;assert.equal(row.ranking?.reason,'与你关注的 AI 研究相关')
  await service.refresh();assert.equal(service.snapshot().items.length,1)
  await service.action({id:row.id,action:'save',value:true});await service.action({id:row.id,action:'read',value:true})
  const interest_id=service.snapshot().interests[0]!.id
  await service.action({action:'weight',interest_id,value:0.5});await service.action({action:'weight',interest_id,value:0.5})
  assert.equal(service.snapshot().interests[0]!.weight,0.5)
  broken=true;await service.refresh();assert.equal(service.snapshot().items.length,1);assert.equal(service.snapshot().sources[0]!.error,'invalid_feed')
  await service.close();service=make();await service.open();assert.equal(service.snapshot().items[0]!.saved,true);assert.equal(service.snapshot().items[0]!.read,true)
  await service.action({action:'block',source_id:'bbc',value:true});assert.equal(service.snapshot().items.length,0)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('profile changes fence late ranking and quoted evidence is validated',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-race-'));let release:()=>void=()=>{/* optional cleanup/observer */};let started:()=>void=()=>{/* optional cleanup/observer */};const entered=new Promise<void>(r=>{started=r})
 const service=new NewsService({path:join(dir,'news.json'),sources:[source],fetcher:()=>Promise.resolve(new Response(xml)),rank:async(interests,articles)=>{started();await new Promise<void>(r=>{release=r});return articles.map(a=>({id:a.id,matches:[{interest_id:interests[0]!.id,score:1,quote:'AI research'}],reason:'AI'}))}})
 await service.open()
 try{await service.configure({enabled:true,interests:['AI'],explore:false});const run=service.refresh();await entered;await service.configure({enabled:true,interests:['Gardening'],explore:false});release();await run;assert.equal(service.snapshot().items[0]!.ranking,null);assert.equal(service.snapshot().pending,1)}finally{release();await service.close();await rm(dir,{recursive:true,force:true})}
})
test('ranking carries an explicit output schema even for JSON-object-only gateways',async()=>{
 const {createNewsRanker}=await import('../src/news/ranking.js');let prompt=''
 const gateway={complete:(request:{prompt:string})=>{prompt=request.prompt;return Promise.resolve({text:JSON.stringify({scores:[]})})}}
 await createNewsRanker(gateway as unknown as ModelGateway,'model')([],[],new AbortController().signal)
 assert.match(prompt,/"output_schema"/u);assert.match(prompt,/"scores"/u)
})
test('refresh requested during ranking runs again for changed interests',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-rerun-'));let release:()=>void=()=>{/* optional cleanup/observer */};let entered:()=>void=()=>{/* optional cleanup/observer */};const started=new Promise<void>(r=>{entered=r});const profiles:string[]=[]
 const service=new NewsService({path:join(dir,'news.json'),sources:[source],fetcher:()=>Promise.resolve(new Response(xml)),rank:async(interests,articles)=>{profiles.push(interests[0]!.text);if(profiles.length===1){entered();await new Promise<void>(r=>{release=r})}return articles.map(a=>({id:a.id,matches:[],reason:''}))}})
 await service.open();try{await service.configure({enabled:true,interests:['AI'],explore:false});const first=service.refresh();await started;await service.configure({enabled:true,interests:['Travel'],explore:false});const second=service.refresh();release();await Promise.all([first,second]);assert.deepEqual(profiles,['AI','Travel']);assert.equal(service.snapshot().pending,0)}finally{release();await service.close();await rm(dir,{recursive:true,force:true})}
})
