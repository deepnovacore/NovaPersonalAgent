import {chatFailure,type ChatFailure} from '../personal-agent/chat-failure.js';
import {notificationSchema,type NotificationInput} from '../notifications/contracts.js';
import {applySpaceSourceInput} from './context-input.js';
import type {SpacePushDelivery} from './push.js';
import {constants} from 'node:fs';
import {link,mkdir,open as openFile,rm} from 'node:fs/promises';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {z} from 'zod';
import {loadWindowsSpaceSecretKey} from './windows-secret-key.js';
import {BoundedJsonStore} from '../storage/bounded-json.js';
import type {PersonalAgentHost} from '../personal-agent/host.js';
import {canonicalJson} from '../text/canonical-json.js';
import {displaySnapshot,displayText,visibleChatRequests} from './projection.js';
import {type HostSecretStore,connectorFeishuSchema,credentialsView,feishuMethod,feishuView,secretClearSchema,secretPutSchema,settingsPatchSchema,settingsView} from './host-admin.js';
import type {HostModelRoutesStore} from './model-settings.js';
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
const entry=z.object({hash:z.string(),tag:z.string().optional(),intent:intentSchema,sender:z.string(),receipt:record.nullable(),chat_status:z.enum(['admitted','completed']).optional(),final:record.optional(),notification_pending:z.boolean().optional(),recorded_at:z.number().int().nonnegative().optional(),revoke_started:z.boolean().optional()});
/** The journal stays readable by binaries from before receipt pruning: version 1, and only fields their non-strict schema tolerates. */
const journalSchema=z.object({version:z.literal(1),space:z.string(),cursor:z.number().int().nonnegative(),projection_revision:z.number().int().nonnegative().default(0),ops:z.record(z.string(),entry),remaps:z.record(z.string(),z.record(z.string(),z.string())),outbox:z.array(z.object({id:z.string(),to:z.string(),body:record})),push_outbox:z.array(z.object({to:z.string(),id:z.string(),title:z.string(),body:z.string(),expires_at:z.number().int().optional(),notification:notificationSchema.optional()})).default([]),actions:z.record(z.string(),z.object({device:z.string(),body:record,result:record.nullable()}))});
/**
 * Replay protection for pruned ops lives in a sidecar next to the journal (see `#prune`). An older binary never reads it, so a
 * downgrade only loses that protection and never refuses or rewrites the journal; a missing sidecar starts empty.
 */
const replaySchema=z.object({version:z.literal(1),space:z.string(),replay_floor:z.record(z.string(),z.number().int().nonnegative()),pruned_receipts:z.record(z.string(),z.object({accepted:z.boolean(),hash:z.string(),tag:z.string().optional(),sender:z.string(),created_at:z.number().int().nonnegative()}))});
type ReplayState=z.infer<typeof replaySchema>;
type Journal=z.infer<typeof journalSchema>;
type JournalOp=z.infer<typeof entry>;
/** Settled receipts kept for idempotent replay before the oldest are pruned (see `#prune`). */
const RETAINED_RECEIPTS=1024;
/** Serialized bytes of retained ops, well below the 32 MiB journal limit: large receipts are pruned by size as well as by count. */
const OPS_BYTE_BUDGET=12*1024*1024;
/**
 * Unsettled ops one sender may hold; past it that sender's new ops are refused, other senders are unaffected.
 * Known limit (pre-existing): the backlog summed over all senders is not bounded against the 32 MiB journal store.
 */
const LIVE_OPS_PER_SENDER=1024;
/** Pruned op outcomes remembered for late `depends_on` lookups and changed-body detection. */
const PRUNED_TOMBSTONES=4096;
/**
 * Accepted ops created after the Host clock keep their tombstones past PRUNED_TOMBSTONES until that time arrives, because the
 * clamped floor does not cover them yet. receive() refuses a sender's new future-dated op (`future_capacity`) once it holds this
 * many such ops or tombstones, which bounds the protected set without ever evicting one early.
 */
