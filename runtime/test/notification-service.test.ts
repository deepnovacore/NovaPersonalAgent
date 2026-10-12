import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NotificationService} from '../src/notifications/service.js'
import type {ChannelBinding,NotificationChannelAdapter,NotificationInput,SendOutcome} from '../src/notifications/contracts.js'

const binding=(id:string):ChannelBinding=>({id,provider:id,user_scope:'u',generation:1,identity:id,status:'ready'})
const message=(key='one'):NotificationInput=>({event_key:key,revision:'1',occurrence:'initial',kind:'suggestion',title:'Reminder',body:'complete body',source:{type:'feed',id:key},created_at:1000,expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[]})
async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-notification-'));let now=1000
 const sent:{target:string,key:string,body:string}[]=[]
 let outcome:SendOutcome={kind:'accepted',receipt:{message_id:'remote'}}
 let barrier:(()=>Promise<void>)|undefined
 const adapter=(id:string):NotificationChannelAdapter=>({providerId:id,inspect:()=>Promise.resolve(true),prepare:n=>Promise.resolve([{body:n.body,title:n.title}]),send:async(part,c)=>{sent.push({target:c.binding.id,key:c.idempotency_key,body:part.body});await barrier?.();return outcome}})
 const make=()=>new NotificationService({path:join(dir,'state.json'),userScope:'u',adapters:[adapter('nova'),adapter('im'),adapter('other')],now:()=>now,random:()=>0.5})
 const service=make();await service.open();for(const id of ['nova','im','other'])await service.bind(binding(id))
 return {service,make,sent,setNow:(v:number)=>{now=v},setOutcome:(v:SendOutcome)=>{outcome=v},barrier:(v:()=>Promise<void>)=>{barrier=v},close:async()=>{await service.close();await rm(dir,{recursive:true,force:true})}}
}

test('durable admission deduplicates restart and route changes do not replay accepted messages',async()=>{
 const f=await fixture();try{await f.service.configure('im');await f.service.publish(message());await f.service.publish(message());await f.service.dispatch();assert.equal(f.sent.length,1);assert.equal(f.service.snapshot().counts.accepted,1)
 await f.service.close();const recovered=f.make();await recovered.open();await recovered.publish(message());await recovered.configure('other');await recovered.dispatch();assert.equal(f.sent.length,1);await recovered.close()
 }finally{await f.close()}
})
test('switch migrates unsent notifications but never sends a racing request to both channels',async()=>{
 const f=await fixture();try{await f.service.publish(message());await f.service.configure('im');let release!:()=>void,entered!:()=>void;const reached=new Promise<void>(r=>{entered=r});f.barrier(()=>{entered();return new Promise<void>(r=>{release=r})});const run=f.service.dispatch();await reached;await f.service.configure('other');release();await run;await f.service.dispatch();assert.deepEqual(f.sent.map(x=>x.target),['im']);assert.equal(f.service.snapshot().primary_binding_id,'other')
 }finally{await f.close()}
})
test('unknown send outcome survives restart and is never blindly retried',async()=>{
 const f=await fixture();try{await f.service.configure('im');f.setOutcome({kind:'unknown',reason:'timeout'});await f.service.publish(message());await f.service.dispatch();assert.equal(f.service.snapshot().counts.unknown,1);await f.service.close();const recovered=f.make();await recovered.open();await recovered.configure('other');await recovered.dispatch();assert.equal(f.sent.length,1);assert.equal(recovered.snapshot().counts.unknown,1);await recovered.close()
 }finally{await f.close()}
})
test('definite rejection backs off and retries with the same idempotency key',async()=>{
 const f=await fixture();try{await f.service.configure('im');f.setOutcome({kind:'retryable',definitelyNotAccepted:true,retryAfterMs:20000});await f.service.publish(message());await f.service.dispatch();await f.service.dispatch();assert.equal(f.sent.length,1);f.setNow(21000);f.setOutcome({kind:'accepted',receipt:{message_id:'ok'}});await f.service.dispatch();assert.equal(f.sent.length,2);assert.equal(f.sent[0]!.key,f.sent[1]!.key)
 }finally{await f.close()}
})
test('binding generation change cannot redirect queued content to another identity',async()=>{
 const f=await fixture();try{await f.service.configure('im');await f.service.publish(message());await f.service.bind({...binding('im'),identity:'different',generation:2});await f.service.dispatch();assert.equal(f.sent.length,0);assert.equal(f.service.snapshot().counts.blocked,1)
 }finally{await f.close()}
})
test('invalidation erases pending content and snooze occurrence is independently deliverable',async()=>{
 const f=await fixture();try{await f.service.configure('im');await f.service.publish(message());await f.service.invalidate('feed','one');await f.service.dispatch();assert.equal(f.sent.length,0);await f.service.publish({...message('next'),not_before:5000});await f.service.dispatch();assert.equal(f.sent.length,0);f.setNow(5000);await f.service.dispatch();await f.service.publish({...message('next'),occurrence:'snooze:6000',not_before:6000});f.setNow(6000);await f.service.dispatch();assert.equal(f.sent.length,2);assert.notEqual(f.sent[0]!.key,f.sent[1]!.key)
 }finally{await f.close()}
})
test('multipart retry preserves receipts and does not resend accepted parts',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-notification-parts-'));let now=1000;const sent:string[]=[];let fail=true
 const adapter:NotificationChannelAdapter={providerId:'nova',inspect:()=>Promise.resolve(true),prepare:()=>Promise.resolve([{title:'a',body:'first'},{title:'b',body:'second'}]),send:p=>{sent.push(p.body);return Promise.resolve(p.body==='second'&&fail?{kind:'retryable',definitelyNotAccepted:true}:{kind:'accepted',receipt:{message_id:p.body}})}}
 const s=new NotificationService({path:join(dir,'state.json'),userScope:'u',adapters:[adapter],now:()=>now,random:()=>0.5});try{await s.open();await s.publish(message());await s.dispatch();assert.deepEqual(sent,['first','second']);fail=false;now=21000;await s.dispatch();assert.deepEqual(sent,['first','second','second']);assert.equal(s.snapshot().counts.accepted,1)}finally{await s.close();await rm(dir,{recursive:true,force:true})}
})

