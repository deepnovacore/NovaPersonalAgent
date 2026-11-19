import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {mintInvitation} from '../src/admission.js';
import type {RegistrationInput} from '../src/gateway.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Gateway, createGatewayServer} from '../src/gateway.js';
import type {PushMessage, PushProvider} from '../src/providers.js';
const jwe = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA';
const registerTimes=new WeakMap<Gateway,()=>number>();
const credentials=new WeakMap<Gateway,Map<string,string>>();
function install(gateway:Gateway,now=Date.now()){const credential=randomBytes(32).toString('base64url');gateway.enroll(mintInvitation('install-admission-key-at-least-32-chars',{now}),credential);return credential}
function register(gateway:Gateway,input:RegistrationInput){let map=credentials.get(gateway);if(!map){map=new Map();credentials.set(gateway,map)}let credential=map.get(input.token);if(!credential){credential=install(gateway,registerTimes.get(gateway)?.()??Date.now());map.set(input.token,credential)}return gateway.register(input,credential)}
function fixture(provider?: PushProvider, limits?: {perHandle: number; global: number}) {
 const dir = mkdtempSync(join(tmpdir(),'nova-push-'));
 const sent: PushMessage[] = [];
 const gateway = new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:provider ?? {send:async m=>{sent.push(m);return {status:'accepted'};}}},...(limits?{limits}:{})});
 return {gateway,sent,dir,close:()=>{gateway.close();rmSync(dir,{recursive:true,force:true});}};
}
test('opaque handle credentials isolate device tokens and persist across restart',async()=>{
 const f=fixture();
 try {
 const reg=register(f.gateway,{provider:'fcm',token:'private-device-token'});
 assert.ok(!JSON.stringify(reg).includes('private-device-token'));
 assert.equal((await f.gateway.push({...reg,notificationId:'n-1',ciphertext:jwe})).status,'accepted');
 await assert.rejects(f.gateway.push({...reg,credential:'wrong',notificationId:'n-2',ciphertext:jwe}),/unauthorized/);
 f.gateway.close();
 const reopened=new Gateway({statePath:join(f.dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:{send:async()=>({status:'accepted'})}}});
 assert.equal((await reopened.push({...reg,notificationId:'n-1',ciphertext:jwe})).status,'accepted');
 assert.ok(!readFileSync(join(f.dir,'state.json.sqlite'),'utf8').includes(reg.credential));
 reopened.close();
 }finally{f.close();}
});
test('unknown provider result is persisted and never blindly retried',async()=>{
 let calls=0;const f=fixture({send:async()=>{calls++;throw new Error('sensitive-provider-body');}});
 try{const reg=register(f.gateway,{provider:'fcm',token:'token'});
 const message={...reg,notificationId:'n-1',ciphertext:jwe};
 assert.deepEqual(await f.gateway.push(message),{status:'unknown',retryable:false});
 assert.deepEqual(await f.gateway.push(message),{status:'unknown',retryable:false});assert.equal(calls,1);
 }finally{f.close();}
});
test('invalid token is unregistered and cannot send again',async()=>{
 const f=fixture({send:async()=>({status:'invalid_token'})});
 try{const reg=register(f.gateway,{provider:'fcm',token:'token'});assert.equal((await f.gateway.push({...reg,notificationId:'n-1',ciphertext:jwe})).status,'invalid_token');
 await assert.rejects(f.gateway.push({...reg,notificationId:'n-2',ciphertext:jwe}),/unauthorized/);
 }finally{f.close();}
});
test('quotas survive new handles for same device and enforce global cap',async()=>{
 const f=fixture(undefined,{perHandle:1,global:2});
 try{const a=register(f.gateway,{provider:'fcm',token:'same-token'});
 assert.equal((await f.gateway.push({...a,notificationId:'n-1',ciphertext:jwe})).status,'accepted');
 const b=register(f.gateway,{provider:'fcm',token:'same-token'});
 assert.equal((await f.gateway.push({...b,notificationId:'n-2',ciphertext:jwe})).status,'quota_exceeded');
 const c=register(f.gateway,{provider:'fcm',token:'another-token'});
 assert.equal((await f.gateway.push({...c,notificationId:'n-3',ciphertext:jwe})).status,'accepted');
 assert.throws(()=>register(f.gateway,{provider:'fcm',token:'third-token'}),/installation_capacity/);
 }finally{f.close();}
});
test('HTTP server authenticates registration and scoped sends and rejects plaintext/SpaceID',async()=>{
 const f=fixture();const server=createServer(createGatewayServer(f.gateway));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address && typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
 const call=async(path:string,body:unknown,key:string)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body)});
 try{
 assert.equal((await call('/v1/registrations',{provider:'fcm',token:'token'},'wrong')).status,401);
 assert.equal((await call('/v1/registrations',{provider:'fcm',token:'token'},'install-admission-key-at-least-32-chars')).status,401);
 const installationCredential=randomBytes(32).toString('base64url');assert.equal((await call('/v1/installations',{credential:installationCredential},mintInvitation('install-admission-key-at-least-32-chars'))).status,201);
 const response=await call('/v1/registrations',{provider:'fcm',token:'token'},installationCredential);assert.equal(response.status,201);
 const reg=await response.json() as {handle:string;credential:string};
 assert.equal((await call('/v1/push',{handle:reg.handle,notificationId:'n-1',ciphertext:'private text'},reg.credential)).status,400);
 assert.equal((await call('/v1/push',{handle:reg.handle,notificationId:'n-1',ciphertext:jwe,spaceId:'secret'},reg.credential)).status,400);
 assert.equal((await call('/v1/push',{handle:reg.handle,notificationId:'n-1',ciphertext:jwe},reg.credential)).status,200);
 assert.equal(f.sent.length,1);
 }finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));f.close();}
});
test('MiPush caps a device at five daily attempts across handles',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-mipush-'));let calls=0;let now=Date.UTC(2026,9,23);
 const gateway=new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{mipush:{send:async()=>{calls++;return {status:'accepted'};}}},now:()=>now});registerTimes.set(gateway,()=>now);
 try {for(let i=0;i<6;i++){const r=register(gateway,{provider:'mipush',token:'same-device'});assert.equal((await gateway.push({...r,notificationId:`n-${i}`,ciphertext:jwe})).status,i===5?'quota_exceeded':'accepted');}
 assert.equal(calls,5);now+=86400000;const r=register(gateway,{provider:'mipush',token:'same-device'});assert.equal((await gateway.push({...r,notificationId:'new-day',ciphertext:jwe})).status,'accepted');
 }finally{gateway.close();rmSync(dir,{recursive:true,force:true});}
});
test('simultaneous duplicate sends reserve before provider I/O',async()=>{
 let complete!:(r:{status:'accepted'})=>void;let calls=0;const f=fixture({send:async()=>{calls++;return new Promise(r=>{complete=r;});}});
 try {const r=register(f.gateway,{provider:'fcm',token:'token'});const input={...r,notificationId:'dup',ciphertext:jwe};const first=f.gateway.push(input);
 assert.equal((await f.gateway.push(input)).status,'unknown');complete({status:'accepted'});assert.equal((await first).status,'accepted');assert.equal(calls,1);
 await assert.rejects(f.gateway.push({...input,ciphertext:jwe.replace('.AAAA.','.BBBB.')}),/notification_conflict/);
 }finally{f.close();}
});
test('rejects clear metadata in JWE headers and nonopaque notification identifiers',async()=>{
 const f=fixture();try{const reg=register(f.gateway,{provider:'fcm',token:'token'});
 const header=Buffer.from(JSON.stringify({alg:'dir',enc:'A256GCM',kid:'private-space-id'})).toString('base64url');
 await assert.rejects(f.gateway.push({...reg,notificationId:'n-1',ciphertext:header+jwe.slice(jwe.indexOf('.'))}),/invalid_push/);
 await assert.rejects(f.gateway.push({...reg,notificationId:'private / SpaceID',ciphertext:jwe}),/invalid_push/);
 }finally{f.close();}
});
test('MiPush five-attempt budget cannot reset across a UTC midnight within 24 hours',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-mipush-roll-'));let now=Date.UTC(2026,9,23,23);
 const gateway=new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{mipush:{send:async()=>({status:'accepted'})}},now:()=>now});registerTimes.set(gateway,()=>now);
 try {const r=register(gateway,{provider:'mipush',token:'same-device'});for(let i=0;i<5;i++)await gateway.push({...r,notificationId:`n-${i}`,ciphertext:jwe});now+=2*3600_000;
 assert.equal((await gateway.push({...r,notificationId:'tomorrow',ciphertext:jwe})).status,'quota_exceeded');
 }finally{gateway.close();rmSync(dir,{recursive:true,force:true});}
});
test('one install can hold independent live handles for multiple Spaces sharing device quota',async()=>{
 const f=fixture(undefined,{perHandle:2,global:10});try{
 const a=register(f.gateway,{provider:'fcm',token:'same-install'}),b=register(f.gateway,{provider:'fcm',token:'same-install'});
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
 try{const reg=register(f.gateway,{provider:'fcm',token:'old-token'});
 assert.equal((await f.gateway.push({...reg,notificationId:'n1',ciphertext:jwe})).status,'accepted');
 const response=await fetch(base+'/v1/registrations/'+reg.handle,{method:'PUT',headers:{authorization:`Bearer ${reg.credential}`,'content-type':'application/json'},body:JSON.stringify({provider:'fcm',token:'new-token'})});assert.equal(response.status,200);
 assert.equal((await f.gateway.push({...reg,notificationId:'n2',ciphertext:jwe})).status,'quota_exceeded');
 }finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));f.close();}
});
test('stale invalid-token feedback during rotation does not revoke the updated handle',async()=>{
 let complete!:(r:{status:'invalid_token'})=>void;let calls=0;
 const f=fixture({send:async()=>{calls++;return calls===1?new Promise(r=>{complete=r;}):{status:'accepted'};}});
 try{const r=register(f.gateway,{provider:'fcm',token:'old-token'});const pending=f.gateway.push({...r,notificationId:'n1',ciphertext:jwe});
 f.gateway.updateRegistration(r.handle,r.credential,{provider:'fcm',token:'new-token'});complete({status:'invalid_token'});
 assert.equal((await pending).status,'rejected');assert.equal((await f.gateway.push({...r,notificationId:'n2',ciphertext:jwe})).status,'accepted');
 }finally{f.close();}
});

