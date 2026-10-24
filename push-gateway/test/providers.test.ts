import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportPKCS8,generateKeyPair,jwtVerify} from 'jose';
import {ApnsProvider,FcmProvider,MiPushProvider} from '../src/providers.js';
const message={token:'device-private-token',handle:'opaque',notificationId:'n1',ciphertext:'opaque-encrypted-body'};
test('APNs uses HTTP/2 bearer ES256 JWT and visible mutable encrypted alert',async()=>{
 const pair=await generateKeyPair('ES256');const privateKey=await exportPKCS8(pair.privateKey);let count=0;
 const p=new ApnsProvider({teamId:'team',keyId:'key',privateKey,topic:'example.nova'},async(origin,path,headers,body)=>{
  count++;assert.equal(origin,'https://api.sandbox.push.apple.com');assert.equal(path,'/3/device/device-private-token');
  const {payload,protectedHeader}=await jwtVerify(headers.authorization!.slice(7),pair.publicKey,{issuer:'team',algorithms:['ES256']});
  assert.equal(protectedHeader.kid,'key');assert.ok(payload.iat);assert.equal(headers['apns-push-type'],'alert');
  assert.ok(Number(headers['apns-expiration'])>Date.now()/1000+86_390);assert.match(headers['apns-collapse-id']!,/^[a-f0-9]{32}$/);
  const parsed=JSON.parse(body) as {aps:{'mutable-content':number;alert:object};ciphertext:string};
  assert.equal(parsed.aps['mutable-content'],1);assert.equal(parsed.ciphertext,message.ciphertext);assert.ok(!body.includes('device-private-token'));
  return {status:410,reason:'Unregistered'};
 });
 assert.equal((await p.send({...message,environment:'sandbox'})).status,'invalid_token');assert.equal(count,1);
});
test('FCM exchanges service account RS256 OAuth assertion then sends data-only v1 payload',async()=>{
 const pair=await generateKeyPair('RS256');const privateKey=await exportPKCS8(pair.privateKey);let count=0;
 const request:typeof fetch=async(input,init)=>{
  count++;
  if(String(input)==='https://oauth2.googleapis.com/token'){
   const params=new URLSearchParams(String(init!.body));const {payload}=await jwtVerify(params.get('assertion')!,pair.publicKey,{issuer:'service@example.invalid',audience:'https://oauth2.googleapis.com/token',algorithms:['RS256']});
   assert.equal(payload.scope,'https://www.googleapis.com/auth/firebase.messaging');return new Response(JSON.stringify({access_token:'oauth-access',expires_in:3600}));
  }
  assert.equal(String(input),'https://fcm.googleapis.com/v1/projects/project/messages:send');
  assert.equal((init!.headers as Record<string,string>).authorization,'Bearer oauth-access');
  const body=JSON.parse(String(init!.body)) as {message:{data:unknown;notification?:unknown;android:{ttl:string;collapse_key:string}}};assert.ok(body.message.data);assert.equal(body.message.notification,undefined);assert.ok(Number(body.message.android.ttl.slice(0,-1))>=86390&&Number(body.message.android.ttl.slice(0,-1))<=86400);assert.match(body.message.android.collapse_key,/^[a-f0-9]{32}$/);
  return new Response(JSON.stringify({error:{details:[{errorCode:'UNREGISTERED'}]}}),{status:404});
 };
 const p=new FcmProvider({projectId:'project',clientEmail:'service@example.invalid',privateKey},request);
 assert.equal((await p.send(message)).status,'invalid_token');assert.equal((await p.send(message)).status,'invalid_token');assert.equal(count,3);
});
test('MiPush uses only generic public-channel content and translates quota rejection',async()=>{
 const p=new MiPushProvider({appSecret:'private-secret',packageName:'example.nova',channelId:'public-channel'},async(_url,init)=>{
  const body=new URLSearchParams(String(init!.body));assert.equal(body.get('extra.channel_id'),'public-channel');assert.equal(body.get('pass_through'),'0');assert.ok(Number(body.get('time_to_live'))>86390000&&Number(body.get('time_to_live'))<=86400000);assert.ok(Number(body.get('notify_id'))>=0);
  assert.ok(!String(init!.body).includes(message.ciphertext));assert.ok(!String(init!.body).includes('private-secret'));assert.equal(body.get('description'),'Open Nova to view new updates.');
  return new Response(JSON.stringify({code:200001}));
 });assert.equal((await p.send(message)).status,'quota_exceeded');
});

test('expired notification is rejected before any provider credential or transport I/O',async()=>{
 const request:typeof fetch=()=>{throw new Error('expired_notification_sent')};
 const apns=new ApnsProvider({teamId:'team',keyId:'key',privateKey:'must-not-be-read',topic:'example.nova'},()=>{throw new Error('expired_notification_sent')});
 const fcm=new FcmProvider({projectId:'project',clientEmail:'service@example.invalid',privateKey:'must-not-be-read'},request);
 const mi=new MiPushProvider({appSecret:'private-secret',packageName:'example.nova',channelId:'public-channel'},request);
 for(const provider of [apns,fcm,mi])assert.deepEqual(await provider.send({...message,expiresAt:Date.now()-1}),{status:'rejected'});
});
test('notification validity bounds provider retention rather than extending stale reminders',async()=>{
 const pair=await generateKeyPair('ES256'),privateKey=await exportPKCS8(pair.privateKey);const expiresAt=Date.now()+600_000;
 const apns=new ApnsProvider({teamId:'team',keyId:'key',privateKey,topic:'example.nova'},async(_origin,_path,headers)=>{assert.equal(headers['apns-expiration'],String(Math.floor(expiresAt/1000)));return {status:200,reason:''}});
 assert.equal((await apns.send({...message,expiresAt})).status,'accepted');
 const mi=new MiPushProvider({appSecret:'secret',packageName:'example.nova',channelId:'public'},async(_url,init)=>{const ttl=Number(new URLSearchParams(String(init!.body)).get('time_to_live'));assert.ok(ttl>590_000&&ttl<=600_000);return new Response('{"code":0}')});
 assert.equal((await mi.send({...message,expiresAt})).status,'accepted');
});
