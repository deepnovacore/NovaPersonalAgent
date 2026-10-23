import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compactDecrypt} from 'jose';
import {SpacePushDelivery} from '../src/space-host/push.js';

test('Host push isolates configured gateway and encrypts human content with per-handle native key',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-host-push-'));let sends=0;let expectedKey='';
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
 const dir=await mkdtemp(join(tmpdir(),'nova-host-unknown-'));let calls=0,removed=0;
 const request:typeof fetch=(_url,init)=>{if(init!.method==='DELETE'){removed++;return Promise.resolve(new Response('{}'));}calls++;return Promise.reject(new Error('lost response'));};
 const make=()=>new SpacePushDelivery({path:join(dir,'push.json'),gatewayUrl:'https://push.example.invalid',request});
 try{let p=make();await p.open();await p.register('phone',{handle:'opaque-handle',credential:'credential'});assert.equal((await p.send('phone',{id:'n1',title:'Nova',body:'text'})).status,'unknown');
 p=make();await p.open();assert.equal((await p.send('phone',{id:'n1',title:'Nova',body:'text'})).status,'unknown');assert.equal(calls,1);await p.prune([]);assert.equal(removed,1);assert.equal((await p.send('phone',{id:'n2',title:'Nova',body:'text'})).status,'rejected');
 }finally{await rm(dir,{recursive:true,force:true});}
});
