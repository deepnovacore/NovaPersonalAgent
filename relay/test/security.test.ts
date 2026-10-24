import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compactDecrypt,importJWK} from 'jose';
import {SecurityStore} from '../src/security.js';
import {PairingStore} from '../src/pairing.js';
import {generateDeviceIdentity,spaceId,signControl,signEnvelope,encryptBody,decryptBody,wrapContentKey,unwrapContentKey,
 saveDeviceIdentity,loadDeviceIdentity,generateContentKey,verifyEnvelope} from '../src/crypto.js';

const bootstrapToken='test-deployment-token-long-enough-32';
async function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'nova-security-'));let now=1000;
 const host=await generateDeviceIdentity();const client=await generateDeviceIdentity();
 const space=await spaceId(host.signingPublicKey);
 const registration={space,host:{device:host.device,signingPublicKey:host.signingPublicKey,encryptionPublicKey:host.encryptionPublicKey}};
 const proof=await signControl({v:1,purpose:'space-create',...registration},host.signingPrivateKey);
 let store=new SecurityStore(join(dir,'security.sqlite'),{bootstrapToken,now:()=>now});
 store.createSpace({...registration,proof},bootstrapToken);
 const p={space,device:host.device,epoch:1};
 const login=async(device=host)=> {const c=store.beginLogin(space,device.device);const proof=await signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},device.signingPrivateKey);return {c,proof,result:store.completeLogin({challengeId:c.id,proof})};};
 const invite=()=>store.createInvitation(p);
 const request=async()=>{const i=invite();const value={invitationId:i.id,secret:i.secret,device:client.device,signingPublicKey:client.signingPublicKey,encryptionPublicKey:client.encryptionPublicKey,business_versions:[1]};return {i,value,proof:await signControl({v:1,purpose:'pair-request',...value},client.signingPrivateKey)};};
 return {dir,host,client,space,p,registration,proof,get store(){return store;},login,invite,request,setNow:(v:number)=>{now=v;},restart(){store.close();store=new SecurityStore(join(dir,'security.sqlite'),{bootstrapToken,now:()=>now});},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('persistent key identity and JOSE ciphertext interoperate with jose and bind metadata',async()=>{
 const f=await fixture();try{
  const file=join(f.dir,'identity.json');saveDeviceIdentity(file,f.host);assert.deepEqual(loadDeviceIdentity(file),f.host);if(process.platform!=='win32')assert.equal(statSync(file).mode & 0o777,0o600);
  const key=generateContentKey();const body=await encryptBody({private:'secret'},key);
  assert.deepEqual(await decryptBody(body,key),{private:'secret'});
  const raw=Buffer.from(body,'base64').toString('utf8');const independent=await compactDecrypt(raw,key,{keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM']});assert.equal(Buffer.from(independent.plaintext).toString(),'{"private":"secret"}');
  const e=await signEnvelope({v:1,space:f.space,id:'one',from:f.host.device,to:f.host.device,chan:'mailbox',epoch:1,expiresAt:null,body},f.host.signingPrivateKey);
  f.store.assertCanSend(f.p,e);assert.throws(()=>verifyEnvelope({...e,to:'substitute'},f.host.signingPublicKey),/invalid_signature/);
  await assert.rejects(()=>decryptBody(body,generateContentKey()));
  const payload={v:1 as const,space:f.space,epoch:2,recipient:f.client.device,key:Buffer.from(key).toString('base64url')};
  const wrapped=await wrapContentKey(payload,f.client.encryptionPublicKey);assert.deepEqual(await unwrapContentKey(wrapped,f.client.encryptionPrivateKey),payload);
  const decoded=await compactDecrypt(wrapped,await importJWK(f.client.encryptionPrivateKey,'ECDH-ES+A256KW'));assert.equal(JSON.parse(Buffer.from(decoded.plaintext).toString()).epoch,2);
 }finally{f.close();}
});
test('Space creation requires bootstrap admission, key-derived root and possession; never replaces Host',async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.store.createSpace({...f.registration,proof:f.proof},'wrong'),/bootstrap_denied/);
  assert.throws(()=>f.store.createSpace({...f.registration,proof:f.proof},bootstrapToken),/space_exists/);
  assert.throws(()=>f.store.createSpace({...f.registration,space:'forged',proof:f.proof},bootstrapToken),/invalid_space_identity/);
  f.restart();assert.equal(f.store.getSpace(f.space).host,f.host.device);
  assert.ok(!readFileSync(join(f.dir,'security.sqlite')).includes(Buffer.from(f.host.signingPrivateKey.d!)));
 }finally{f.close();}
});
test('login challenges are single-use, expiring, possession bound and sessions durable',async()=>{
 const f=await fixture();try{
  const {c,proof,result}=await f.login();assert.deepEqual(f.store.authenticate(`Bearer ${result.token}`),f.p);
  assert.throws(()=>f.store.completeLogin({challengeId:c.id,proof}),/invalid_challenge/);
  f.restart();assert.deepEqual(f.store.authenticate(`Bearer ${result.token}`),f.p);
  assert.throws(()=>f.store.authenticate('Bearer forged'),/unauthorized/);
  const other=f.store.beginLogin(f.space,f.host.device);const forged=await signControl({v:1,purpose:'relay-login',challengeId:other.id,nonce:other.nonce,space:other.space,device:other.device,epoch:other.epoch,expiresAt:other.expiresAt},f.client.signingPrivateKey);
  assert.throws(()=>f.store.completeLogin({challengeId:other.id,proof:forged}),/invalid_signature/);
  f.setNow(1_000_000);assert.throws(()=>f.store.authenticate(`Bearer ${result.token}`),/unauthorized/);
 }finally{f.close();}
});
test('pairing invitation is one-use and pending devices need explicit immutable Host approval',async()=>{
 const f=await fixture();try{
  const pairing=new PairingStore(f.store);const {i,value,proof}=await f.request();const pending=pairing.requestPairing({...value,proof});
  assert.deepEqual(pairing.requestPairing({...value,proof}),pending);
  assert.throws(()=>f.store.beginLogin(f.space,f.client.device),/device_inactive/);
  assert.equal(pairing.pendingPairings(f.p)[0]?.fingerprint,pending.fingerprint);f.restart();
  assert.throws(()=>f.store.confirmPairing({...f.p,device:f.client.device},pending.id,'confirm-'+pending.id),/device_inactive/);
  const device=f.store.confirmPairing(f.p,pending.id,'confirm-'+pending.id);assert.equal(device.device,f.client.device);
  assert.deepEqual(f.store.confirmPairing(f.p,pending.id,'confirm-'+pending.id),device);
  assert.ok((await f.login(f.client)).result.token);assert.equal(i.space,f.space);
 }finally{f.close();}
});
test('expired pairing cannot approve and Client cannot change membership',async()=>{
 const f=await fixture();try{
  const {value,proof}=await f.request();const req=f.store.requestPairing({...value,proof});f.setNow(601_001);
  assert.throws(()=>f.store.confirmPairing(f.p,req.id,'confirm-'+req.id),/invalid_pairing_request/);
  f.setNow(602_000);const second=await f.request();const p=f.store.requestPairing({...second.value,proof:second.proof});f.store.confirmPairing(f.p,p.id,'confirm-'+p.id);
  assert.throws(()=>f.store.createInvitation({...f.p,device:f.client.device}),/host_required/);
 }finally{f.close();}
});
test('revocation atomically increments epoch and invalidates sessions, pending invitations and old messages',async()=>{
 const f=await fixture();try{
  const {value,proof}=await f.request();const req=f.store.requestPairing({...value,proof});f.store.confirmPairing(f.p,req.id,'confirm-'+req.id);
  const hostLogin=await f.login();const clientLogin=await f.login(f.client);const invitation=f.invite();
  const result=f.store.revokeDevice(f.p,f.client.device,'revoke-client');assert.equal(result.epoch,2);assert.deepEqual(result.remainingDevices.map(d=>d.device),[f.host.device]);
  for(const token of [hostLogin.result.token,clientLogin.result.token])assert.throws(()=>f.store.authenticate(`Bearer ${token}`),/unauthorized/);
  assert.throws(()=>f.store.assertActive(f.p),/stale_epoch/);assert.throws(()=>f.store.beginLogin(f.space,f.client.device),/device_inactive/);
  const fresh=(await f.login()).result;assert.equal(fresh.principal.epoch,2);assert.throws(()=>f.store.revokeDevice(fresh.principal,f.host.device,'revoke-host'),/cannot_revoke_host/);
  const input={invitationId:invitation.id,secret:invitation.secret,device:'new',signingPublicKey:f.client.signingPublicKey,encryptionPublicKey:f.client.encryptionPublicKey,business_versions:[1]};const signed=await signControl({v:1,purpose:'pair-request',...input},f.client.signingPrivateKey);
  assert.throws(()=>f.store.requestPairing({...input,proof:signed}),/invalid_invitation/);f.restart();assert.equal(f.store.getSpace(f.space).epoch,2);
 }finally{f.close();}
});

