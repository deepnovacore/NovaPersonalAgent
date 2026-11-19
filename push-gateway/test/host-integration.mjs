// Run against explicitly selected isolated compilation outputs; never a live vendor provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {realpath,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const args=process.argv.slice(2);
const select=flag=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw Error(`required ${flag}`);return resolve(args[index+1]);};
const {Gateway,createGatewayServer}=await import(pathToFileURL(join(select('--gateway-output'),'src/gateway.js')));
const {mintInvitation}=await import(pathToFileURL(join(select('--gateway-output'),'src/admission.js')));
const {SpacePushDelivery}=await import(pathToFileURL(join(select('--runtime-output'),'src/space-host/push.js')));
const {compactDecrypt}=await import(pathToFileURL(createRequire(import.meta.url).resolve('jose')));
const master='test-install-admission-key-32-chars-min',expiresAt=Date.now()+15*60_000;
const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-push-integration-'));let key;let delivered=0;
const gateway=new Gateway({statePath:join(dir,'gateway.json'),admissionKey:master,providers:{fcm:{send:async message=>{
 assert.equal(message.token,'device-token-only-gateway-sees');assert.equal(message.expiresAt,expiresAt);assert.ok(!JSON.stringify(message).includes('private content'));
 const plain=await compactDecrypt(message.ciphertext,Buffer.from(key.notification_key,'base64url'));
 assert.deepEqual(JSON.parse(Buffer.from(plain.plaintext).toString()),{title:'Nova',body:'private content'});delivered++;return {status:'accepted'};
}}}});
const server=createServer(createGatewayServer(gateway));await new Promise((r,e)=>{server.once('error',e);server.listen(0,'127.0.0.1',r);});
const base=`http://127.0.0.1:${server.address().port}`;
try {
 const installationCredential=randomBytes(32).toString('base64url');
 const enrolled=await fetch(base+'/v1/installations',{method:'POST',headers:{authorization:`Bearer ${mintInvitation(master)}`,'content-type':'application/json'},body:JSON.stringify({credential:installationCredential})});assert.equal(enrolled.status,201);
 const response=await fetch(base+'/v1/registrations',{method:'POST',headers:{authorization:`Bearer ${installationCredential}`,'content-type':'application/json'},body:JSON.stringify({provider:'fcm',token:'device-token-only-gateway-sees',registrationId:randomUUID()})});
 assert.equal(response.status,201);const registration=await response.json();
 // Host remains configured to a fixed HTTPS origin; only the injected test transport maps to loopback.
 const host=new SpacePushDelivery({path:join(dir,'host.json'),gatewayUrl:'https://push.example.invalid',request:(url,init)=>fetch(String(url).replace('https://push.example.invalid',base),init)});
 await host.open();key=await host.register('phone',{handle:registration.handle,credential:registration.credential});
 const notification={id:'opaque-n1',title:'Nova',body:'private content',expires_at:expiresAt};
 assert.equal((await host.send('phone',notification)).status,'accepted');
 assert.equal((await host.send('phone',notification)).status,'accepted');assert.equal(delivered,1);
 await host.revoke('phone');
 const rejected=await fetch(base+'/v1/push',{method:'POST',headers:{authorization:`Bearer ${registration.credential}`,'content-type':'application/json'},body:JSON.stringify({handle:registration.handle,notificationId:'n2',ciphertext:'invalid'})});
 assert.equal(rejected.status,400);assert.equal((await host.send('phone',{...notification,id:'n2'})).status,'rejected');
 console.log('PASS real loopback Client invitation enrollment + registration → Host JWE + expiry → gateway scoped send → provider boundary; duplicate and revoke');
}finally{await new Promise((r,e)=>server.close(error=>error?e(error):r()));gateway.close();await rm(dir,{recursive:true,force:true});}
