import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {HubStore} from '../src/hub/store.js'
import {HubContextBridge,type ContextMemoryPort} from '../src/hub/context-bridge.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import type {ProcessingBatch} from '../src/memory-substrate/source-processing.js'
import {loadSettings} from '../src/config/config.js'
import {configuredMemoryConsumer,configuredMemoryRecipient} from '../src/composition/realtime-assembly.js'

test('real PC worker persists no contradicted inference and exposes explicit corrections separately',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'nova-corrected-profile-'))),hub=new HubStore(':memory:')
 const provider='https://model.invalid|fixture'
 const settings={...loadSettings({DASHSCOPE_API_KEY:'fixture'}),cascade_llm_provider:'qwen' as const,cascade_llm_model:'fixture'},consumer=configuredMemoryConsumer(settings,'text'),recipient=configuredMemoryRecipient(settings,'text')
 assert.ok(consumer&&recipient);assert.equal(consumer,recipient.consumer)
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',sourceProcessingLlm:{baseUrl:'https://model.invalid',apiKey:'fixture'},conversationProviders:[consumer,'other'],conversationRecipients:{[consumer]:recipient.provider,other:'https://other.invalid|other'},personalMemoryEnabled:false,gateway:{async *stream(){await Promise.reject(Error('unused'))}, complete(request){try{assert.match(request.system,/I design software/);throw Error('fixture-model-stop')}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}}})
 try{
  await memory.open()
  const phone=hub.enroll('s','phone','mobile'),pc=hub.enroll('s','pc','desktop');hub.authority.initialize(pc.token)
  const event=(seq:number,payload:unknown)=>({protocol_version:1,space_id:'s',producer_device_id:phone.device_id,producer_seq:seq,event_id:`c${seq}`,payload})
  hub.context.append(phone.token,[event(1,{kind:'grant',source_id:'source',revision:1,provider,purpose:'profile',allow_upload:true,allow_processing:true}),event(2,{kind:'source_fact',source_id:'source',grant_revision:1,evidence_id:'fact',resource_id:'message',source_version:'v1',text:'I used to teach',relation:'self',occurred_at:new Date().toISOString()}),event(3,{kind:'correction',key:'about',value:'I design software',provider})])
  const bridge=new HubContextBridge(memory,join(root,'bridge.json'),(path,body)=>{try{
   if(path==='identity')return Promise.resolve(hub.identity(pc.token));
   if(path==='authority')return Promise.resolve(hub.authority.snapshot(pc.token));
   if(path==='context')return Promise.resolve(hub.context.snapshot(pc.token));
   if(path==='context/ack')return Promise.resolve(hub.context.acknowledge(pc.token,(body as {cursor:number}).cursor));
   if(path==='context/publish')return Promise.resolve(hub.context.publish(pc.token,body));
   throw Error('unexpected_request')
  }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}})
  memory.setSharedContext(bridge);await memory.syncSharedContext()
  hub.context.append(phone.token,[event(4,{kind:'correction',key:'work',value:'Conversation-authorized responsibility',provider:recipient.provider})]);await memory.syncSharedContext()
  const adaptation=await memory.prepareResponseAdaptation(consumer)
  assert.match(adaptation.explicitUserContext!,/Conversation-authorized responsibility/)
  assert.doesNotMatch(adaptation.explicitUserContext!,/I design software/)
  assert.doesNotMatch((await memory.prepareResponseAdaptation('other')).explicitUserContext??'',/Conversation-authorized responsibility/)
  const batch=await memory.sourceProcessing({action:'claim'}) as ProcessingBatch
  await memory.sourceProcessing({action:'bind',batch_id:batch.id,task_id:'task',run_id:'run'})
  const originals=await memory.sourceProcessing({action:'read',batch_id:batch.id}) as {items:{evidence_id:string;version:string}[]}
  const first=originals.items[0]!
  await assert.rejects(memory.sourceProcessingProfile([{id:first.evidence_id,version:first.version,origin:'inferred',content:'I used to teach',source:{kind:'im',relation:'self',project:'fixture',document:'message'}}],new AbortController().signal,()=>Promise.resolve()),/fixture-model-stop/)
  await memory.sourceProcessing({action:'publish',batch_id:batch.id,task_id:'task',run_id:'run',expected_revision:0,refs:batch.items,draft:{about:{text:'A teacher',refs:[{entry_id:first.evidence_id,version:first.version}]},work:[],interests:[]}})
  const local=await memory.sourceProcessing({action:'profile'}) as {draft:unknown;explicit_corrections:{about:{value:string}}}
  assert.equal(local.draft,null)
  assert.equal(local.explicit_corrections.about.value,'I design software')
  await memory.sourceProcessing({action:'commit',batch_id:batch.id,task_id:'task',run_id:'run',topics:[]})
  assert.equal(hub.context.snapshot(phone.token).derived?.entries[0]?.text,'I design software')
 }finally{await memory.close();hub.close();await rm(root,{recursive:true,force:true})}
})

