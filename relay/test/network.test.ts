import test from 'node:test';
import assert from 'node:assert/strict';
import {RelayServer} from '../src/server.js';

test('network service refuses public plaintext binding by default', () => {
  assert.throws(() => new RelayServer({bind: '0.0.0.0', securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: 'operator-only-bootstrap-secret'}), /tls_required/);
});

import {RelayClient} from '../src/client.js';
import {generateDeviceIdentity,spaceId,signControl,signEnvelope,encryptBody,generateContentKey, type DeviceIdentity} from '../src/crypto.js';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';

async function fixture(overrides: Partial<ConstructorParameters<typeof RelayServer>[0]> = {}) {
  const service=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret',...overrides});
  const url=await service.listen();
  const host=await generateDeviceIdentity();const phone=await generateDeviceIdentity();const space=spaceId(host.signingPublicKey);
  const makeClient=(identity: DeviceIdentity):RelayClient => new RelayClient({url,space,device:identity.device,pollIntervalMs:30,reconnectMinMs:20,
    signChallenge: c => signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},identity.signingPrivateKey)});
  const h=makeClient(host);const p=makeClient(phone);
  const publicHost={device:host.device,signingPublicKey:host.signingPublicKey,encryptionPublicKey:host.encryptionPublicKey};
  await h.createSpace({space,host:publicHost,proof:await signControl({v:1,purpose:'space-create',space,host:publicHost},host.signingPrivateKey)},'operator-only-bootstrap-secret');
  return {service,url,host,phone,space,h,p};
}
async function paired(f: Awaited<ReturnType<typeof fixture>>) {
  const invite=await f.h.createInvitation() as {id:string;secret:string};
  const payload={v:1,purpose:'pair-request',invitationId:invite.id,secret:invite.secret,device:f.phone.device,
    signingPublicKey:f.phone.signingPublicKey,encryptionPublicKey:f.phone.encryptionPublicKey,business_versions:[1]};
  const request=await f.p.requestPairing({...payload,proof:await signControl(payload,f.phone.signingPrivateKey)}) as {id:string};
  await f.h.confirmPairing(request.id,'confirm-'+request.id);
}
async function until(predicate:()=>boolean):Promise<void> {
  const deadline=Date.now()+3000;
  while (!predicate()) {assert.ok(Date.now()<deadline,'timed out waiting for real network delivery');await delay(10);}
}
test('real HTTP signed login, one-use pairing, ciphertext mailbox, durable ACK, stream and epoch revocation', async () => {
  const f=await fixture();let stop: (()=>void)|undefined;
  try {
    const unauth=await fetch(`${f.url}/v1/mailbox`);assert.ok([400,401].includes(unauth.status));
    await assert.rejects(()=>f.p.login(),/device|member|auth/);
    await paired(f);
    const contentKey=generateContentKey();
    const envelope=await signEnvelope({v:1,space:f.space,id:'durable-final',from:f.host.device,to:f.phone.device,chan:'mailbox',epoch:1,
      expiresAt:null,body:await encryptBody({type:'chat.final',text:'private reply'},contentKey)},f.host.signingPrivateKey);
    await assert.rejects(()=>f.h.send({...envelope,body:Buffer.from('tampered').toString('base64')}),/signature/);
    assert.deepEqual(await f.h.send(envelope),{seq:1,duplicate:false});
    assert.deepEqual(await f.h.send(envelope),{seq:1,duplicate:true});
    const page=await f.p.read();assert.equal(page.messages[0]?.envelope.body,envelope.body);
    await assert.rejects(()=>f.p.acknowledge(2),/cursor/);
    assert.equal(await f.p.acknowledge(1),1);assert.equal((await f.p.read()).messages.length,0);
    const previews: string[]=[];stop=f.p.start({onMailbox:async()=>{},onStream:e=>previews.push(e.id)});
    await until(()=>f.service.live.presence({space:f.space,device:f.host.device,epoch:1},f.phone.device));
    assert.equal(await f.h.presence(f.phone.device),true);
    const stream=await signEnvelope({...envelope,id:'preview',chan:'stream',expiresAt:Date.now()+10000},f.host.signingPrivateKey);
    await f.h.stream(stream);await until(()=>previews.length===1);assert.deepEqual(previews,['preview']);
    stop();stop=undefined;
    await until(()=>!f.service.live.presence({space:f.space,device:f.host.device,epoch:1},f.phone.device));
    await assert.rejects(()=>f.h.stream(stream),/offline/);
    await f.h.revokeDevice(f.phone.device,'revoke-phone');
    await assert.rejects(()=>f.p.read(),/session|auth|revoked|epoch|token/);
    assert.equal((await f.h.status()).ackCursor,0); // Host reauthenticates at new epoch.
  } finally {stop?.();f.h.stop();f.p.stop();await f.service.close();}
});

