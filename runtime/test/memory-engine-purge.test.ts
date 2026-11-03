import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {RealClock} from '../src/core/clock.js'
import {providerFixture,settle} from './memory-engine-provider-fixture.js'

async function ownedFiles(root:string):Promise<string[]>{
  const files:string[]=[]
  for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())files.push(...await ownedFiles(path));else if(entry.isFile())files.push(path)}
  return files
}
async function containsSentinel(root:string,sentinel:string):Promise<boolean>{
  for(const file of await ownedFiles(root))if((await readFile(file)).includes(Buffer.from(sentinel)))return true
  return false
}

for(const backend of ['mem0','voicemem'] as const)test(`production ${backend}: retired index reactivation and physical purge acknowledgement`,{timeout:45_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'nova-engine-purge-')),provider=await providerFixture(),path=join(root,'ledger.sqlite'),enginePath=join(root,'engines'),sentinel='PURGE_SENTINEL_'+backend.toUpperCase()
  const create=(recall:'mem0'|'voicemem'|'ledger')=>new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'owner',gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',inputConsent:true,conversationProviders:['consumer'],embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'embedding',extractionFingerprint:'extraction',consolidation:{enabled:false},engine:{recall,styles:recall!=='ledger',consumer:'consumer',config:{path:enginePath,embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}}})
  let memory=create(backend)
  const locks:DatabaseSync[]=[]
  try{
    await memory.open();await memory.remember({sourceId:'source',sessionId:'session',sequence:1,text:'I always prefer concise answers '+sentinel,occurredAt:new Date().toISOString(),confirmed:true});await settle(memory)
    const row=(await memory.list()).entries[0]!
    assert.ok(row.content.includes(sentinel))
    assert.equal(await containsSentinel(enginePath,sentinel),true,'real SDK/manifest files contain synthetic indexed source before erasure')
    await memory.close();memory=create('ledger');await memory.open();await settle(memory)
    assert.equal(await containsSentinel(enginePath,sentinel),false,'retired SDK paths are erased and compacted, not merely hidden')
    await memory.close();memory=create(backend);await memory.open();await settle(memory)
    assert.ok((await memory.recall('answers')).hits.some(hit=>hit.memoryId===row.id),'VoiceMem tombstones do not prevent reactivation/backfill')
    assert.equal(await containsSentinel(enginePath,sentinel),true)
    for(const file of (await ownedFiles(enginePath)).filter(path=>path.endsWith('/lock.sqlite'))){const lock=new DatabaseSync(file);lock.exec('BEGIN IMMEDIATE');locks.push(lock)}
    const purge=await memory.purgeEntry(row.id,row.version,'physical-purge')
    assert.equal(purge.status,'incomplete','purge must not acknowledge while engine write/compaction is blocked')
    assert.ok(purge.backup_cleanup.unresolved.includes('memory_engine_cleanup_pending'))
    const before=await memory.completePurgeIndex(row.id,purge.operation_id)
    assert.equal(before.status,'incomplete','knowledge completion cannot waive SDK erasure')
    for(const lock of locks){lock.exec('ROLLBACK');lock.close()}locks.length=0
    await settle(memory)
    assert.deepEqual(await memory.pendingPurges(),[],'durable engine acknowledgement resolves pending purge receipt')
    assert.equal((await memory.completePurgeIndex(row.id,purge.operation_id)).status,'complete')
    assert.equal(await containsSentinel(enginePath,sentinel),false,'successful purge leaves no sentinel in owned SDK, state, journal or WAL files')
    await memory.close();memory=create(backend);await memory.open();await settle(memory)
    assert.deepEqual((await memory.recall('answers')).hits,[])
    assert.equal(await containsSentinel(enginePath,sentinel),false,'erasure survives restart without refeeding forgotten sources')
  }finally{for(const lock of locks){lock.exec('ROLLBACK');lock.close()}await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})
