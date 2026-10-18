import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
import type {ExplicitMemoryArguments,ExplicitMemoryTurn} from '../src/memory/explicit-memory.js'

// These boundary tests deliberately disable extraction and embeddings: a successful explicit
// write must be visible without either service, including after a process/resource restart.
const gateway:ModelGateway={async *stream(){await Promise.reject(Error('unexpected model call'))},complete(){throw Error('unexpected extraction')}}
const turn=(sourceId:string,text:string):ExplicitMemoryTurn=>({sourceId,text,occurredAt:new Date().toISOString()})
const name=(text:string):ExplicitMemoryArguments=>({action:'set',kind:'preference',slot:'preferred_name',text,quote:text})
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'nova-explicit-memory-')),path=join(root,'ledger.sqlite')
 const create=(userId='test',enabled=true)=>new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId,gateway,model:'fixture',inputConsent:true,conversationProviders:['chat'],personalMemoryEnabled:enabled})
 const memory=create();await memory.open({deferBackground:true})
 return {memory,create,async close(){await memory.close();await rm(root,{recursive:true,force:true})}}
}

test('explicit preferred name is immediately readable in a new conversation and after restart without models',async()=>{
 const f=await fixture();let restarted:ReturnType<typeof f.create>|undefined
 try{
  assert.equal(typeof f.memory.beginExplicitTurn,'function','explicit admission must exist')
  const t=await f.memory.beginExplicitTurn(turn('a','请记住叫我 kant'))
  const saved=await f.memory.writeExplicit(t,'call-1',name('kant'),'chat')
  assert.equal(saved.state,'committed');assert.equal(saved.current?.text,'kant')
  assert.match((await f.memory.prepareResponseAdaptation('chat')).memoryContext!.text,/kant/)
  assert.match((await f.memory.prepareResponseAdaptation('chat')).memoryContext!.voice,/kant/)
  assert.equal((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]?.text,'kant')
  assert.deepEqual((await f.memory.lookupExplicit({},'other-provider')).entries,[])
  await f.memory.close();restarted=f.create();await restarted.open({deferBackground:true})
  assert.match((await restarted.prepareResponseAdaptation('chat')).memoryContext!.text,/kant/)
 }finally{await restarted?.close();await f.close()}
})

test('explicit retries are idempotent; a changed payload cannot reuse a receipt; forgetting is reflected on replay',async()=>{
 const f=await fixture()
 try{
  assert.equal(typeof f.memory.beginExplicitTurn,'function')
  const t=await f.memory.beginExplicitTurn(turn('a','请记住叫我 kant，也可以叫我 k'))
  const first=await f.memory.writeExplicit(t,'call-1',name('kant'),'chat')
  const replay=await f.memory.writeExplicit(t,'call-1',name('kant'),'chat')
  assert.equal(replay.version,1);assert.equal(replay.replayed,true)
  await assert.rejects(f.memory.writeExplicit(t,'call-1',name('k'),'chat'),{code:'STORE_IDEMPOTENCY_CONFLICT'})
  const forget=await f.memory.beginExplicitTurn(turn('b','忘记我的称呼'))
  await f.memory.writeExplicit(forget,'call-2',{action:'forget',slot:'preferred_name',quote:'忘记我的称呼'},'chat')
  assert.deepEqual((await f.memory.lookupExplicit({},'chat')).entries,[])
  assert.doesNotMatch(JSON.stringify(await f.memory.prepareResponseAdaptation('chat')),/kant/)
  const after=await f.memory.writeExplicit(t,'call-1',name('kant'),'chat')
  assert.equal(after.id,first.id);assert.equal(after.current,null,'historical receipt must not claim a forgotten value is current')
  const again=await f.memory.beginExplicitTurn(turn('c','请记住叫我 kant，也可以叫我 k'))
  const restored=await f.memory.writeExplicit(again,'call-3',name('kant'),'chat')
  assert.equal(restored.current?.text,'kant');assert.equal(restored.version,3)
 }finally{await f.close()}
})