test('SDK reconnect catches up from a persisted cursor and never ACKs a failed durable handler', async () => {
  const f=await fixture();let stop:(()=>void)|undefined;let cursor:number|undefined;const applied:string[]=[];
  try {
    await paired(f);
    const envelope=await signEnvelope({v:1,space:f.space,id:'first',from:f.host.device,to:f.phone.device,chan:'mailbox',epoch:1,
      expiresAt:null,body:await encryptBody({value:1},generateContentKey())},f.host.signingPrivateKey);
    await f.h.send(envelope);
    await assert.rejects(()=>f.p.synchronize({onMailbox:async()=>{throw new Error('disk full');}}),/disk full/);
    assert.equal((await f.p.status()).ackCursor,0);
    stop=f.p.start({onMailbox:async e=>{applied.push(e.id);},loadCursor:async()=>cursor,saveCursor:async value=>{cursor=value;}});
    await until(()=>cursor===1);stop();
    await f.h.send(await signEnvelope({...envelope,id:'second'},f.host.signingPrivateKey));
    stop=f.p.start({onMailbox:async e=>{applied.push(e.id);},loadCursor:async()=>cursor,saveCursor:async value=>{cursor=value;}});
    await until(()=>cursor===2);assert.deepEqual(applied,['first','second']);
  } finally {stop?.();f.h.stop();f.p.stop();await f.service.close();}
});

test('HTTP limits reject oversized bodies, cap bootstrap abuse and authenticate WebSocket upgrades',async()=> {
  const f=await fixture({maxBodyBytes:8192,bootstrapPerMinute:5});
  try {
    const large=await fetch(`${f.url}/v1/auth/challenge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({data:'x'.repeat(9000)})});
    assert.equal(large.status,413);
    let response:Response|undefined;
    for(let i=0;i<5;i++) response=await fetch(`${f.url}/v1/auth/challenge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({space:f.space,device:f.host.device})});
    assert.equal(response?.status,429);
    await new Promise<void>((resolve,reject)=> {
      const ws=new WebSocket(f.url.replace('http:','ws:')+'/v1/live');
      ws.on('open',()=>{ws.terminate();reject(new Error('unauthenticated upgrade accepted'));});
      ws.on('unexpected-response',(_req,res)=>{assert.ok(res.statusCode!>=400);res.resume();ws.terminate();resolve();});
      ws.on('error',()=>{});
    });
  } finally {f.h.stop();f.p.stop();await f.service.close();}
});