test('primary PC imports only permitted self evidence; revoked facts are purged before ACK and late publication fails',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'nova-hub-context-'))),hub=new HubStore(':memory:')
 try{
  const phone=hub.enroll('s','phone','mobile'),pc=hub.enroll('s','pc','desktop');hub.authority.initialize(pc.token)
  const provider='https://model.invalid|fixture'
  const event=(seq:number,payload:unknown)=>({protocol_version:1,space_id:'s',producer_device_id:phone.device_id,producer_seq:seq,event_id:`e${seq}`,payload})
  hub.context.append(phone.token,[event(1,{kind:'grant',source_id:'source',revision:1,provider,purpose:'profile',allow_upload:true,allow_processing:true}),event(2,{kind:'source_fact',source_id:'source',grant_revision:1,evidence_id:'fact',resource_id:'message',source_version:'v1',text:'I prefer concise replies',relation:'self',occurred_at:new Date().toISOString()})])
  let imports=0,purges=0
  const memory:ContextMemoryPort={sourceProcessingLlm:()=>({baseUrl:'https://model.invalid',model:'fixture',apiKey:'fixture'}),sourceProcessingConsumer:()=> 'provider-fingerprint',recordEvidenceBatch: entries=>{try{imports+=entries.length;assert.equal(entries[0]?.embeddingConsent,false);return Promise.resolve(entries.map(()=>({evidence_id:'local-evidence'})));}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},forgetSources: refs=>{try{purges+=refs.length
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}}
  const request=(path:string,body?:unknown):Promise<unknown>=>{try{
   if(path==='identity')return Promise.resolve(hub.identity(pc.token));
   if(path==='authority')return Promise.resolve(hub.authority.snapshot(pc.token));
   if(path==='context')return Promise.resolve(hub.context.snapshot(pc.token));
   if(path==='context/publish')return Promise.resolve(hub.context.publish(pc.token,body));
   if(path==='context/ack')return Promise.resolve(hub.context.acknowledge(pc.token,(body as {cursor:number}).cursor));
   throw Error('unexpected_request')
  }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}
  const bridge=new HubContextBridge(memory,join(root,'bridge.json'),request)
  await bridge.prepare();await bridge.prepare();assert.equal(imports,1)
  await bridge.publish({about:{text:'Concise replies',refs:[{entry_id:'local-evidence',version:'v1'}]},work:[],interests:[]})
  assert.equal(hub.context.snapshot(phone.token).derived?.entries[0]?.text,'Concise replies')
  hub.context.append(phone.token,[event(3,{kind:'correction',key:'about',value:'I prefer detailed replies',provider}),event(4,{kind:'correction',key:'work',value:'I design software',provider}),event(5,{kind:'correction',key:'interests',value:'Private display only'})])
  await assert.rejects(bridge.authorize(),/stale_inputs/)
  await bridge.prepare()
  assert.match(bridge.correctionContext(),/I prefer detailed replies/)
  assert.doesNotMatch(bridge.correctionContext(),/Private display only/)
  assert.equal(bridge.explicitCorrections().interests,undefined)
  const stale={about:{text:'Concise replies',refs:[{entry_id:'local-evidence',version:'v1'}]},work:[{title:'New synonym',text:'Old claim',refs:[{entry_id:'local-evidence',version:'v1'}]}],interests:[]}
  assert.deepEqual(bridge.suppressCorrected(stale),{about:null,work:[],interests:[]})
  await bridge.publish(stale)
  const canonical=hub.context.snapshot(phone.token).derived!
  assert.equal(canonical.entries.find(e=>e.key==='about')?.text,'I prefer detailed replies')
  assert.equal(canonical.entries.find(e=>e.key==='work')?.text,'I design software')
  assert.equal(canonical.entries.some(e=>e.text.includes('Old claim')),false)
  hub.context.deleteSource(phone.token,{source_id:'source',request_id:'forget'})
  await assert.rejects(bridge.publish({about:{text:'Late',refs:[{entry_id:'local-evidence',version:'v1'}]},work:[],interests:[]}),/stale_inputs/)
  await bridge.prepare();assert.equal(purges,1)
  const other=hub.enroll('s','other','desktop');hub.authority.prepare(pc.token,{expected_epoch:1,target_device_id:other.device_id,transition_id:'transfer'})
  await assert.rejects(bridge.authorize(),/authority_transition/)
 }finally{hub.close();await rm(root,{recursive:true,force:true})}
})