test('late old turns and concurrent stale snapshots cannot replace a newer explicit name',async()=>{
 const f=await fixture()
 try{
  assert.equal(typeof f.memory.beginExplicitTurn,'function')
  const old=await f.memory.beginExplicitTurn(turn('old','请记住叫我 kant'))
  const newer=await f.memory.beginExplicitTurn(turn('new','以后叫我 kay'))
  await f.memory.writeExplicit(newer,'new-call',name('kay'),'chat')
  await assert.rejects(f.memory.writeExplicit(old,'old-call',name('kant'),'chat'),/STALE|stale/)
  assert.equal((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries[0]?.text,'kay')
 }finally{await f.close()}
})

test('generic facts are enumerable and editable; quote, consumer, and namespace are checked',async()=>{
 const f=await fixture()
 try{
  assert.equal(typeof f.memory.beginExplicitTurn,'function')
  const t=await f.memory.beginExplicitTurn(turn('project','记住项目代号 C731'))
  await assert.rejects(f.memory.writeExplicit(t,'bad',{action:'set',kind:'fact',text:'C999',quote:'C999'},'chat'))
  const fact=await f.memory.writeExplicit(t,'fact',{action:'set',kind:'fact',text:'项目代号 C731',quote:'项目代号 C731'},'chat')
  const rows=await f.memory.lookupExplicit({},'chat');assert.equal(rows.entries[0]?.text,'项目代号 C731')
  const correction=await f.memory.beginExplicitTurn(turn('fix','项目代号改成 C732'))
  const fixed=await f.memory.writeExplicit(correction,'fix',{action:'set',kind:'fact',id:fact.id,text:'项目代号 C732',quote:'项目代号改成 C732'},'chat')
  assert.equal(fixed.version,2);assert.equal(fixed.id,fact.id)
  await assert.rejects(f.memory.writeExplicit(correction,'foreign',{action:'forget',id:'personal:foreign:entry',quote:'项目代号'},'chat'))
  await assert.rejects(f.memory.writeExplicit(correction,'unauthorized',{action:'set',kind:'fact',text:'C732',quote:'C732'},'other-provider'))
 }finally{await f.close()}
})

test('preferred name survives a full context budget and forgetting suppresses its automatic source',async()=>{
 const f=await fixture()
 try{
  assert.equal(typeof f.memory.beginExplicitTurn,'function')
  const t=await f.memory.beginExplicitTurn(turn('name','请记住叫我 kant'))
  await f.memory.remember({...t,sessionId:'a',sequence:1,confirmed:true})
  const originals=await f.memory.options.client.memory('pending_evidence',{source_prefix:f.memory.prefix,provider:'fixture',limit:20}) as {id:string}[]
  assert.equal(originals.length,1)
  await f.memory.writeExplicit(t,'name',name('kant'),'chat')
  for(let i=0;i<35;i++){
   const text='偏好 '+i+' '+('x'.repeat(180)),other=await f.memory.beginExplicitTurn(turn('other-'+i,text))
   await f.memory.writeExplicit(other,'call',{action:'set',kind:'preference',text,quote:text},'chat')
  }
  assert.match((await f.memory.prepareResponseAdaptation('chat')).memoryContext!.voice,/kant/)
  const seen=new Set<string>();let cursor:string|undefined
  do{
   const page=await f.memory.lookupExplicit(cursor?{cursor}:{},'chat')
   assert(JSON.stringify(page).length<=3500,'lookup pages must fit the tool-result transport')
   for(const entry of page.entries){assert(!seen.has(entry.id));seen.add(entry.id)}
   cursor=page.next_cursor??undefined
  }while(cursor)
  assert.equal(seen.size,36)
  const forget=await f.memory.beginExplicitTurn(turn('forget','忘记我的称呼'))
  await f.memory.writeExplicit(forget,'forget',{action:'forget',slot:'preferred_name',quote:'忘记我的称呼'},'chat')
  assert.doesNotMatch(JSON.stringify(await f.memory.prepareResponseAdaptation('chat')),/kant/)
  assert.equal(await f.memory.readEvidence(originals[0]!.id),null,'an old automatic source cannot restore the forgotten memory')
 }finally{await f.close()}
})

test('disabled memory refuses explicit writes and user namespaces remain isolated after restart',async()=>{
 const f=await fixture();let other:ReturnType<typeof f.create>|undefined
 try{
  assert.equal(typeof f.memory.beginExplicitTurn,'function')
  const t=await f.memory.beginExplicitTurn(turn('name','叫我 kant'))
  await f.memory.writeExplicit(t,'name',name('kant'),'chat')
  await f.memory.close();other=f.create('someone-else');await other.open({deferBackground:true})
  assert.deepEqual((await other.lookupExplicit({},'chat')).entries,[])
  assert.doesNotMatch(JSON.stringify(await other.prepareResponseAdaptation('chat')),/kant/)
  await other.close();other=f.create('test',false);await other.open({deferBackground:true})
  await assert.rejects(other.beginExplicitTurn(turn('disabled','请记住叫我 k')),/disabled/)
 }finally{await other?.close();await f.close()}
})

test('a fresh turn can save a purged name but an earlier pending turn cannot resurrect it',async()=>{
 const f=await fixture()
 try{
  const t=await f.memory.beginExplicitTurn(turn('name','叫我 kant'))
  const saved=await f.memory.writeExplicit(t,'name',name('kant'),'chat')
  const pending=await f.memory.beginExplicitTurn(turn('pending','叫我 kay'))
  await f.memory.purgeEntry(saved.id,saved.version,'purge-name')
  await assert.rejects(f.memory.writeExplicit(pending,'late',name('kay'),'chat'),/STALE|stale/)
  const fresh=await f.memory.beginExplicitTurn(turn('fresh','叫我 kay'))
  const next=await f.memory.writeExplicit(fresh,'fresh',name('kay'),'chat')
  assert.notEqual(next.id,saved.id);assert.equal(next.current?.text,'kay')
  assert.equal((await f.memory.lookupExplicit({slot:'preferred_name'},'chat')).entries.length,1)
  await f.memory.forgetEntry(next.id,next.version)
  const restored=await f.memory.beginExplicitTurn(turn('after-ui-forget','叫我 kant'))
  assert.equal((await f.memory.writeExplicit(restored,'restore',name('kant'),'chat')).current?.text,'kant')
 }finally{await f.close()}
})

test('two facts from one turn retain separate evidence after one is forgotten',async()=>{
 const f=await fixture()
 try{
  const t=await f.memory.beginExplicitTurn(turn('both','记住叫我 kant，我住 Berlin'))
  await f.memory.writeExplicit(t,'name',name('kant'),'chat')
  const home=await f.memory.writeExplicit(t,'home',{action:'set',kind:'fact',text:'用户住在 Berlin',quote:'我住 Berlin'},'chat')
  const forget=await f.memory.beginExplicitTurn(turn('forget','忘记我的称呼'))
  await f.memory.writeExplicit(forget,'forget',{action:'forget',slot:'preferred_name',quote:'忘记我的称呼'},'chat')
  const evidence=await f.memory.evidenceFor(home.id,home.version)
  assert.equal(evidence.length,1);assert.equal(evidence[0]?.text,'我住 Berlin')
  assert.doesNotMatch(JSON.stringify(evidence),/kant/)
 }finally{await f.close()}
})

test('forgetting one fact does not suppress a distinct fact merely sharing its quoted sentence',async()=>{
 const f=await fixture()
 try{
  const t=await f.memory.beginExplicitTurn(turn('both','记住叫我 kant，我住 Berlin'))
  await f.memory.writeExplicit(t,'name',{...name('kant'),quote:t.text},'chat')
  const home=await f.memory.writeExplicit(t,'home',{action:'set',kind:'fact',text:'用户住在 Berlin',quote:t.text},'chat')
  const forget=await f.memory.beginExplicitTurn(turn('forget','忘记我的称呼'))
  await f.memory.writeExplicit(forget,'forget',{action:'forget',slot:'preferred_name',quote:forget.text},'chat')
  assert.equal((await f.memory.evidenceFor(home.id,home.version)).length,1)
  assert.equal((await f.memory.lookupExplicit({},'chat')).entries[0]?.id,home.id)
  assert.doesNotMatch(JSON.stringify(await f.memory.prepareResponseAdaptation('chat')),/kant/)
 }finally{await f.close()}
})

test('purge also fences pending turns captured before the slot was first created',async()=>{
 const f=await fixture()
 try{
  const pending=await f.memory.beginExplicitTurn(turn('early','叫我 kant'))
  const newer=await f.memory.beginExplicitTurn(turn('newer','叫我 kay'))
  const saved=await f.memory.writeExplicit(newer,'newer',name('kay'),'chat')
  await f.memory.purgeEntry(saved.id,saved.version,'purge-newer')
  await assert.rejects(f.memory.writeExplicit(pending,'late',name('kant'),'chat'),/STALE|stale/)
  assert.deepEqual((await f.memory.lookupExplicit({},'chat')).entries,[])
 }finally{await f.close()}
})

test('a fresh name can replace an existing name only while its source grant permits the consumer',async()=>{
 const f=await fixture()
 try{
  const t=await f.memory.beginExplicitTurn(turn('both','记住叫我 kant，我住 Berlin'))
  const saved=await f.memory.writeExplicit(t,'name',{...name('kant'),quote:t.text},'chat')
  const home=await f.memory.writeExplicit(t,'home',{action:'set',kind:'fact',text:'用户住在 Berlin',quote:t.text},'chat')
  const forget=await f.memory.beginExplicitTurn(turn('forget-home','忘记我的住址'))
  await f.memory.writeExplicit(forget,'forget-home',{action:'forget',id:home.id,quote:forget.text},'chat')
  const history=await f.memory.options.client.memory('history',{entry_id:saved.id}) as {evidence_refs:string[]}[]
  const evidence=await f.memory.options.client.memory('evidence',{id:history[0]!.evidence_refs[0]}) as {source_id:string}
  await f.memory.options.client.memory('source_grant',{source_id:evidence.source_id,expected_revision:1,grant:f.memory.processingGrant(false,2)})
  const denied=await f.memory.beginExplicitTurn(turn('denied','叫我 kay'))
  await assert.rejects(f.memory.writeExplicit(denied,'denied',name('kay'),'chat'))
  await f.memory.options.client.memory('source_grant',{source_id:evidence.source_id,expected_revision:2,grant:f.memory.processingGrant(true,3)})
  const fresh=await f.memory.beginExplicitTurn(turn('fresh','叫我 kay'))
  assert.equal((await f.memory.writeExplicit(fresh,'fresh',name('kay'),'chat')).current?.text,'kay')
 }finally{await f.close()}
})
