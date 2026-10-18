import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'
import {allowsProcessing,type ProcessingGrant} from '../src/memory-substrate/source-state.js'
import {FeishuConnector,FEISHU_SCOPES} from '../src/connectors/feishu/index.js'
const account=createHash('sha256').update(JSON.stringify(['fixture',null,'self'])).digest('hex')
const scope='personal:fixture:feishu:',source=(i:number)=>scope+account+':0:chat'+i
const grant=(revision:number,allowed=true):ProcessingGrant=>({revision,scope_revision:2,extraction_provider:allowed?'provider':null,embedding_provider:null,conversation_providers:allowed?['chat-provider']:[]})
function transition(db:DatabaseSync,mode:string,sources:string[],value:ProcessingGrant,pending=false){return memoryOperation(db,'source_grant',{action:'feishu_consent',scope,mode,sources,grant:value,pending}) as ProcessingGrant}
function seed(db:DatabaseSync){for(let i=0;i<126;i++)memoryOperation(db,'source_grant',{source_id:source(i),expected_revision:0,grant:grant(i<116?8:7,i<116)})}
const ids=Array.from({length:126},(_,i)=>source(i))
interface TestSaved {sources:string[];processingConsent:ProcessingGrant;processingConsentPending?:boolean}
async function savedState(path:string):Promise<TestSaved>{return JSON.parse(await readFile(path,'utf8')) as TestSaved}

test('legacy 116/126 partial grants are denied before connector recovery; mismatch revokes above every old revision',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db);seed(db)
 try{
  assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
  assert.equal(allowsProcessing(db,source(0),'conversation','chat-provider'),false)
  const recovered=transition(db,'reconcile',ids,grant(7,false));assert.equal(recovered.revision,9);assert.equal(recovered.extraction_provider,null)
  transition(db,'activate',ids,recovered)
  for(const id of ids){assert.equal(allowsProcessing(db,id,'extraction','provider'),false);assert.deepEqual(memoryOperation(db,'source_grant',{action:'get',source_id:id}),recovered)}
 }finally{db.close()}
})

test('a failure on source 117 rolls the entire batch back and keeps processing fenced; explicit retry works',()=>{
 const db=new DatabaseSync(':memory:');initializeMemory(db);seed(db)
 try{
  db.exec(`CREATE TRIGGER reject_fixture BEFORE UPDATE ON source_grants WHEN NEW.source_id='${source(116)}' BEGIN SELECT RAISE(ABORT,'fixture interruption'); END;`)
  assert.throws(()=>transition(db,'apply',ids,grant(8)),/fixture interruption/)
  for(let i=0;i<126;i++){assert.equal((memoryOperation(db,'source_grant',{action:'get',source_id:source(i)}) as ProcessingGrant).revision,i<116?8:7);assert.equal(allowsProcessing(db,source(i),'extraction','provider'),false)}
  db.exec('DROP TRIGGER reject_fixture')
  const accepted=transition(db,'apply',ids,grant(8));assert.equal(accepted.revision,9)
  assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
  transition(db,'activate',ids,accepted);assert.equal(allowsProcessing(db,source(0),'extraction','provider'),true)
  transition(db,'suspend',ids,accepted);assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
  const revoked=transition(db,'apply',[],grant(8,false));assert.equal(revoked.revision,10)
  transition(db,'activate',[],revoked);assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
 }finally{db.close()}
})

test('worker restart fences previously bound scheduler reads before recovery, and pending consent never regrants',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-consent-restart-')),path=join(dir,'ledger.sqlite')
 let db=new DatabaseSync(path);initializeMemory(db)
 try{
  const now=new Date().toISOString(),id='personal:fixture:e:one'
  memoryOperation(db,'append_evidence',{id,source_id:source(0),source_kind:'im',locator:'fixture',raw_text:'Synthetic planning material',hash:'fixture',observed_at:now,recorded_at:now,trust:'untrusted_external',source_metadata:{sender_id:'self',account_id:'self',recipient_id:'self'}})
  const accepted=transition(db,'apply',[source(0)],grant(1))
  const process=(action:Record<string,unknown>)=>memoryOperation(db,'source_processing',{prefix:'personal:fixture:',provider:'provider',participants:true,...action})
  assert.equal(process({action:'claim'}),null,'a scheduler may scan while startup consent is closed')
  transition(db,'activate',[source(0)],accepted)
  const batch=process({action:'claim'}) as {id:string};assert.ok(batch,'activation requeues evidence skipped before recovery')
  process({action:'bind',batch_id:batch.id,task_id:'task',run_id:'run'});assert.ok(process({action:'read',batch_id:batch.id}))
  db.close();db=new DatabaseSync(path);initializeMemory(db)
  assert.equal(process({action:'read',batch_id:batch.id}),null)
  assert.deepEqual(memoryOperation(db,'pending_evidence',{source_prefix:'personal:fixture:',provider:'provider'}),[])
  assert.deepEqual(transition(db,'reconcile',[source(0)],accepted),accepted)
  assert.equal(process({action:'read',batch_id:batch.id}),null,'reconciliation alone does not activate before JSON persistence')
  transition(db,'activate',[source(0)],accepted);assert.ok(process({action:'read',batch_id:batch.id}))
  transition(db,'suspend',[source(0)],accepted)
  const recovered=transition(db,'reconcile',[source(0)],accepted,true);assert.equal(recovered.extraction_provider,null)
  transition(db,'activate',[source(0)],recovered);assert.equal(process({action:'read',batch_id:batch.id}),null)
 }finally{db.close();await rm(dir,{recursive:true,force:true})}
})

