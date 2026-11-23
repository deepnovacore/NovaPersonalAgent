import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js';
import type {ApprovalView} from '../src/core/approval-port.js';
import './helpers/space-host-sync-open.js'

const view=(id:string,secondsLeft:number|null,overrides:Partial<ApprovalView>={}):ApprovalView=>({pending_approval:true,pending_approval_busy:false,pending_approval_id:id,kind:'command_execution',local_detail:null,operation_summary:'Run npm test',expires_at:secondsLeft===null?null:performance.now()/1000+secondsLeft,allowed_decisions:['accept','acceptForSession','decline'],work:null,queued:0,...overrides});

async function fixture(){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-approvals-')),sent:Record<string,unknown>[]=[],decisions:{id:string;approved:boolean}[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(()=>{ /* no relay */ }),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone','other']};
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 await host.open({deferBackground:true});
 host.setConversationRuntime(()=>Promise.resolve({runTurn:()=>Promise.resolve({assistant:'ack'}),approvalDecision:(id:string,approved:boolean)=>{decisions.push({id,approved});host.recordTaskApproval('chat:main',0,{...view(id,null),pending_approval:false});return Promise.resolve()},close:()=>Promise.resolve()}),()=>{/* no renderer transport */});
 await host.submitConversationText('chat:main','Start');await host.waitConversation('chat:main');
 const journal=join(dir,'space.json'),start=async()=>{const value=new SpaceHost({path:journal,space:'s',host,transport,owner:()=>'phone'});await value.open();return value};
 let space=await start();
 // Each call answers with the receipts emitted by that call only, so a replay can never be satisfied by an earlier receipt.
 const stamps=new Map<string,number>(),send=async(from:string,op_id:string,input:Record<string,unknown>)=>{if(!stamps.has(op_id))stamps.set(op_id,Date.now());const before=sent.length;await space.receive(from,{v:1,type:'intent',op_id,kind:'approval.resolve',input,created_at:stamps.get(op_id)!});const receipts=sent.slice(before).filter(row=>row.type==='receipt'&&row.op_id===op_id);assert.equal(receipts.length,1,'exactly one receipt per delivery');return receipts[0]!};
 return {host,get space(){return space},sent,decisions,send,journal,
  /** Restarts the Space service, optionally from an earlier copy of its journal. */
  restart:async(from?:string)=>{await space.close();if(from)await copyFile(from,journal);space=await start()},
  close:async()=>{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}};
}
interface Approval {id:string;conversation_id:string;summary:string;kind:string|null;allowed_decisions:string[];expires_at:number|null}
const approvals=(snapshot:unknown)=>(snapshot as {pending_approvals?:Approval[]}).pending_approvals;

test('the owner snapshot projects pending executor approvals with a stable wall-clock deadline',async()=>{
 const f=await fixture();
 try{
  f.host.recordTaskApproval('chat:main',0,view('approval-1',30));
  const before=Date.now(),[row]=approvals(f.space.snapshot('phone'))!;
  assert.deepEqual({...row,expires_at:undefined},{id:'approval-1',conversation_id:'chat:main',summary:'Run npm test',kind:'command_execution',allowed_decisions:['accept','acceptForSession','decline'],expires_at:undefined});
  assert.ok(row!.expires_at!>=before+29000&&row!.expires_at!<=Date.now()+30500,String(row!.expires_at));
  assert.equal(approvals(f.space.snapshot('phone'))![0]!.expires_at,row!.expires_at,'re-projection must not churn the deadline');
  assert.deepEqual(approvals(f.space.snapshot('other')),[],'non-owners never see approval summaries');
  f.host.recordTaskApproval('chat:main',0,view('approval-1',null,{held:true}));
  assert.equal(approvals(f.space.snapshot('phone'))![0]!.expires_at,null,'a held head has no countdown');
 }finally{await f.close()}
});

test('approval.resolve approves for the owner and refuses non-owners, unknown, expired and session-scoped ids',async()=>{
 const f=await fixture();
 try{
  f.host.recordTaskApproval('chat:main',0,view('approval-1',30));
  assert.deepEqual(await f.send('other','foreign',{conversation_id:'chat:main',approval_id:'approval-1',approved:true}).then(r=>[r.status,r.error]),['rejected','owner_required']);
  assert.deepEqual(await f.send('phone','unknown',{conversation_id:'chat:main',approval_id:'missing',approved:true}).then(r=>[r.status,r.error]),['rejected','approval_not_found']);
  assert.deepEqual(await f.send('phone','wrong-conversation',{conversation_id:'topic:x',approval_id:'approval-1',approved:true}).then(r=>[r.status,r.error]),['rejected','approval_not_found']);
  assert.deepEqual(await f.send('phone','session',{conversation_id:'chat:main',approval_id:'approval-1',approved:true,scope:'session'}).then(r=>[r.status,r.error]),['rejected','scope_unsupported']);
  assert.deepEqual(f.decisions,[]);
  const ok=await f.send('phone','approve',{conversation_id:'chat:main',approval_id:'approval-1',approved:true});
  assert.equal(ok.status,'accepted',String(ok.error));assert.deepEqual(f.decisions,[{id:'approval-1',approved:true}]);
  const snapshot=f.sent.filter(row=>row.type==='snapshot').at(-1)?.snapshot;assert.deepEqual(approvals(snapshot),[],'the accepted receipt is followed by a snapshot without the card');
  // A replay of the same op returns the stored receipt and never decides twice.
  assert.equal((await f.send('phone','approve',{conversation_id:'chat:main',approval_id:'approval-1',approved:true})).status,'accepted');assert.equal(f.decisions.length,1);
  f.host.recordTaskApproval('chat:main',0,view('approval-2',-1));
  assert.deepEqual(approvals(f.space.snapshot('phone')),[],'an expired head is not projected');
  assert.deepEqual(await f.send('phone','expired',{conversation_id:'chat:main',approval_id:'approval-2',approved:false}).then(r=>[r.status,r.error]),['rejected','approval_expired']);
  assert.equal(f.decisions.length,1);
 }finally{await f.close()}
});

test('a redelivery after the Host decided but before the Space receipt was saved replays the Host receipt',async()=>{
 const f=await fixture();
 try{
  f.host.recordTaskApproval('chat:main',0,view('approval-1',30));
  await f.restart();const saved=f.journal+'.before';await copyFile(f.journal,saved);
  const input={conversation_id:'chat:main',approval_id:'approval-1',approved:true};
  assert.equal((await f.send('phone','crash',input)).status,'accepted');assert.equal(f.decisions.length,1);
  // Crash: the Host committed its decision and command receipt, the Space journal lost the op and its receipt.
  await f.restart(saved);
  assert.deepEqual(approvals(f.space.snapshot('phone')),[],'the decided approval is no longer pending');
  const replay=await f.send('phone','crash',input);
  assert.deepEqual([replay.status,replay.error],['accepted',undefined]);
  assert.equal(f.decisions.length,1,'the Host never decides twice');
 }finally{await f.close()}
});

