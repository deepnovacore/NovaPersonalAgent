import {loadRelayFixture} from './helpers/relay-fixture.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SpaceHostController,type HostSpaceConfig} from '../src/space-host/config.js';
import {runSpacePair} from '../src/space-host/cli.js';
import {adminSocketPath,spaceAdminRequest} from '../src/space-host/admin-socket.js';

/** A live headless Host Space with a real local relay, so pairing runs through the admin socket the CLI uses. */
async function spaceHostFixture(t:TestContext,environment?:NodeJS.ProcessEnv){
 const {RelayServer,RelayClient,crypto}=await loadRelayFixture();
 const dir=await mkdtemp(join(await realpath(tmpdir()),'cli-'));const cleanup:(()=>void|Promise<void>)[]=[()=>rm(dir,{recursive:true,force:true})];
 t.after(async()=>{for(const close of cleanup.reverse())await close()});
 const relay=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret',bootstrapPerMinute:200,requestsPerMinute:5000});cleanup.push(()=>relay.close());const url=await relay.listen();
 const identity=await crypto.generateDeviceIdentity(),space=crypto.spaceId(identity.signingPublicKey);
 const make=(who:typeof identity)=>new RelayClient({url,space,device:who.device,pollIntervalMs:30,reconnectMinMs:20,signChallenge:c=>crypto.signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},who.signingPrivateKey)});
 const h=make(identity),record={device:identity.device,signingPublicKey:identity.signingPublicKey,encryptionPublicKey:identity.encryptionPublicKey};cleanup.push(()=>h.stop());
 await h.createSpace({space,host:record,proof:await crypto.signControl({v:1,purpose:'space-create',space,host:record},identity.signingPrivateKey)},'operator-only-bootstrap-secret');
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:space,memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const config:HostSpaceConfig={v:1,mode:'host',space,personal_path:host.path,relay_url:url,epoch:1,identity,content_key:Buffer.from(crypto.generateContentKey()).toString('base64url'),members:[]};
 const configPath=join(dir,'config.json'),controller=new SpaceHostController(configPath,config,host,{crypto,RelayClient},environment);host.setSpaceHost(controller);cleanup.push(()=>host.close());
 await host.open({deferBackground:true});
 const socket=adminSocketPath(configPath),io={output:{write:()=>undefined},interactive:false,confirm:()=>Promise.resolve(false),signal:new AbortController().signal,pollMs:20};
 const phone=async()=>crypto.generateDeviceIdentity();
 const pair=async(device:typeof identity)=>{const client=make(device);cleanup.push(()=>client.stop());const invitation=await spaceAdminRequest(socket,'invitation') as {id:string;secret:string};const input={v:1,purpose:'pair-request',invitationId:invitation.id,secret:invitation.secret,device:device.device,signingPublicKey:device.signingPublicKey,encryptionPublicKey:device.encryptionPublicKey,business_versions:[1]};await client.requestPairing({...input,proof:await crypto.signControl(input,device.signingPrivateKey)});
  assert.equal(await runSpacePair({command:'pair',configPath,timeoutSeconds:10,yesFingerprint:crypto.deviceFingerprint(device.signingPublicKey,device.encryptionPublicKey)},io),0)};
 return {config,configPath,controller,phone,pair,socket};
}

test('Space owner is the first phone on a fresh Host and is never promoted onto a Host that already has members',{skip:process.platform==='win32'},async t=>{
 const {config,controller,phone,pair,socket}=await spaceHostFixture(t),a=await phone(),b=await phone(),third=await phone(),fourth=await phone();
 // A fresh Host has no members, so the first confirmed phone owns credential control.
 await pair(a);assert.equal(config.owner_device,a.device);
 await pair(b);assert.equal(config.owner_device,a.device);
 // Revoking the owner leaves other members: the next pairing must not inherit credential control.
 await spaceAdminRequest(socket,'revoke',{device:a.device});assert.equal(config.owner_device,undefined);
 assert.equal(controller.service!.snapshot(b.device).owner,false);
 await pair(third);assert.equal(config.owner_device,undefined);
 assert.equal(controller.service!.snapshot(third.device).owner,false);
 // Revoking down to zero members makes the Host fresh again, so the next pairing becomes owner.
 await spaceAdminRequest(socket,'revoke',{device:b.device});
 await spaceAdminRequest(socket,'revoke',{device:third.device});assert.deepEqual(config.members,[]);
 await pair(fourth);assert.equal(config.owner_device,fourth.device);
});

test('the owner projection reads the Host operator environment the controller was built with',{skip:process.platform==='win32'},async t=>{
 // A synthetic environment proves the service does not fall back to process.env; the stored-secret store starts empty.
 const {controller,phone,pair}=await spaceHostFixture(t,{SELF_HOSTED_LLM_API_KEY:'operator-custom-env'}),a=await phone();
 await pair(a);assert.equal(controller.config.owner_device,a.device);
 const credentials=(controller.service!.snapshot(a.device) as unknown as {host_credentials:{credentials:{name:string;configured:boolean;source:string|null}[]}}).host_credentials.credentials;
 assert.deepEqual(credentials.filter(row=>row.source==='environment').map(row=>row.name),['SELF_HOSTED_LLM_API_KEY']);
 assert.equal(credentials.find(row=>row.name==='SELF_HOSTED_LLM_API_KEY')!.configured,true);
});
