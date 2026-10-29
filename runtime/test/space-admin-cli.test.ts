import {loadRelayFixture} from './helpers/relay-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SpaceHostController,type HostSpaceConfig} from '../src/space-host/config.js';
import {parseSpaceAdmin,runSpacePair,renderInvitationQr,main} from '../src/space-host/cli.js';
import {adminSocketPath,spaceAdminRequest} from '../src/space-host/admin-socket.js';

test('admin CLI argument parsing',()=>{
 assert.deepEqual(parseSpaceAdmin(['status','--config','/a/c.json']),{command:'status',configPath:'/a/c.json',timeoutSeconds:300});
 assert.deepEqual(parseSpaceAdmin(['pair','--config','/a/c.json','--timeout-seconds','5','--yes-fingerprint','fp']),{command:'pair',configPath:'/a/c.json',timeoutSeconds:5,yesFingerprint:'fp'});
 assert.equal(parseSpaceAdmin(['revoke','--config','/a/c.json','--device','d']).device,'d');
 for(const bad of [['status'],['status','--config'],['revoke','--config','/a'],['status','--config','/a','--device','d'],['pair','--config','/a','--timeout-seconds','0'],['pair','--config','/a','--timeout-seconds','x'],['pair','--config','/a','--config','/b'],['devices','--config','/a','--bogus','1'],['pair','--config','--yes-fingerprint']])
  assert.throws(()=>parseSpaceAdmin(bad),/usage:/);
});

test('invitation QR is rendered from the exact desktop payload',async()=>{
 const text=await renderInvitationQr({id:'i',space:'s'});assert.match(text,/\x1b\[47m/);
 await assert.rejects(renderInvitationQr({pad:'x'.repeat(9000)}),/pairing_payload_too_large/);
});

test('pair, devices and revoke report a stopped Host clearly',{skip:process.platform==='win32'},async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(main(['pair','--config',join(dir,'config.json'),'--yes-fingerprint','x']),/space_host_not_running/);
 await assert.rejects(main(['devices','--config',join(dir,'config.json')]),/space_host_not_running/);
});

test('headless pairing end to end: relay, controller, admin socket, CLI pair, revoke',{skip:process.platform==='win32'},async t=>{
 const {RelayServer,RelayClient,crypto}=await loadRelayFixture();
 const dir=await mkdtemp(join(await realpath(tmpdir()),'cli-'));const cleanup:(()=>void|Promise<void>)[]=[()=>rm(dir,{recursive:true,force:true})];
 t.after(async()=>{for(const close of cleanup.reverse())await close()});
 const relay=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret',bootstrapPerMinute:200,requestsPerMinute:5000});cleanup.push(()=>relay.close());const url=await relay.listen();
 const identity=await crypto.generateDeviceIdentity(),phone=await crypto.generateDeviceIdentity(),space=crypto.spaceId(identity.signingPublicKey);
 const make=(who:typeof identity)=>new RelayClient({url,space,device:who.device,pollIntervalMs:30,reconnectMinMs:20,signChallenge:c=>crypto.signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},who.signingPrivateKey)});
 const h=make(identity),p=make(phone),record={device:identity.device,signingPublicKey:identity.signingPublicKey,encryptionPublicKey:identity.encryptionPublicKey};cleanup.push(()=>h.stop(),()=>p.stop());
 await h.createSpace({space,host:record,proof:await crypto.signControl({v:1,purpose:'space-create',space,host:record},identity.signingPrivateKey)},'operator-only-bootstrap-secret');
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:space,memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const config:HostSpaceConfig={v:1,mode:'host',space,personal_path:host.path,relay_url:url,epoch:1,identity,content_key:Buffer.from(crypto.generateContentKey()).toString('base64url'),members:[]};
 const configPath=join(dir,'config.json'),controller=new SpaceHostController(configPath,config,host,{crypto,RelayClient});host.setSpaceHost(controller);cleanup.push(()=>host.close());
 await host.open({deferBackground:true});
 const socket=adminSocketPath(configPath);assert.equal((await spaceAdminRequest(socket,'status') as {space:string}).space,space);
 const fingerprint=crypto.deviceFingerprint(phone.signingPublicKey,phone.encryptionPublicKey);
 const requestPairing=async()=>{const invitation=await spaceAdminRequest(socket,'invitation') as {id:string;secret:string};const input={v:1,purpose:'pair-request',invitationId:invitation.id,secret:invitation.secret,device:phone.device,signingPublicKey:phone.signingPublicKey,encryptionPublicKey:phone.encryptionPublicKey,business_versions:[1]};return p.requestPairing({...input,proof:await crypto.signControl(input,phone.signingPrivateKey)})};
 const io=(output:string[],confirm:()=>Promise<boolean>=()=>Promise.resolve(false))=>({output:{write:(text:string)=>{output.push(text)}},interactive:false,confirm,signal:new AbortController().signal,pollMs:20});
 const args=(yesFingerprint?:string)=>({command:'pair' as const,configPath,timeoutSeconds:10,...yesFingerprint?{yesFingerprint}:{}});
 await assert.rejects(runSpacePair(args(),io([])),/space_pair_requires_tty/);
 await requestPairing();
 const wrong:string[]=[];assert.equal(await runSpacePair(args('wrong'),io(wrong)),1);assert.match(wrong.join(''),/未绑定/);assert.deepEqual((await spaceAdminRequest(socket,'status') as {clients:string[]}).clients,[]);
 const out:string[]=[];assert.equal(await runSpacePair(args(fingerprint),io(out)),0);assert.ok(out.join('').includes(fingerprint));
 assert.deepEqual((await spaceAdminRequest(socket,'status') as {clients:string[]}).clients,[phone.device]);
 assert.deepEqual(await main(['devices','--config',configPath]),0);
 await spaceAdminRequest(socket,'revoke',{device:phone.device});
 assert.deepEqual((await spaceAdminRequest(socket,'status') as {clients:string[]}).clients,[]);
 const timeout:string[]=[];assert.equal(await runSpacePair({...args(fingerprint),timeoutSeconds:1},io(timeout)),1);assert.match(timeout.join(''),/超时/);
 await host.close();await assert.rejects(spaceAdminRequest(socket,'status'),/space_host_not_running/);
});
