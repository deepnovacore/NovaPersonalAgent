import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js';
import {BoundedJsonStore} from '../src/storage/bounded-json.js';
import {canonicalJson} from '../src/text/canonical-json.js';
import {z} from 'zod';
import {intentSchema} from '../src/space-host/contracts.js';
import {notificationSchema} from '../src/notifications/contracts.js';
import './helpers/space-host-sync-open.js'

type Receipt=Record<string,unknown>;
interface Journal {version:number;ops:Record<string,{receipt:Receipt|null}>}
interface Replay {replay_floor:Record<string,number>;pruned_receipts:Record<string,unknown>}
const fingerprint=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const key=(sender:string,op:string)=>fingerprint([sender,op]);
const noop=()=>{ /* Test transport has nothing to stop. */ };
function fixture(clients=['phone']){
 const sent:Receipt[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(noop),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>clients};
 const receipt=(op:string)=>sent.filter(row=>row.type==='receipt'&&row.op_id===op).at(-1);
 return {sent,transport,receipt};
}
const makeHost=(dir:string)=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
const readJournal=async(path:string)=>JSON.parse(await readFile(path,'utf8')) as Journal;
const readReplay=async(path:string)=>JSON.parse(await readFile(path+'.replay.json','utf8')) as Replay;
// The journal schema of binaries from before receipt pruning (merge-base 21ad52dc, runtime/src/space-host/service.ts), copied verbatim.
const legacyRecord=z.record(z.string(),z.unknown());
const legacyEntry=z.object({hash:z.string(),tag:z.string().optional(),intent:intentSchema,sender:z.string(),receipt:legacyRecord.nullable(),chat_status:z.enum(['admitted','completed']).optional(),final:legacyRecord.optional(),notification_pending:z.boolean().optional()});
const legacyJournalSchema=z.object({version:z.literal(1),space:z.string(),cursor:z.number().int().nonnegative(),projection_revision:z.number().int().nonnegative().default(0),ops:z.record(z.string(),legacyEntry),remaps:z.record(z.string(),z.record(z.string(),z.string())),outbox:z.array(z.object({id:z.string(),to:z.string(),body:legacyRecord})),push_outbox:z.array(z.object({to:z.string(),id:z.string(),title:z.string(),body:z.string(),expires_at:z.number().int().optional(),notification:notificationSchema.optional()})).default([]),actions:z.record(z.string(),z.object({device:z.string(),body:legacyRecord,result:legacyRecord.nullable()}))});