test('fixed JOSE vector verifies across independent endpoint keys',async()=>{
 const {joseFixture:f}=await import('./fixtures/jose-v1.js');
 const key=Buffer.from(f.key,'base64url');verifyEnvelope(f.envelope,f.host.signingPublicKey);
 assert.deepEqual(await decryptBody(f.envelope.body,key),f.plaintext);
 verifyEnvelope(f.keyEnvelope,f.host.signingPublicKey);
 assert.deepEqual(await unwrapContentKey(f.wrapped,f.client.encryptionPrivateKey),f.keyDelivery);
});
test('membership change cannot race a stale Host mutation across security adapters',async()=>{
 const f=await fixture();let second:SecurityStore|undefined;try{
  const r=await f.request();const p=f.store.requestPairing({...r.value,proof:r.proof});f.store.confirmPairing(f.p,p.id,'confirm-'+p.id);
  let revoke=false;second=new SecurityStore(join(f.dir,'security.sqlite'),{bootstrapToken,now:()=>{if(revoke){revoke=false;f.store.revokeDevice(f.p,f.client.device,'revoke-client');}return 1000;}});
  revoke=true;assert.throws(()=>second!.createInvitation(f.p),/stale_epoch/);
 }finally{second?.close();f.close();}
});
test('bad key-delivery context and malformed identities are rejected before persistence',async()=>{
 const f=await fixture();try{
  const bad={v:1 as const,space:'',epoch:0,recipient:'',key:'short'};
  await assert.rejects(()=>wrapContentKey(bad,f.client.encryptionPublicKey),/invalid_key_delivery/);
  assert.throws(()=>saveDeviceIdentity(join(f.dir,'bad.json'),{...f.host,device:'invalid id'}),/invalid/);
  assert.throws(()=>saveDeviceIdentity(join(f.dir,'bad.json'),{...f.host,signingPrivateKey:f.client.signingPrivateKey}),/invalid_identity/);
 }finally{f.close();}
});
test('pairing fingerprint binds agreement key as well as signing identity against Relay substitution',async()=>{
 const f=await fixture();try{
  const r=await f.request();const original=f.store.requestPairing({...r.value,proof:r.proof});
  const other=await generateDeviceIdentity();const i=f.invite();const substituted={invitationId:i.id,secret:i.secret,device:'substituted',signingPublicKey:f.client.signingPublicKey,encryptionPublicKey:other.encryptionPublicKey,business_versions:[1]};
  const proof=await signControl({v:1,purpose:'pair-request',...substituted},f.client.signingPrivateKey);
  const replacement=f.store.requestPairing({...substituted,proof});assert.notEqual(original.fingerprint,replacement.fingerprint);
 }finally{f.close();}
});

