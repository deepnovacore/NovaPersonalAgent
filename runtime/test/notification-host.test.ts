import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {NotificationChannelAdapter} from '../src/notifications/contracts.js'
const now=new Date('2026-10-12T12:00:00Z')
test('external channel receives feed and task result without local chat or unread; direct replies remain local',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-notification-host-'));const received:string[]=[]
 const adapter:NotificationChannelAdapter={providerId:'test-im',inspect:()=>Promise.resolve(true),prepare:n=>Promise.resolve([{title:n.title,body:n.body}]),send:p=>{received.push(p.body);return Promise.resolve({kind:'accepted',receipt:{message_id:String(received.length)}})}}
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:ref,source:{type:'conversation',ref}}),now:()=>now,notificationAdapters:[adapter]})
 try{await host.open();await host.notifications.bind({id:'im',provider:'test-im',user_scope:'u',identity:'self',generation:1,status:'ready'});await host.configureNotifications('im');await host.admit({kind:'notify',summary:'Reminder',why_now:'Evidence',evidence_refs:['conversation:1'],memory_refs:[]},{...(await host.discoverySnapshot()),evidence_refs:['conversation:1']});await host.flushNotifications();assert.deepEqual(received,['Evidence']);assert.equal(host.conversationSnapshot().unread_count,0);assert.deepEqual(host.conversationSnapshot().messages,[],'the external channel never also writes the main chat');assert.equal(host.snapshot().feed.length,1)
 await host.taskResult('work-a','Complete result');await host.flushNotifications();assert.equal(received.at(-1),'Complete result');assert.equal(host.conversationSnapshot().unread_count,0);assert.deepEqual(host.conversationSnapshot().messages,[])
 host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'Direct reply'}),sendAudio:()=>Promise.resolve(),close:()=>Promise.resolve()}),()=>{/* no observer */});await host.submitConversationText('chat:main','Hello');await new Promise(r=>setTimeout(r,100));assert.equal(host.conversationSnapshot().messages.at(-1)?.text,'Direct reply');assert.equal(received.length,2)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('local notifications land once in the main chat as unread proactive messages; direct replies never count',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-notification-main-'))
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:ref,source:{type:'conversation',ref}}),now:()=>now})
 try{await host.open();assert.deepEqual(host.conversationSnapshot().items.map(item=>item.id),['chat:main'])
  host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'Direct reply'}),close:()=>Promise.resolve()}),()=>{/* no observer */})
  await host.submitConversationText('chat:main','Hello');await host.waitConversation('chat:main');assert.equal(host.conversationSnapshot().unread_count,0,'a reply to the user is not unread')
  await host.admit({kind:'notify',summary:'Reminder',why_now:'Evidence',evidence_refs:['conversation:1'],memory_refs:[]},{...(await host.discoverySnapshot()),evidence_refs:['conversation:1']});await host.flushNotifications();await host.flushNotifications()
  const feed=host.snapshot().feed[0]!,notices=host.conversationSnapshot().messages.filter(m=>m.origin==='proactive')
  assert.deepEqual(notices.map(m=>[m.id,m.conversation_id]),[['feed:'+feed.id,'chat:main']],'one message with a stable id in the main chat')
  assert.equal(host.conversationSnapshot().unread_count,1);assert.equal(host.conversationSnapshot().items[0]!.unread_count,1)
  await host.command({type:'personal.command',request_id:'read',method:'conversations.read',params:{id:'chat:main',through_message_id:notices[0]!.id}});assert.equal(host.conversationSnapshot().unread_count,0)
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('notification commands are available through the host protocol',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-notification-command-'));const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>now});
 try{await host.open();for(const [method,params]of [['notifications.status',{}],['notifications.configure',{binding_id:'nova'}]] as const){const result=await host.command({type:'personal.command',request_id:method,method,params}) as {ok:boolean};assert.equal(result.ok,true)}}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('verified generated task prose is delivered in full to IM without a local reply',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-task-notice-'));const sent:string[]=[];const adapter:NotificationChannelAdapter={providerId:'im',inspect:()=>Promise.resolve(true),prepare:n=>Promise.resolve([{title:n.title,body:n.body}]),send:p=>{sent.push(p.body);return Promise.resolve({kind:'accepted',receipt:{message_id:'result'}})}};
 const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>now,notificationAdapters:[adapter]});
 try{await host.open();await host.notifications.bind({id:'im',provider:'im',user_scope:'u',generation:1,identity:'self',status:'ready'});await host.configureNotifications('im');const task=await host.tasks.delegate('task',{conversation_id:'chat:main',goal:'Draft',acceptance:[],origin_ref:'conversation:1'});const prose='A'.repeat(16000)+'END';await host.tasks.recordDelivery({task_id:task.id,goal_revision:0,control_revision:0},'generated',prose,'generated');host.attachTaskRuntime('chat:main',0,{input:()=>Promise.resolve('accepted'),cancel:()=>{/* no work */},dispatch:()=>Promise.reject(Error('must not execute')),evaluate:()=>Promise.resolve({kind:'complete',evidence_refs:['task-delivery:generated']})});await host.wakeTask(task.id);await host.flushNotifications();assert.deepEqual(sent,[prose]);assert.equal(host.conversationSnapshot().unread_count,0);assert.equal(host.tasks.evidence(task.id)[0]?.outcome,'generated')}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('runtime notice guard rejects revoked evidence and cancelled work',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-guard-'));let evidence=true;const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>evidence?{subject_key:'source',source:{type:'file',ref:'source'}}:null,now:()=>now});
 try{await host.open();const task=await host.tasks.delegate('guard-task',{conversation_id:'chat:main',goal:'Work',acceptance:[],origin_ref:'conversation:1'});const n={event_key:'guard',revision:'1',occurrence:'initial',kind:'task_progress' as const,title:'Progress',body:'Evidence',source:{type:'runtime',id:'guard'},created_at:now.getTime(),expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:[],guard:{task_id:task.id,goal_revision:0,evidence_refs:['source']}};assert.equal(await host.notificationValidity(n),'valid');evidence=false;assert.equal(await host.notificationValidity(n),'invalid');evidence=true;await host.tasks.cancel('cancel',{task_id:task.id,control_revision:0,goal_revision:0},{kind:'nova'});assert.equal(await host.notificationValidity(n),'invalid')}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('migration preserves a future snooze without replaying ordinary historical Feed',async()=>{
 const {PersonalStore,initialState}=await import('../src/personal-agent/store.js');const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-snooze-migrate-'));const path=join(dir,'state.json'),state=initialState();let clock=now.getTime();const due=clock+60000;
 state.feed.push({id:'snooze',kind:'notify',title:'Later',why_now:'Scheduled body',evidence_refs:[],memory_refs:[],source:{type:'conversation',ref:'conversation:1'},subject_key:'old',task_ref:null,suggestion_id:null,priority:40,created_at:now.toISOString(),updated_at:now.toISOString(),expires_at:null,user_state:'snoozed',snooze_until:new Date(due).toISOString(),lifecycle:'active',delivery:{presented_at:null,notified_at:null,spoken_at:null}});state.feed.push({...state.feed[0]!,id:'history',snooze_until:null,user_state:'new'});await new PersonalStore(path).write(state);
 const host=new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>new Date(clock)});
 try{await host.open();assert.equal(host.conversationSnapshot().unread_count,0);clock=due;await host.flushNotifications();assert.equal(host.conversationSnapshot().unread_count,1);assert.equal(host.notifications.snapshot().counts.accepted,1)}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})