test('historical imports preserve occurrence and renew bounded retention only after owner refetch',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'nova-hub-history-'))),hub=new HubStore(':memory:')
 try{
  const phone=hub.enroll('s','phone','mobile'),pc=hub.enroll('s','pc','desktop');hub.authority.initialize(pc.token)
  const provider='https://model.invalid|fixture',now=Date.now(),occurred='2020-01-01T00:00:00.000Z',fetched=new Date(now-1000).toISOString()
  const event=(seq:number,payload:unknown)=>({protocol_version:1,space_id:'s',producer_device_id:phone.device_id,producer_seq:seq,event_id:`h${seq}`,payload})
  const historical={kind:'source_fact',source_id:'source',grant_revision:1,evidence_id:'fact',resource_id:'message',source_version:'v1',text:'Historical plan',relation:'self',occurred_at:occurred,fetched_at:fetched}
  hub.context.append(phone.token,[event(1,{kind:'grant',source_id:'source',revision:1,provider,purpose:'profile',allow_upload:true,allow_processing:true}),event(2,historical)])
  const imports:{sourceId:string;observedAt:string;retentionUntil?:string}[]=[],purged:string[]=[]
  const memory:ContextMemoryPort={sourceProcessingLlm:()=>({baseUrl:'https://model.invalid',model:'fixture',apiKey:'fixture'}),sourceProcessingConsumer:()=> 'provider-fingerprint',recordEvidenceBatch: entries=>{try{imports.push(...entries);return Promise.resolve(entries.map((_,i)=>({evidence_id:`local-${imports.length+i}`})));}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}},forgetSources: refs=>{try{purged.push(...refs)
return Promise.resolve();}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}}
  const bridge=new HubContextBridge(memory,join(root,'bridge.json'),(path,body)=>{try{
   if(path==='identity')return Promise.resolve(hub.identity(pc.token));
   if(path==='authority')return Promise.resolve(hub.authority.snapshot(pc.token));
   if(path==='context')return Promise.resolve(hub.context.snapshot(pc.token));
   if(path==='context/ack')return Promise.resolve(hub.context.acknowledge(pc.token,(body as {cursor:number}).cursor));
   throw Error('unexpected_request')
  }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}})
  await bridge.prepare();await bridge.prepare()
  assert.equal(imports.length,1);assert.equal(imports[0]!.observedAt,occurred)
  assert.equal(imports[0]!.retentionUntil,new Date(Date.parse(fetched)+30*86400000).toISOString())
  const renewed=new Date(now).toISOString()
  hub.context.append(phone.token,[event(3,{...historical,fetched_at:renewed})])
  await bridge.prepare();await bridge.prepare()
  assert.equal(imports.length,2);assert.equal(purged.length,1)
  assert.notEqual(imports[0]!.sourceId,imports[1]!.sourceId)
  assert.equal(imports[1]!.observedAt,occurred)
  assert.equal(imports[1]!.retentionUntil,new Date(now+30*86400000).toISOString())
  hub.context.deleteSource(phone.token,{source_id:'source',request_id:'forget'})
  await bridge.prepare();assert.equal(purged.length,2)
 }finally{hub.close();await rm(root,{recursive:true,force:true})}
})

