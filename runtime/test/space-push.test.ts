import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compactDecrypt} from 'jose';
import {SpacePushDelivery} from '../src/space-host/push.js';
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {spaceRelayNotificationAdapter} from '../src/notifications/adapters/space-relay.js';
import type {NotificationInput} from '../src/notifications/contracts.js';

test('Host push isolates configured gateway and encrypts human content with per-handle native key',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-host-push-'));let sends=0;let expectedKey='';
 const request:typeof fetch=async(url,init)=>{
  assert.equal((typeof url==='string'?url:url instanceof URL?url.href:url.url),'https://push.example.invalid/v1/push');assert.equal((init!.headers as Record<string,string>).authorization,'Bearer opaque-scoped-credential');
  assert.equal(typeof init!.body,'string');const body=init!.body as string;const data=JSON.parse(body) as {handle:string;notificationId:string;ciphertext:string};assert.equal(data.handle,'opaque-handle');assert.ok(!body.includes('private content'));assert.ok(!body.includes('SpaceID'));
  const plain=await compactDecrypt(data.ciphertext,Buffer.from(expectedKey,'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(plain.plaintext).toString()),{title:'Nova',body:'private content'});sends++;return new Response(JSON.stringify({status:'accepted',retryable:false}));
 };
 const make=()=>new SpacePushDelivery({path:join(dir,'push.json'),gatewayUrl:'https://push.example.invalid',request});let push=make();
 try{await push.open();await assert.rejects(push.register('phone',{handle:'opaque-handle',credential:'opaque-scoped-credential',gateway_url:'https://evil.invalid'}),/gateway_not_allowed/);
 const key=await push.register('phone',{handle:'opaque-handle',credential:'opaque-scoped-credential'});expectedKey=key.notification_key;
 assert.equal(Buffer.from(expectedKey,'base64url').length,32);assert.equal(key.type,'push.key');
 assert.equal((await push.send('phone',{id:'n1',title:'Nova',body:'private content'})).status,'accepted');
 push=make();await push.open();assert.equal((await push.send('phone',{id:'n1',title:'Nova',body:'private content'})).status,'accepted');assert.equal(sends,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Host persists unknown before HTTP and never resends after restart, revoke calls actual gateway endpoint',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-host-unknown-'));let calls=0,removed=0;
 const request:typeof fetch=(_url,init)=>{if(init!.method==='DELETE'){removed++;return Promise.resolve(new Response('{}'));}calls++;return Promise.reject(new Error('lost response'));};
 const make=()=>new SpacePushDelivery({path:join(dir,'push.json'),gatewayUrl:'https://push.example.invalid',request});
 try{let p=make();await p.open();await p.register('phone',{handle:'opaque-handle',credential:'credential'});assert.equal((await p.send('phone',{id:'n1',title:'Nova',body:'text'})).status,'unknown');
 p=make();await p.open();assert.equal((await p.send('phone',{id:'n1',title:'Nova',body:'text'})).status,'unknown');assert.equal(calls,1);await p.prune([]);assert.equal(removed,1);assert.equal((await p.send('phone',{id:'n2',title:'Nova',body:'text'})).status,'rejected');
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('Host push preserves notification expiry, bounds offline retention, and never submits expired notifications',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-host-push-expiry-'));
 const now=1700000000000;const sent:{expiresAt:number}[]=[];
 const request:typeof fetch=(_url,init)=>{assert.ok(typeof init?.body==='string');sent.push(JSON.parse(init.body) as {expiresAt:number});return Promise.resolve(new Response(JSON.stringify({status:'accepted'})))};
 const options={path:join(dir,'push.json'),gatewayUrl:'https://push.example.invalid',request,now:()=>now};
 const push=new SpacePushDelivery(options);
 try{await push.open();await push.register('phone',{handle:'opaque-handle',credential:'credential'});
  const expiring={id:'short',title:'Nova',body:'short validity',expires_at:now+600000};
  assert.equal((await push.send('phone',expiring)).status,'accepted');assert.equal(sent[0]?.expiresAt,expiring.expires_at);
  const long={id:'long',title:'Nova',body:'long validity',expires_at:now+7*86400000};
  await push.send('phone',long);assert.equal(sent[1]?.expiresAt,now+86400000);
  await push.send('phone',{id:'default',title:'Nova',body:'offline result'});assert.equal(sent[2]?.expiresAt,now+86400000);
  const expired={id:'expired',title:'Nova',body:'obsolete result',expires_at:now};
  assert.equal((await push.send('phone',expired)).status,'rejected');assert.equal(sent.length,3);
  const reopened=new SpacePushDelivery(options);await reopened.open();await reopened.send('phone',expiring);assert.equal(sent.length,3);
 }finally{await rm(dir,{recursive:true,force:true})}
});


test('notification adapter and durable Host outbox retain validity across restart without exporting guards',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-host-notice-validity-'));const now=Date.now();
 const sent:{expiresAt:number}[]=[],mailbox:Record<string,unknown>[]=[];
 const request:typeof fetch=(_url,init)=>{assert.ok(typeof init?.body==='string');sent.push(JSON.parse(init.body) as {expiresAt:number});return Promise.resolve(new Response(JSON.stringify({status:'accepted'})))};
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'space',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const validity:{value:'valid'|'invalid'|'defer'}={value:'valid'};host.notificationValidity=()=>Promise.resolve(validity.value);
 const push=new SpacePushDelivery({path:join(dir,'push.json'),gatewayUrl:'https://push.example.invalid',request,now:()=>now});
 const transport:SpaceHostTransport={clients:()=>['phone'],start:()=>Promise.resolve(()=>{ /* Fixture owns no network resources. */ }),send:(_to,body)=>{mailbox.push(body);return Promise.resolve()},stream:()=>Promise.resolve()};
 const make=()=>new SpaceHost({path:join(dir,'space.json'),space:'space',host,transport,push,now:()=>now});let space=make();
 try{await host.open({deferBackground:true});await space.open();await push.register('phone',{handle:'opaque-handle',credential:'credential'});
  const adapter=spaceRelayNotificationAdapter(()=>space),binding={id:'space',provider:'space-relay',identity:'local',generation:0,user_scope:'space',status:'ready' as const};
  const notification:NotificationInput={event_key:'notice',revision:'1',occurrence:'initial',kind:'alert',title:'Nova',body:'private result',source:{type:'test',id:'internal-source'},guard:{evidence_refs:['private-ref']},created_at:now,expires_at:now+600000,not_before:0,priority:100,coalesce_key:null,feedback:[]};
  await adapter.send({title:notification.title,body:notification.body},{binding,idempotency_key:'first',notification,signal:new AbortController().signal});
  assert.equal(sent[0]?.expiresAt,notification.expires_at);
  const delivered=mailbox.find(message=>message.type==='notification');assert.ok(delivered);assert.equal(delivered.expires_at,notification.expires_at);assert.equal('guard' in delivered,false);assert.equal('source' in delivered,false);
  validity.value='defer';await adapter.send({title:notification.title,body:notification.body},{binding,idempotency_key:'deferred',notification,signal:new AbortController().signal});assert.equal(sent.length,1);
  const pending=JSON.parse(await readFile(join(dir,'space.json'),'utf8')) as {push_outbox:{expires_at:number;notification:NotificationInput}[]};assert.equal(pending.push_outbox.length,1);assert.equal(pending.push_outbox[0]?.expires_at,notification.expires_at);assert.deepEqual(pending.push_outbox[0]?.notification.guard,notification.guard);
  await space.close();validity.value='invalid';space=make();await space.open();assert.equal(sent.length,1);
  const restored=JSON.parse(await readFile(join(dir,'space.json'),'utf8')) as {push_outbox:unknown[]};assert.equal(restored.push_outbox.length,0);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});


test('Host receipt cleanup follows retired handles and keeps unclassified legacy receipts',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-host-push-gc-'));let sends=0;
 const request:typeof fetch=(_url,init)=>{if(init?.method==='DELETE')return Promise.resolve(new Response('{}'));sends++;return Promise.resolve(new Response(JSON.stringify({status:'unknown'})))};
 const path=join(dir,'push.json'),make=()=>new SpacePushDelivery({path,gatewayUrl:'https://push.example.invalid',request});
 const read=async()=>JSON.parse(await readFile(path,'utf8')) as {receipts:Record<string,{handle?:string;status:string}>};
 try{let push=make();await push.open();await push.register('phone',{handle:'first',credential:'credential'});
  await push.send('phone',{id:'one',title:'Nova',body:'result'});assert.equal(Object.values((await read()).receipts)[0]?.handle,'first');
  await push.register('phone',{handle:'second',credential:'second-credential'});assert.equal(Object.keys((await read()).receipts).length,0);
  await push.send('phone',{id:'two',title:'Nova',body:'result'});push=make();await push.open();await push.send('phone',{id:'two',title:'Nova',body:'result'});assert.equal(sends,2);
  await push.revoke('phone');assert.equal(Object.keys((await read()).receipts).length,0);
  await push.register('phone',{handle:'legacy',credential:'legacy-credential'});await push.send('phone',{id:'old',title:'Nova',body:'result'});
  const legacy=await read();for(const receipt of Object.values(legacy.receipts))delete receipt.handle;await writeFile(path,JSON.stringify(legacy));
  push=make();await push.open();await push.register('phone',{handle:'modern',credential:'modern-credential'});
  await push.send('phone',{id:'new',title:'Nova',body:'result'});await push.revoke('phone');
  const remaining=Object.values((await read()).receipts);assert.equal(remaining.length,1);assert.equal(remaining[0]?.handle,undefined);assert.equal(remaining[0]?.status,'unknown');
 }finally{await rm(dir,{recursive:true,force:true})}
});
