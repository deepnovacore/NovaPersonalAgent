import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {PersonalStore,initialState} from '../src/personal-agent/store.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {NotificationInput} from '../src/notifications/contracts.js'

// 2026-10-12 20:00 in Shanghai; 16:30Z is already the next local date there while UTC is still the 12th.
const start=Date.parse('2026-10-12T12:00:00Z'),nextLocalDay=Date.parse('2026-10-12T16:30:00Z')
async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-proactive-cap-')),path=join(dir,'state.json');let clock=start
 const state=initialState();state.settings={discovery_enabled:false,discovery_interval_minutes:30,timezone:'Asia/Shanghai',quiet_start:'00:00',quiet_end:'00:00'};await new PersonalStore(path).write(state)
 const host=new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>new Date(clock)})
 await host.open()
 const notice=(key:string,over:Partial<NotificationInput>={}):NotificationInput=>({event_key:key,revision:'1',occurrence:'initial',kind:'suggestion',title:key,body:key,source:{type:'runtime',id:key},created_at:clock,expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[],guard:{requires_runtime:true},...over})
 const publish=(key:string,over:Partial<NotificationInput>={})=>host.publishNotification(notice(key,over),()=>true)
 const status=(key:string)=>host.notifications.snapshot().deliveries.find(d=>d.title===key)?.status
 const configure=(params:Record<string,unknown>)=>host.command({type:'personal.command',request_id:'cfg-'+JSON.stringify(params),method:'discovery.configure',params}) as Promise<{ok:boolean;error?:string}>
 return {host,publish,status,configure,setClock:(v:number)=>{clock=v},close:async()=>{await host.close();await rm(dir,{recursive:true,force:true})}}
}

test('proactive messages beyond the daily cap are deferred until the next local date; responses and preemptive alerts are not capped',async()=>{
 const f=await fixture();try{
  for(const key of ['s1','s2','s3'])await f.publish(key)
  assert.deepEqual(['s1','s2','s3'].map(f.status),['accepted','accepted','accepted'],'the default cap of 3 delivers within quota')
  await f.publish('s4');await f.publish('b5',{kind:'brief'})
  assert.equal(f.status('s4'),'pending','the fourth suggestion is deferred, not dropped');assert.equal(f.status('b5'),'pending','briefs share the same quota')
  await f.publish('result',{kind:'task_result'});await f.publish('urgent',{priority:100})
  assert.equal(f.status('result'),'accepted','task results answer the user and are never capped');assert.equal(f.status('urgent'),'accepted','priority 100 is exempt like quiet hours')
  await f.host.flushNotifications();assert.equal(f.status('s4'),'pending','a later flush on the same local date still defers')
  f.setClock(nextLocalDay);await f.host.flushNotifications()
  assert.equal(f.status('s4'),'accepted','the next local date in the user timezone delivers the deferred message');assert.equal(f.status('b5'),'accepted')
 }finally{await f.close()}
})

test('superseded and expired proactive deliveries do not consume the daily cap',async()=>{
 const f=await fixture();try{
  await f.publish('old',{coalesce_key:'same',not_before:start+3600000});await f.publish('replacement',{coalesce_key:'same',not_before:start+3600000})
  assert.equal(f.status('old'),'superseded')
  await f.publish('stale',{expires_at:start+1000,not_before:start+500});f.setClock(start+2000);await f.host.flushNotifications()
  assert.equal(f.status('stale'),'expired')
  for(const key of ['fresh1','fresh2','fresh3']){await f.publish(key);assert.equal(f.status(key),'accepted','neither superseded nor expired deliveries count')}
  await f.publish('over');assert.equal(f.status('over'),'pending','accepted deliveries do count')
 }finally{await f.close()}
})

test('discovery.configure stores the daily cap, keeps it when omitted and rejects values outside 1-10',async()=>{
 const f=await fixture();try{
  assert.equal(f.host.snapshot().settings.proactive_daily_cap,3,'default cap')
  assert.equal((await f.configure({proactive_daily_cap:7})).ok,true);assert.equal(f.host.snapshot().settings.proactive_daily_cap,7)
  assert.equal((await f.configure({enabled:false})).ok,true);assert.equal(f.host.snapshot().settings.proactive_daily_cap,7,'omitted field keeps the stored value')
  for(const value of [0,11,2.5,'3'])assert.equal((await f.configure({proactive_daily_cap:value})).ok,false,String(value))
  assert.equal(f.host.snapshot().settings.proactive_daily_cap,7)
 }finally{await f.close()}
})

test('NotificationService counts only accepted deliveries of the requested kinds on the local date of the given timezone',async()=>{
 const {NotificationService}=await import('../src/notifications/service.js')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-delivered-today-'));let now=Date.parse('2026-10-12T15:30:00Z')
 const service=new NotificationService({path:join(dir,'n.json'),userScope:'u',adapters:[{providerId:'nova',inspect:()=>Promise.resolve(true),prepare:n=>Promise.resolve([{title:n.title,body:n.body}]),send:()=>Promise.resolve({kind:'accepted',receipt:{message_id:'m'}})}],now:()=>now})
 const notice=(key:string,kind:NotificationInput['kind']):NotificationInput=>({event_key:key,revision:'1',occurrence:'initial',kind,title:key,body:key,source:{type:'runtime',id:key},created_at:now,expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[]})
 try{await service.open()
  await service.publish(notice('a','suggestion'));await service.publish(notice('b','task_result'));await service.dispatch()
  await service.publish(notice('c','brief'));await service.dispatch();await service.publish(notice('pending','suggestion'))
  assert.equal(service.deliveredToday(['brief','suggestion'],'Asia/Shanghai',now),2,'23:30 local: two proactive deliveries today')
  assert.equal(service.deliveredToday(['task_result'],'Asia/Shanghai',now),1)
  now=Date.parse('2026-10-12T16:00:00Z')
  assert.equal(service.deliveredToday(['brief','suggestion'],'Asia/Shanghai',now),0,'local midnight in Shanghai starts a new day')
  assert.equal(service.deliveredToday(['brief','suggestion'],'UTC',now),2,'the same instant is still the same UTC date')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