test('legacy additional delivery is retained until an explicit primary choice',async()=>{
 const f=await fixture();try{await f.service.migrate('im');await f.service.publish(message());await f.service.dispatch();assert.deepEqual(f.sent.map(x=>x.target),['nova','im']);await f.service.configure('im');await f.service.publish(message('new'));await f.service.dispatch();assert.deepEqual(f.sent.map(x=>x.target),['nova','im','im'])}finally{await f.close()}
})
test('definitely unsent racing request follows the new route after its rejection',async()=>{
 const f=await fixture();try{await f.service.publish(message());let release!:()=>void,entered!:()=>void;const reached=new Promise<void>(r=>{entered=r});f.barrier(()=>{entered();return new Promise<void>(r=>{release=r})});f.setOutcome({kind:'retryable',definitelyNotAccepted:true});const run=f.service.dispatch();await reached;await f.service.configure('im');release();await run;f.barrier(()=>Promise.resolve());f.setOutcome({kind:'accepted',receipt:{message_id:'done'}});await f.service.dispatch();assert.deepEqual(f.sent.map(x=>x.target),['nova','im']);assert.equal(f.service.snapshot().counts.accepted,1)}finally{await f.close()}
})
test('invalidation during preparation stops the first send and erases its prepared body',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-invalidate-'));let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r});let sends=0;
 const adapter:NotificationChannelAdapter={providerId:'nova',inspect:()=>Promise.resolve(true),prepare:async()=>{enter();await new Promise<void>(r=>{release=r});return [{title:'private',body:'private'}]},send:()=>{sends++;return Promise.resolve({kind:'accepted',receipt:{message_id:'bad'}})}};
 const service=new NotificationService({path:join(dir,'state.json'),userScope:'u',adapters:[adapter]});try{await service.open();await service.publish({...message(),created_at:Date.now()});const run=service.dispatch();await entered;await service.invalidate('feed','one');release();await run;assert.equal(sends,0);assert.equal(service.snapshot().counts.cancelled,1)}finally{await service.close();await rm(dir,{recursive:true,force:true})}
})

test('explicit selection of a replacement account never migrates the old identity queue',async()=>{
 const f=await fixture();try{await f.service.configure('im');await f.service.publish(message());await f.service.bind({...binding('im'),identity:'new-account',generation:2});await f.service.configure('im');await f.service.dispatch();assert.equal(f.sent.length,0);assert.equal(f.service.snapshot().counts.blocked,1)}finally{await f.close()}
})
test('obsolete multipart validity cancels only its version, not the replacement',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-revisions-'));let revision='1',release!:()=>void,enter!:()=>void;const entered=new Promise<void>(r=>{enter=r});const sent:string[]=[];
 const adapter:NotificationChannelAdapter={providerId:'nova',inspect:()=>Promise.resolve(true),prepare:n=>Promise.resolve([{title:n.title,body:n.revision+'-a'},{title:n.title,body:n.revision+'-b'}]),send:async p=>{sent.push(p.body);if(p.body==='1-a'){enter();await new Promise<void>(r=>{release=r})}return {kind:'accepted',receipt:{message_id:p.body}}}};
 const service=new NotificationService({path:join(dir,'state.json'),userScope:'u',adapters:[adapter],now:()=>1000,valid:n=>Promise.resolve(n.revision===revision?'valid':'invalid')});try{await service.open();await service.publish(message());const run=service.dispatch();await entered;revision='2';await service.publish({...message(),revision});release();await run;await service.dispatch();assert.deepEqual(sent,['1-a','2-a','2-b']);assert.equal(service.snapshot().counts.accepted,1)}finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
