import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SpaceHostController,type HostSpaceConfig} from '../src/space-host/config.js';
import type {SpaceIdentity} from '../src/space-host/relay-transport.js';
import {loadRelayFixture} from './helpers/relay-fixture.js';

test('scheduled Host result survives an offline Client and arrives once through the real relay',async()=>{
const {RelayServer,RelayClient,crypto}=await loadRelayFixture();
const dir=await mkdtemp(join(tmpdir(),'host-background-network-'));const relay=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'operator-only-bootstrap-secret'});const url=await relay.listen();
const identity=await crypto.generateDeviceIdentity(),phone=await crypto.generateDeviceIdentity(),space=crypto.spaceId(identity.signingPublicKey),key=crypto.generateContentKey();
const make=(identity:SpaceIdentity)=>new RelayClient({url,space,device:identity.device,pollIntervalMs:30,reconnectMinMs:20,signChallenge:(c:{id:string;nonce:string;space:string;device:string;epoch:number;expiresAt:number})=>crypto.signControl({v:1,purpose:'relay-login',challengeId:c.id,nonce:c.nonce,space:c.space,device:c.device,epoch:c.epoch,expiresAt:c.expiresAt},identity.signingPrivateKey)});
const h=make(identity),p=make(phone),record={device:identity.device,signingPublicKey:identity.signingPublicKey,encryptionPublicKey:identity.encryptionPublicKey};await h.createSpace({space,host:record,proof:await crypto.signControl({v:1,purpose:'space-create',space,host:record},identity.signingPrivateKey)},'operator-only-bootstrap-secret');

const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:space,memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
const config:HostSpaceConfig={v:1,mode:'host',space,personal_path:host.path,relay_url:url,epoch:1,identity,content_key:Buffer.from(key).toString('base64url'),members:[]};
const controller=new SpaceHostController(join(dir,'config.json'),config,host,{crypto,RelayClient});host.setSpaceHost(controller);
try {
 await host.open();
 const invitation=await controller.invitation();
 const input={v:1,purpose:'pair-request',invitationId:invitation.id,secret:invitation.secret,device:phone.device,signingPublicKey:phone.signingPublicKey,encryptionPublicKey:phone.encryptionPublicKey,business_versions:[1]};
 const request=await p.requestPairing({...input,proof:await crypto.signControl(input,phone.signingPrivateKey)});
 await controller.confirmPairing(request.id,crypto.deviceFingerprint(phone.signingPublicKey,phone.encryptionPublicKey));
 // No Client WebSocket or mailbox reader is running while the Host completes its work.
 const context={todos:true,goals:false,tasks:false,memory:false,search:false,knowledge:false};
 const schedule=await host.schedules.create('create',{title:'Offline report',goal:'Suggest one action',acceptance:['One action'],rule:{kind:'daily',timezone:'UTC',time:'10:00'},context},{user_scope:space,source:'ui',origin_ref:'ui:create',source_refs:[],allowed_context:context});
 const run=await host.schedules.runNow('run',schedule.id,1),task=await host.tasks.delegate('scheduled:'+run.run_id,run.input),fence={task_id:task.id,control_revision:0,goal_revision:0};
 await host.schedules.bindTask(run.run_id,task.id);await host.schedules.markPrepared(run.run_id,'schedule-run:'+run.run_id);
 await host.readAppContext('todos',null,host.scheduledRunGrant(run.run_id,new AbortController().signal));
 await host.tasks.recordDelivery(fence,'reply','Prepare the proposal.');
 await host.tasks.applyDecision(fence,{kind:'complete',evidence_refs:['task-delivery:reply'],criteria:[{index:0,evidence_refs:['task-delivery:reply']}]});
 await host.publishScheduledResult(run.run_id);await host.flushNotifications();
 await host.publishScheduledResult(run.run_id);await host.flushNotifications();
 await controller.service!.flush();
 assert.equal(host.tasks.list().length,1);
 const received:Record<string,unknown>[]=[];let cursor=0;
 const deadline=Date.now()+5000;
 for(let pageCount=0;pageCount<200&&Date.now()<deadline;pageCount++) {
  const page=await p.read({after:cursor,limit:2});
  for(const item of page.messages){const envelope=item.envelope;crypto.verifyEnvelope(envelope,identity.signingPublicKey);try{received.push(await crypto.decryptBody(envelope.body,key) as Record<string,unknown>)}catch{await crypto.unwrapContentKey(Buffer.from(envelope.body,'base64').toString(),phone.encryptionPrivateKey)}}
  cursor=page.nextCursor;await p.acknowledge(cursor);
  if(received.some(message=>message.type==='notification'&&message.body==='Prepare the proposal.')&&received.some(message=>message.type==='snapshot'&&JSON.stringify(message).includes('Prepare the proposal.')))break;
  if(!page.hasMore)await new Promise(resolve=>setTimeout(resolve,25));
 }
 const notices=received.filter(message=>message.type==='notification'&&message.body==='Prepare the proposal.');
 assert.equal(notices.length,1,'the real scheduled producer delivers one durable notification after offline completion');
 assert.ok(received.some(message=>message.type==='snapshot'&&JSON.stringify(message).includes('Prepare the proposal.')),'authoritative snapshot includes the completed report');
 const message=notices[0]!;
 const scheduleFeed=host.snapshot().feed.find(item=>item.schedule_ref?.run_id===run.run_id)!;
 const {feedNotification}=await import('../src/notifications/feed.js');
 assert.equal(await host.notificationValidity(feedNotification(scheduleFeed)),'valid');
 await host.life.mutate({op:'create',kind:'todo',title:'Context changed'},'change');
 assert.equal(await host.notificationValidity(feedNotification(scheduleFeed)),'invalid','changed App context still invalidates scheduled delivery');
 assert.ok(typeof message.id==='string');
}finally{await host.close();h.stop();p.stop();await relay.close();await rm(dir,{recursive:true,force:true})}
});
