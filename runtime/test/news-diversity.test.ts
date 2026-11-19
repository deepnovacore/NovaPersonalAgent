import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NewsService} from '../src/news/service.js'
import {parseFeed,type NewsSource} from '../src/news/feeds.js'
import {lifestyleNewsInterests} from '../src/news/interests.js'
const now=()=>new Date('2026-11-04T12:00:00Z')
const sources=(count:number):NewsSource[]=>Array.from({length:count},(_,i)=>({id:'source-'+i,name:'Source '+i,url:`https://source-${i}.example/rss`,language:'en'}))
const xml=(id:string,count=12)=>'<rss><channel>'+Array.from({length:count},(_,i)=>`<item><title>${i===0?'Health research':'Other news'} ${i}</title><link>https://${id}.example/${i}</link><pubDate>Wed, 04 Nov 2026 11:00:00 GMT</pubDate></item>`).join('')+'</channel></rss>'
async function fixture(count:number,match=false){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-diversity-')),ranked:string[]=[]
 let clock=now()
 const service=new NewsService({path:join(dir,'news.json'),sources:sources(count),now:()=>clock,firstRefreshMs:null,
  fetcher:(url)=>Promise.resolve(new Response(xml(new URL(typeof url==='string'?url:url instanceof URL?url.href:url.url).hostname.split('.')[0]!))),
  rank:(interests,articles)=>{ranked.push(...articles.map(a=>a.source_id));return Promise.resolve(articles.map(a=>({id:a.id,matches:match&&a.title.startsWith('Health')?[{interest_id:(interests.find(i=>i.text==='Health')??interests[0])!.id,score:1,quote:'Health research'}]:[],reason:''})))}})
 await service.open()
 return {service,ranked,advance:()=>{clock=new Date(clock.getTime()+1000)},close:async()=>{await service.close();await rm(dir,{recursive:true,force:true})}}
}
test('seeded interests rank the page but still never authorize push, even with a strong score',async()=>{
 const f=await fixture(4,true);try{
  await f.service.seedInterests(['Health']);await f.service.refresh()
  const snapshot=f.service.snapshot();assert.equal(snapshot.mode,'personalized');assert.ok(snapshot.items[0]!.ranking?.matches.length)
  assert.deepEqual(f.service.pushCandidates(),[]);assert.equal(f.service.pushEligibility(snapshot.items[0]!.id),'ineligible')
 }finally{await f.close()}
})
test('weak matches fill twelve fresh diverse cards with bounded source counts and exploration',async()=>{
 const f=await fixture(4,true);try{
  await f.service.configure({enabled:true,explore:true,interests:['Health']});await f.service.refresh()
  const snapshot=f.service.snapshot();assert.equal(snapshot.items.length,12);assert.equal(snapshot.items.filter(a=>a.exploration).length,2)
  const counts=new Map<string,number>();for(const item of snapshot.items)counts.set(item.source_id,(counts.get(item.source_id)??0)+1)
  assert.equal(counts.size,4);assert.ok([...counts.values()].every(n=>n<=3));assert.ok(snapshot.items.some(a=>!a.ranking?.matches.length))
  await f.service.configure({enabled:true,explore:false,interests:[]});assert.equal(f.service.snapshot().items.length,12,'empty interests still have a timeline')
 }finally{await f.close()}
})
test('ranking work scales with source count but is capped per refresh and per source',async()=>{
 for(const [count,expected,quota] of [[2,24,12],[8,32,4],[30,96,4]]){
  const f=await fixture(count!);try{
   await f.service.seedInterests(['Health']);await f.service.refresh();assert.equal(f.ranked.length,expected)
   for(const source of sources(count!))assert.ok(f.ranked.filter(id=>id===source.id).length<=quota!)
  }finally{await f.close()}
 }
})
test('mining never evicts confirmed interests and evicts older/lower-weight mined cues',async()=>{
 const f=await fixture(1);try{
  await f.service.configure({enabled:true,explore:true,interests:['My health','My music']})
  await f.service.seedInterests(['a','b','c','d','e','f']);assert.equal(f.service.snapshot().interests.length,8)
  f.advance();await f.service.seedInterests(['new']);const texts=f.service.snapshot().interests.map(i=>i.text)
  assert.ok(texts.includes('My health'));assert.ok(texts.includes('My music'));assert.ok(texts.includes('new'));assert.equal(texts.length,8)
  const mined=f.service.snapshot().interests.filter(i=>i.seeded),heavy=mined[0]!
  await f.service.action({action:'weight',interest_id:heavy.id,value:2});f.advance();await f.service.seedInterests(mined.map(i=>i.text).reverse().concat('overflow'))
  assert.ok(f.service.snapshot().interests.some(i=>i.id===heavy.id),'weight breaks equal-recency ties')
  await f.service.clearSeededInterests();assert.deepEqual(f.service.snapshot().interests.map(i=>i.text),['My health','My music'])
  await f.service.configure({enabled:true,explore:true,interests:Array.from({length:8},(_,i)=>'Confirmed '+i)})
  assert.equal(await f.service.seedInterests(['Travel']),false);assert.ok(f.service.snapshot().interests.every(i=>!i.seeded))
 }finally{await f.close()}
})
test('mixed profiles cannot push on a mined match',async()=>{
 const f=await fixture(1,true);try{
  await f.service.configure({enabled:true,explore:true,interests:['Health']});await f.service.seedInterests(['Travel']);await f.service.refresh()
  assert.ok(f.service.pushCandidates().length,'confirmed matches still authorize push')
  await f.service.configure({enabled:true,explore:true,interests:['Other']});await f.service.seedInterests(['Health'])
  await f.service.refresh();assert.ok(f.service.snapshot().items.some(a=>a.ranking?.matches.length));assert.deepEqual(f.service.pushCandidates(),[])
 }finally{await f.close()}
})
test('RDF dc:date and RSS CDATA/numeric timezone formats parse synthetic DW, China News, FT and RFI excerpts',()=>{
 const source=sources(1)[0]!
 const rdf='<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><item><title>Health</title><link>https://example.com/rdf</link><dc:date>2026-11-04T11:00:00Z</dc:date><description>Details</description></item></rdf:RDF>'
 assert.equal(parseFeed(rdf,source,now())[0]!.published_at,'2026-11-04T11:00:00.000Z')
 for(const timestamp of ['2026-11-04 19:00:00 +0800','Wed, 04 Nov 2026 11:00:00 GMT']){
  const feed=`<rss><channel><item><title><![CDATA[Health &amp; food]]></title><link>https://example.com/rss</link><description><![CDATA[<p>Details</p>]]></description><pubDate>${timestamp}</pubDate></item></channel></rss>`
  const row=parseFeed(feed,source,now())[0]!;assert.equal(row.summary,'Details');assert.equal(row.published_at,'2026-11-04T11:00:00.000Z')
 }
})
test('lifestyle hints stay bounded, approximate and language appropriate',()=>{
 assert.deepEqual(lifestyleNewsInterests(['I enjoy cooking and hiking']),['Food','Travel'])
 assert.deepEqual(lifestyleNewsInterests(['喜欢跑步和园艺'],'zh-CN'),['体育','园艺'])
 assert.deepEqual(lifestyleNewsInterests(['Unrelated meeting notes']),[])
})