test('connector journals an interrupted grant and recovery saves revocation before allowing reads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-consent-connector-')),path=join(dir,'state.json'),db=new DatabaseSync(':memory:');initializeMemory(db)
 let interrupt=false,activated=false
 const state={paused:true,connected:true,bot:false,selected:['chat0'],actions:[],sources:['feishu:'+account+':0:chat0'],generation:0,account,openId:'self',cursors:{},deliveries:{},processingConsent:grant(7,false)}
 await writeFile(path,JSON.stringify(state))
 const make=()=>new FeishuConnector({executable:'unused',credentialRoot:dir,statePath:path,ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),processingGrant:(allowed,revision,scope_revision)=>({...grant(revision,allowed),scope_revision}),processingConsentTransition:async(mode,sources,value,pending)=>{
   const result=transition(db,mode,sources.map(id=>'personal:fixture:'+id),value,pending)
   if(mode==='apply'&&interrupt)throw Error('fixture lost reply after ledger commit')
   if(mode==='activate'){const saved=(await savedState(path));assert.equal(saved.processingConsentPending,undefined);assert.deepEqual(saved.processingConsent,value);activated=true}
   return result
  },run:args=>Promise.resolve(args[0]==='--version'?'lark-cli 1.0.69':args[1]==='status'?JSON.stringify({appId:'fixture',verified:true,identities:{user:{openId:'self',status:'authenticated',scopes:FEISHU_SCOPES}}}):'{}')})
 let connector=make()
 try{
  await connector.open();interrupt=true;activated=false
  await assert.rejects(connector.setProcessingConsent(true),/lost reply/)
  assert.equal((await savedState(path)).processingConsentPending,true)
  assert.equal(connector.snapshot().processing_consent_required,true);assert.equal(activated,false)
  assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
  await connector.close();interrupt=false;connector=make();await connector.open()
  const saved=(await savedState(path));assert.equal(saved.processingConsent.extraction_provider,null);assert.equal(saved.processingConsentPending,undefined)
  assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false);assert.equal(connector.snapshot().processing_consent_required,true)
  await connector.setProcessingConsent(true);assert.equal(connector.snapshot().processing_consent_required,false);assert.equal(allowsProcessing(db,source(0),'extraction','provider'),true)
 }finally{await connector.close();db.close();await rm(dir,{recursive:true,force:true})}
})

