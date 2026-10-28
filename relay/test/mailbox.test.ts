import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MailboxStore} from '../src/mailbox.js';
import {RelayError, type RelayAuthority, type RelayEnvelope, type RelayPrincipal} from '../src/protocol.js';
const sender: RelayPrincipal = {space:'s',device:'host',epoch:1};
const client: RelayPrincipal = {space:'s',device:'c1',epoch:1};
function envelope(id:string, changes:Partial<RelayEnvelope> = {}):RelayEnvelope {
  return {v:1,space:'s',from:'host',to:'c1',epoch:1,id,chan:'mailbox',expiresAt:null,body:'YQ==',sig:'Yg==',...changes};
}
function setup(options:ConstructorParameters<typeof MailboxStore>[2] = {}) {
  const directory = mkdtempSync(join(tmpdir(),'relay-mailbox-'));
  const revoked = new Set<string>();
  const authority:RelayAuthority = {
    assertActive(p) {if (revoked.has(p.device) || p.epoch !== 1) throw new RelayError('revoked');},
    assertCanSend(_p,e) {if(e.to === 'unknown') throw new RelayError('recipient_unknown');},
  };
  let store = new MailboxStore(join(directory,'mail.sqlite'),authority,options);
  return {get store(){return store;},revoked,legacy(id:string,expires:number){const accepted=store.send(sender,envelope(id));const db=new DatabaseSync(join(directory,'mail.sqlite'));try{db.prepare('UPDATE mailbox_messages SET expires=?,payload=? WHERE seq=?').run(expires,JSON.stringify(envelope(id,{expiresAt:expires})),accepted.seq);}finally{db.close();}},restart(){store.close();store = new MailboxStore(join(directory,'mail.sqlite'),authority,options);},close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('durable send retry and lost ACK preserve logical delivery across restart',()=>{
  const f=setup();try {
    assert.deepEqual(f.store.send(sender,envelope('a')),{seq:1,duplicate:false});
    f.restart();assert.deepEqual(f.store.send(sender,envelope('a')),{seq:1,duplicate:true});
    assert.equal(f.store.read(client).messages[0]?.envelope.body,'YQ==');
    f.restart();assert.equal(f.store.read(client).messages[0]?.seq,1);
    assert.equal(f.store.acknowledge(client,1),1);f.restart();
    assert.equal(f.store.read(client).messages.length,0);
    assert.equal(f.store.acknowledge(client,1),1);
  } finally {f.close();}
});
test('recipient sequences, ACK and spaces remain isolated',()=>{
 const f=setup();try {
   f.store.send(sender,envelope('a'));f.store.send(sender,envelope('b',{to:'c2'}));
   f.store.send({...sender,space:'other'},envelope('a',{space:'other'}));
   f.store.read(client);f.store.acknowledge(client,1);
   assert.equal(f.store.read({...client,device:'c2'}).messages[0]?.seq,1);
   assert.equal(f.store.read({...client,space:'other'}).messages[0]?.envelope.space,'other');
   assert.equal(f.store.read({...client,device:'empty'}).messages.length,0);
 }finally{f.close();}
});
test('every retry, read and ACK rechecks revocation and epoch',()=>{
 const f=setup();try {
   f.store.send(sender,envelope('a'));f.store.read(client);f.revoked.add('host');f.revoked.add('c1');
   assert.throws(()=>f.store.send(sender,envelope('a')),/revoked/);
   assert.throws(()=>f.store.read(client),/revoked/);
   assert.throws(()=>f.store.acknowledge(client,1),/revoked/);
   assert.throws(()=>f.store.read({...client,device:'c2',epoch:2}),/revoked/);
 }finally{f.close();}
});
test('conflicting IDs, invalid envelopes and unauthorized recipients never deliver',()=>{
 const f=setup();try {
   f.store.send(sender,envelope('a'));
   for(const changes of [{body:'Yw=='},{to:'c2'},{sig:'ZA=='}])
     assert.throws(()=>f.store.send(sender,envelope('a',changes)),/id_conflict/);
   assert.throws(()=>f.store.send(sender,envelope('b',{from:'c1'})),/sender_mismatch/);
   assert.throws(()=>f.store.send(sender,envelope('b',{to:'unknown'})),/recipient_unknown/);
   assert.throws(()=>f.store.send(sender,envelope('b',{chan:'stream',expiresAt:100})),/invalid_channel/);
   assert.equal(f.store.read(client).messages.length,1);
 }finally{f.close();}
});
test('pagination is contiguous and ACK cannot advance to unseen or future deliveries',()=>{
 const f=setup();try {
   for(const id of ['a','b','c'])f.store.send(sender,envelope(id));
   assert.throws(()=>f.store.acknowledge(client,1),/cursor_not_delivered/);
   assert.throws(()=>f.store.read(client,{after:2}),/cursor_not_delivered/);
   const first=f.store.read(client,{limit:1});assert.equal(first.nextCursor,1);assert.equal(first.hasMore,true);
   assert.throws(()=>f.store.acknowledge(client,2),/cursor_not_delivered/);
   f.store.read(client,{after:1,limit:1});f.restart();assert.equal(f.store.acknowledge(client,2),2);
   assert.equal(f.store.acknowledge(client,1),2);
   assert.equal(f.store.read(client).messages[0]?.seq,3);
   assert.throws(()=>f.store.read(client,{limit:0}),/invalid_limit/);
   assert.throws(()=>f.store.acknowledge(client,NaN),/invalid_cursor/);
 }finally{f.close();}
});
test('capacity rejection rolls back sequence and dedup, prune releases payload capacity',()=>{
 const f=setup({maxMessages:2,maxMessagesPerDevice:1});try {
   f.store.send(sender,envelope('a'));
   assert.throws(()=>f.store.send(sender,envelope('b')),/capacity_exceeded/);
   f.store.send(sender,envelope('c',{to:'c2'}));
   assert.throws(()=>f.store.send(sender,envelope('d',{to:'c3'})),/capacity_exceeded/);
   f.store.prune(client,1);
   assert.deepEqual(f.store.send(sender,envelope('b')),{seq:2,duplicate:false});
   assert.throws(()=>f.store.read(client),/cursor_expired/);
   assert.equal(f.store.read(client,{after:1}).messages[0]?.seq,2);
   assert.deepEqual(f.store.send(sender,envelope('a')),{seq:1,duplicate:true});
 }finally{f.close();}
});
test('dedup history is bounded and retained after prune and restart',()=>{
 const f=setup({maxHistory:2,maxHistoryPerDevice:1});try {
   f.store.send(sender,envelope('a'));f.store.prune(client,1);f.restart();
   assert.throws(()=>f.store.send(sender,envelope('b')),/history_capacity_exceeded/);
   assert.equal(f.store.send(sender,envelope('a')).duplicate,true);
   f.store.send(sender,envelope('c',{to:'c2'}));
   assert.throws(()=>f.store.send(sender,envelope('d',{to:'c3'})),/history_capacity_exceeded/);
   assert.throws(()=>f.store.send(sender,envelope('a',{body:'Yw=='})),/id_conflict/);
 }finally{f.close();}
});
test('mailbox rejects any deadline and safely traverses pre-upgrade expired rows after a lost ACK',()=>{
 let now=10;const f=setup({now:()=>now});try {
   for(const expiresAt of [0,10,11,100000])assert.throws(()=>f.store.send(sender,envelope('old',{expiresAt})),/mailbox_deadline_forbidden/);
   f.legacy('a',11);f.store.send(sender,envelope('b'));now=12;
   assert.throws(()=>f.store.acknowledge(client,1),/cursor_not_delivered/);
   let page=f.store.read(client);assert.deepEqual(page.messages.map(m=>m.envelope.id),['b']);assert.equal(page.nextCursor,2);
   f.restart();page=f.store.read(client);assert.equal(page.nextCursor,2);assert.deepEqual(page.messages.map(m=>m.envelope.id),['b']);
   assert.equal(f.store.acknowledge(client,2),2);assert.equal(f.store.read(client).messages.length,0);
 }finally{f.close();}
});
test('byte quotas and option validation are enforced',()=>{
 const f=setup({maxBytes:1});try {assert.throws(()=>f.store.send(sender,envelope('a')),/capacity_exceeded/);}finally{f.close();}
 assert.throws(()=>new MailboxStore(':memory:',{assertActive(){},assertCanSend(){}},{maxHistory:0}),/invalid_options/);
});
test('a page of only expired legacy rows advances a bounded cursor without delivering their ciphertext',()=>{
 let now=10;const f=setup({now:()=>now});try {
   f.legacy('a',11);f.legacy('b',11);now=12;
   const first=f.store.read(client,{limit:1});assert.equal(first.nextCursor,1);assert.equal(first.messages.length,0);assert.equal(first.hasMore,true);
   assert.throws(()=>f.store.acknowledge(client,2),/cursor_not_delivered/);
   const second=f.store.read(client,{after:1,limit:1});assert.equal(second.nextCursor,2);assert.equal(second.messages.length,0);assert.equal(second.hasMore,false);
   assert.equal(f.store.acknowledge(client,2),2);
 }finally{f.close();}
});
test('per-device byte limits and envelope limits cannot be bypassed by another destination',()=>{
 const bytes=Buffer.byteLength(JSON.stringify(envelope('a')));
 const f=setup({maxBytesPerDevice:bytes});try {
   f.store.send(sender,envelope('a'));
   assert.throws(()=>f.store.send(sender,envelope('b')),/capacity_exceeded/);
   assert.equal(f.store.send(sender,envelope('b',{to:'c2'})).seq,1);
 }finally{f.close();}
 const g=setup({maxMessageBytes:100});try {
   assert.throws(()=>g.store.send(sender,envelope('a')),/message_too_large/);
 }finally{g.close();}
});
test('prune rechecks authorization and cannot clear another recipient through sender identity',()=>{
 const f=setup();try {
   f.store.send(sender,envelope('a'));
   assert.throws(()=>f.store.prune(sender,1),/invalid_cursor/);
   f.revoked.add('c1');assert.throws(()=>f.store.prune(client,1),/revoked/);
   f.revoked.delete('c1');assert.equal(f.store.read(client).messages.length,1);
 }finally{f.close();}
});
test('status exposes durable recovery cursors without advancing delivery and enforces authority',()=>{
 const f=setup();try {
   assert.deepEqual(f.store.status(client),{lastCursor:0,ackCursor:0,deliveredCursor:0,retainedAfter:0});
   f.store.send(sender,envelope('a'));f.store.send(sender,envelope('b'));
   f.store.read(client,{limit:1});f.store.acknowledge(client,1);f.store.prune(client,2);f.restart();
   assert.throws(()=>f.store.read(client),/cursor_expired/);
   const state=f.store.status(client);
   assert.deepEqual(state,{lastCursor:2,ackCursor:1,deliveredCursor:1,retainedAfter:2});
   assert.deepEqual(f.store.status({...client,space:'other'}),{lastCursor:0,ackCursor:0,deliveredCursor:0,retainedAfter:0});
   assert.throws(()=>f.store.acknowledge(client,2),/cursor_not_delivered/);
   assert.equal(f.store.read(client,{after:state.retainedAfter}).messages.length,0);
   assert.equal(f.store.acknowledge(client,2),2);
   f.revoked.add('c1');assert.throws(()=>f.store.status(client),/revoked/);
 }finally{f.close();}
});
test('invalid clocks fail expiry checks without publishing or advancing delivery',()=>{
 let now=10;const f=setup({now:()=>now});try {
   f.legacy('a',20);
   for (const invalid of [NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
     now=invalid;
     assert.throws(()=>f.store.send(sender,envelope('b')),/invalid_clock/);
     assert.throws(()=>f.store.read(client),/invalid_clock/);
   }
   assert.throws(()=>f.store.acknowledge(client,1),/cursor_not_delivered/);
   now=11;assert.equal(f.store.send(sender,envelope('b')).seq,2);
 }finally{f.close();}
});
test('clock rollback cannot resurrect expired ciphertext within a store lifetime',()=>{
 let now=10;const f=setup({now:()=>now});try {
   f.legacy('a',20);
   now=21;assert.equal(f.store.read(client).messages.length,0);
   now=11;assert.equal(f.store.read(client).messages.length,0);
 }finally{f.close();}
});
test('empty recovery page delivers the retained floor for durable ACK after snapshot',()=>{
 const f=setup();try {
   f.store.send(sender,envelope('a'));f.store.prune(client,1);
   const {retainedAfter}=f.store.status(client);
   assert.throws(()=>f.store.acknowledge(client,retainedAfter),/cursor_not_delivered/);
   const page=f.store.read(client,{after:retainedAfter});
   assert.equal(page.messages.length,0);assert.equal(page.nextCursor,1);
   assert.equal(f.store.acknowledge(client,page.nextCursor),1);
   f.restart();assert.equal(f.store.read(client).nextCursor,1);
   assert.throws(()=>f.store.read(client,{after:2}),/cursor_not_delivered/);
   assert.throws(()=>f.store.acknowledge(client,2),/cursor_not_delivered/);
 }finally{f.close();}
});

test('byte-budgeted mailbox pages expose only returned cursors and reject an undersized page without delivery',()=> {
 const f=setup();try {
  for(const id of ['a','b','c'])f.store.send(sender,envelope(id));
  const entryBytes=Buffer.byteLength(JSON.stringify({seq:1,envelope:envelope('a')}));
  const options={limit:100,maxBytes:entryBytes};
  const page=f.store.read(client,options);
  assert.equal(page.messages.length,1);assert.equal(page.nextCursor,1);assert.equal(page.hasMore,true);
  assert.throws(()=>f.store.acknowledge(client,2),/cursor_not_delivered/);
  const tooSmall={after:1,maxBytes:1};
  assert.throws(()=>f.store.read(client,tooSmall),/page_too_small/);
  assert.equal(f.store.status(client).deliveredCursor,1);
  const next=f.store.read(client,{...options,after:1});assert.equal(next.messages[0]?.seq,2);
 }finally{f.close();}
});