async function publicationFixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'nova-hub-finish-'))),hub=new HubStore(':memory:')
 const provider='https://model.invalid|fixture',phone=hub.enroll('s','phone','mobile'),pc=hub.enroll('s','pc','desktop')
 hub.authority.initialize(pc.token)
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',sourceProcessingLlm:{baseUrl:'https://model.invalid',apiKey:'fixture'},personalMemoryEnabled:false,gateway:{async *stream(){await Promise.reject(Error('no_model_calls'))}, complete(){try{throw Error('no_model_calls')}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}}})
 let seq=0,publishCalls=0,failure:'before'|'after'|null=null
 const append=(payload:unknown)=>hub.context.append(phone.token,[{protocol_version:1,space_id:'s',producer_device_id:phone.device_id,producer_seq:++seq,event_id:`publish-${seq}`,payload}])
 append({kind:'grant',source_id:'source',revision:1,provider,purpose:'profile',allow_upload:true,allow_processing:true})
 const bridge=new HubContextBridge(memory,join(root,'bridge.json'),(path,body)=>{try{
  if(path==='identity')return Promise.resolve(hub.identity(pc.token));
  if(path==='authority')return Promise.resolve(hub.authority.snapshot(pc.token));
  if(path==='context')return Promise.resolve(hub.context.snapshot(pc.token));
  if(path==='context/ack')return Promise.resolve(hub.context.acknowledge(pc.token,(body as {cursor:number}).cursor));
  if(path==='context/publish'){
   publishCalls++
   if(failure==='before')throw Error('fixture_hub_unavailable')
   const result=hub.context.publish(pc.token,body)
   if(failure==='after')throw Error('fixture_response_lost')
   return Promise.resolve(result);
  }
  throw Error('unexpected_request')
 }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}})
 await memory.open();memory.setSharedContext(bridge)
 const add=async(id:string)=>{append({kind:'source_fact',source_id:'source',grant_revision:1,evidence_id:id,resource_id:id,source_version:'v1',text:`I work on ${id}.`,relation:'self',occurred_at:new Date().toISOString()});await memory.syncSharedContext()}
 const claim=async()=>{
  const batch=await memory.sourceProcessing({action:'claim'}) as ProcessingBatch
  assert.ok(batch)
  const owner={batch_id:batch.id,task_id:'task-'+batch.id,run_id:'run-'+batch.id}
  await memory.sourceProcessing({action:'bind',...owner})
  const originals=await memory.sourceProcessing({action:'read',batch_id:batch.id}) as {items:{evidence_id:string;version:string}[]}
  const refs=originals.items.map(item=>({entry_id:item.evidence_id,version:item.version}))
  return {batch,owner,refs}
 }
 const close=async()=>{await memory.close();hub.close();await rm(root,{recursive:true,force:true})}
 return {memory,hub,phone,provider,append,add,claim,close,setFailure:(value:typeof failure)=>{failure=value},publishCalls:()=>publishCalls}
}

test('products read suppresses an already cached portrait after a shared correction',async()=>{
 const f=await publicationFixture()
 try{
  await f.add('first');const {batch,owner,refs}=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...owner,expected_revision:0,refs:batch.items,draft:{about:{text:'A teacher',refs},work:[],interests:[]}})
  await f.memory.sourceProcessing({action:'commit',...owner,topics:[]})
  f.append({kind:'correction',key:'about',value:'I design software',provider:f.provider});await f.memory.syncSharedContext()
  const products=await f.memory.sourceProcessing({action:'products'}) as {draft:unknown;explicit_corrections:Record<string,{value:string}>}
  assert.equal(products.draft,null)
  assert.equal(products.explicit_corrections.about?.value,'I design software')
 }finally{await f.close()}
})

test('Hub failure leaves finish retryable with the durable draft and no new model work',async()=>{
 const f=await publicationFixture()
 try{
  await f.add('first');const {batch,owner,refs}=await f.claim()
  f.setFailure('before')
  await f.memory.sourceProcessing({action:'publish',...owner,expected_revision:0,refs:batch.items,draft:{about:{text:'Works on first',refs},work:[],interests:[]}})
  assert.equal(f.publishCalls(),0)
  await assert.rejects(f.memory.sourceProcessing({action:'commit',...owner,topics:[]}),/fixture_hub_unavailable/)
  const pending=await f.memory.sourceProcessing({action:'batch',batch_id:batch.id}) as {published:boolean;batch:ProcessingBatch}
  assert.equal(pending.published,true);assert.equal(pending.batch.status,'bound')
  assert.equal(f.hub.context.snapshot(f.phone.token).derived,null)
  f.setFailure(null)
  await f.memory.sourceProcessing({action:'commit',...owner,topics:[]})
  assert.equal((await f.memory.sourceProcessing({action:'batch',batch_id:batch.id}) as {batch:ProcessingBatch}).batch.status,'completed')
  assert.equal(f.hub.context.snapshot(f.phone.token).derived?.entries[0]?.text,'Works on first')
  const calls=f.publishCalls();await f.memory.sourceProcessing({action:'commit',...owner,topics:[]});assert.equal(f.publishCalls(),calls)
 }finally{await f.close()}
})

