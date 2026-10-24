import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js';
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {initializeMemory,memoryOperation,type EvidenceRecord} from '../src/memory-substrate/store.js'
const prefix='personal:fixture:',provider='https://model.invalid|fixture',consumer='model-fingerprint';
const grant={kind:'grant',source_id:'chat',revision:1,provider,allow_upload:true,allow_processing:true};
const fact={kind:'source_fact',source_id:'chat',grant_revision:1,resource_id:'message',source_version:'v1',text:'I prefer short replies',relation:'self',occurred_at:new Date().toISOString()};
function fixture(){const db=new DatabaseSync(':memory:');initializeMemory(db);const apply=(op:string,input:unknown,sender='phone')=>memoryOperation(db,'space_source_input',{prefix,space:'space',sender,op_id:op,provider,consumer,input});return {db,apply}}
test('source admission, source consent and idempotency receipts commit in one Host ledger',()=>{
 const {db,apply}=fixture();try{
  assert.throws(()=>apply('no-consent',fact));
  apply('grant',grant);
  const saved=apply('fact',fact) as {evidence_id:string};assert.ok(saved.evidence_id.startsWith(prefix));
  assert.deepEqual(apply('fact',fact),saved);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_evidence').get()!.n,1);
  assert.throws(()=>apply('fact',{...fact,text:'changed'}),/IDEMPOTENCY/);
  const evidence=memoryOperation(db,'evidence',{id:saved.evidence_id}) as EvidenceRecord;
  assert.equal(evidence.trust,'untrusted_external');assert.equal(evidence.source_metadata?.sender_id,evidence.source_metadata?.recipient_id);
  assert.ok(memoryOperation(db,'processing_stamp',{ids:[saved.evidence_id],purpose:'extraction',provider:consumer}));
  assert.equal(memoryOperation(db,'processing_stamp',{ids:[saved.evidence_id],purpose:'embedding',provider:consumer}),null);
  assert.throws(()=>apply('spoof',{...fact,device:'another-device'}));
  assert.throws(()=>apply('other-device',fact,'other'));
  apply('revoke',{...grant,revision:2,allow_processing:false});
  assert.equal(memoryOperation(db,'processing_stamp',{ids:[saved.evidence_id],purpose:'extraction',provider:consumer}),null);
 }finally{db.close()}
});
test('source deletion fences late outboxes and retention cannot be renewed by replay',()=>{
 const {db,apply}=fixture();try{
  apply('grant',grant);const saved=apply('fact',fact) as {evidence_id:string};
  apply('delete',{kind:'delete_source',source_id:'chat'});
  assert.equal(memoryOperation(db,'evidence',{id:saved.evidence_id}),null);
  assert.throws(()=>apply('late',fact));assert.throws(()=>apply('regrant',{...grant,revision:3}));
  const expired={...fact,source_id:'old',occurred_at:'2020-01-01T00:00:00.000Z'};
  apply('old-grant',{...grant,source_id:'old'});const result=apply('old-fact',expired) as {retained:boolean};assert.equal(result.retained,false);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_evidence').get()!.n,0);
 }finally{db.close()}
});
test('explicit corrections stay provider scoped and retain authenticated origin without fabricated evidence',()=>{
 const {db,apply}=fixture();try{
  apply('correction',{kind:'correction',key:'about',value:'I design software',provider});
  const snapshot=memoryOperation(db,'space_source_snapshot',{prefix,provider}) as {corrections:Record<string,{value:string;sender:string}>};
  assert.equal(snapshot.corrections.about!.value,'I design software');assert.equal(snapshot.corrections.about!.sender,'phone');
  assert.equal(db.prepare('SELECT count(*) n FROM memory_evidence').get()!.n,0);
  assert.deepEqual((memoryOperation(db,'space_source_snapshot',{prefix,provider:'other'}) as {corrections:unknown}).corrections,{});
 }finally{db.close()}
});

test('Host profile processing honors local explicit corrections without a Hub bridge',async()=>{
 const {mkdtemp,rm,realpath}=await import('node:fs/promises');
 const {MemoryLedgerClient}=await import('../src/memory-ledger/store-client.js');const {SubstrateMemoryResource}=await import('../src/memory-substrate/resource.js');
 const root=await mkdtemp(join(await realpath(tmpdir()),'space-source-profile-'));
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',sourceProcessingLlm:{baseUrl:'https://model.invalid',apiKey:'fixture'},personalMemoryEnabled:false,gateway:{stream(){return {[Symbol.asyncIterator]:()=>({next:()=>Promise.reject(Error('unused'))})}},complete(request){assert.match(request.system,/I design software/);return Promise.reject(Error('fixture_stop'))}}});
 try{
  await memory.open({deferBackground:true});
  await memory.receiveSpaceSourceInput({space:'space',sender:'phone',opId:'correction'},{kind:'correction',key:'about',value:'I design software',provider});
  const profile=await memory.sourceProcessing({action:'profile'}) as {explicit_corrections:Record<string,{value:string}>};
  assert.equal(profile.explicit_corrections.about!.value,'I design software');
  await assert.rejects(memory.sourceProcessingProfile([{id:'fixture',version:1,content:'I used to teach',origin:'inferred'}],new AbortController().signal,()=>Promise.resolve()),/fixture_stop/);
 }finally{await memory.close();await rm(root,{recursive:true,force:true})}
});

test('invalid source inputs return a bounded code without reflecting private field names',async()=>{
 const {applySpaceSourceInput}=await import('../src/space-host/context-input.js');
 await assert.rejects(applySpaceSourceInput({} as PersonalMemoryResource,{space:'space',sender:'phone',opId:'invalid'},{kind:'correction',key:'about',value:'I design software','private-account-and-secret':'private-text'}),error=>error instanceof Error&&error.message==='invalid_source_input');
});
