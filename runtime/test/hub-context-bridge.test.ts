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
 const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'memory.sqlite')),userId:'fixture',model:'fixture',sourceProcessingLlm:{baseUrl:'https://model.invalid',apiKey:'fixture'},conversationProviders:[consumer,'other'],conversationRecipients:{[consumer]:recipient.provider,other:'https://other.invalid|other'},personalMemoryEnabled:false,gateway:{async *stream(){throw Error('unused')},async complete(request){assert.match(request.system,/I design software/);throw Error('fixture-model-stop')}}})
 try{
  await memory.open()
  const phone=hub.enroll('s','phone','mobile'),pc=hub.enroll('s','pc','desktop');hub.authority.initialize(pc.token)
  const event=(seq:number,payload:unknown)=>({protocol_version:1,space_id:'s',producer_device_id:phone.device_id,producer_seq:seq,event_id:`c${seq}`,payload})
  hub.context.append(phone.token,[event(1,{kind:'grant',source_id:'source',revision:1,provider,purpose:'profile',allow_upload:true,allow_processing:true}),event(2,{kind:'source_fact',source_id:'source',grant_revision:1,evidence_id:'fact',resource_id:'message',source_version:'v1',text:'I used to teach',relation:'self',occurred_at:new Date().toISOString()}),event(3,{kind:'correction',key:'about',value:'I design software',provider})])
  const bridge=new HubContextBridge(memory,join(root,'bridge.json'),async(path,body)=>{
   if(path==='identity')return hub.identity(pc.token)
   if(path==='authority')return hub.authority.snapshot(pc.token)
   if(path==='context')return hub.context.snapshot(pc.token)
   if(path==='context/ack')return hub.context.acknowledge(pc.token,(body as {cursor:number}).cursor)
   if(path==='context/publish')return hub.context.publish(pc.token,body)
   throw Error('unexpected_request')
  })
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
  await assert.rejects(memory.sourceProcessingProfile([{id:first.evidence_id,version:first.version,origin:'inferred',content:'I used to teach',source:{kind:'im',relation:'self',project:'fixture',document:'message'}}],new AbortController().signal,async()=>{}),/fixture-model-stop/)
  await memory.sourceProcessing({action:'publish',batch_id:batch.id,task_id:'task',run_id:'run',expected_revision:0,refs:batch.items,draft:{about:{text:'A teacher',refs:[{entry_id:first.evidence_id,version:first.version}]},work:[],interests:[]}})
  const local=await memory.sourceProcessing({action:'profile'}) as {draft:unknown;explicit_corrections:{about:{value:string}}}
  assert.equal(local.draft,null)
  assert.equal(local.explicit_corrections.about.value,'I design software')
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
  const memory:ContextMemoryPort={sourceProcessingLlm:()=>({baseUrl:'https://model.invalid',model:'fixture',apiKey:'fixture'}),sourceProcessingConsumer:()=> 'provider-fingerprint',recordEvidenceBatch:async entries=>{imports+=entries.length;assert.equal(entries[0]?.embeddingConsent,false);return entries.map(()=>({evidence_id:'local-evidence'}))},forgetSources:async refs=>{purges+=refs.length}}
  const request=async(path:string,body?:unknown):Promise<unknown>=>{
   if(path==='identity')return hub.identity(pc.token)
   if(path==='authority')return hub.authority.snapshot(pc.token)
   if(path==='context')return hub.context.snapshot(pc.token)
   if(path==='context/publish')return hub.context.publish(pc.token,body)
   if(path==='context/ack')return hub.context.acknowledge(pc.token,(body as {cursor:number}).cursor)
   throw Error('unexpected_request')
  }
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