test('finish retries a lost Hub response against its current authorized revision',async()=>{
 const f=await publicationFixture()
 try{
  await f.add('first');const {batch,owner,refs}=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...owner,expected_revision:0,refs:batch.items,draft:{about:{text:'Works on first',refs},work:[],interests:[]}})
  f.setFailure('after')
  await assert.rejects(f.memory.sourceProcessing({action:'commit',...owner,topics:[]}),/fixture_response_lost/)
  assert.equal(f.hub.context.snapshot(f.phone.token).derived?.revision,1)
  assert.equal((await f.memory.sourceProcessing({action:'batch',batch_id:batch.id}) as {batch:ProcessingBatch}).batch.status,'bound')
  f.setFailure(null)
  await f.memory.sourceProcessing({action:'commit',...owner,topics:[]})
  assert.equal((await f.memory.sourceProcessing({action:'batch',batch_id:batch.id}) as {batch:ProcessingBatch}).batch.status,'completed')
 }finally{await f.close()}
})

test('finish publishes the full merged portrait instead of only the latest batch',async()=>{
 const f=await publicationFixture()
 try{
  await f.add('first');const first=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...first.owner,expected_revision:0,refs:first.batch.items,draft:{about:null,work:[{title:'First',text:'First responsibility',refs:first.refs}],interests:[]}})
  await f.memory.sourceProcessing({action:'commit',...first.owner,topics:[]})
  await f.add('second');const second=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...second.owner,expected_revision:1,refs:second.batch.items,draft:{about:null,work:[{title:'Second',text:'Second responsibility',refs:second.refs}],interests:[]}})
  await f.memory.sourceProcessing({action:'commit',...second.owner,topics:[]})
  const shared=f.hub.context.snapshot(f.phone.token).derived?.entries.find(e=>e.key==='work')?.text
  assert.match(shared??'',/First responsibility/);assert.match(shared??'',/Second responsibility/)
 }finally{await f.close()}
})

test('deferred profile batches do not publish while empty projections do not clear Hub',async()=>{
 const f=await publicationFixture()
 try{
  await f.add('first');const first=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...first.owner,expected_revision:0,refs:first.batch.items,draft:{about:null,work:[],interests:[]}})
  await f.memory.sourceProcessing({action:'commit',...first.owner,topics:[]})
  assert.equal(f.publishCalls(),0)
  await f.add('second');const second=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...second.owner,expected_revision:1,refs:second.batch.items,draft:{about:{text:'Current portrait',refs:second.refs},work:[],interests:[]}})
  await f.memory.sourceProcessing({action:'commit',...second.owner,topics:[]})
  const calls=f.publishCalls()
  await f.add('third');const third=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...third.owner,expected_revision:2,refs:third.batch.items,defer_profile:true,draft:{about:null,work:[],interests:[]}})
  await f.memory.sourceProcessing({action:'commit',...third.owner,topics:[]})
  assert.equal(f.publishCalls(),calls)
  assert.equal(f.hub.context.snapshot(f.phone.token).derived?.entries[0]?.text,'Current portrait')
 }finally{await f.close()}
})


test('a correction scoped to another provider neither hides nor enters the active portrait',async()=>{
 const f=await publicationFixture()
 try{
  await f.add('first');const {batch,owner,refs}=await f.claim()
  await f.memory.sourceProcessing({action:'publish',...owner,expected_revision:0,refs:batch.items,draft:{about:{text:'Active provider portrait',refs},work:[],interests:[]}})
  await f.memory.sourceProcessing({action:'commit',...owner,topics:[]})
  f.append({kind:'correction',key:'about',value:'Other provider correction',provider:'another-provider'});await f.memory.syncSharedContext()
  const products=await f.memory.sourceProcessing({action:'products'}) as {draft:{about:{text:string}};explicit_corrections?:Record<string,unknown>}
  assert.equal(products.draft.about.text,'Active provider portrait')
  assert.equal(products.explicit_corrections?.about,undefined)
 }finally{await f.close()}
})