const FUTURE_TOMBSTONES_PER_SENDER=1024;
/** A dependent whose dependency is unknown to the Host (never seen, not tombstoned) fails after waiting this long on the Host clock. */
const DEPENDENCY_WAIT_MS=7*86_400_000;
/** An intent created further ahead of the Host clock is refused; the refusal is an ordinary settled, prunable op. */
const CLOCK_SKEW_MS=86_400_000;
/** An op no replay or later op can still change: it has a final receipt, its chat is finished and its notification is published. */
const settled=(op:JournalOp)=>op.receipt!==null&&op.receipt.status!=='pending'&&op.chat_status!=='admitted'&&!op.notification_pending;
const ADMIN_KINDS=new Set(['settings.patch','secret.put','secret.clear','connector.feishu','device.revoke']);
/** Kinds whose journaled intent is redacted; an HMAC tag over the full intent lets replays detect a changed value without storing it. */
const SECRET_KINDS=new Set<SpaceIntent['kind']>(['secret.put','secret.clear','source.input','push.register']);
const fingerprint=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Key-file failures carry their code as a property too, so startup diagnostics do not have to parse the message. */
const keyError=(code:string)=>Object.assign(Error(code),{code});
export class SpaceHost {
 readonly #store;#state:Journal;#raw=new Map<string,string>();#tail:Promise<unknown>=Promise.resolve();#stop:(()=>void|Promise<void>)|undefined;#unsubscribe:(()=>void)|undefined;#chats=new Map<string,Promise<void>>();#feishuPolls=new Map<string,{abort:AbortController;task:Promise<void>}>();#flush:Promise<void>|undefined;#opened=false;#snapshotTimer:ReturnType<typeof setTimeout>|undefined;#snapshotHashes=new Map<string,string>();#secretKey:string|undefined;
/** `feishuPollMs` is the interval between Feishu app-setup status polls and `feishuSetupTimeoutMs` bounds them to the connector's 300s config operation, so a link that appears late still reaches the phone. */
 constructor(readonly options:{path:string;space:string;host:PersonalAgentHost;transport:SpaceHostTransport;push?:SpacePushDelivery;owner?:()=>string|undefined;secrets?:HostSecretStore;models?:HostModelRoutesStore;revokeDevice?:(device:string)=>Promise<unknown>;feishuPollMs?:number;feishuSetupTimeoutMs?:number;environment?:NodeJS.ProcessEnv;now?:()=>number;onError?:(error:unknown)=>void;retainedReceipts?:number}){this.#store=new BoundedJsonStore(options.path,journalSchema,32*1024*1024);this.#replayStore=new BoundedJsonStore(options.path+'.replay.json',replaySchema,8*1024*1024);this.#replay={version:1,space:options.space,replay_floor:{},pruned_receipts:{}};this.#state={version:1,space:options.space,cursor:0,projection_revision:0,ops:{},remaps:{},outbox:[],push_outbox:[],actions:{}}}
 #now(){return this.options.now?.()??Date.now()}
 #serial<T>(work:()=>Promise<T>):Promise<T>{const run=this.#tail.then(work);this.#tail=run.catch(()=>{ /* Keep the serial queue usable after a caller-visible failure. */ });return run}
 readonly #replayStore;#replay:ReplayState;#replayDirty=false;#loaded=false;
 /** The sidecar is written first: a crash between the writes leaves tombstones for ops the journal still holds, which is harmless because a retained op is always looked up first. */
 async #save(){this.#prune();if(this.#replayDirty){await this.#replayStore.write(this.#replay);this.#replayDirty=false}await this.#store.write(this.#state)}
 #opBytes=new WeakMap<JournalOp,number>();
 /** Ops are replaced, never mutated in place, when their receipt changes, so the cached size of an op object stays exact. */
 #sizeOf(op:JournalOp){let bytes=this.#opBytes.get(op);if(bytes===undefined){bytes=Buffer.byteLength(JSON.stringify(op));this.#opBytes.set(op,bytes)}return bytes}
 /**
  * Bounded receipt retention. Idempotent replay needs the receipt of an op its client may still resend, but keeping every receipt
  * eventually fills the journal. Settled ops (refusals included) are pruned oldest arrival first while more than `retainedReceipts`
  * remain or their serialized size exceeds OPS_BYTE_BUDGET. An op is kept while anything can still need it: it is unsettled, an
  * unsettled op depends on it, or the snapshot chat window still shows its turn.
  *
  * Replay safety: a pruned op leaves a tombstone in the replay sidecar (outcome, redacted body hash, HMAC tag over the full intent of redacted kinds) and
  * lifts its sender's floor to its `created_at`, clamped to the Host clock. receive() answers an unknown op whose key is tombstoned,
  * or whose `created_at` is at or below the floor, without running it: `op_id_conflict` for a changed intent under a tombstoned op
  * id, `op_expired` otherwise. The floor only compares one device's clock with itself; the clamp keeps a future-dated record from
  * locking that device out after its clock is corrected.
  *
  * Known tradeoffs:
  * - Beyond the tombstone window, an op id reused with a changed intent and a `created_at` above the floor is a new op. Clients never
  *   reuse op ids, and a resend carries its original `created_at`, which the floor rejects; the exception is a future-dated op whose
  *   floor contribution was clamped, which after leaving the tombstone window is judged afresh.
  * - An op refused as clock_skew can run if it is redelivered after its time arrives and its tombstone has left the window. Accepted:
  *   it never ran, and its client already saw the rejection and dropped it.
  * - A downgraded binary ignores the replay sidecar, so ops pruned before the downgrade lose replay protection while it runs. It also
  *   strips `revoke_started`, so after a re-upgrade a revocation that completed while its receipt was pending stays pending until
  *   its client resends it.
  * - A first delivery that arrives after newer ops of the same device were pruned is refused as `op_expired`, for example an op held
  *   back by its client while more than `retainedReceipts` newer ops settled. It fails visibly and never runs twice.
  * - A chat turn that leaves the snapshot window can be pruned; if the window later shows it again, it appears without its turn id.
  * Pre-existing limits, not addressed here: `remaps` and completed mobile `actions` still grow without bound; a version_conflict
  * receipt carries a full snapshot in one message and can exceed the relay message limit; the Flutter controller does not enqueue a
  * new snapshot.request after a terminal rejection of its pending one.
  */
 #prune(){
  const now=this.#now(),ops=this.#state.ops,tombstones=this.#replay.pruned_receipts,limit=this.options.retainedReceipts??RETAINED_RECEIPTS;
  const known=(sender:string,dep:string)=>{const depKey=this.#key(sender,dep);return depKey in ops||depKey in tombstones};
  for(const [key,op] of Object.entries(ops)){
   if(op.receipt?.status!=='pending'||op.receipt.error!=='dependency_pending')continue;
   // A dependent cannot wait forever: past its own deadline it expires, and on a dependency the Host never saw it fails after DEPENDENCY_WAIT_MS. Its client gets the stored rejection on its next resend.
   const recorded=op.recorded_at??now,error=op.intent.expires_at!==undefined&&op.intent.expires_at<=now?'expired':recorded+DEPENDENCY_WAIT_MS<=now&&(op.intent.depends_on??[]).some(dep=>!known(op.sender,dep))?'dependency_failed':undefined;
   if(error)ops[key]={...op,receipt:{v:1,type:'receipt',op_id:op.intent.op_id,status:'rejected',error}};
   else if(op.recorded_at===undefined)ops[key]={...op,recorded_at:now};
  }
  const keys=Object.keys(ops),needed=new Set<string>();let count=keys.length,bytes=0;
  for(const op of Object.values(ops)){bytes+=this.#sizeOf(op);if(!settled(op))for(const dep of op.intent.depends_on??[])needed.add(this.#key(op.sender,dep))}
  if(count>limit||bytes>OPS_BYTE_BUDGET){
   const visible=visibleChatRequests(this.options.host);
   // Object key order is first-arrival order: #record reassigns an existing key in place.
   for(const key of keys){
    if(count<=limit&&bytes<=OPS_BYTE_BUDGET)break;
    const op=ops[key]!;
    if(!settled(op)||needed.has(key)||visible.has('space:'+key))continue;
    delete ops[key];this.#raw.delete(key);count--;bytes-=this.#sizeOf(op);
    this.#replay.replay_floor[op.sender]=Math.max(this.#replay.replay_floor[op.sender]??0,Math.min(op.intent.created_at,now));
    delete tombstones[key];tombstones[key]={accepted:op.receipt!.status==='accepted',hash:op.hash,...(op.tag?{tag:op.tag}:{}),sender:op.sender,created_at:op.intent.created_at};this.#replayDirty=true;
   }
  }
  // The oldest tombstones leave first, except one a pending dependent still waits on and an accepted one whose op was created after
  // the Host clock (bounded at admission, see FUTURE_TOMBSTONES_PER_SENDER). An evicted tombstone raises its sender's floor to its
  // created_at, clamped to the Host clock, so a tombstone that waited for its time is still covered once it leaves.
  let extra=Object.keys(tombstones).length-PRUNED_TOMBSTONES;
  if(extra>0)for(const [key,tombstone] of Object.entries(tombstones)){
   if(extra<=0)break;
   if(needed.has(key)||tombstone.accepted&&tombstone.created_at>now)continue;
   this.#replay.replay_floor[tombstone.sender]=Math.max(this.#replay.replay_floor[tombstone.sender]??0,Math.min(tombstone.created_at,now));
   delete tombstones[key];extra--;this.#replayDirty=true;
  }
 }
 /** Accepted or still running ops of a sender created after the Host clock, retained or tombstoned. */
 #futureOps(sender:string,now:number){let count=0;for(const op of Object.values(this.#state.ops))if(op.sender===sender&&op.intent.created_at>now&&op.receipt?.status!=='rejected')count++;for(const tombstone of Object.values(this.#replay.pruned_receipts))if(tombstone.sender===sender&&tombstone.accepted&&tombstone.created_at>now)count++;return count}
 /** The outcome of a dependency, from its retained op or its tombstone. */
 #dependency(sender:string,dep:string):{status?:unknown}|undefined{const depKey=this.#key(sender,dep),pruned=this.#replay.pruned_receipts[depKey];return this.#state.ops[depKey]?.receipt??(pruned===undefined?undefined:{status:pruned.accepted?'accepted':'rejected'})}
 // A persisted hash must not be an offline guess oracle for a stored secret: the idempotency hash covers the redacted form only. A conflicting value under the same op id is detected from `#raw` within one process and from the persisted HMAC tag across restarts. The tag key lives in a private sibling file, never in the journal.
 #journalIntent(intent:SpaceIntent):SpaceIntent{if(intent.kind==='source.input')return {...intent,input:{}};if(intent.kind==='secret.put'||intent.kind==='secret.clear')return {...intent,input:{name:intent.input.name}};if(intent.kind==='push.register'){const {credential:_credential,...rest}=intent.input;return {...intent,input:rest}}return intent}
 /** The journal is a portable backup; its secret tags are useless without this separate 0600 key. */
 async #loadSecretKey():Promise<string>{
  const cached=this.#secretKey;if(cached)return cached
  const path=this.options.path+'.key'
  if(process.platform==='win32')return this.#secretKey=await loadWindowsSpaceSecretKey(path)
  // Only a missing key is created. A damaged key fails closed and is never deleted or replaced: it may be the last copy that can still authenticate existing tags, and a starter that recovers "late" must not remove the complete key another starter just published.
  const existing=await this.#readSecretKey(path).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error})
  if(existing!==undefined)return this.#secretKey=existing
  return this.#publishSecretKey(path)
 }
 /** Publish only a complete key: write and fsync a private temp file, then link it into place without replacing a key another starter already published. */
 async #publishSecretKey(path:string):Promise<string>{
  const key=randomBytes(32).toString('hex'),temp=path+'.'+randomUUID()+'.tmp'
  await mkdir(dirname(path),{recursive:true,mode:0o700})
  let publishing=false
  try{
   const file=await openFile(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
   try{await file.writeFile(key);await file.sync()}finally{await file.close()}
   publishing=true;await link(temp,path);
   // Node cannot fsync directories on Windows; the key itself was synced before it was linked.
   if(process.platform!=='win32'){const dir=await openFile(dirname(path),constants.O_RDONLY);try{await dir.sync()}finally{await dir.close()}}
  }catch(error){
   // A starter that lost the race adopts the winner's complete key below instead of trusting its own.
   if(!publishing||(error as NodeJS.ErrnoException).code!=='EEXIST')throw error
  }finally{await rm(temp,{force:true}).catch(()=>{ /* A leftover temp file is never read as the key. */ })}
  return this.#secretKey=await this.#readSecretKey(path)
 }
 /** Read the tag key through a handle: a symlinked or group-readable key file must never supply the tag key. */
 async #readSecretKey(path:string):Promise<string>{
  const opened=await openFile(path,constants.O_RDONLY|constants.O_NOFOLLOW).catch((error:NodeJS.ErrnoException)=>{
   // O_NOFOLLOW reports a symlinked key as ELOOP instead of following it to a file someone else controls.
   if(error.code==='ELOOP')throw keyError('space_secret_key_symlink')
   throw error
  })
  try{
   const stats=await opened.stat()
   if(!stats.isFile())throw keyError('space_secret_key_invalid')
   // Another account could read a 0644 key and forge the tags that guard secret replays.
   if((stats.mode&0o077)!==0)throw keyError('space_secret_key_permissions')
   if(stats.size===0)throw keyError('space_secret_key_empty')
   if(stats.size!==64)throw keyError('space_secret_key_invalid')
   const {buffer,bytesRead}=await opened.read(Buffer.alloc(64),0,64,0),text=buffer.toString('utf8',0,bytesRead)
   if(!/^[a-f0-9]{64}$/u.test(text))throw keyError('space_secret_key_invalid')
   return text
  }finally{await opened.close()}
 }
 #secretTag(key:string,raw:string):string{return createHmac('sha256',this.#secretKey!).update(key+'\n'+raw).digest('hex')}
 #owner(){return this.options.owner?.()}
 #hostAdmin(sender:string){return this.#owner()===sender}
 #requireChat(id:string){const row=this.options.host.conversationSnapshot(0).items.find(row=>row.id===id);if(!row)throw Error('conversation_not_found');if(!['chat','topic'].includes(row.kind)||(row.mode??'chat')!=='chat')throw Error('conversation_read_only')}
 #key(sender:string,op:string){return fingerprint([sender,op])}
 async open(){if(this.#opened)return;
  // Both files are validated before either replaces the initial state; until then close() saves nothing, so a refused or unreadable file is never overwritten.
  const read=async<T>(store:BoundedJsonStore<T>,fallback:T)=>{try{return await store.read(fallback)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return fallback}};
  const state=await read(this.#store,this.#state),replay=await read(this.#replayStore,this.#replay);
  if(state.space!==this.options.space||replay.space!==this.options.space)throw Error('space_scope_mismatch');
  this.#state=state;this.#replay=replay;this.#loaded=true;
  // A crash between the sidecar and journal writes can leave an op both retained and tombstoned; the tombstone is the later state, so the op was settled and pruned. Dropping it makes a retry answer op_expired instead of running it again.
  for(const [key,op] of Object.entries(this.#state.ops))if(this.#replay.pruned_receipts[key]?.hash===op.hash)delete this.#state.ops[key];
 await this.#loadSecretKey();await this.options.secrets?.open();await this.options.push?.open();await this.options.push?.prune(this.options.transport.clients());this.#opened=true;const clients=new Set(this.options.transport.clients());this.#state.outbox=this.#state.outbox.filter(row=>clients.has(row.to));this.#state.push_outbox=this.#state.push_outbox.filter(row=>clients.has(row.to));await this.#save();await this.options.transport.recoverPending?.(this.#state.outbox.map(row=>row.id));
  // An admitted chat is never submitted to the model a second time after a crash.
  for(const [key,op] of Object.entries(this.#state.ops))if(op.chat_status==='admitted'){const saved=this.options.host.spaceChatResult('space:'+key,displayText(op.intent.input.conversation_id,'chat:main'));await this.#finishChat(key,saved??{text:'',status:'interrupted',message_id:'turn-'+fingerprint(key)})}
  // An authorized revocation stays pending because revoking restarts the Host. Only an op marked when the authorized branch started
  // the revoke is settled, once its device has left the membership; its accepted receipt gets its own queue id after the pending one.
  for(const op of Object.values(this.#state.ops))if(op.intent.kind==='device.revoke'&&op.revoke_started&&op.receipt?.status==='pending'&&!clients.has(String(op.intent.input.device))){const key=this.#key(op.sender,op.intent.op_id);if(clients.has(op.sender))await this.#record(op.sender,op.intent,op.hash,{status:'accepted'},'receipt-'+key+'-settled');else{this.#state.ops[key]={...op,receipt:{v:1,type:'receipt',op_id:op.intent.op_id,status:'accepted'}};await this.#save()}}
  this.#unsubscribe=this.options.host.subscribe(()=>this.#scheduleSnapshot());
  this.#stop=await this.options.transport.start((from,body)=>this.receive(from,body),{load:()=>this.#state.cursor,save:n=>this.#serial(async()=>{if(!this.#opened)throw Error('space_host_closed');if(this.#state.cursor===n)return;const durable=this.#state.cursor;this.#state.cursor=n;try{await this.#save()}catch(error){this.#state.cursor=durable;throw error}})});
  // Delivering queued messages needs the relay, which can be unreachable (for example a stopped tailnet) and then waits out one network
  // timeout per queued message. Startup must not wait for that: the Host is usable locally, and the queue is retried in the background.
  this.initialDelivery=(async()=>{try{await this.publishSnapshot();await this.dispatchNotifications();await this.flush()}catch{this.options.onError?.(undefined)}})()
 }
 /** The first delivery pass after open(), which runs in the background; tests and shutdown can wait for it. */
 initialDelivery:Promise<void>=Promise.resolve()
 #scheduleSnapshot(){if(!this.#opened||this.#snapshotTimer)return;this.#snapshotTimer=setTimeout(()=>{this.#snapshotTimer=undefined;if(!this.#opened)return;void this.#publishSnapshot(undefined,true).catch(error=>this.options.onError?.(error))},100);this.#snapshotTimer.unref()}
 snapshot(to?:string){const owner=to!==undefined&&this.#hostAdmin(to),turns=new Map(Object.entries(this.#state.ops).filter(([,op])=>op.intent.kind==='chat.send').map(([key,op])=>['space:'+key,op.intent.op_id]));return {...displaySnapshot(this.options.host,turns),revision:++this.#state.projection_revision,owner,...(owner?{host_settings:{devices:this.options.transport.clients(),...settingsView(this.options.host),...(this.options.models?{models:this.options.models.view()}:{})},host_credentials:credentialsView(this.options.secrets,this.options.environment??process.env),host_feishu:this.#feishuProjection()}:{})}}
 #setupUrl:string|undefined;
 #feishuProjection(){const raw=this.options.host.snapshot().feishu,view=feishuView(raw);return this.#setupUrl&&view.app_setup?.state==='waiting'?{...view,app_setup:{...view.app_setup,verification_url:this.#setupUrl}}:view}
 async publishSnapshot(to?:string){await this.#publishSnapshot(to)}
 async #publishSnapshot(to?:string,onlyChanged=false){await this.#serial(async()=>{for(const device of to?[to]:this.options.transport.clients())this.#queueSnapshot(device,this.snapshot(device),'snapshot-'+randomUUID(),onlyChanged);await this.#save();await this.options.transport.recoverPending?.(this.#state.outbox.map(row=>row.id))});await this.flush()}
 #queueSnapshot(to:string,snapshot:Record<string,unknown>,id:string,onlyChanged=false){
  const {revision:_revision,...projection}=snapshot,hash=fingerprint(projection);
  if(onlyChanged&&this.#snapshotHashes.get(to)===hash)return;
  // A newer full projection supersedes queued snapshot chunks, never receipts or actions.
  this.#state.outbox=this.#state.outbox.filter(row=>row.to!==to||!['snapshot','snapshot.chunk'].includes(String(row.body.type)));
  this.#enqueue(to,{v:1,type:'snapshot',snapshot},id);this.#snapshotHashes.set(to,hash);
 }
 #enqueue(to:string,body:BusinessMessage,id:string){if(body.type==='snapshot'){const data=JSON.stringify(body.snapshot);if(Buffer.byteLength(data)>48*1024){if(Buffer.byteLength(data)>16*1024*1024)throw Error('snapshot_capacity');const chunks:string[]=[];let text='',bytes=0;for(const char of data){const size=Buffer.byteLength(char);if(bytes+size>48*1024){chunks.push(text);text='';bytes=0}text+=char;bytes+=size}if(text)chunks.push(text);if(chunks.length>512)throw Error('snapshot_capacity');for(const [index,data]of chunks.entries())this.#enqueue(to,{v:1,type:'snapshot.chunk',snapshot_id:id,index,total:chunks.length,data},id+'-'+index);return}}if(this.#state.outbox.some(row=>row.id===id&&row.to===to))return;if(this.#state.outbox.length>=4096)throw Error('space_outbox_capacity');this.#state.outbox.push({to,body:structuredClone(body),id})}
 async receive(sender:string,raw:unknown){if(!this.#opened)throw Error('space_host_closed');if(!this.options.transport.clients().includes(sender))throw Error('sender_not_paired');const parsed=intentSchema.safeParse(raw);if(!parsed.success){this.options.onError?.(Error('invalid_business_intent'));return}const intent=parsed.data;const key=this.#key(sender,intent.op_id);let startChat=false,pollSetup=false;
  let revokeTarget:string|undefined;await this.#serial(async()=>{const old=this.#state.ops[key],raw=fingerprint(intent),hash=fingerprint(this.#journalIntent(intent)),tag=SECRET_KINDS.has(intent.kind)?this.#secretTag(key,raw):undefined;if(old){
    // A record written before tags existed keeps the legacy in-memory comparison; its raw fingerprint must never be compared against an HMAC tag.
    const seen=old.tag??this.#raw.get(key),next=old.tag===undefined?raw:tag;
    if(old.hash!==hash||(seen!==undefined&&seen!==next)){this.#enqueue(sender,{v:1,type:'receipt',op_id:intent.op_id,status:'rejected',error:'op_id_conflict'},'conflict-'+randomUUID());await this.#save();return}if(old.receipt&&old.receipt.status!=='pending'){
     // A stored conflict receipt omits its snapshot to keep the journal small; a replay carries the current one.
     this.#enqueue(sender,old.receipt.status==='conflict'?{...old.receipt,snapshot:this.snapshot(sender)}:old.receipt,'receipt-'+key);await this.#save();return}}else{
    // An unknown op that may be a pruned one is answered without journaling it (see #prune): the answer depends only on the op and on
    // tombstones and the replay floor, which never move back. Its queue id is deterministic so repeated replays dedupe in the outbox.
    const refuse=async(error:string)=>{this.#enqueue(sender,{v:1,type:'receipt',op_id:intent.op_id,status:'rejected',error},'refused-'+key+'-'+error);await this.#save()};
    const tombstone=this.#replay.pruned_receipts[key],floor=this.#replay.replay_floor[sender];
    if(tombstone){await refuse(tombstone.hash!==hash||(tombstone.tag!==undefined&&tombstone.tag!==tag)?'op_id_conflict':'op_expired');return}
    if(floor!==undefined&&intent.created_at<=floor){await refuse('op_expired');return}
    this.#raw.set(key,raw);
    // Other refusals are journaled as settled ops, so a redelivery can never run an intent that was already refused; pruning bounds them.
    const now=this.#now(),live=Object.values(this.#state.ops).filter(op=>op.sender===sender&&!settled(op));
    // A parent that a pending op waits on is admitted past the limit, but only if it can run now, so the exception cannot chain.
    const releases=live.some(op=>op.intent.depends_on?.includes(intent.op_id))&&(intent.depends_on??[]).every(dep=>{const prior=this.#dependency(sender,dep);return prior!==undefined&&prior.status!=='pending'});
    const refusal=intent.created_at>now+CLOCK_SKEW_MS?'clock_skew':intent.created_at>now&&this.#futureOps(sender,now)>=FUTURE_TOMBSTONES_PER_SENDER?'future_capacity':intent.expires_at!==undefined&&intent.expires_at<=now?'expired':live.length>=LIVE_OPS_PER_SENDER&&!releases?'space_receipt_capacity':undefined;
    if(refusal){await this.#record(sender,intent,hash,{status:'rejected',error:refusal});return}
   }
   // A pending op re-evaluated after its deadline settles as expired instead of waiting on its dependencies again.
   if(old&&intent.expires_at!==undefined&&intent.expires_at<=this.#now()){await this.#record(sender,intent,hash,{status:'rejected',error:'expired'});return}
   for(const dep of intent.depends_on??[]){const prior=this.#dependency(sender,dep);if(!prior||prior.status==='pending'){await this.#record(sender,intent,hash,{status:'pending',error:'dependency_pending'});return}if(prior.status!=='accepted'){await this.#record(sender,intent,hash,{status:'rejected',error:'dependency_failed'});return}}
   if(!old){this.#state.ops[key]={hash,...(tag?{tag}:{}),intent:this.#journalIntent(intent),sender,receipt:null,recorded_at:this.#now()};await this.#save()}
   let authorityCommitted=false;
   try{
    if(ADMIN_KINDS.has(intent.kind)&&!this.#hostAdmin(sender))throw Error(this.#owner()===undefined?'owner_unassigned':'owner_required');
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
     this.#requireChat(displayText(intent.input.conversation_id,'chat:main'));
     if(Object.entries(this.#state.ops).some(([other,value])=>other!==key&&value.chat_status==='admitted'&&displayText(value.intent.input.conversation_id,'chat:main')===displayText(intent.input.conversation_id,'chat:main')))throw Error('conversation_busy');
     this.#state.ops[key]!.chat_status='admitted';await this.#record(sender,intent,hash,{status:'accepted',turn_id:intent.op_id});startChat=true;
    }else if(intent.kind==='chat.cancel'){
     const p=z.object({op_id:z.string()}).parse(intent.input),target=this.#state.ops[this.#key(sender,p.op_id)];if(target?.intent.kind!=='chat.send')throw Error('chat_not_found');
     if(target.chat_status==='admitted')await this.options.host.cancelSpaceChat(displayText(target.intent.input.conversation_id,'chat:main'));
     await this.#record(sender,intent,hash,{status:'accepted'});
    }else if(intent.kind==='source.input'){const memory=this.options.host.options.memory();if(!memory)throw Error('source_backend_unavailable');const result=await applySpaceSourceInput(memory,{space:this.options.space,sender,opId:intent.op_id},intent.input);authorityCommitted=true;await this.options.host.sourceProcessingAgent.reload();this.options.host.connectionChanged();await this.#record(sender,intent,hash,{status:'accepted',result})}
    else if(intent.kind==='push.register'){if(!this.options.push)throw Error('push_unconfigured');const message=await this.options.push.register(sender,intent.input);this.#enqueue(sender,{...message},'push-key-'+key);await this.#record(sender,intent,hash,{status:'accepted'})}
    else if(intent.kind==='push.unregister'){await this.options.push?.revoke(sender);await this.#record(sender,intent,hash,{status:'accepted'})}
    // Identity edits carry one field; merging at execution keeps queued offline edits from reverting each other.
    // soul.set reports a version mismatch as 'stale'; the Client offers a retry only for conflict receipts.
    else if(intent.kind==='settings.patch'){const p=settingsPatchSchema.parse(intent.input);if(p.method==='models.configure'){if(!this.options.models)throw Error('models_unconfigured');const result=await this.options.models.configure(p.params,'space:'+key);authorityCommitted=true;await this.#record(sender,intent,hash,{status:'accepted',...result})}else{const params=p.method==='identity.configure'?{...this.options.host.identity(),...p.params}:p.params,result=await this.options.host.command({type:'personal.command',request_id:'space:'+key,method:p.method,params},{client_id:'space:'+sender}) as {ok:boolean;error?:string};if(!result.ok)throw Error(result.error==='stale'?'version_conflict':result.error??'unavailable');authorityCommitted=true;await this.#record(sender,intent,hash,{status:'accepted'})}}
    else if(intent.kind==='secret.put'||intent.kind==='secret.clear'){if(!this.options.secrets)throw Error('secrets_unconfigured');const env=this.options.environment??process.env,p=intent.kind==='secret.put'?secretPutSchema.parse(intent.input):secretClearSchema.parse(intent.input);const value=(p as {value?:string}).value;if(value!==undefined)await this.options.secrets.put(p.name,value);else await this.options.secrets.clear(p.name);authorityCommitted=true;await this.#record(sender,intent,hash,{status:'accepted',applies:'restart',shadowed_by_environment:!!env[p.name]?.trim()})}
    else if(intent.kind==='device.revoke'){const p=z.object({device:z.string().min(1).max(256)}).strict().parse(intent.input);if(p.device===sender)throw Error('cannot_revoke_self');if(!this.options.revokeDevice)throw Error('device_revoke_unavailable');if(this.options.transport.clients().includes(p.device)){this.#state.ops[key]={...this.#state.ops[key]!,revoke_started:true};await this.#record(sender,intent,hash,{status:'pending'});revokeTarget=p.device}else await this.#record(sender,intent,hash,{status:'accepted'})}
    else if(intent.kind==='connector.feishu'){const p=connectorFeishuSchema.parse(intent.input),result=await this.options.host.command({type:'personal.command',request_id:'space:'+key,method:feishuMethod(p.action),params:{}},{client_id:'space:'+sender}) as {ok:boolean;error?:string;data?:unknown};if(!result.ok)throw Error(result.error??'unavailable');authorityCommitted=true;const view=feishuView(result.data);this.#setupUrl=(view.app_setup as {verification_url?:string}|undefined)?.verification_url;pollSetup=view.app_setup?.state==='waiting'&&!this.#setupUrl;await this.#record(sender,intent,hash,{status:'accepted',result:view})}
    else if(intent.kind==='mobile.result'){
     const p=z.object({action_id:z.string(),status:z.enum(['completed','denied','failed','unknown']),result:record.optional(),error:z.string().max(500).optional()}).parse(intent.input),action=this.#state.actions[p.action_id];if(action?.device!==sender)throw Error('action_not_found');if(action.result&&fingerprint(action.result)!==fingerprint(p))throw Error('action_result_conflict');action.result=p;await this.#record(sender,intent,hash,{status:'accepted'});
    }
   }catch(error){if(authorityCommitted)throw error;const code=error instanceof Error?error.message:'invalid_intent';await this.#record(sender,intent,hash,{status:code==='version_conflict'?'conflict':'rejected',error:code.slice(0,128),...(code==='version_conflict'?{snapshot:this.snapshot(sender)}:{})})}
  });
  if(pollSetup)this.#startFeishuPoll(sender);
  if(startChat){const run=this.#runChat(key);this.#chats.set(key,run);void run.catch(error=>this.options.onError?.(error)).finally(()=>this.#chats.delete(key))}
  await this.flush();
  if(revokeTarget)await this.options.revokeDevice!(revokeTarget);
 }
 /** One cancellable task per owner: a repeated app.start replaces nothing and must not add another polling chain. */
 #startFeishuPoll(owner:string){
  if(!this.#opened||this.#feishuPolls.has(owner))return;
  const abort=new AbortController();
  const task=this.#pollFeishuSetup(owner,abort.signal).catch(error=>{if(!abort.signal.aborted&&this.#opened)this.options.onError?.(error)}).finally(()=>{if(this.#feishuPolls.get(owner)?.abort===abort)this.#feishuPolls.delete(owner)});
  this.#feishuPolls.set(owner,{abort,task});
 }
 #sleep(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise<void>(resolve=>{
   if(signal.aborted)return resolve();
   const wake=()=>{clearTimeout(timer);resolve()};
   const timer=setTimeout(()=>{signal.removeEventListener('abort',wake);resolve()},ms);timer.unref();
   signal.addEventListener('abort',wake,{once:true});
  })
 }
 /** The setup link appears only after lark-cli starts; the connector strips it from published snapshots, so fetch it once for the owner. The connector allows 300s for the config operation, so poll while it is still waiting; a status call that fails transiently is retried instead of dropping the link. */
 async #pollFeishuSetup(owner:string,signal:AbortSignal){
  const deadline=Date.now()+(this.options.feishuSetupTimeoutMs??300_000);let failures=0;
  while(this.#opened&&!signal.aborted&&Date.now()<deadline){
   await this.#sleep(this.options.feishuPollMs??1000,signal);
   // Every await can outlive close: re-check before touching the host or publishing.
   if(!this.#opened||signal.aborted)return;
   const result=await this.options.host.command({type:'personal.command',request_id:'space-feishu-setup-'+randomUUID(),method:'feishu.app.status',params:{}},{client_id:'space:'+owner}).catch(()=>undefined) as {ok:boolean;data?:unknown}|undefined;
   if(!this.#opened||signal.aborted)return;
   if(!result?.ok){if(++failures>=3)return;continue}
   failures=0;
   const view=feishuView(result.data),url=(view.app_setup as {verification_url?:string}|undefined)?.verification_url;
   if(view.app_setup?.state!=='waiting')return;
   if(url){this.#setupUrl=url;if(this.#hostAdmin(owner)&&this.#opened&&!signal.aborted)await this.publishSnapshot(owner);return}
  }
 }
 async #record(sender:string,intent:SpaceIntent,hash:string,value:BusinessMessage,id?:string){const receipt={v:1,type:'receipt',op_id:intent.op_id,...value};const key=this.#key(sender,intent.op_id),tag=SECRET_KINDS.has(intent.kind)?this.#secretTag(key,fingerprint(intent)):undefined,projection=value.status==='accepted'&&['life.mutate','card.dismiss','source.input','snapshot.request','settings.patch','secret.put','secret.clear','connector.feishu'].includes(intent.kind)?this.snapshot(sender):undefined;this.#enqueue(sender,receipt,id??'receipt-'+key);if(projection)this.#queueSnapshot(sender,projection,'snapshot-'+key);
  // Every path that records a secret op stores its salted tag, including the early pending and dependency records, so a retry stays idempotent across a restart.
  const {snapshot:_snapshot,...stored}=receipt as BusinessMessage;
  this.#state.ops[key]={...this.#state.ops[key]!,hash,...(tag?{tag}:{}),intent:this.#journalIntent(intent),sender,receipt:stored,recorded_at:this.#state.ops[key]?.recorded_at??this.#now()};await this.#save();if(projection)await this.options.transport.recoverPending?.(this.#state.outbox.map(row=>row.id))}
 async #runChat(key:string){const op=this.#state.ops[key]!;const conversation=displayText(op.intent.input.conversation_id,'chat:main');let sequence=0;
  const unsubscribe=this.options.host.subscribeSpaceFrames(frame=>{if(frame.conversation_id!==conversation||typeof frame.text!=='string'||frame.role!=='assistant')return;void this.options.transport.stream(op.sender,{v:1,type:'chat.delta',op_id:op.intent.op_id,conversation_id:conversation,text:typeof frame.full_text==='string'?frame.full_text:frame.text,sequence:++sequence},'delta-'+randomUUID()).catch(()=>{/* previews are intentionally disposable */})});
  try{this.#requireChat(conversation);await this.options.host.submitConversationText(conversation,String(op.intent.input.text),'space:'+key);await this.options.host.waitConversation(conversation);await this.#serial(()=>this.#finishChat(key,this.options.host.spaceChatResult('space:'+key,conversation)??{text:'',status:'failed',message_id:'turn-'+key}))}
  catch(error){await this.#serial(()=>this.#finishChat(key,{text:'',status:'failed',message_id:'turn-'+key,error:chatFailure(error)}))}finally{unsubscribe()}
  await this.dispatchNotifications();await this.flush();
 }
 async #finishChat(key:string,result:{text:string;status:string;message_id:string;error?:ChatFailure}){const op={...this.#state.ops[key]!,chat_status:'completed' as const,final:result,...(result.status==='completed'&&result.text?{notification_pending:true}:{})};this.#state.ops[key]=op;this.#enqueue(op.sender,{v:1,type:'chat.final',op_id:op.intent.op_id,conversation_id:displayText(op.intent.input.conversation_id,'chat:main'),...result},'final-'+key);await this.#save()}
 async dispatchNotifications(){for(const [key,op]of Object.entries(this.#state.ops)){if(!op.notification_pending||!op.final)continue;const now=this.#now();await this.options.host.publishNotification({event_key:'space-chat:'+key,revision:'1',occurrence:'initial',kind:'alert',title:'Nova',body:String(op.final.text),source:{type:'space_chat',id:key},created_at:now,expires_at:null,not_before:0,priority:100,coalesce_key:null,feedback:[]});await this.#serial(async()=>{const current=this.#state.ops[key];if(current)this.#state.ops[key]={...current,notification_pending:false};await this.#save()})}}
 async waitForChats(){await Promise.all([...this.#chats.values()])}
 async notify(notification:BusinessMessage,id:string,validity?:NotificationInput){await this.#serial(async()=>{for(const to of this.options.transport.clients()){this.#enqueue(to,{v:1,type:'notification',...notification,id},'notification-'+fingerprint([id,to]));if(this.options.push&&!this.#state.push_outbox.some(row=>row.id===id&&row.to===to))this.#state.push_outbox.push({to,id,title:displayText(notification.title),body:displayText(notification.body),expires_at:Math.min(typeof notification.expires_at==='number'?notification.expires_at:Infinity,(typeof notification.created_at==='number'?notification.created_at:this.#now())+86400000),...(validity?{notification:structuredClone(validity)}:{})})}await this.#save()});await this.flush()}
 async #flushPush(){if(!this.options.push)return;for(const next of [...this.#state.push_outbox]){
  // Legacy pending rows have no validity deadline. Do not extend an unknown-age notification on upgrade.
  const expired=next.expires_at===undefined||next.expires_at<=this.#now();
  const validity=expired?'invalid':next.notification?await this.options.host.notificationValidity(next.notification):'valid';
  if(validity==='defer')continue;
  if(validity==='valid'&&next.expires_at!==undefined)await this.options.push.send(next.to,{id:next.id,title:next.title,body:next.body,expires_at:next.expires_at});
  await this.#serial(async()=>{this.#state.push_outbox=this.#state.push_outbox.filter(row=>row.id!==next.id||row.to!==next.to);await this.#save()})
 }}
 async requestMobileAction(device:string,action:unknown,ttlMs=60000,providedId?:string){if(!this.options.transport.clients().includes(device))throw Error('client_not_paired');if(ttlMs<=0||ttlMs>60000)throw Error('invalid_action_deadline');const parsed=mobileActionSchema.parse(action),action_id=providedId??randomUUID(),body={v:1,type:'mobile.action',action_id,...parsed,expires_at:this.#now()+ttlMs};await this.#serial(async()=>{const prior=this.#state.actions[action_id];if(prior){if(prior.device!==device||fingerprint({tool:prior.body.tool,args:prior.body.args})!==fingerprint(parsed))throw Error('action_id_conflict');return}this.#state.actions[action_id]={device,body,result:null};this.#enqueue(device,body,'action-'+action_id);await this.#save()});await this.flush();return {action_id}}
 mobileResult(actionId:string){return structuredClone(this.#state.actions[actionId]?.result??null)}
 flush():Promise<void>{const pass=(this.#flush??Promise.resolve()).then(()=>this.#drainOutbox());this.#flush=pass.then(()=>{ /* the queue tail only orders passes; callers own their own result */ },()=>{ /* a failed pass must not poison the passes queued after it */ });return pass}
 /** One bounded pass over the rows queued when it runs: a steady stream of unrelated snapshots must not keep a caller's own receipt pending behind a chase that only ends once the Host goes quiet. */
 async #drainOutbox(){if(!this.#opened)return;for(const next of [...this.#state.outbox]){try{await this.options.transport.send(next.to,next.body,next.id)}catch(error){this.options.onError?.(error);continue}await this.#serial(async()=>{this.#state.outbox=this.#state.outbox.filter(row=>row.id!==next.id||row.to!==next.to);await this.#save()});await this.options.transport.settle?.(next.id)}await this.#flushPush()}
 async close(){this.#opened=false;if(this.#snapshotTimer)clearTimeout(this.#snapshotTimer);this.#snapshotTimer=undefined;const polls=[...this.#feishuPolls.values()];for(const poll of polls)poll.abort.abort();await Promise.all(polls.map(poll=>poll.task.catch(()=>undefined)));for(const op of Object.values(this.#state.ops))if(op.chat_status==='admitted')await this.options.host.cancelSpaceChat(displayText(op.intent.input.conversation_id,'chat:main'));await this.waitForChats();if(this.#snapshotTimer)clearTimeout(this.#snapshotTimer);this.#snapshotTimer=undefined;this.#unsubscribe?.();await this.#stop?.();await this.#flush;if(this.#loaded)await this.#serial(()=>this.#save());await this.#tail}
}