test('pairing refuses an unsigned or missing business version declaration',async()=> {
 const f=await fixture();try {
  const r=await f.request();const legacy={...r.value} as Record<string,unknown>;delete legacy.business_versions;
  const proof=await signControl({v:1,purpose:'pair-request',...legacy},f.client.signingPrivateKey);
  assert.throws(()=>f.store.requestPairing({...legacy,proof} as unknown as Parameters<SecurityStore['requestPairing']>[0]),/invalid_business_versions/);
 }finally{f.close();}
});

test('business versions are signed, require an intersection and survive pending admission and login',async()=> {
 const f=await fixture();try {
  const r=await f.request();assert.deepEqual(r.i.business_versions,[1]);
  const incompatible={...r.value,business_versions:[2]};
  const badProof=await signControl({v:1,purpose:'pair-request',...incompatible},f.client.signingPrivateKey);
  assert.throws(()=>f.store.requestPairing({...incompatible,proof:badProof}),/unsupported_business_version/);
  assert.throws(()=>f.store.requestPairing({...incompatible,proof:r.proof}),/invalid_signature/);
  const compatible={...r.value,business_versions:[3,1]};
  const proof=await signControl({v:1,purpose:'pair-request',...compatible},f.client.signingPrivateKey);
  const request=f.store.requestPairing({...compatible,proof});assert.equal(request.selected_version,1);
  f.restart();assert.deepEqual(f.store.pendingPairings(f.p)[0]?.business_versions,[3,1]);
  const member=f.store.confirmPairing(f.p,request.id,'version-confirm');assert.equal(member.selected_version,1);
  f.restart();assert.equal((await f.login(f.client)).result.selected_version,1);
  assert.equal(f.store.listDevices(f.p).find(d=>d.device===f.client.device)?.selected_version,1);
 }finally{f.close();}
});
test('pair claims and membership operations replay durable receipts without consuming a second identity or epoch',async()=> {
 const f=await fixture();try {
  const r=await f.request();const first=f.store.requestPairing({...r.value,proof:r.proof});
  f.restart();assert.deepEqual(f.store.requestPairing({...r.value,proof:r.proof}),first);
  const member=f.store.confirmPairing(f.p,first.id,'confirm-stable');f.restart();
  assert.deepEqual(f.store.confirmPairing(f.p,first.id,'confirm-stable'),member);
  assert.throws(()=>f.store.confirmPairing(f.p,'different-request','confirm-stable'),/op_conflict/);
  assert.throws(()=>f.store.confirmPairing({...f.p,device:f.client.device},first.id,'confirm-stable'),/host_required/);
  const result=f.store.revokeDevice(f.p,f.client.device,'revoke-stable');assert.equal(result.epoch,2);f.restart();
  const principal=(await f.login()).result.principal;
  assert.deepEqual(f.store.revokeDevice(principal,f.client.device,'revoke-stable'),result);
  assert.equal(f.store.getSpace(f.space).epoch,2);
  assert.throws(()=>f.store.revokeDevice(principal,'different-device','revoke-stable'),/op_conflict/);
  assert.throws(()=>f.store.confirmPairing(principal,first.id,'confirm-stable'),/invalid_pairing_request/);
  assert.throws(()=>f.store.requestPairing({...r.value,proof:r.proof}),/invalid_invitation/);
  assert.ok(!readFileSync(join(f.dir,'security.sqlite')).includes(Buffer.from(r.value.secret)));
 }finally{f.close();}
});
test('full control receipt quota never prevents revocation and the new epoch receipt survives restart',async()=> {
 const f=await fixture();let limited:SecurityStore|undefined;try {
  const r=await f.request();const request=f.store.requestPairing({...r.value,proof:r.proof});
  const member=f.store.confirmPairing(f.p,request.id,'only-operation');
  limited=new SecurityStore(join(f.dir,'security.sqlite'),{bootstrapToken,now:()=>1000,maxControlOperations:1});
  assert.deepEqual(limited.confirmPairing(f.p,request.id,'only-operation'),member);
  const revoked=limited.revokeDevice(f.p,f.client.device,'over-quota');
  assert.equal(revoked.epoch,2);f.restart();
  assert.deepEqual(f.store.revokeDevice({...f.p,epoch:2},f.client.device,'over-quota'),revoked);
  assert.throws(()=>f.store.assertActive({...f.p,epoch:2,device:f.client.device}),/device_inactive/);
 }finally{limited?.close();f.close();}
});


