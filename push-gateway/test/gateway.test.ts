import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Gateway, createGatewayServer} from '../src/gateway.js';
import type {PushMessage, PushProvider} from '../src/providers.js';
const jwe = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA';
function fixture(provider?: PushProvider, limits?: {perHandle: number; global: number}) {
 const dir = mkdtempSync(join(tmpdir(),'nova-push-'));
 const sent: PushMessage[] = [];
 const gateway = new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:provider ?? {send:async m=>{sent.push(m);return {status:'accepted'};}}},...(limits?{limits}:{})});
 return {gateway,sent,dir,close:()=>{gateway.close();rmSync(dir,{recursive:true,force:true});}};
}
test('opaque handle credentials isolate device tokens and persist across restart',async()=>{
 const f=fixture();
 try {
 const reg=f.gateway.register({provider:'fcm',token:'private-device-token'});
 assert.ok(!JSON.stringify(reg).includes('private-device-token'));
 assert.equal((await f.gateway.push({...reg,notificationId:'n-1',ciphertext:jwe})).status,'accepted');
 await assert.rejects(f.gateway.push({...reg,credential:'wrong',notificationId:'n-2',ciphertext:jwe}),/unauthorized/);
 f.gateway.close();
 const reopened=new Gateway({statePath:join(f.dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:{send:async()=>({status:'accepted'})}}});
 assert.equal((await reopened.push({...reg,notificationId:'n-1',ciphertext:jwe})).status,'accepted');
 assert.ok(!readFileSync(join(f.dir,'state.json'),'utf8').includes(reg.credential));
 reopened.close();
 }finally{f.close();}
});
test('unknown provider result is persisted and never blindly retried',async()=>{
 let calls=0;const f=fixture({send:async()=>{calls++;throw new Error('sensitive-provider-body');}});
 try{const reg=f.gateway.register({provider:'fcm',token:'token'});
 const message={...reg,notificationId:'n-1',ciphertext:jwe};
 assert.deepEqual(await f.gateway.push(message),{status:'unknown',retryable:false});
 assert.deepEqual(await f.gateway.push(message),{status:'unknown',retryable:false});assert.equal(calls,1);
 }finally{f.close();}
});
test('invalid token is unregistered and cannot send again',async()=>{
 const f=fixture({send:async()=>({status:'invalid_token'})});
 try{const reg=f.gateway.register({provider:'fcm',token:'token'});assert.equal((await f.gateway.push({...reg,notificationId:'n-1',ciphertext:jwe})).status,'invalid_token');
 await assert.rejects(f.gateway.push({...reg,notificationId:'n-2',ciphertext:jwe}),/unauthorized/);
 }finally{f.close();}
});
test('quotas survive new handles for same device and enforce global cap',async()=>{
 const f=fixture(undefined,{perHandle:1,global:2});
 try{const a=f.gateway.register({provider:'fcm',token:'same-token'});
 assert.equal((await f.gateway.push({...a,notificationId:'n-1',ciphertext:jwe})).status,'accepted');
 const b=f.gateway.register({provider:'fcm',token:'same-token'});
 assert.equal((await f.gateway.push({...b,notificationId:'n-2',ciphertext:jwe})).status,'quota_exceeded');
 const c=f.gateway.register({provider:'fcm',token:'another-token'});
 assert.equal((await f.gateway.push({...c,notificationId:'n-3',ciphertext:jwe})).status,'accepted');
 const d=f.gateway.register({provider:'fcm',token:'third-token'});
 assert.equal((await f.gateway.push({...d,notificationId:'n-4',ciphertext:jwe})).status,'quota_exceeded');
 }finally{f.close();}
});
test('HTTP server authenticates registration and scoped sends and rejects plaintext/SpaceID',async()=>{
 const f=fixture();const server=createServer(createGatewayServer(f.gateway));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address && typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
 const call=async(path:string,body:unknown,key:string)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body)});
 try{
 assert.equal((await call('/v1/registrations',{provider:'fcm',token:'token'},'wrong')).status,401);
 const response=await call('/v1/registrations',{provider:'fcm',token:'token'},'install-admission-key-at-least-32-chars');assert.equal(response.status,201);
 const reg=await response.json() as {handle:string;credential:string};
 assert.equal((await call('/v1/push',{handle:reg.handle,notificationId:'n-1',ciphertext:'private text'},reg.credential)).status,400);
 assert.equal((await call('/v1/push',{handle:reg.handle,notificationId:'n-1',ciphertext:jwe,spaceId:'secret'},reg.credential)).status,400);
 assert.equal((await call('/v1/push',{handle:reg.handle,notificationId:'n-1',ciphertext:jwe},reg.credential)).status,200);
 assert.equal(f.sent.length,1);
 }finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));f.close();}
});
test('MiPush caps a device at five daily attempts across handles',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-mipush-'));let calls=0;let now=Date.UTC(2026,9,23);
 const gateway=new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{mipush:{send:async()=>{calls++;return {status:'accepted'};}}},now:()=>now});
 try {for(let i=0;i<6;i++){const r=gateway.register({provider:'mipush',token:'same-device'});assert.equal((await gateway.push({...r,notificationId:`n-${i}`,ciphertext:jwe})).status,i===5?'quota_exceeded':'accepted');}
 assert.equal(calls,5);now+=86400000;const r=gateway.register({provider:'mipush',token:'same-device'});assert.equal((await gateway.push({...r,notificationId:'new-day',ciphertext:jwe})).status,'accepted');
 }finally{gateway.close();rmSync(dir,{recursive:true,force:true});}
});
test('simultaneous duplicate sends reserve before provider I/O',async()=>{
 let complete!:(r:{status:'accepted'})=>void;let calls=0;const f=fixture({send:async()=>{calls++;return new Promise(r=>{complete=r;});}});
 try {const r=f.gateway.register({provider:'fcm',token:'token'});const input={...r,notificationId:'dup',ciphertext:jwe};const first=f.gateway.push(input);
 assert.equal((await f.gateway.push(input)).status,'unknown');complete({status:'accepted'});assert.equal((await first).status,'accepted');assert.equal(calls,1);
 await assert.rejects(f.gateway.push({...input,ciphertext:jwe.replace('.AAAA.','.BBBB.')}),/notification_conflict/);
 }finally{f.close();}
});
test('rejects clear metadata in JWE headers and nonopaque notification identifiers',async()=>{
 const f=fixture();try{const reg=f.gateway.register({provider:'fcm',token:'token'});
 const header=Buffer.from(JSON.stringify({alg:'dir',enc:'A256GCM',kid:'private-space-id'})).toString('base64url');
 await assert.rejects(f.gateway.push({...reg,notificationId:'n-1',ciphertext:header+jwe.slice(jwe.indexOf('.'))}),/invalid_push/);
 await assert.rejects(f.gateway.push({...reg,notificationId:'private / SpaceID',ciphertext:jwe}),/invalid_push/);
 }finally{f.close();}
});
test('MiPush five-attempt budget cannot reset across a UTC midnight within 24 hours',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-mipush-roll-'));let now=Date.UTC(2026,9,23,23);
 const gateway=new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{mipush:{send:async()=>({status:'accepted'})}},now:()=>now});
 try {const r=gateway.register({provider:'mipush',token:'same-device'});for(let i=0;i<5;i++)await gateway.push({...r,notificationId:`n-${i}`,ciphertext:jwe});now+=2*3600_000;
 assert.equal((await gateway.push({...r,notificationId:'tomorrow',ciphertext:jwe})).status,'quota_exceeded');
 }finally{gateway.close();rmSync(dir,{recursive:true,force:true});}
});
test('one install can hold independent live handles for multiple Spaces sharing device quota',async()=>{
 const f=fixture(undefined,{perHandle:2,global:10});try{
 const a=f.gateway.register({provider:'fcm',token:'same-install'}),b=f.gateway.register({provider:'fcm',token:'same-install'});
 assert.notEqual(a.handle,b.handle);
 assert.equal((await f.gateway.push({...a,notificationId:'space-a',ciphertext:jwe})).status,'accepted');
 assert.equal((await f.gateway.push({...b,notificationId:'space-b',ciphertext:jwe})).status,'accepted');
 assert.equal((await f.gateway.push({...a,notificationId:'space-a-2',ciphertext:jwe})).status,'quota_exceeded');
 f.gateway.unregister(a.handle,a.credential);
 assert.equal((await f.gateway.push({...b,notificationId:'space-b',ciphertext:jwe})).status,'accepted');
 }finally{f.close();}
});
test('token rotation preserves handle credentials and per-handle quota',async()=>{
 const f=fixture(undefined,{perHandle:1,global:10});const server=createServer(createGatewayServer(f.gateway));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
 try{const reg=f.gateway.register({provider:'fcm',token:'old-token'});
 assert.equal((await f.gateway.push({...reg,notificationId:'n1',ciphertext:jwe})).status,'accepted');
 const response=await fetch(base+'/v1/registrations/'+reg.handle,{method:'PUT',headers:{authorization:`Bearer ${reg.credential}`,'content-type':'application/json'},body:JSON.stringify({provider:'fcm',token:'new-token'})});assert.equal(response.status,200);
 assert.equal((await f.gateway.push({...reg,notificationId:'n2',ciphertext:jwe})).status,'quota_exceeded');
 }finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));f.close();}
});
test('stale invalid-token feedback during rotation does not revoke the updated handle',async()=>{
 let complete!:(r:{status:'invalid_token'})=>void;let calls=0;
 const f=fixture({send:async()=>{calls++;return calls===1?new Promise(r=>{complete=r;}):{status:'accepted'};}});
 try{const r=f.gateway.register({provider:'fcm',token:'old-token'});const pending=f.gateway.push({...r,notificationId:'n1',ciphertext:jwe});
 f.gateway.updateRegistration(r.handle,r.credential,{provider:'fcm',token:'new-token'});complete({status:'invalid_token'});
 assert.equal((await pending).status,'rejected');assert.equal((await f.gateway.push({...r,notificationId:'n2',ciphertext:jwe})).status,'accepted');
 }finally{f.close();}
});