test('Feed feedback is bound to the notification revision and occurrence',async()=>{
 const {feedNotification}=await import('../src/notifications/feed.js');const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-feedback-'));const host=new PersonalAgentHost({path:join(dir,'state.json'),userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:ref=>({subject_key:ref,source:{type:'conversation',ref}}),now:()=>now});
 try{await host.open();await host.admit({kind:'notify',summary:'Before',why_now:'Evidence',evidence_refs:['conversation:1'],memory_refs:[]},{...(await host.discoverySnapshot()),evidence_refs:['conversation:1']});const item=host.snapshot().feed[0]!,notice=feedNotification(item),notification={revision:notice.revision,occurrence:notice.occurrence};await host.action({id:item.id,action:'open',notification});await host.command({type:'personal.command',request_id:'topic',method:'conversations.open_feed',params:{feed_id:item.id}});await host.rememberWorkOwner('work',host.conversationSnapshot().selected_id);await host.taskResult('work','Completed');await assert.rejects(host.action({id:item.id,action:'dismiss',notification}),/stale_notification/);assert.notEqual(host.snapshot().feed[0]!.user_state,'dismissed')}finally{await host.close();await rm(dir,{recursive:true,force:true})}
})

test('restart cancels runtime-only notices whose source guard cannot be restored',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-runtime-recovery-'));const path=join(dir,'state.json');let clock=now.getTime();const make=()=>new PersonalAgentHost({path,userScope:'u',pool:new SuggestionPool(),memory:()=>undefined,evidence:()=>null,now:()=>new Date(clock)});const host=make();let recovered:PersonalAgentHost|undefined;
 try{await host.open();await host.publishNotification({event_key:'ephemeral',revision:'1',occurrence:'initial',kind:'task_progress',title:'Progress',body:'Unverifiable after restart',source:{type:'runtime',id:'ephemeral'},created_at:clock,expires_at:null,not_before:clock+60000,priority:40,coalesce_key:null,feedback:[],guard:{requires_runtime:true}},()=>true);await host.close();clock+=60000;recovered=make();await recovered.open();await recovered.flushNotifications();assert.equal(recovered.notifications.snapshot().counts.cancelled,1);assert.equal(recovered.conversationSnapshot().unread_count,0)}finally{await recovered?.close();await host.close();await rm(dir,{recursive:true,force:true})}
})
