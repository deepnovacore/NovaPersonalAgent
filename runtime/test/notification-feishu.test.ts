import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {FeishuConnector} from '../src/connectors/feishu/index.js'
import {feishuNotificationAdapter} from '../src/notifications/adapters/feishu.js'
import type {NotificationInput} from '../src/notifications/contracts.js'
const message:NotificationInput={event_key:'feed:a',revision:'1',occurrence:'initial',kind:'brief',title:'Brief',body:'A'.repeat(4500)+'END',source:{type:'feed',id:'a'},created_at:1000,expires_at:null,not_before:0,priority:40,coalesce_key:null,feedback:['open','snooze','dismiss']}
test('outbound-only identity can send full multipart body with collection paused and rejects an account change',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-notify-feishu-'));let account='ou_me';const contents:string[]=[];const scopes:string[]=[];const feedback:unknown[]=[]
 const connector=new FeishuConnector({executable:'unused',credentialRoot:dir,statePath:join(dir,'state.json'),ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:action=>{feedback.push(action);return Promise.resolve()},run:async(args,options)=>{
 if(args[0]==='--version')return '1.0.69'
 if(args[1]==='status')return JSON.stringify({appId:'cli_test',verified:true,identities:{user:{openId:account,status:'authenticated',scopes:['offline_access']}}})
 if(args[1]==='login'&&args.includes('--scope')){scopes.push(args[args.indexOf('--scope')+1]!);return JSON.stringify({verification_url:'https://accounts.feishu.cn/device',device_code:'code',expires_in:900})}
 if(args[1]==='login')return '{}'
 if(args[1]==='+messages-send'){assert.equal(args[args.indexOf('--user-id')+1],'ou_me');contents.push(args[args.indexOf('--content')+1]!);return JSON.stringify({message_id:'om_'+contents.length,chat_id:'oc_self'})}
 if(args[1]==='consume')return new Promise<string>(resolve=>options?.signal?.addEventListener('abort',()=>resolve(''),{once:true}))
 return '{}'
 }})
 try{await connector.open();await connector.command('feishu.notification.login');assert.deepEqual(scopes,['offline_access']);await connector.completeLogin();await connector.command('feishu.notification.configure',{enabled:true});await connector.pause();const binding=connector.notificationBinding('u');assert(binding);assert.equal(binding.status,'ready');const adapter=feishuNotificationAdapter(connector);assert(await adapter.inspect(binding,new AbortController().signal));const parts=await adapter.prepare(message,binding);assert.equal(parts.map(p=>p.body).join(''),message.body);assert(parts.length>1)
 for(const [i,p]of parts.entries()){const result=await adapter.send(p,{binding,idempotency_key:'part:'+i,notification:message,signal:new AbortController().signal});assert.equal(result.kind,'accepted')}
 const card=JSON.parse(contents[0]!) as {elements:{actions?:{value:{nonce:string;proposal_id:string;action:string}}[]}[]};const action=card.elements.find(e=>e.actions)?.actions?.[0]!.value;assert(action);assert.equal(await connector.acceptAction({type:'card.action.trigger',operator_id:'ou_me',event_id:'click1',message_id:'om_1',chat_id:'oc_self',action_value:JSON.stringify(action)}),true);assert.deepEqual(feedback,[{proposal_id:'a',action:'open',event_id:'click1',notification:{revision:'1',occurrence:'initial'}}]);
 const openOnly={...message,feedback:['open'] as const};await adapter.send(parts[0]!,{binding,idempotency_key:'open-only',notification:{...openOnly,feedback:[...openOnly.feedback]},signal:new AbortController().signal});const lastCard=JSON.parse(contents.at(-1)!) as typeof card;const lastAction=lastCard.elements.find(e=>e.actions)?.actions?.[0]!.value;assert.equal(await connector.acceptAction({type:'card.action.trigger',operator_id:'ou_me',event_id:'forged',message_id:'om_'+contents.length,chat_id:'oc_self',action_value:JSON.stringify({...lastAction,action:'ignore'})}),false);
 account='ou_someone_else';const rejected=await adapter.send(parts[0]!,{binding,idempotency_key:'old',notification:message,signal:new AbortController().signal});assert.equal(rejected.kind,'blocked');assert.equal(contents.length,parts.length+1)
 }finally{await connector.close();await rm(dir,{recursive:true,force:true})}
})