test('one-time invitation exchange resumes only its original credential and never accepts the issuer key for registration',()=>{
 const f=fixture();try{const invitation=mintInvitation('install-admission-key-at-least-32-chars'),credential=randomBytes(32).toString('base64url');
 const first=f.gateway.enroll(invitation,credential);assert.equal(f.gateway.enroll(invitation,credential).installationId,first.installationId);
 assert.throws(()=>f.gateway.enroll(invitation,randomBytes(32).toString('base64url')),/invitation_used/);
 assert.throws(()=>f.gateway.register({provider:'fcm',token:'fake'},'install-admission-key-at-least-32-chars'),/unauthorized/);
 const input={provider:'fcm' as const,token:'token',registrationId:'client-persisted-registration-id'};
 const a=f.gateway.register(input,credential),b=f.gateway.register(input,credential);assert.deepEqual(a,b);
 assert.throws(()=>f.gateway.register({...input,token:'different'},credential),/registration_conflict/);
 }finally{f.close()}
});
test('token and handle multiplication cannot spend another admitted installation reserved daily budget',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-budget-'));let sends=0;
 const gateway=new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:{send:async()=>{sends++;return {status:'accepted'}}}},limits:{perHandle:100,global:6},installationDailyLimit:3});
 try{const attacker=install(gateway),legitimate=install(gateway);assert.throws(()=>install(gateway),/installation_capacity/);
 const first=gateway.register({provider:'fcm',token:'fake-1'},attacker),second=gateway.register({provider:'fcm',token:'fake-2'},attacker),good=gateway.register({provider:'fcm',token:'real'},legitimate);
 for(let n=0;n<3;n++)assert.equal((await gateway.push({...first,notificationId:'a'+n,ciphertext:jwe})).status,'accepted');
 assert.equal((await gateway.push({...second,notificationId:'b',ciphertext:jwe})).status,'quota_exceeded');
 gateway.updateRegistration(first.handle,first.credential,{provider:'fcm',token:'fake-rotated'});
 assert.equal((await gateway.push({...first,notificationId:'c',ciphertext:jwe})).status,'quota_exceeded');
 for(let n=0;n<3;n++)assert.equal((await gateway.push({...good,notificationId:'g'+n,ciphertext:jwe})).status,'accepted');
 assert.equal(sends,6);
 }finally{gateway.close();rmSync(dir,{recursive:true,force:true})}
});
test('lease GC bounds receipt history without making unknown or revoked requests sendable again',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-receipt-gc-'));let now=Date.now(),calls=0;
 const path=join(dir,'state.json');const gateway=new Gateway({statePath:path,admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:{send:async()=>{calls++;return {status:'unknown'}}}},now:()=>now,registrationTtlMs:60_000});
 const db=new DatabaseSync(path+'.sqlite',{readOnly:true});
 try{const credential=install(gateway,now),input={provider:'fcm' as const,token:'token',registrationId:'persisted-request-id'};let old:{handle:string;credential:string}|undefined;
 for(let iteration=0;iteration<35;iteration++){
  const r=gateway.register(input,credential);if(old){assert.notEqual(r.handle,old.handle);await assert.rejects(gateway.push({...old,notificationId:'same',ciphertext:jwe}),/unauthorized/)}
  assert.equal((await gateway.push({...r,notificationId:'same',ciphertext:jwe})).status,'unknown');assert.equal((await gateway.push({...r,notificationId:'same',ciphertext:jwe})).status,'unknown');
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM receipts').get()!.n),1);old=r;if(iteration<34)now+=86400_000;
 }
 assert.equal(calls,35);assert.equal(Number(db.prepare('SELECT count(*) AS n FROM registrations').get()!.n),1);
 gateway.unregister(old!.handle,old!.credential);assert.equal(Number(db.prepare('SELECT count(*) AS n FROM receipts').get()!.n),0);
 }finally{db.close();gateway.close();rmSync(dir,{recursive:true,force:true})}
});
test('HTTP admission limit is enforced before reading an unauthenticated enrollment body',async()=>{
 const f=fixture(),server=createServer(createGatewayServer(f.gateway,{enrollmentsPerMinute:1}));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/v1/installations`;
 try{assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({credential:'a'.repeat(43)})})).status,401);assert.equal((await fetch(url,{method:'POST',body:'not JSON'})).status,429)}finally{await new Promise<void>(r=>server.close(()=>r()));f.close()}
});
test('APNs invalid-token feedback is isolated by sandbox versus production environment',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-apns-env-'));const gateway=new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{apns:{send:async m=>({status:m.environment==='sandbox'?'invalid_token':'accepted'})}}});
 try{const credential=install(gateway),sandbox=gateway.register({provider:'apns',token:'same-token',environment:'sandbox'},credential),production=gateway.register({provider:'apns',token:'same-token',environment:'production'},credential);
 assert.equal((await gateway.push({...sandbox,notificationId:'sandbox',ciphertext:jwe})).status,'invalid_token');assert.equal((await gateway.push({...production,notificationId:'production',ciphertext:jwe})).status,'accepted');
 }finally{gateway.close();rmSync(dir,{recursive:true,force:true})}
});

test('a lost enrollment response is recoverable by its credential after invitation expiry, without accepting expired invitations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-enroll-recovery-'));let now=Date.now();const gateway=new Gateway({statePath:join(dir,'state.json'),admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:{send:async()=>({status:'accepted'})}},now:()=>now});
 const credential=randomBytes(32).toString('base64url'),invitation=mintInvitation('install-admission-key-at-least-32-chars',{now}),first=gateway.enroll(invitation,credential);
 const server=createServer(createGatewayServer(gateway));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/v1/installation`;
 try{now+=16*60_000;assert.throws(()=>gateway.enroll(invitation,credential),/invalid_invitation/);const response=await fetch(url,{headers:{authorization:`Bearer ${credential}`}});assert.equal(response.status,200);assert.equal((await response.json() as {installationId:string}).installationId,first.installationId);assert.equal((await fetch(url,{headers:{authorization:'Bearer wrong'}})).status,401);
 now+=30*86400_000+1;assert.equal((await fetch(url,{headers:{authorization:`Bearer ${credential}`}})).status,401);
 }finally{await new Promise<void>(r=>server.close(()=>r()));gateway.close();rmSync(dir,{recursive:true,force:true})}
});
test('restart refuses to lower the global capacity below already reserved installation budgets',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nova-budget-config-')),path=join(dir,'state.json'),options={statePath:path,admissionKey:'install-admission-key-at-least-32-chars',providers:{fcm:{send:async()=>({status:'accepted' as const})}},installationDailyLimit:3,limits:{perHandle:3,global:6}};
 const gateway=new Gateway(options);install(gateway);install(gateway);gateway.close();
 try{assert.throws(()=>new Gateway({...options,limits:{perHandle:3,global:3}}),/configured_capacity_below_reservations/);const recovered=new Gateway(options);recovered.close()}finally{rmSync(dir,{recursive:true,force:true})}
});