test('service accepts a camera sized ciphertext and SDK restores a dropped real WebSocket',async()=> {
  const f=await fixture();let stop:(()=>void)|undefined;let ready=0;let offline=0;
  try {
    await paired(f);
    const body=await encryptBody({jpeg:'a'.repeat(96*1024)},generateContentKey());
    const envelope=await signEnvelope({v:1,space:f.space,id:'camera-result',from:f.phone.device,to:f.host.device,chan:'mailbox',epoch:1,expiresAt:null,body},f.phone.signingPrivateKey);
    assert.equal((await f.p.send(envelope)).seq,1);
    assert.equal((await f.h.read()).messages[0]?.envelope.body,body);
    stop=f.p.start({onMailbox:async()=>{},onConnection:online=>{if(online)ready++;else offline++;}});
    await until(()=>ready===1);
    const replacement=f.service.live.connect({space:f.space,device:f.phone.device,epoch:1},{send:async()=>{},close:()=>{}});
    await until(()=>ready>=2);assert.ok(offline>=1);
    // This old handle cannot close the newly reconnected generation.
    replacement.close();assert.equal(await f.h.presence(f.phone.device),true);
  } finally {stop?.();f.h.stop();f.p.stop();await f.service.close();}
});

test('global request budget applies independently of source and service closes before listening',async()=> {
  const f=await fixture({globalRequestsPerMinute:1});
  try {assert.equal((await fetch(`${f.url}/v1/mailbox`)).status,429);}
  finally {await f.service.close();}
  const unopened=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret'});
  await unopened.close();
});

import {createConnection,type Socket} from 'node:net';
test('raw TCP source connection cap bounds unauthenticated sockets',async()=> {
  const service=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret',maxConnectionsPerIp:2});
  const url=new URL(await service.listen());const sockets:Socket[]=[];
  try {
    for(let i=0;i<2;i++) {
      const socket=createConnection({host:'127.0.0.1',port:Number(url.port)});sockets.push(socket);
      await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
    }
    const third=createConnection({host:'127.0.0.1',port:Number(url.port)});sockets.push(third);
    await new Promise<void>((resolve,reject)=>{third.once('close',()=>resolve());third.once('error',reject);setTimeout(()=>reject(new Error('source connection cap not enforced')),1000).unref();});
  } finally {for(const socket of sockets)socket.destroy();await service.close();}
});