for(const concurrent of ['configure','reopen'] as const)test(`a suspended revocation cannot be reopened by concurrent ${concurrent}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-consent-race-')),path=join(dir,'state.json'),db=new DatabaseSync(':memory:');initializeMemory(db)
 await writeFile(path,JSON.stringify({paused:true,connected:true,bot:false,selected:['chat0'],actions:[],sources:['feishu:'+account+':0:chat0'],generation:0,account,openId:'self',cursors:{},deliveries:{},processingConsent:grant(1,false)}))
 let hold=false,release!:()=>void,reached!:()=>void,activations=0
 const suspended=new Promise<void>(resolve=>{reached=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
 const connector=new FeishuConnector({executable:'unused',credentialRoot:dir,statePath:path,ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),processingGrant:(allowed,revision,scope_revision)=>({...grant(revision,allowed),scope_revision}),processingConsentTransition:async(mode,sources,value,pending)=>{
  const result=transition(db,mode,sources.map(id=>'personal:fixture:'+id),value,pending)
  if(mode==='activate')activations++
  if(mode==='suspend'&&hold){hold=false;reached();await resume}
  return result
 },run:args=>Promise.resolve(args[0]==='--version'?'lark-cli 1.0.69':args[1]==='status'?JSON.stringify({appId:'fixture',verified:true,identities:{user:{openId:'self',status:'authenticated',scopes:FEISHU_SCOPES}}}):'{}')})
 try{
  await connector.open();await connector.setProcessingConsent(true);assert.equal(allowsProcessing(db,source(0),'extraction','provider'),true)
  hold=true;const revoking=connector.setProcessingConsent(false);await suspended
  const before=activations;assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
  const competing=concurrent==='configure'?connector.configure([],true):connector.open()
  await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(activations,before,'recovery cannot reactivate old saved consent while revocation is suspended')
  assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
  release();await Promise.all([revoking,competing]);assert.equal(allowsProcessing(db,source(0),'extraction','provider'),false)
  assert.equal(connector.snapshot().processing_consent_required,true)
 }finally{release();await connector.close();db.close();await rm(dir,{recursive:true,force:true})}
})

test('first sync of empty chats preserves consent across restart, but evidence without a grant revokes it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-consent-empty-')),path=join(dir,'state.json'),db=new DatabaseSync(':memory:');initializeMemory(db)
 await writeFile(path,JSON.stringify({paused:false,connected:true,bot:false,selected:['chat0','chat1'],actions:[],sources:[],generation:0,account,openId:'self',cursors:{},deliveries:{},processingConsent:grant(1)}))
 const make=()=>new FeishuConnector({executable:'unused',credentialRoot:dir,statePath:path,ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),processingGrant:(allowed,revision,scope_revision)=>({...grant(revision,allowed),scope_revision}),processingConsentTransition:(mode,sources,value,pending)=>Promise.resolve(transition(db,mode,sources.map(id=>'personal:fixture:'+id),value,pending)),run:args=>Promise.resolve(args[0]==='--version'?'lark-cli 1.0.69':args[1]==='status'?JSON.stringify({appId:'fixture',verified:true,identities:{user:{openId:'self',status:'authenticated',scopes:FEISHU_SCOPES}}}):JSON.stringify({items:[],has_more:false}))})
 let connector=make()
 try{
  await connector.open();await connector.sync();assert.equal((await savedState(path)).sources.length,2)
  await connector.close();connector=make();await connector.open()
  assert.equal(connector.snapshot().processing_consent_required,false)
  assert.deepEqual((await savedState(path)).processingConsent,grant(1),'empty chats must not manufacture a revocation')
  // First nonempty ingestion may create its per-source grant under the already admitted scope.
  memoryOperation(db,'source_grant',{source_id:source(1),expected_revision:0,grant:grant(1)})
  assert.equal(allowsProcessing(db,source(1),'extraction','provider'),true)
  await connector.close();connector=make();await connector.open();assert.equal(connector.snapshot().processing_consent_required,false)
  const now=new Date().toISOString()
  memoryOperation(db,'append_evidence',{id:'personal:fixture:e:ungranted',source_id:source(0),source_kind:'im',locator:'fixture-ungranted',raw_text:'Synthetic ungranted source',hash:'ungranted',observed_at:now,recorded_at:now,trust:'untrusted_external'})
  await connector.close();connector=make();await connector.open()
  assert.equal(connector.snapshot().processing_consent_required,true);assert.equal((await savedState(path)).processingConsent.extraction_provider,null)
 }finally{await connector.close();db.close();await rm(dir,{recursive:true,force:true})}
})

test('without atomic memory, dynamic connector capability still allows Feishu login and notification status',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-consent-no-memory-'))
 let capabilities:{feishuProcessingConsent?: (mode:'suspend'|'reconcile'|'apply'|'activate',sources:string[],value:ProcessingGrant,pending?:boolean)=>Promise<ProcessingGrant>}|undefined
 let versions=0
 const connector=new FeishuConnector({executable:'unused',credentialRoot:dir,statePath:join(dir,'state.json'),ingest:()=>Promise.resolve(),deleteSource:()=>Promise.resolve(),onAction:()=>Promise.resolve(),get processingConsentTransition(){return capabilities?.feishuProcessingConsent?.bind(capabilities)},run:args=>{if(args[0]==='--version'){versions++;return Promise.resolve('lark-cli 1.0.69')}return Promise.resolve(JSON.stringify({appId:'fixture',verified:true,identities:{user:{openId:'self',status:'authenticated',scopes:FEISHU_SCOPES}}}))}})
 try{
  await connector.open();assert.equal(versions,1);assert.equal(connector.snapshot().available,true);assert.equal(connector.snapshot().configured,true);assert.equal(connector.snapshot().notification_ready,true)
  capabilities={feishuProcessingConsent:(_mode,_sources,value)=>Promise.resolve(value)}
  await connector.open();assert.equal(versions,2);assert.equal(connector.snapshot().available,true)
 }finally{await connector.close();await rm(dir,{recursive:true,force:true})}
})
