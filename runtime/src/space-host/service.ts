import {applySpaceSourceInput} from './context-input.js';
import type {SpacePushDelivery} from './push.js';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {BoundedJsonStore} from '../storage/bounded-json.js';
import type {PersonalAgentHost} from '../personal-agent/host.js';
import {canonicalJson} from '../text/canonical-json.js';
import {displaySnapshot,displayText} from './projection.js';
import {intentSchema,mobileActionSchema,type BusinessMessage,type SpaceIntent} from './contracts.js';
export interface SpaceHostTransport {
 clients():string[];
 settle?(id:string):Promise<void>;
 recoverPending?(ids:string[]):Promise<void>;
 start(receive:(from:string,body:unknown)=>Promise<void>,cursor:{load:()=>number;save:(n:number)=>Promise<void>}):Promise<()=>void|Promise<void>>;
 send(to:string,body:BusinessMessage,id:string):Promise<void>;
 stream(to:string,body:BusinessMessage,id:string):Promise<void>;
}
const record=z.record(z.string(),z.unknown());
const entry=z.object({hash:z.string(),intent:intentSchema,sender:z.string(),receipt:record.nullable(),chat_status:z.enum(['admitted','completed']).optional(),final:record.optional(),notification_pending:z.boolean().optional()});
const journalSchema=z.object({version:z.literal(1),space:z.string(),cursor:z.number().int().nonnegative(),projection_revision:z.number().int().nonnegative().default(0),ops:z.record(z.string(),entry),remaps:z.record(z.string(),z.record(z.string(),z.string())),outbox:z.array(z.object({id:z.string(),to:z.string(),body:record})),push_outbox:z.array(z.object({to:z.string(),id:z.string(),title:z.string(),body:z.string()})).default([]),actions:z.record(z.string(),z.object({device:z.string(),body:record,result:record.nullable()}))});
type Journal=z.infer<typeof journalSchema>;
const fingerprint=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export class SpaceHost {
 readonly #store;#state:Journal;#tail:Promise<unknown>=Promise.resolve();#stop:(()=>void|Promise<void>)|undefined;#unsubscribe:(()=>void)|undefined;#chats=new Map<string,Promise<void>>();#flush:Promise<void>|undefined;#opened=false;#snapshotTimer:ReturnType<typeof setTimeout>|undefined;
 constructor(readonly options:{path:string;space:string;host:PersonalAgentHost;transport:SpaceHostTransport;push?:SpacePushDelivery;now?:()=>number;onError?:(error:unknown)=>void}){this.#store=new BoundedJsonStore(options.path,journalSchema,32*1024*1024);this.#state={version:1,space:options.space,cursor:0,projection_revision:0,ops:{},remaps:{},outbox:[],push_outbox:[],actions:{}}}
 #now(){return this.options.now?.()??Date.now()}
 #serial<T>(work:()=>Promise<T>):Promise<T>{const run=this.#tail.then(work);this.#tail=run.catch(()=>{ /* Keep the serial queue usable after a caller-visible failure. */ });return run}
 async #save(){await this.#store.write(this.#state)}
 #journalIntent(intent:SpaceIntent):SpaceIntent{return intent.kind==='source.input'?{...intent,input:{}}:intent}
 #key(sender:string,op:string){return fingerprint([sender,op])}
 async open(){if(this.#opened)return;try{this.#state=await this.#store.read(this.#state)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(this.#state.space!==this.options.space)throw Error('space_scope_mismatch');await this.options.push?.open();await this.options.push?.prune(this.options.transport.clients());this.#opened=true;const clients=new Set(this.options.transport.clients());this.#state.outbox=this.#state.outbox.filter(row=>clients.has(row.to));this.#state.push_outbox=this.#state.push_outbox.filter(row=>clients.has(row.to));await this.#save();await this.options.transport.recoverPending?.(this.#state.outbox.map(row=>row.id));
  // An admitted chat is never submitted to the model a second time after a crash.
  for(const [key,op] of Object.entries(this.#state.ops))if(op.chat_status==='admitted'){const saved=this.options.host.spaceChatResult('space:'+key,displayText(op.intent.input.conversation_id,'chat:main'));await this.#finishChat(key,saved??{text:'',status:'interrupted',message_id:'turn-'+fingerprint(key)})}
  this.#unsubscribe=this.options.host.subscribe(()=>this.#scheduleSnapshot());
  this.#stop=await this.options.transport.start((from,body)=>this.receive(from,body),{load:()=>this.#state.cursor,save:n=>this.#serial(async()=>{this.#state.cursor=n;await this.#save()})});
  await this.publishSnapshot();await this.dispatchNotifications();await this.flush();
 }
 #scheduleSnapshot(){if(!this.#opened||this.#snapshotTimer)return;this.#snapshotTimer=setTimeout(()=>{this.#snapshotTimer=undefined;void this.publishSnapshot().catch(error=>this.options.onError?.(error))},100);this.#snapshotTimer.unref()}
 snapshot(){const turns=new Map(Object.entries(this.#state.ops).filter(([,op])=>op.intent.kind==='chat.send').map(([key,op])=>['space:'+key,op.intent.op_id]));return {...displaySnapshot(this.options.host,turns),revision:++this.#state.projection_revision}}
 async publishSnapshot(to?:string){await this.#serial(async()=>{for(const device of to?[to]:this.options.transport.clients())this.#enqueue(device,{v:1,type:'snapshot',snapshot:this.snapshot()},'snapshot-'+randomUUID());await this.#save()});await this.flush()}
 #enqueue(to:string,body:BusinessMessage,id:string){if(body.type==='snapshot'){const data=JSON.stringify(body.snapshot);if(Buffer.byteLength(data)>48*1024){if(Buffer.byteLength(data)>16*1024*1024)throw Error('snapshot_capacity');const chunks:string[]=[];let text='',bytes=0;for(const char of data){const size=Buffer.byteLength(char);if(bytes+size>48*1024){chunks.push(text);text='';bytes=0}text+=char;bytes+=size}if(text)chunks.push(text);if(chunks.length>512)throw Error('snapshot_capacity');for(const [index,data]of chunks.entries())this.#enqueue(to,{v:1,type:'snapshot.chunk',snapshot_id:id,index,total:chunks.length,data},id+'-'+index);return}}if(this.#state.outbox.some(row=>row.id===id&&row.to===to))return;if(this.#state.outbox.length>=4096)throw Error('space_outbox_capacity');this.#state.outbox.push({to,body:structuredClone(body),id})}
 async receive(sender:string,raw:unknown){if(!this.#opened)throw Error('space_host_closed');if(!this.options.transport.clients().includes(sender))throw Error('sender_not_paired');const parsed=intentSchema.safeParse(raw);if(!parsed.success){this.options.onError?.(Error('invalid_business_intent'));return}const intent=parsed.data;const key=this.#key(sender,intent.op_id);let startChat=false;
  await this.#serial(async()=>{const old=this.#state.ops[key],hash=fingerprint(intent);if(old){if(old.hash!==hash){this.#enqueue(sender,{v:1,type:'receipt',op_id:intent.op_id,status:'rejected',error:'op_id_conflict'},'conflict-'+randomUUID());await this.#save();return}if(old.receipt&&old.receipt.status!=='pending'){this.#enqueue(sender,old.receipt,'receipt-'+key);await this.#save();return}}
   if(Object.keys(this.#state.ops).length>=10000&&!old)throw Error('space_receipt_capacity');
   for(const dep of intent.depends_on??[]){const prior=this.#state.ops[this.#key(sender,dep)]?.receipt;if(!prior||prior.status==='pending'){await this.#record(sender,intent,hash,{status:'pending',error:'dependency_pending'});return}if(prior.status!=='accepted'){await this.#record(sender,intent,hash,{status:'rejected',error:'dependency_failed'});return}}
   if(Object.keys(this.#state.ops).length>=10000&&!old)throw Error('space_receipt_capacity');
   if(!old){this.#state.ops[key]={hash,intent:this.#journalIntent(intent),sender,receipt:null};await this.#save()}
   let authorityCommitted=false;
   try{
    if(intent.expires_at!==undefined&&intent.expires_at<=this.#now())throw Error('expired');
    if(intent.kind==='life.mutate'){
     const input=structuredClone(intent.input),maps=this.#state.remaps[sender]??{};for(const field of ['id','goal_id','idea_id'])if(typeof input[field]==='string'&&Object.hasOwn(maps,input[field]))input[field]=maps[input[field]];
     if(input.op!=='create'){if(intent.base_version===undefined)throw Error('base_version_required');input.expected_version=intent.base_version}
     const requestId='space:'+key;const result=await this.options.host.life.mutate(input,requestId);authorityCommitted=true;
     if(intent.temp_id)(this.#state.remaps[sender]??={})[intent.temp_id]=result.id;
     await this.#record(sender,intent,hash,{status:'accepted',result,...(intent.temp_id?{id_map:{[intent.temp_id]:result.id}}:{})});
    }else if(intent.kind==='snapshot.request'){await this.#record(sender,intent,hash,{status:'accepted'})}
    else if(intent.kind==='card.dismiss'){const p=z.object({id:z.string(),kind:z.enum(['feed','timeline'])}).parse(intent.input);if(p.kind==='feed')await this.options.host.action({id:p.id,action:'dismiss'});else await this.options.host.timeline.dismiss(p.id);await this.#record(sender,intent,hash,{status:'accepted'})}
    else if(intent.kind==='chat.send'){
     z.object({conversation_id:z.string().max(128).default('chat:main'),text:z.string().min(1).max(16000)}).parse(intent.input);
     if(intent.expires_at===undefined||intent.expires_at-this.#now()>60000)throw Error('chat_deadline_required');
     if(Object.entries(this.#state.ops).some(([other,value])=>other!==key&&value.chat_status==='admitted'&&displayText(value.intent.input.conversation_id,'chat:main')===displayText(intent.input.conversation_id,'chat:main')))throw Error('conversation_busy');
     this.#state.ops[key]!.chat_status='admitted';await this.#record(sender,intent,hash,{status:'accepted',turn_id:intent.op_id});startChat=true;
    }else if(intent.kind==='chat.cancel'){
     const p=z.object({op_id:z.string()}).parse(intent.input),target=this.#state.ops[this.#key(sender,p.op_id)];if(target?.intent.kind!=='chat.send')throw Error('chat_not_found');
     if(target.chat_status==='admitted')await this.options.host.cancelSpaceChat(displayText(target.intent.input.conversation_id,'chat:main'));
     await this.#record(sender,intent,hash,{status:'accepted'});
    }else if(intent.kind==='source.input'){const memory=this.options.host.options.memory();if(!memory)throw Error('source_backend_unavailable');const result=await applySpaceSourceInput(memory,{space:this.options.space,sender,opId:intent.op_id},intent.input);authorityCommitted=true;await this.options.host.sourceProcessingAgent.reload();this.options.host.connectionChanged();await this.#record(sender,intent,hash,{status:'accepted',result})}
    else if(intent.kind==='push.register'){if(!this.options.push)throw Error('push_unconfigured');const message=await this.options.push.register(sender,intent.input);this.#enqueue(sender,{...message},'push-key-'+key);await this.#record(sender,intent,hash,{status:'accepted'})}
    else if(intent.kind==='push.unregister'){await this.options.push?.revoke(sender);await this.#record(sender,intent,hash,{status:'accepted'})}
    else if(intent.kind==='mobile.result'){
     const p=z.object({action_id:z.string(),status:z.enum(['completed','denied','failed','unknown']),result:record.optional(),error:z.string().max(500).optional()}).parse(intent.input),action=this.#state.actions[p.action_id];if(action?.device!==sender)throw Error('action_not_found');if(action.result&&fingerprint(action.result)!==fingerprint(p))throw Error('action_result_conflict');action.result=p;await this.#record(sender,intent,hash,{status:'accepted'});
    }
   }catch(error){if(authorityCommitted)throw error;const code=error instanceof Error?error.message:'invalid_intent';await this.#record(sender,intent,hash,{status:code==='version_conflict'?'conflict':'rejected',error:code.slice(0,128),...(code==='version_conflict'?{snapshot:this.snapshot()}:{})})}
  });
  if(startChat){const run=this.#runChat(key);this.#chats.set(key,run);void run.catch(error=>this.options.onError?.(error)).finally(()=>this.#chats.delete(key))}
  await this.flush();
 }
 async #record(sender:string,intent:SpaceIntent,hash:string,value:BusinessMessage){const receipt={v:1,type:'receipt',op_id:intent.op_id,...value};const key=this.#key(sender,intent.op_id),projection=value.status==='accepted'&&['life.mutate','card.dismiss','source.input','snapshot.request'].includes(intent.kind)?this.snapshot():undefined;this.#enqueue(sender,receipt,'receipt-'+key);if(projection)this.#enqueue(sender,{v:1,type:'snapshot',snapshot:projection},'snapshot-'+key);this.#state.ops[key]={...this.#state.ops[key]!,hash,intent:this.#journalIntent(intent),sender,receipt};await this.#save()}
 async #runChat(key:string){const op=this.#state.ops[key]!;const conversation=displayText(op.intent.input.conversation_id,'chat:main');let sequence=0;
  const unsubscribe=this.options.host.subscribeSpaceFrames(frame=>{if(frame.conversation_id!==conversation||typeof frame.text!=='string'||frame.role!=='assistant')return;void this.options.transport.stream(op.sender,{v:1,type:'chat.delta',op_id:op.intent.op_id,conversation_id:conversation,text:typeof frame.full_text==='string'?frame.full_text:frame.text,sequence:++sequence},'delta-'+randomUUID()).catch(()=>{/* previews are intentionally disposable */})});
  try{await this.options.host.submitConversationText(conversation,String(op.intent.input.text),'space:'+key);await this.options.host.waitConversation(conversation);await this.#serial(()=>this.#finishChat(key,this.options.host.spaceChatResult('space:'+key,conversation)??{text:'',status:'failed',message_id:'turn-'+key}))}
  catch{await this.#serial(()=>this.#finishChat(key,{text:'',status:'failed',message_id:'turn-'+key}))}finally{unsubscribe()}
  await this.dispatchNotifications();await this.flush();
 }
 async #finishChat(key:string,result:{text:string;status:string;message_id:string}){const op=this.#state.ops[key]!;op.chat_status='completed';op.final=result;if(result.status==='completed'&&result.text)op.notification_pending=true;this.#enqueue(op.sender,{v:1,type:'chat.final',op_id:op.intent.op_id,conversation_id:displayText(op.intent.input.conversation_id,'chat:main'),...result},'final-'+key);await this.#save()}
 async dispatchNotifications(){for(const [key,op]of Object.entries(this.#state.ops)){if(!op.notification_pending||!op.final)continue;const now=this.#now();await this.options.host.publishNotification({event_key:'space-chat:'+key,revision:'1',occurrence:'initial',kind:'alert',title:'Nova',body:String(op.final.text),source:{type:'space_chat',id:key},created_at:now,expires_at:null,not_before:0,priority:100,coalesce_key:null,feedback:[]});await this.#serial(async()=>{op.notification_pending=false;await this.#save()})}}
 async waitForChats(){await Promise.all([...this.#chats.values()])}
 async notify(notification:BusinessMessage,id:string){await this.#serial(async()=>{for(const to of this.options.transport.clients()){this.#enqueue(to,{v:1,type:'notification',...notification,id},'notification-'+fingerprint([id,to]));if(this.options.push&&!this.#state.push_outbox.some(row=>row.id===id&&row.to===to))this.#state.push_outbox.push({to,id,title:displayText(notification.title),body:displayText(notification.body)})}await this.#save()});await this.flush()}
 async #flushPush(){if(!this.options.push)return;for(const next of [...this.#state.push_outbox]){await this.options.push.send(next.to,{id:next.id,title:next.title,body:next.body});await this.#serial(async()=>{this.#state.push_outbox=this.#state.push_outbox.filter(row=>row.id!==next.id||row.to!==next.to);await this.#save()})}}
 async requestMobileAction(device:string,action:unknown,ttlMs=60000,providedId?:string){if(!this.options.transport.clients().includes(device))throw Error('client_not_paired');if(ttlMs<=0||ttlMs>60000)throw Error('invalid_action_deadline');const parsed=mobileActionSchema.parse(action),action_id=providedId??randomUUID(),body={v:1,type:'mobile.action',action_id,...parsed,expires_at:this.#now()+ttlMs};await this.#serial(async()=>{const prior=this.#state.actions[action_id];if(prior){if(prior.device!==device||fingerprint({tool:prior.body.tool,args:prior.body.args})!==fingerprint(parsed))throw Error('action_id_conflict');return}this.#state.actions[action_id]={device,body,result:null};this.#enqueue(device,body,'action-'+action_id);await this.#save()});await this.flush();return {action_id}}
 mobileResult(actionId:string){return structuredClone(this.#state.actions[actionId]?.result??null)}
 flush():Promise<void>{if(this.#flush)return this.#flush;const run=(async()=>{while(this.#opened){let progress=false;for(const next of [...this.#state.outbox]){try{await this.options.transport.send(next.to,next.body,next.id)}catch(error){this.options.onError?.(error);continue}await this.#serial(async()=>{this.#state.outbox=this.#state.outbox.filter(row=>row.id!==next.id||row.to!==next.to);await this.#save()});await this.options.transport.settle?.(next.id);progress=true}await this.#flushPush();if(!progress||!this.#state.outbox.length)return}})();this.#flush=run.finally(()=>{this.#flush=undefined});return this.#flush}
 async close(){this.#opened=false;for(const op of Object.values(this.#state.ops))if(op.chat_status==='admitted')await this.options.host.cancelSpaceChat(displayText(op.intent.input.conversation_id,'chat:main'));await this.waitForChats();if(this.#snapshotTimer)clearTimeout(this.#snapshotTimer);this.#snapshotTimer=undefined;this.#unsubscribe?.();await this.#stop?.();await this.#flush;await this.#serial(()=>this.#save());await this.#tail}
}