test('a journal past the old 10,000 receipt wall is pruned to its retention bound and keeps accepting intents without re-running pruned ops',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-retention-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 const base=Date.now()-86_400_000,ops:Record<string,unknown>={};
 const seed=(op_id:string,created_at:number,extra:Record<string,unknown>={},status:Receipt={status:'accepted',result:{id:'stored-'+op_id}})=>{
  const intent={v:1,type:'intent',op_id,kind:'life.mutate',input:{op:'create',kind:'todo',title:op_id},created_at,...extra};
  ops[key('phone',op_id)]={hash:fingerprint(intent),intent,sender:'phone',receipt:{v:1,type:'receipt',op_id,...status}};
  return intent;
 };
 // The oldest entries are a still-pending dependent and its settled target: neither may be pruned.
 seed('waiting',base,{depends_on:['parent']},{status:'pending',error:'dependency_pending'});seed('parent',base);
 const seeds=Array.from({length:10_050},(_,index)=>seed('seed-'+index,base+1+index));
 await writeFile(path,JSON.stringify({version:1,space:'s',cursor:0,ops,remaps:{},outbox:[],actions:{}}),{mode:0o600});
 const host=makeHost(dir);let space=new SpaceHost({path,space:'s',host,transport});
 try{await host.open({deferBackground:true});await space.open();
  let journal=await readJournal(path);const replay=await readReplay(path);
  assert.equal(Object.keys(journal.ops).length,1024);
  assert.ok(journal.ops[key('phone','waiting')]&&journal.ops[key('phone','parent')]);
  // 1,022 seeds survive; the newest pruned one, seed-9027, sets the replay floor.
  assert.equal(journal.ops[key('phone','seed-9027')],undefined);assert.ok(journal.ops[key('phone','seed-9028')]);
  assert.equal(replay.replay_floor.phone,seeds[9027]!.created_at);assert.equal(Object.keys(replay.pruned_receipts).length,4096);
  // Replay state lives in the sidecar, so the journal stays one a pre-pruning binary loads; the sidecar survives a restart.
  assert.equal(journal.version,1);legacyJournalSchema.parse(journal);
  await space.close();space=new SpaceHost({path,space:'s',host,transport});await space.open();

  await space.receive('phone',{v:1,type:'intent',op_id:'fresh',kind:'life.mutate',input:{op:'create',kind:'todo',title:'fresh'},created_at:Date.now()});
  assert.equal(receipt('fresh')?.status,'accepted');
  // Replaying a pruned op is answered, never executed, even when its outcome has left the tombstones.
  await space.receive('phone',seeds[5]);assert.deepEqual(receipt('seed-5'),{v:1,type:'receipt',op_id:'seed-5',status:'rejected',error:'op_expired'});
  await space.receive('phone',seeds[9027]);assert.equal(receipt('seed-9027')?.error,'op_expired');
  // Reusing a tombstoned op id with another body and a fresh created_at is a conflict, not a new op.
  await space.receive('phone',{...seeds[9027],input:{op:'create',kind:'todo',title:'changed'},created_at:Date.now()});assert.equal(receipt('seed-9027')?.error,'op_id_conflict');
  // A retained op replays its stored receipt.
  await space.receive('phone',seeds[10_049]);assert.deepEqual(receipt('seed-10049'),{v:1,type:'receipt',op_id:'seed-10049',status:'accepted',result:{id:'stored-seed-10049'}});
  assert.deepEqual(host.life.snapshot().todos.map(todo=>todo.title),['fresh']);
  // A new op that depends on a recently pruned op still resolves the dependency.
  await space.receive('phone',{v:1,type:'intent',op_id:'after-pruned',kind:'life.mutate',input:{op:'create',kind:'todo',title:'after pruned'},created_at:Date.now(),depends_on:['seed-9027']});
  assert.equal(receipt('after-pruned')?.status,'accepted');
  for(let index=0;index<40;index++)await space.receive('phone',{v:1,type:'intent',op_id:'more-'+index,kind:'snapshot.request',input:{},created_at:Date.now()});
  journal=await readJournal(path);
  assert.equal(Object.keys(journal.ops).length,1024);
  assert.ok(journal.ops[key('phone','waiting')]&&journal.ops[key('phone','parent')]);
  assert.equal(Object.keys((await readReplay(path)).pruned_receipts).length,4096);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('pruning keeps admitted chats, depends_on targets of pending ops and visible chat turns',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-retention-live-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve});
 const host=makeHost(dir);
 host.setConversationRuntime(()=>Promise.resolve({runTurn:async()=>{await gate;return {assistant:'reply'}},close:()=>Promise.resolve()}),noop);
 const space=new SpaceHost({path,space:'s',host,transport,retainedReceipts:4});
 const intents=new Map<string,Record<string,unknown>>();
 // A client retry resends the identical intent, so each op id is built once.
 const snapshotRequest=(op_id:string,extra:Record<string,unknown>={})=>{if(!intents.has(op_id))intents.set(op_id,{v:1,type:'intent',op_id,kind:'snapshot.request',input:{},created_at:Date.now(),...extra});return intents.get(op_id)!};
 const retained=async()=>new Set(Object.keys((await readJournal(path)).ops));
 try{await host.open({deferBackground:true});await space.open();
  await space.receive('phone',{v:1,type:'intent',op_id:'chat',kind:'chat.send',created_at:Date.now(),expires_at:Date.now()+30000,input:{conversation_id:'chat:main',text:'hi'}});
  await space.receive('phone',snapshotRequest('child',{depends_on:['parent']}));assert.equal(receipt('child')?.error,'dependency_pending');
  await space.receive('phone',snapshotRequest('parent'));assert.equal(receipt('parent')?.status,'accepted');
  for(let index=0;index<10;index++)await space.receive('phone',snapshotRequest('flood-'+index));
  let ops=await retained();
  for(const op of ['chat','child','parent'])assert.ok(ops.has(key('phone',op)),op+' must be retained');
  assert.equal(ops.size,4);assert.equal(ops.has(key('phone','flood-0')),false);
  await space.receive('phone',snapshotRequest('flood-0'));assert.equal(receipt('flood-0')?.error,'op_expired');
  await space.receive('phone',snapshotRequest('child'));assert.equal(receipt('child')?.status,'accepted');

  finish();await space.waitForChats();
  for(let index=10;index<20;index++)await space.receive('phone',snapshotRequest('flood-'+index));
  ops=await retained();
  // The chat is settled now, but the snapshot chat window still shows its turn.
  assert.ok(ops.has(key('phone','chat')));assert.equal(ops.has(key('phone','parent')),false);
  const user=space.snapshot().chat.find(row=>row.role==='user');assert.equal(user?.turn_id,'chat');assert.equal(user?.id,'user_chat');
 }finally{finish();await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('an unchanged relay cursor does not rewrite the journal',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-cursor-'));
 let cursor!:{load:()=>number;save:(n:number)=>Promise<void>};
 const transport:SpaceHostTransport={start:(_receive,value)=>{cursor=value;return Promise.resolve(noop)},send:()=>Promise.resolve(),stream:()=>Promise.resolve(),clients:()=>['phone']};
 const host=makeHost(dir),space=new SpaceHost({path:join(dir,'space.json'),space:'s',host,transport});
 // eslint-disable-next-line @typescript-eslint/unbound-method -- the spy restores and calls the original with its receiver
 const write=BoundedJsonStore.prototype.write;let writes=0;
 try{await host.open({deferBackground:true});await space.open();
  BoundedJsonStore.prototype.write=function(this:BoundedJsonStore<unknown>,state:unknown){writes++;return write.call(this,state)};
  for(let index=0;index<5;index++)await cursor.save(cursor.load());
  assert.equal(writes,0);
  await cursor.save(cursor.load()+1);assert.equal(writes,1);assert.equal(cursor.load(),1);
  // A failed save leaves the cursor at its durable value, so the relay client never ACKs past it.
  BoundedJsonStore.prototype.write=()=>Promise.reject(Error('disk full'));
  await assert.rejects(cursor.save(2),/disk full/);assert.equal(cursor.load(),1);
  BoundedJsonStore.prototype.write=write;
  assert.equal((JSON.parse(await readFile(join(dir,'space.json'),'utf8')) as {cursor:number}).cursor,1);
  // A closed Host refuses the save, so the relay SDK never ACKs after a shutdown or revoke restart.
  await space.close();await assert.rejects(cursor.save(5),/space_host_closed/);assert.equal(cursor.load(),1);
 }finally{BoundedJsonStore.prototype.write=write;await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('refusals are settled, prunable ops: a fast clock cannot fill the journal, a refused op never runs later, and the floor stays at Host time',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-skew-')),path=join(dir,'space.json'),{transport,receipt}=fixture(['phone','tablet']);
 let clock=Date.now();const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport,now:()=>clock,retainedReceipts:8});
 const future=(index:number)=>({v:1,type:'intent',op_id:'future-'+index,kind:'snapshot.request',input:{},created_at:clock+2*86_400_000});
 try{await host.open({deferBackground:true});await space.open();
  const first=future(0);await space.receive('phone',first);assert.equal(receipt('future-0')?.error,'clock_skew');
  // Once the Host clock passes the op's created_at, a redelivery still gets the stored refusal instead of running.
  clock+=3*86_400_000;await space.receive('phone',first);assert.equal(receipt('future-0')?.error,'clock_skew');
  clock-=3*86_400_000;
  for(let index=1;index<60;index++)await space.receive('phone',future(index));
  await space.receive('phone',{v:1,type:'intent',op_id:'stale',kind:'snapshot.request',input:{},created_at:clock+1,expires_at:clock-1});
  assert.equal(receipt('future-59')?.error,'clock_skew');assert.equal(receipt('stale')?.error,'expired');
  const journal=await readJournal(path);
  assert.ok(Object.keys(journal.ops).length<=8);
  // A pruned future-dated refusal lifts the floor only to the Host clock, so the corrected device is not locked out.
  assert.ok((await readReplay(path)).replay_floor.phone!<=clock);
  await space.receive('phone',{v:1,type:'intent',op_id:'corrected',kind:'snapshot.request',input:{},created_at:clock+2});assert.equal(receipt('corrected')?.status,'accepted');
  await space.receive('tablet',{v:1,type:'intent',op_id:'other-device',kind:'snapshot.request',input:{},created_at:clock});
  assert.equal(receipt('other-device')?.status,'accepted');
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a dependent on an op the Host never saw fails after the dependency wait window',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-orphan-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 let clock=Date.now();const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport,now:()=>clock});
 const child={v:1,type:'intent',op_id:'orphan',kind:'snapshot.request',input:{},created_at:clock,depends_on:['never-sent']};
 try{await host.open({deferBackground:true});await space.open();
  await space.receive('phone',child);assert.equal(receipt('orphan')?.error,'dependency_pending');
  clock+=6*86_400_000;await space.receive('phone',{v:1,type:'intent',op_id:'tick-1',kind:'snapshot.request',input:{},created_at:clock});
  assert.equal((await readJournal(path)).ops[key('phone','orphan')]?.receipt?.error,'dependency_pending');
  clock+=2*86_400_000;await space.receive('phone',{v:1,type:'intent',op_id:'tick-2',kind:'snapshot.request',input:{},created_at:clock});
  assert.equal((await readJournal(path)).ops[key('phone','orphan')]?.receipt?.error,'dependency_failed');
  await space.receive('phone',child);assert.equal(receipt('orphan')?.error,'dependency_failed');
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('reopening settles only a device.revoke whose authorized branch started the revoke, under a fresh queue id',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-revoke-')),path=join(dir,'space.json'),ids:string[]=[],sent:Receipt[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(noop),send:(_to,body,id)=>{sent.push(body);ids.push(id);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone']};
 const op=(op_id:string,marked:boolean)=>{const intent={v:1,type:'intent',op_id,kind:'device.revoke',input:{device:'gone'},created_at:Date.now()};return {hash:fingerprint(intent),intent,sender:'phone',receipt:{v:1,type:'receipt',op_id,status:'pending'},...(marked?{revoke_started:true}:{})}};
 await writeFile(path,JSON.stringify({version:1,space:'s',cursor:0,ops:{[key('phone','marked')]:op('marked',true),[key('phone','unmarked')]:op('unmarked',false)},remaps:{},outbox:[],actions:{}}),{mode:0o600});
 const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport});
 try{await host.open({deferBackground:true});await space.open();
  const journal=await readJournal(path);
  assert.equal(journal.ops[key('phone','marked')]?.receipt?.status,'accepted');assert.equal(journal.ops[key('phone','unmarked')]?.receipt?.status,'pending');
  assert.ok(sent.some(row=>row.op_id==='marked'&&row.status==='accepted'));assert.ok(ids.includes('receipt-'+key('phone','marked')+'-settled'));
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a tombstone detects a changed push.register credential',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-tag-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport,retainedReceipts:1});
 const register=(credential:string)=>({v:1,type:'intent',op_id:'register',kind:'push.register',input:{handle:'h',credential},created_at:stamp});const stamp=Date.now();
 try{await host.open({deferBackground:true});await space.open();
  await space.receive('phone',register('first'));assert.equal(receipt('register')?.error,'push_unconfigured');
  await space.receive('phone',{v:1,type:'intent',op_id:'next',kind:'snapshot.request',input:{},created_at:stamp+1});
  assert.ok((await readReplay(path)).pruned_receipts[key('phone','register')]);
  await space.receive('phone',register('second'));assert.equal(receipt('register')?.error,'op_id_conflict');
  await space.receive('phone',register('first'));assert.equal(receipt('register')?.error,'op_expired');
  assert.equal(JSON.stringify(await readJournal(path)).includes('first'),false);assert.equal(JSON.stringify(await readReplay(path)).includes('first'),false);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a pending dependent past its deadline settles as expired and releases its dependency',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-expire-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 let clock=Date.now();const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport,now:()=>clock});
 const child={v:1,type:'intent',op_id:'child',kind:'snapshot.request',input:{},created_at:clock,expires_at:clock+1000,depends_on:['missing']};
 try{await host.open({deferBackground:true});await space.open();
  await space.receive('phone',child);assert.equal(receipt('child')?.error,'dependency_pending');
  clock+=2000;
  await space.receive('phone',{v:1,type:'intent',op_id:'next',kind:'snapshot.request',input:{},created_at:clock});
  assert.equal((await readJournal(path)).ops[key('phone','child')]?.receipt?.error,'expired');
  await space.receive('phone',child);assert.deepEqual(receipt('child'),{v:1,type:'receipt',op_id:'child',status:'rejected',error:'expired'});
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('the journal written with markers and pruning still parses with the pre-pruning schema, and an unknown version is refused',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-version-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 const host=makeHost(dir);
 try{await host.open({deferBackground:true});
  const space=new SpaceHost({path,space:'s',host,transport,retainedReceipts:1});await space.open();
  await space.receive('phone',{v:1,type:'intent',op_id:'waiting',kind:'snapshot.request',input:{},created_at:Date.now(),depends_on:['missing']});
  for(let index=0;index<3;index++)await space.receive('phone',{v:1,type:'intent',op_id:'op-'+index,kind:'snapshot.request',input:{},created_at:Date.now()});
  assert.equal(receipt('waiting')?.error,'dependency_pending');await space.close();
  const journal=await readJournal(path);assert.equal(journal.version,1);legacyJournalSchema.parse(journal);
  assert.ok(Object.keys((await readReplay(path)).pruned_receipts).length>0);
  await writeFile(path,JSON.stringify({version:3,space:'s',cursor:0,ops:{},remaps:{},outbox:[],actions:{}}),{mode:0o600});
  await assert.rejects(new SpaceHost({path,space:'s',host,transport}).open());
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a pruned op created ahead of the Host clock keeps its tombstone through a flood until its time arrives',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-future-')),path=join(dir,'space.json'),{transport,receipt}=fixture(['phone','tablet']);
 let clock=Date.now();const host=makeHost(dir),make=()=>new SpaceHost({path,space:'s',host,transport,now:()=>clock,retainedReceipts:1});let space=make();
 const ahead={v:1,type:'intent',op_id:'ahead',kind:'life.mutate',input:{op:'create',kind:'todo',title:'ahead'},created_at:clock+3_600_000};
 try{await host.open({deferBackground:true});await space.open();
  await space.receive('phone',ahead);assert.equal(receipt('ahead')?.status,'accepted');
  await space.receive('phone',{v:1,type:'intent',op_id:'after',kind:'snapshot.request',input:{},created_at:clock});
  const replay=await readReplay(path);assert.ok(replay.pruned_receipts[key('phone','ahead')]);assert.ok(replay.replay_floor.phone!<ahead.created_at,'the clamped floor does not cover it');
  // Other senders' pruned ops push more than the tombstone window behind it.
  await space.close();
  for(let index=0;index<4200;index++)replay.pruned_receipts[key('tablet','flood-'+index)]={accepted:true,hash:'h',sender:'tablet',created_at:clock-1};
  await writeFile(path+'.replay.json',JSON.stringify(replay),{mode:0o600});
  space=make();await space.open();
  await space.receive('tablet',{v:1,type:'intent',op_id:'flood-last',kind:'snapshot.request',input:{},created_at:clock});
  await space.receive('tablet',{v:1,type:'intent',op_id:'flood-next',kind:'snapshot.request',input:{},created_at:clock});
  const trimmed=(await readReplay(path)).pruned_receipts;assert.ok(Object.keys(trimmed).length<=4097);assert.ok(trimmed[key('phone','ahead')]);
  await space.receive('phone',ahead);assert.equal(receipt('ahead')?.error,'op_expired');
  // Once its time has passed the tombstone becomes evictable; evicting it lifts the floor over it, so a redelivery still never runs.
  clock+=2*3_600_000;await space.close();
  const later=await readReplay(path);for(let index=0;index<4200;index++)later.pruned_receipts[key('tablet','later-'+index)]={accepted:true,hash:'h',sender:'tablet',created_at:clock-1};
  await writeFile(path+'.replay.json',JSON.stringify(later),{mode:0o600});
  space=make();await space.open();
  await space.receive('tablet',{v:1,type:'intent',op_id:'later-op',kind:'snapshot.request',input:{},created_at:clock});
  await space.receive('tablet',{v:1,type:'intent',op_id:'later-next',kind:'snapshot.request',input:{},created_at:clock});
  const evicted=await readReplay(path);assert.equal(evicted.pruned_receipts[key('phone','ahead')],undefined);assert.ok(evicted.replay_floor.phone!>=ahead.created_at);
  await space.receive('phone',ahead);assert.equal(receipt('ahead')?.error,'op_expired');
  assert.deepEqual(host.life.snapshot().todos.map(todo=>todo.title),['ahead']);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a sender holding the maximum of future-dated accepted ops is refused another one instead of losing a protected tombstone',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-future-cap-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 const clock=Date.now(),ops:Record<string,unknown>={};
 for(let index=0;index<1024;index++){const intent={v:1,type:'intent',op_id:'future-'+index,kind:'snapshot.request',input:{},created_at:clock+60_000};ops[key('phone','future-'+index)]={hash:fingerprint(intent),intent,sender:'phone',receipt:{v:1,type:'receipt',op_id:'future-'+index,status:'accepted'}}}
 await writeFile(path,JSON.stringify({version:1,space:'s',cursor:0,ops,remaps:{},outbox:[],actions:{}}),{mode:0o600});
 const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport,now:()=>clock,retainedReceipts:2048});
 try{await host.open({deferBackground:true});await space.open();
  await space.receive('phone',{v:1,type:'intent',op_id:'one-more',kind:'snapshot.request',input:{},created_at:clock+60_000});assert.equal(receipt('one-more')?.error,'future_capacity');
  await space.receive('phone',{v:1,type:'intent',op_id:'present',kind:'snapshot.request',input:{},created_at:clock});assert.equal(receipt('present')?.status,'accepted');
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('an op left retained with no receipt beside its tombstone after a crash is not run again on retry',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-crash-')),path=join(dir,'space.json'),{transport,receipt}=fixture();
 const intent={v:1,type:'intent',op_id:'crashed',kind:'life.mutate',input:{op:'create',kind:'todo',title:'once'},created_at:Date.now()};
 await writeFile(path,JSON.stringify({version:1,space:'s',cursor:0,ops:{[key('phone','crashed')]:{hash:fingerprint(intent),intent,sender:'phone',receipt:null}},remaps:{},outbox:[],actions:{}}),{mode:0o600});
 await writeFile(path+'.replay.json',JSON.stringify({version:1,space:'s',replay_floor:{phone:intent.created_at},pruned_receipts:{[key('phone','crashed')]:{accepted:true,hash:fingerprint(intent),sender:'phone',created_at:intent.created_at}}}),{mode:0o600});
 const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport});
 try{await host.open({deferBackground:true});await space.open();
  await space.receive('phone',intent);assert.equal(receipt('crashed')?.error,'op_expired');assert.equal(host.life.snapshot().todos.length,0);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a sidecar from another space is refused and close writes neither file',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-foreign-')),path=join(dir,'space.json'),{transport}=fixture();
 await writeFile(path,JSON.stringify({version:1,space:'s',cursor:3,ops:{},remaps:{},outbox:[],actions:{}}),{mode:0o600});
 await writeFile(path+'.replay.json',JSON.stringify({version:1,space:'other',replay_floor:{phone:5},pruned_receipts:{}}),{mode:0o600});
 const before=[await readFile(path,'utf8'),await readFile(path+'.replay.json','utf8')];
 const host=makeHost(dir),space=new SpaceHost({path,space:'s',host,transport});
 try{await host.open({deferBackground:true});
  await assert.rejects(space.open(),/space_scope_mismatch/);await space.close();
  assert.deepEqual([await readFile(path,'utf8'),await readFile(path+'.replay.json','utf8')],before);
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
});