test('authenticated control-frame floods are rate limited before repeated session verification',async()=> {
  const f=await fixture({requestsPerMinute:25});let ws:WebSocket|undefined;
  try {
    await paired(f);
    const challengeResponse=await fetch(`${f.url}/v1/auth/challenge`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({space:f.space,device:f.phone.device})});
    const c=await challengeResponse.json() as {id:string;nonce:string;space:string;device:string;epoch:number;expiresAt:number};
    const proof=await signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},f.phone.signingPrivateKey);
    const sessionResponse=await fetch(`${f.url}/v1/auth/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challengeId:c.id,proof})});
    const session=await sessionResponse.json() as {token:string};
    ws=new WebSocket(f.url.replace('http:','ws:')+'/v1/live',{headers:{authorization:`Bearer ${session.token}`}});
    const socket=ws;
    await new Promise<void>((resolve,reject)=> {
      socket.on('open',()=>{for(let i=0;i<40;i++)socket.pong();});
      socket.once('close',()=>resolve());socket.on('error',()=>{});
      setTimeout(()=>reject(new Error('control-frame quota not enforced')),1000).unref();
    });
  } finally {ws?.terminate();f.h.stop();f.p.stop();await f.service.close();}
});

test('a ciphertext backlog above 2MiB catches up in bounded HTTP pages without delivering hidden cursors',async()=> {
 const f=await fixture();try {
  await paired(f);
  const body=await encryptBody({jpeg:'k'.repeat(96*1024)},generateContentKey());
  for(let i=0;i<6;i++) await f.h.send(await signEnvelope({v:1,space:f.space,id:`large-${i}`,from:f.host.device,to:f.phone.device,
   epoch:1,chan:'mailbox',expiresAt:null,body},f.host.signingPrivateKey));
  const first=await f.p.read({limit:64});
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=1536*1024,'HTTP page exceeds the endpoint response budget');
  assert.equal(first.hasMore,true);assert.ok(first.nextCursor<6);
  await assert.rejects(()=>f.p.acknowledge(6),/cursor_not_delivered/);
  const received=first.messages.map(m=>m.seq);let cursor=first.nextCursor;let more:boolean=first.hasMore;
  while(more) {
   const page=await f.p.read({after:cursor,limit:64});
   assert.ok(Buffer.byteLength(JSON.stringify(page))<=1536*1024);
   received.push(...page.messages.map(m=>m.seq));cursor=page.nextCursor;more=page.hasMore;
  }
  assert.deepEqual(received,[1,2,3,4,5,6]);assert.equal(await f.p.acknowledge(cursor),6);
 }finally{f.h.stop();f.p.stop();await f.service.close();}
});

test('lost pair claim, confirmation and revoke HTTP responses resume the same durable control operations',async()=> {
 const f=await fixture();try {
  const drop=new Set<string>();
  f.service.http.prependListener('request',(req,res)=>{
   if(drop.delete(req.url??''))res.end=(()=>{res.destroy();return res;}) as typeof res.end;
  });
  const invite=await f.h.createInvitation();
  const payload={v:1,purpose:'pair-request',invitationId:invite.id,secret:invite.secret,device:f.phone.device,
   signingPublicKey:f.phone.signingPublicKey,encryptionPublicKey:f.phone.encryptionPublicKey,business_versions:[1]};
  const requestBody={...payload,proof:await signControl(payload,f.phone.signingPrivateKey)};
  drop.add('/v1/pairing/requests');await assert.rejects(()=>f.p.requestPairing(requestBody));
  const request=await f.p.requestPairing(requestBody);assert.equal(request.selected_version,1);
  drop.add('/v1/pairing/confirm');await assert.rejects(()=>f.h.confirmPairing(request.id,'stable-confirm'));
  const member=await f.h.confirmPairing(request.id,'stable-confirm');assert.equal(member.device,f.phone.device);assert.equal(member.selected_version,1);
  await f.p.login();
  drop.add('/v1/devices/revoke');await assert.rejects(()=>f.h.revokeDevice(f.phone.device,'stable-revoke'));
  const revoked=await f.h.revokeDevice(f.phone.device,'stable-revoke');assert.equal(revoked.epoch,2);
  assert.equal(f.service.security.getSpace(f.space).epoch,2);
  assert.deepEqual(revoked.remainingDevices.map(d=>d.device),[f.host.device]);
 }finally{f.h.stop();f.p.stop();await f.service.close();}
});


test('mailbox rejects sender controlled expiry before storing any poison message',async()=>{
 const f=await fixture();try{
  await paired(f);
  const envelope=await signEnvelope({v:1,space:f.space,id:'poison',from:f.phone.device,to:f.host.device,chan:'mailbox',epoch:1,expiresAt:Date.now()+50,body:await encryptBody({test:true},generateContentKey())},f.phone.signingPrivateKey);
  await assert.rejects(()=>f.p.send(envelope),/mailbox_deadline_forbidden/);
  assert.equal((await f.h.status()).lastCursor,0);
  await f.h.revokeDevice(f.phone.device,'revoke-poisoner');
  assert.equal((await f.h.read()).messages.length,0);
 }finally{f.h.stop();f.p.stop();await f.service.close();}
});

test('trusted reverse proxy separates real source budgets while forged prefixes cannot evade them',async()=>{
 const options={securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret',trustedProxyAddresses:['127.0.0.1'],requestsPerMinute:1};
 const service=new RelayServer(options);const url=await service.listen();
 try{
  const request=(xff:string)=>fetch(`${url}/v1/mailbox`,{headers:{'x-forwarded-for':xff}});
  assert.equal((await request('192.0.2.1')).status,401);
  assert.equal((await request('192.0.2.2')).status,401);
  assert.equal((await request('198.51.100.4, 192.0.2.1')).status,429);
  assert.equal((await request('192.0.2.3, malformed')).status,400);
 }finally{await service.close();}
});

test('untrusted direct callers cannot choose their rate bucket through forwarding headers',async()=>{
 const service=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret',requestsPerMinute:1});const url=await service.listen();
 try{
  assert.equal((await fetch(`${url}/v1/mailbox`,{headers:{'x-forwarded-for':'192.0.2.1'}})).status,401);
  assert.equal((await fetch(`${url}/v1/mailbox`,{headers:{'x-forwarded-for':'192.0.2.2'}})).status,429);
 }finally{await service.close();}
});

test('trusted proxy HTTP and WebSocket concurrency belongs to the verified source, not the proxy socket',async()=>{
 const f=await fixture({trustedProxyAddresses:['127.0.0.1'],maxConnectionsPerIp:1});const sockets:WebSocket[]=[];
 const session=async(identity:DeviceIdentity)=>{const c=f.service.security.beginLogin(f.space,identity.device);const proof=await signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},identity.signingPrivateKey);return f.service.security.completeLogin({challengeId:c.id,proof}).token;};
 const connect=(token:string,ip:string)=>new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(f.url.replace('http:','ws:')+'/v1/live',{headers:{authorization:`Bearer ${token}`,'x-forwarded-for':ip}});sockets.push(ws);ws.once('open',()=>resolve(ws));ws.once('error',reject);});
 try{
  await paired(f);const hostToken=await session(f.host),phoneToken=await session(f.phone);
  const first=await connect(hostToken,'192.0.2.1');await connect(phoneToken,'192.0.2.2');
  assert.equal((await fetch(`${f.url}/v1/mailbox`,{headers:{'x-forwarded-for':'192.0.2.1'}})).status,429);
  assert.equal((await fetch(`${f.url}/v1/mailbox`,{headers:{'x-forwarded-for':'192.0.2.3'}})).status,401);
  await assert.rejects(()=>connect(hostToken,'198.51.100.5, 192.0.2.1'),/429/);
  const closed=new Promise<void>(resolve=>first.once('close',()=>resolve()));first.terminate();await closed;await until(()=>!f.service.live.presence({space:f.space,device:f.phone.device,epoch:1},f.host.device));
  await connect(hostToken,'192.0.2.1');
 }finally{for(const socket of sockets)socket.terminate();f.h.stop();f.p.stop();await f.service.close();}
});

import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
test('a revoked sender legacy expired envelope cannot block Host mailbox or cursor ACK',async()=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'relay-legacy-')),path=join(dir,'mail.sqlite');
 const f=await fixture({mailboxPath:path});try{
  await paired(f);
  const old=await signEnvelope({v:1,space:f.space,id:'legacy-poison',from:f.phone.device,to:f.host.device,chan:'mailbox',epoch:1,expiresAt:null,body:await encryptBody({test:true},generateContentKey())},f.phone.signingPrivateKey);
  await f.p.send(old);
  // Model a row admitted by the pre-upgrade server, without bypassing current network admission.
  const legacy=await signEnvelope({...old,expiresAt:1},f.phone.signingPrivateKey),db=new DatabaseSync(path);
  try{db.prepare('UPDATE mailbox_messages SET expires=1,payload=? WHERE space=? AND recipient=?').run(JSON.stringify(legacy),f.space,f.host.device);}finally{db.close();}
  await f.h.revokeDevice(f.phone.device,'remove-compromised-device');
  const page=await f.h.read();assert.equal(page.messages.length,0);assert.equal(page.nextCursor,1);assert.equal(await f.h.acknowledge(page.nextCursor),1);
  const valid=await signEnvelope({...old,id:'valid-after-revoke',from:f.host.device,epoch:2},f.host.signingPrivateKey);
  await f.h.send(valid);assert.deepEqual((await f.h.read()).messages.map(m=>m.envelope.id),['valid-after-revoke']);
 }finally{f.h.stop();f.p.stop();await f.service.close();rmSync(dir,{recursive:true,force:true});}
});
