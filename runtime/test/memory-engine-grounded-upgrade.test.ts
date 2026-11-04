import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {mkdtemp,rm,readdir,readFile,rename} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {DashScopeEmbeddingProvider} from '../src/knowledge/embeddings.js'
import {OpenAIModelGateway} from '../src/model/model-gateway.js'
import {RealClock} from '../src/core/clock.js'
import {providerFixture,settle} from './memory-engine-provider-fixture.js'

const original='我一贯更喜欢简洁直接的回答，这是一项长期沟通偏好。'
async function files(root:string):Promise<string[]>{
  const result:string[]=[]
  for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())result.push(...await files(path));else result.push(path)}
  return result
}

test('production grounded styles: old protocol retirement, backfill, revoke, expiry and forget survive restart',{timeout:60_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'grounded-upgrade-')),provider=await providerFixture(),path=join(root,'ledger.sqlite'),enginePath=join(root,'engines')
  const config={path:enginePath,embedding:{baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl:provider.baseUrl,apiKey:'fixture'},extractionModel:'fixture'}
  const create=()=>new SubstrateMemoryResource({client:new MemoryLedgerClient(path),userId:'owner',gateway:new OpenAIModelGateway({baseUrl:provider.baseUrl,apiKey:'fixture',clock:new RealClock()}),model:'fixture',inputConsent:true,conversationProviders:['consumer'],embedding:new DashScopeEmbeddingProvider({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dims:2}),embeddingFingerprint:'embedding',extractionFingerprint:'extraction',consolidation:{enabled:false},engine:{recall:'voicemem',styles:true,consumer:'consumer',config}})
  let memory=create()
  const traits=async()=> (await memory.recall('answers')).contextHits?.filter(hit=>hit.kind==='trait')??[]
  try{
    await memory.open()
    for(let n=1;n<=3;n++){
      await memory.remember({sourceId:'standing-'+n,text:original,sessionId:'same-session',sequence:1,occurredAt:new Date().toISOString(),confirmed:true});await settle(memory)
      assert.equal((await traits()).length,n<3?0:2)
    }
    assert.deepEqual((await memory.list()).entries,[],'derived SDK style is not a ledger fact')
    const before=provider.counts().extractions
    await memory.close()
    // Recreate the pre-protocol configuration identity and unsupported legacy payload
    // in a fully owned SDK store; no shared dependency or human correction is used.
    const legacyKey=createHash('sha256').update(JSON.stringify([config.path,'voicemem',true,config.embedding.baseUrl,config.embedding.model,config.embedding.dimensions,config.extraction.baseUrl,config.extractionModel])).digest('hex')
    const ledger=new DatabaseSync(path),oldRow=ledger.prepare("SELECT engine FROM memory_engine_outbox WHERE retired=0").get()!
    assert.notEqual(oldRow.engine,legacyKey,'semantic protocol changes identity')
    ledger.prepare('UPDATE memory_engine_outbox SET engine=? WHERE engine=?').run(legacyKey,String(oldRow.engine));ledger.close()
    const sdkPath=(await files(enginePath)).find(file=>file.endsWith('/voicemem.sqlite'))!
    const legacyDir=join(dirname(dirname(sdkPath)),legacyKey)
    await rename(dirname(sdkPath),legacyDir)
    const sdk=new DatabaseSync(join(legacyDir,'voicemem.sqlite'))
    const sentinel='UNSUPPORTED_LEGACY_ORDERING_SENTINEL'
    for(const row of sdk.prepare("SELECT id,payload FROM vm_memories WHERE json_extract(payload,'$.kind')='trait'").all()){
      const record=JSON.parse(String(row.payload)) as {text:string;attribute:string;replyPreference?:unknown}
      record.text=sentinel;record.attribute='reply_preference';delete record.replyPreference
      sdk.prepare('UPDATE vm_memories SET payload=? WHERE id=?').run(JSON.stringify(record),String(row.id))
    }
    sdk.close()
    memory=create();await memory.open();await settle(memory)
    const rebuilt=await traits()
    assert.deepEqual(rebuilt.map(hit=>hit.text).sort(),['Prefers brief replies','Prefers direct replies'])
    assert.ok(provider.counts().extractions>=before+3,'manifested legacy sources are reprocessed under new identity')
    for(const file of await files(legacyDir))assert.ok(!(await readFile(file)).includes(Buffer.from(sentinel)),'legacy unsupported payload physically erased')
    const retired=new DatabaseSync(path)
    assert.equal(retired.prepare('SELECT retired,completed=generation AS done FROM memory_engine_outbox WHERE engine=?').get(legacyKey)?.retired,1)
    assert.equal(retired.prepare('SELECT completed=generation AS done FROM memory_engine_outbox WHERE engine=?').get(legacyKey)?.done,1)
    retired.close()
    await memory.setProcessingConsent('standing-1',memory.processingGrant(false,2));await settle(memory)
    assert.deepEqual(await traits(),[],'one revoked source drops both claims below three')
    await memory.close();memory=create();await memory.open();await settle(memory);assert.deepEqual(await traits(),[],'revoke persists across restart')
    await memory.setProcessingConsent('standing-1',memory.processingGrant(true,3));await settle(memory)
    assert.equal((await traits()).length,2,'current authorization can reprocess still-live evidence')
    await memory.close()
    const expired=new DatabaseSync(path)
    for(const row of expired.prepare('SELECT id,payload_json FROM memory_evidence').all()){
      const evidence=JSON.parse(String(row.payload_json)) as {source_id:string;retention_until:string}
      if(evidence.source_id.endsWith('standing-2')){evidence.retention_until=new Date(Date.now()-1).toISOString();expired.prepare('UPDATE memory_evidence SET payload_json=? WHERE id=?').run(JSON.stringify(evidence),String(row.id))}
    }
    expired.close()
    memory=create();await memory.open();await settle(memory);assert.deepEqual(await traits(),[],'expired evidence cannot revive SDK support on restart')
    await memory.forgetSource('standing-3');await settle(memory)
    await memory.close();memory=create();await memory.open();await settle(memory);assert.deepEqual(await traits(),[],'forget/restart cannot resurrect old or expired claims')
  }finally{await memory.close();await provider.close();await rm(root,{recursive:true,force:true})}
})
