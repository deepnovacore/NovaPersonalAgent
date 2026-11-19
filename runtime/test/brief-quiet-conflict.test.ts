import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {briefQuietConflicts,dueDailyBriefs} from '../src/personal-agent/daily-brief.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'

test('a brief is in conflict only when it is switched on and its time sits inside quiet hours',()=>{
 assert.deepEqual(briefQuietConflicts({discovery_enabled:true,discovery_interval_minutes:30}),[],'both off by default')
 assert.deepEqual(briefQuietConflicts({discovery_enabled:true,discovery_interval_minutes:30,briefing_outlook_enabled:true,briefing_outlook_time:'07:30'}),['outlook'],'07:30 is before the default 08:00 end')
 assert.deepEqual(briefQuietConflicts({discovery_enabled:true,discovery_interval_minutes:30,briefing_outlook_enabled:true,briefing_review_enabled:true}),[],'the defaults 08:30 and 18:30 are fine')
 assert.deepEqual(briefQuietConflicts({discovery_enabled:true,discovery_interval_minutes:30,briefing_review_enabled:true,briefing_review_time:'23:00'}),['review'],'23:00 is after the 22:00 start')
 assert.deepEqual(briefQuietConflicts({discovery_enabled:true,discovery_interval_minutes:30,briefing_outlook_enabled:false,briefing_outlook_time:'03:00'}),[],'a switched-off brief cannot conflict')
 assert.deepEqual(briefQuietConflicts({discovery_enabled:true,discovery_interval_minutes:30,briefing_outlook_enabled:true,briefing_outlook_time:'03:00',quiet_start:'09:00',quiet_end:'09:00'}),[],'equal start and end means no quiet hours')
 assert.deepEqual(briefQuietConflicts({discovery_enabled:true,discovery_interval_minutes:30,briefing_outlook_enabled:true,briefing_review_enabled:true,briefing_outlook_time:'12:00',briefing_review_time:'12:30',quiet_start:'11:00',quiet_end:'13:00'}),['outlook','review'])
})
test('the conflict predicate agrees with the scheduler: a conflicting brief is never due, a clear one is',()=>{
 const base={discovery_enabled:true,discovery_interval_minutes:30,timezone:'UTC',briefing_outlook_enabled:true,briefing_weekdays:[1,2,3,4,5,6,7]}
 const noon=new Date('2026-09-23T07:35:00Z')
 assert.equal(dueDailyBriefs({...base,briefing_outlook_time:'07:30'},noon,[]).length,0,'quiet until 08:00, so never due')
 assert.equal(briefQuietConflicts({...base,briefing_outlook_time:'07:30'}).length,1)
 assert.equal(dueDailyBriefs({...base,briefing_outlook_time:'07:30',quiet_end:'07:00'},noon,[]).length,1)
 assert.equal(briefQuietConflicts({...base,briefing_outlook_time:'07:30',quiet_end:'07:00'}).length,0)
})

async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-brief-conflict-')),path=join(dir,'state.json')
 const make=()=>new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null})
 let host=make(),requests=0;await host.open()
 const configure=(params:Record<string,unknown>)=>host.command({type:'personal.command',request_id:'c-'+(++requests),method:'discovery.configure',params}) as Promise<{ok:boolean;error?:string}>
 return {configure,host:()=>host,path,reopen:async()=>{await host.close();host=make();await host.open()},close:async()=>{await host.close();await rm(dir,{recursive:true,force:true})}}
}
test('saving a brief inside quiet hours is refused, and nothing is stored',async()=>{
 const f=await fixture()
 try{
  const result=await f.configure({briefing_outlook_enabled:true,briefing_outlook_time:'07:30'})
  assert.equal(result.ok,false);assert.equal(result.error,'brief_in_quiet_hours')
  const settings=f.host().snapshot().settings;assert.equal(settings.briefing_outlook_enabled,false,'still the default');assert.equal(settings.briefing_outlook_time,'08:30','still the default')
 }finally{await f.close()}
})
test('moving quiet hours so they swallow an enabled brief is refused too',async()=>{
 const f=await fixture()
 try{
  assert.equal((await f.configure({briefing_review_enabled:true,briefing_review_time:'18:30'})).ok,true)
  const result=await f.configure({quiet_start:'18:00',quiet_end:'19:00'})
  assert.equal(result.ok,false);assert.equal(result.error,'brief_in_quiet_hours')
  assert.equal(f.host().snapshot().settings.quiet_start,'22:00','the refused change was not stored')
  assert.equal((await f.configure({quiet_start:'22:00',quiet_end:'07:00'})).ok,true)
 }finally{await f.close()}
})
test('a clear configuration saves, and unrelated settings are never blocked by an old conflict',async()=>{
 const f=await fixture()
 try{
  assert.equal((await f.configure({briefing_outlook_enabled:true,briefing_outlook_time:'08:30',briefing_review_enabled:true,briefing_review_time:'18:30'})).ok,true)
  await f.host().close()
  // A conflict already on disk (saved before this check existed) must not lock the user out of unrelated settings.
  const stored=JSON.parse(await readFile(f.path,'utf8')) as {settings:Record<string,unknown>};stored.settings.briefing_outlook_time='07:30';await writeFile(f.path,JSON.stringify(stored))
  await f.reopen()
  assert.equal(f.host().snapshot().settings.briefing_outlook_time,'07:30')
  assert.equal((await f.configure({proactive_daily_cap:3})).ok,true)
  assert.equal((await f.configure({briefing_outlook_time:'07:45'})).ok,false,'but touching the brief fields validates them')
  assert.equal((await f.configure({briefing_outlook_time:'09:00'})).ok,true)
 }finally{await f.close()}
})
