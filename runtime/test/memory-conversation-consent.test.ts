import {configuredDiscoveryConsumer,configuredMemoryConsumers,configuredTaskVerifierConsumer} from '../src/memory/consumer.js'
import {settingsSchema} from '../src/config/config.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {ModelGateway} from '../src/model/model-gateway.js'
const gateway:ModelGateway={async *stream(){ /* complete only */ },complete(){return Promise.resolve({text:JSON.stringify({entries:[{key:'spicy',text:'我不吃辣',topic:'饮食',kind:'preference',due:null,direction:null,status:null,valid_until:null}]})})}}
const now=()=>new Date().toISOString()

test('actual conversation recipients require separate grants and fresh preparation observes revocation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-conversation-consent-')),client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'scope',gateway,model:'extractor',inputConsent:true,conversationProviders:['consumer-a','consumer-b']})
 try{
  await resource.open();await resource.remember({sourceId:'one',sessionId:'fixture',sequence:1,text:'我不吃辣',occurredAt:now(),confirmed:true});await resource.flush()
  assert.deepEqual(resource.processingGrant(true).conversation_providers,['consumer-a','consumer-b'])
  await resource.setProcessingConsent('one',{...resource.processingGrant(true,2),conversation_providers:['consumer-a']})
  const allowed=await resource.prepareResponseAdaptation('consumer-a');assert.ok(allowed.memoryContext?.voice.includes('我不吃辣'));assert.equal(allowed.replyPreferences.length,1)
  const denied=await resource.prepareResponseAdaptation('consumer-b');assert.equal(denied.memoryContext?.voice,'');assert.equal(denied.replyPreferences.length,0)
  assert.equal((await resource.prepareResponseAdaptation('extractor')).memoryContext?.voice,'','extraction consent is never conversation consent')
  // Simulate revocation by another already-open client; the synchronous cache has not been notified.
  await client.memory('source_grant',{source_id:resource.prefix+'one',expected_revision:2,grant:{...resource.processingGrant(true,3),conversation_providers:[]}})
  assert.equal((await resource.prepareResponseAdaptation('consumer-a')).memoryContext?.voice,'')
  const controller=new AbortController();controller.abort();await assert.rejects(resource.prepareResponseAdaptation('consumer-a',controller.signal),/abort/i)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

for(const revokeBeforeEdit of [false,true])test(`send-time preparation reconciles hand edits without leaking old or ungranted content (revoked=${revokeBeforeEdit})`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-conversation-hand-edit-')),path=join(root,'memory.sqlite'),client=new MemoryLedgerClient(path),resource=new SubstrateMemoryResource({client,userId:'edit',gateway,model:'extractor',inputConsent:true,conversationProviders:['consumer-a']})
 try{
  await resource.open();await resource.remember({sourceId:'one',sessionId:'fixture',sequence:1,text:'我不吃辣',occurredAt:now(),confirmed:true});await resource.flush()
  assert.ok((await resource.prepareResponseAdaptation('consumer-a')).memoryContext?.voice.includes('我不吃辣'))
  if(revokeBeforeEdit)await client.memory('source_grant',{source_id:resource.prefix+'one',expected_revision:1,grant:{...resource.processingGrant(true,2),conversation_providers:[]}})
  const directory=join(path+'.memory','entries'),file=join(directory,(await readdir(directory))[0]!),text=await readFile(file,'utf8'),at=text.lastIndexOf('我不吃辣')
  await writeFile(file,text.slice(0,at)+'现在可以吃微辣'+text.slice(at+'我不吃辣'.length))
  const fresh=await resource.prepareResponseAdaptation('consumer-a');assert.ok(!fresh.memoryContext?.voice.includes('我不吃辣'))
  if(revokeBeforeEdit)assert.equal(fresh.memoryContext?.voice,'');else{assert.ok(fresh.memoryContext?.voice.includes('现在可以吃微辣'));assert.match(fresh.memoryContext!.voice,/revision=2(?:;|\])/)}
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('manual corrections inherit only the intersection of current source destinations',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{initializeMemory,memoryOperation}=await import('../src/memory-substrate/store.js'),{correctionProcessingGrant}=await import('../src/memory-substrate/source-state.js')
 const db=new DatabaseSync(':memory:');initializeMemory(db)
 try{
  const grant=(providers:string[])=>({revision:1,scope_revision:0,extraction_provider:'extractor',embedding_provider:null,conversation_providers:providers})
  memoryOperation(db,'source_grant',{source_id:'first',expected_revision:0,grant:grant(['consumer-a','consumer-b'])})
  memoryOperation(db,'source_grant',{source_id:'second',expected_revision:0,grant:grant(['consumer-b','consumer-c'])})
  assert.deepEqual(correctionProcessingGrant(db,['first','second']),grant(['consumer-b']))
  assert.equal(correctionProcessingGrant(db,['first','not-granted']),null)
  memoryOperation(db,'source_grant',{source_id:'second',expected_revision:1,grant:{...grant([]),revision:2,extraction_provider:null}})
  assert.equal(correctionProcessingGrant(db,['first','second']),null)
 }finally{db.close()}
})


test('discovery consumer follows the actual support route and is included in admission grants',()=>{
 const legacy=settingsSchema.parse({executors:[],dashscope_api_key:'test',support_model:'legacy-support'})
 const configured=settingsSchema.parse({...legacy,openai_compatible_base_url:'https://example.invalid/v1',openai_compatible_api_key:'test',model_routes:{support:{provider:'openai-compatible',model:'routed-support'}}})
 const consumer=configuredDiscoveryConsumer(configured)!
 assert.ok(consumer)
 assert.ok(configuredMemoryConsumers(configured).includes(consumer))
 assert.ok(consumer===configuredTaskVerifierConsumer(configured),'verification and discovery use the same routed support destination')
 assert.ok(configuredDiscoveryConsumer(legacy)===configuredTaskVerifierConsumer(legacy))
 for(const overrides of [{openai_compatible_base_url:'https://other.invalid/v1'},{model_routes:{support:{provider:'openai-compatible',model:'changed-support'}}}]){
  assert.ok(configuredDiscoveryConsumer(settingsSchema.parse({...configured,...overrides}))!==consumer,'endpoint or model changes require a new grant')
 }
})

test('ledger host discovery, evidence citations, delivered feed and expired-history preference retain existing behavior',async()=>{
 const {PersonalAgentHost}=await import('../src/personal-agent/host.js'),{SuggestionPool}=await import('../src/core/suggestions.js'),{UnifiedRetrieval}=await import('../src/memory/retrieval.js')
 const root=await mkdtemp(join(tmpdir(),'nova-ledger-host-control-')),client=new MemoryLedgerClient(join(root,'memory.sqlite')),resource=new SubstrateMemoryResource({client,userId:'scope',gateway,model:'extractor',inputConsent:true,conversationProviders:['consumer-a']})
 let consumer='consumer-a'
 const host=new PersonalAgentHost({path:join(root,'host.json'),userScope:'scope',memory:()=>resource,pool:new SuggestionPool(),evidence:()=>null,discoveryMemoryConsumer:()=>consumer})
 host.setRetrieval(new UnifiedRetrieval({memory:()=>resource}))
 try{
  await resource.open();await resource.remember({sourceId:'control',sessionId:'fixture',sequence:1,text:'我不吃辣',occurredAt:now(),confirmed:true});await resource.flush();await host.open()
  assert.equal(host.snapshot().capabilities.memory.includeExpired,true)
  await host.refreshMemory(undefined,100,true);await host.refreshMemory()
  assert.equal(host.snapshot().memory.include_expired,true)
  const snapshot=await host.discoverySnapshot(),entry=snapshot.memory[0]!,ref=entry.evidence_refs![0]!
  assert.equal(await host.admit({kind:'notify',summary:'Control',why_now:'Control reminder',evidence_refs:[ref],memory_refs:[{entry_id:entry.id,version:entry.version}]},{...snapshot,evidence_refs:[ref]}),'admitted')
  await host.action({id:host.snapshot().feed[0]!.id,action:'presented'})
  const before=await host.discoverySnapshot(),dailyBefore=await host.dailyBriefSnapshot()
  consumer='consumer-b'
  assert.deepEqual((await host.discoverySnapshot()).recent_delivery,before.recent_delivery)
  assert.deepEqual((await host.dailyBriefSnapshot()).recent_delivery,dailyBefore.recent_delivery)
  assert.deepEqual((await host.discoverySnapshot()).memory,before.memory)
  await host.revalidate();assert.equal(host.snapshot().feed[0]!.lifecycle,'active')
 }finally{await host.close();await resource.close();await rm(root,{recursive:true,force:true})}
})
