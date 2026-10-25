import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {NewsRanker} from '../src/news/ranking.js'

async function fixture(withFallback=true){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-news-fallback-')),path=join(dir,'state.json'),used:string[]=[]
 const rankNews:NewsRanker=()=>{used.push('jev');return Promise.resolve([])},rankNewsFallback:NewsRanker=()=>{used.push('support');return Promise.resolve([])}
 const host=new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,rankNews,...(withFallback?{rankNewsFallback}:{})})
 await host.open()
 const configure=(params:Record<string,unknown>)=>host.command({type:'personal.command',request_id:'cfg-'+JSON.stringify(params),method:'discovery.configure',params}) as Promise<{ok:boolean}>
 const rank=()=>host.news.options.rank!([],[],new AbortController().signal)
 return {host,used,configure,rank,close:async()=>{await host.close();await rm(dir,{recursive:true,force:true})}}
}
test('discovery.configure stores news_rank_fallback, defaults it on, keeps it when omitted and rejects non-booleans',async()=>{
 const f=await fixture();try{
  assert.equal(f.host.snapshot().settings.news_rank_fallback,true)
  assert.equal((await f.configure({news_rank_fallback:false})).ok,true);assert.equal(f.host.snapshot().settings.news_rank_fallback,false)
  assert.equal((await f.configure({proactive_daily_cap:6})).ok,true);assert.equal(f.host.snapshot().settings.news_rank_fallback,false,'omitted field keeps the stored value')
  for(const value of ['true',1,null])assert.equal((await f.configure({news_rank_fallback:value})).ok,false,String(value))
  assert.equal(f.host.snapshot().settings.news_rank_fallback,false)
  assert.equal((await f.configure({news_rank_fallback:true})).ok,true);assert.equal(f.host.snapshot().settings.news_rank_fallback,true)
 }finally{await f.close()}
})
test('the news ranker is chosen on every call from the current switch, without a restart',async()=>{
 const f=await fixture();try{
  await f.rank();await f.configure({news_rank_fallback:false});await f.rank();await f.configure({news_rank_fallback:true});await f.rank()
  assert.deepEqual(f.used,['support','jev','support'])
 }finally{await f.close()}
 const keyed=await fixture(false);try{await keyed.rank();assert.deepEqual(keyed.used,['jev'],'no fallback ranker (a key exists) always uses Jev')}finally{await keyed.close()}
})
