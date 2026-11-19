import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {RealClock} from '../src/core/clock.js'
import {ConfigurationError,loadSettings,resolveMemoryComposition} from '../src/config/config.js'
import {providerFixture,settle} from './memory-engine-provider-fixture.js'

async function lockFiles(root:string):Promise<string[]>{
  const paths:string[]=[]
  for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())paths.push(...await lockFiles(path));else if(entry.name==='lock.sqlite')paths.push(path)}
  return paths
}

for(const backend of ['mem0','voicemem'] as const)test(`production ${backend}: processing revoke fences still-present SDK candidates and styles`,{timeout:25_000},async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-engine-fencing-')),provider=await providerFixture(),enginePath=join(root,'engines')
  const memory=new SubstrateMemoryResource({client:new MemoryLedgerClient(join(root,'ledger.sqlite')),userId:'owner',gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',inputConsent:true,conversationProviders:['consumer'],embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'embedding',extractionFingerprint:'extraction',consolidation:{enabled:false},engine:{recall:backend,styles:true,consumer:'consumer',config:{path:enginePath,embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}}})
  const locks:DatabaseSync[]=[]
  try{
    await memory.open()
    for(const [sourceId,text] of [['emotion','I am upset today'],['preference','I always prefer concise answers']]){await memory.remember({sourceId:sourceId!,text:text!,sessionId:'session',sequence:1,occurredAt:new Date().toISOString(),confirmed:true});await settle(memory)}
    const before=await memory.recall('answers');assert.ok(before.hits.length);assert.ok(before.contextHits?.length)
    for(const file of await lockFiles(enginePath)){const lock=new DatabaseSync(file);lock.exec('BEGIN IMMEDIATE');locks.push(lock)}
    await memory.setProcessingConsent('emotion',{...memory.processingGrant(true,2),extraction_provider:null})
    await memory.setProcessingConsent('preference',{...memory.processingGrant(true,2),embedding_provider:null})
    const after=await memory.recall('answers')
    assert.deepEqual(after.hits,[],'revoked embedding authority invalidates stale canonical index hits immediately')
    assert.deepEqual(after.contextHits,[],'revoked extraction authority invalidates styles even with conversation consent and pending physical cleanup')
    assert.equal(after.degraded,true,'pending outbox never masquerades as healthy empty recall')
  }finally{for(const lock of locks){lock.exec('ROLLBACK');lock.close()}await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})

test('real settings producer preserves remote loopback and emits credential-free startup metadata',()=>{
  for(const url of ['http://127.0.0.1:9000','http://[::1]:9000','https://memory.example/']){
    const plan=resolveMemoryComposition(loadSettings({MEMORY_CONNECTION:'remote',MEMORY_URL:url,MEMORY_TOKEN:'fixture'}))
    assert.equal(plan.kind,'remote')
  }
  for(const env of [{MEMORY_CONNECTION:'remote',MEMORY_URL:'https://private.invalid?token=SECRET_SENTINEL',MEMORY_TOKEN:'fixture'},{MEMORY_CONNECTION:'remote',MEMORY_URL:'https://memory.example',MEMORY_TOKEN:'SECRET_SENTINEL with whitespace'},{MEMORY_RECALL_ENGINE:'SECRET_SENTINEL'},{MEMORY_EXTRACTORS:'ledger,SECRET_SENTINEL'},{MEMORY_PROVIDER:'mem0',MEMORY_RECALL_ENGINE:'ledger'}]){
    assert.throws(()=>loadSettings(env),(error:unknown)=>{assert.ok(error instanceof ConfigurationError);assert.ok(error.startupConfiguration?.variables.length);assert.ok(!JSON.stringify(error.startupConfiguration).includes('SECRET_SENTINEL'));return true})
  }
})
