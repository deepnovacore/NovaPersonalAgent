// Run against explicitly selected isolated compilation outputs; never a live vendor provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const args=process.argv.slice(2);
const select=flag=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw Error(`required ${flag}`);return resolve(args[index+1]);};
const {Gateway,createGatewayServer}=await import(pathToFileURL(join(select('--gateway-output'),'src/gateway.js')));
const {SpacePushDelivery}=await import(pathToFileURL(join(select('--runtime-output'),'src/space-host/push.js')));
const {compactDecrypt}=await import(pathToFileURL(createRequire(import.meta.url).resolve('jose')));
const dir=await mkdtemp(join(tmpdir(),'nova-push-integration-'));let key;let delivered=0;
const gateway=new Gateway({statePath:join(dir,'gateway.json'),admissionKey:'test-install-admission-key-32-chars-min',providers:{fcm:{send:async message=>{
 assert.equal(message.token,'device-token-only-gateway-sees');assert.ok(!JSON.stringify(message).includes('private content'));
 const plain=await compactDecrypt(message.ciphertext,Buffer.from(key.notification_key,'base64url'));
 assert.deepEqual(JSON.parse(Buffer.from(plain.plaintext).toString()),{title:'Nova',body:'private content'});delivered++;return {status:'accepted'};
}}}});
const server=createServer(createGatewayServer(gateway));await new Promise((r,e)=>{server.once('error',e);server.listen(0,'127.0.0.1',r);});
const base=`http://127.0.0.1:${server.address().port}`;
try {
 const response=await fetch(base+'/v1/registrations',{method:'POST',headers:{authorization:'Bearer test-install-admission-key-32-chars-min','content-type':'application/json'},body:JSON.stringify({provider:'fcm',token:'device-token-only-gateway-sees'})});
 assert.equal(response.status,201);const registration=await response.json();
 // Host remains configured to a fixed HTTPS origin; only the injected test transport maps to loopback.
 const host=new SpacePushDelivery({path:join(dir,'host.json'),gatewayUrl:'https://push.example.invalid',request:(url,init)=>fetch(String(url).replace('https://push.example.invalid',base),init)});
 await host.open();key=await host.register('phone',registration);
 const notification={id:'opaque-n1',title:'Nova',body:'private content'};
 assert.equal((await host.send('phone',notification)).status,'accepted');
 assert.equal((await host.send('phone',notification)).status,'accepted');assert.equal(delivered,1);
 await host.revoke('phone');
 const rejected=await fetch(base+'/v1/push',{method:'POST',headers:{authorization:`Bearer ${registration.credential}`,'content-type':'application/json'},body:JSON.stringify({handle:registration.handle,notificationId:'n2',ciphertext:'invalid'})});
 assert.equal(rejected.status,400);assert.equal((await host.send('phone',{...notification,id:'n2'})).status,'rejected');
 console.log('PASS real loopback Client registration → Host JWE → gateway scoped send → provider boundary; duplicate and revoke');
}finally{await new Promise((r,e)=>server.close(error=>error?e(error):r()));gateway.close();await rm(dir,{recursive:true,force:true});}
