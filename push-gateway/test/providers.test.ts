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
  const body=JSON.parse(String(init!.body)) as {message:{data:unknown;notification?:unknown}};assert.ok(body.message.data);assert.equal(body.message.notification,undefined);
  return new Response(JSON.stringify({error:{details:[{errorCode:'UNREGISTERED'}]}}),{status:404});
 };
 const p=new FcmProvider({projectId:'project',clientEmail:'service@example.invalid',privateKey},request);
 assert.equal((await p.send(message)).status,'invalid_token');assert.equal((await p.send(message)).status,'invalid_token');assert.equal(count,3);
});
test('MiPush uses only generic public-channel content and translates quota rejection',async()=>{
 const p=new MiPushProvider({appSecret:'private-secret',packageName:'example.nova',channelId:'public-channel'},async(_url,init)=>{
  const body=new URLSearchParams(String(init!.body));assert.equal(body.get('extra.channel_id'),'public-channel');assert.equal(body.get('pass_through'),'0');
  assert.ok(!String(init!.body).includes(message.ciphertext));assert.ok(!String(init!.body).includes('private-secret'));assert.equal(body.get('description'),'Open Nova to view new updates.');
  return new Response(JSON.stringify({code:200001}));
 });assert.equal((await p.send(message)).status,'quota_exceeded');
});