test('receipt capacity is isolated per Space and epoch cleanup permits repeated pairing/revocation',async()=>{
 const f=await fixture();const path=join(f.dir,'security.sqlite');const limited=new SecurityStore(path,{bootstrapToken,maxControlOperations:1,now:()=>1000});
 const pair=async(p:typeof f.p,phone:typeof f.client)=>{const i=limited.createInvitation(p);const body={invitationId:i.id,secret:i.secret,device:phone.device,signingPublicKey:phone.signingPublicKey,encryptionPublicKey:phone.encryptionPublicKey,business_versions:[1]};const request=limited.requestPairing({...body,proof:await signControl({v:1,purpose:'pair-request',...body},phone.signingPrivateKey)});return limited.confirmPairing(p,request.id,'confirm-'+request.id);};
 try{
  const other=await generateDeviceIdentity(),phone=await generateDeviceIdentity(),space=spaceId(other.signingPublicKey),host={device:other.device,signingPublicKey:other.signingPublicKey,encryptionPublicKey:other.encryptionPublicKey};
  limited.createSpace({space,host,proof:await signControl({v:1,purpose:'space-create',space,host},other.signingPrivateKey)},bootstrapToken);
  await pair(f.p,f.client);await pair({space,device:other.device,epoch:1},phone);
  const first=limited.revokeDevice(f.p,f.client.device,'first-revoke');
  const replacement=await generateDeviceIdentity();await pair({...f.p,epoch:first.epoch},replacement);
  const second=limited.revokeDevice({...f.p,epoch:first.epoch},replacement.device,'second-revoke');assert.equal(second.epoch,3);
  f.restart();assert.deepEqual(f.store.revokeDevice({...f.p,epoch:3},replacement.device,'second-revoke'),second);
  const db=new DatabaseSync(path);try{const rows=db.prepare('SELECT epoch,kind FROM security_operations WHERE space=?').all(f.space);assert.deepEqual(rows.map(row=>({...row})),[{epoch:3,kind:'revoke'}]);}finally{db.close();}
 }finally{limited.close();f.close();}
});
