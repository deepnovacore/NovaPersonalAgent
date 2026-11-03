import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'

interface Batch {id:string;items:{evidence_id:string;stamp:string;start:number;end:number}[]}

test('supported product deletion and different revision-one recreation cannot reuse an authority token',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-product-aba-')),path=join(root,'ledger.sqlite'),first=new MemoryLedgerClient(path),second=new MemoryLedgerClient(path),prefix='personal:owner:',provider='fixture-provider'
  const revision=()=>first.lifeAuthorizationRevision(prefix+'life:')
  const process=(request:Record<string,unknown>,participants=true)=>second.memory('source_processing',{prefix,provider,participants,...request})
  let observer:DatabaseSync|undefined
  try{
    await first.open();await second.open();observer=new DatabaseSync(path)
    const now=new Date().toISOString(),id=prefix+'e:product'
    await second.memory('append_evidence',{id,source_id:prefix+'source:product',source_kind:'file',locator:'fixture',raw_text:'Synthetic project planning',hash:'product-version',observed_at:now,recorded_at:now,trust:'untrusted_external'})
    await second.memory('source_grant',{source_id:prefix+'source:product',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
    const batch=await process({action:'claim'}) as Batch;assert.ok(batch)
    const owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
    await process({action:'bind',...owner});await process({action:'read',batch_id:batch.id})
    const refs=[{entry_id:id,version:'product-version'}],draft={about:{text:'Original synthetic project',refs},work:[],interests:[]}
    const publish={action:'publish',...owner,expected_revision:0,draft,refs:batch.items,products:{projects:[],suggestions:[]}}
    assert.deepEqual(await process(publish),{applied:true,revision:1})
    const before=await revision(),pairs=observer.prepare('SELECT provider,revision FROM processing_profiles WHERE prefix=? ORDER BY provider').all(prefix)
    const epoch=observer.prepare('SELECT value FROM recall_authority_epoch WHERE slot=1').get()!.value
    await process({action:'status'},false)
    await process({action:'status'},true)
    const replacement={...publish,draft:{...draft,about:{...draft.about,text:'Different synthetic project'}}}
    assert.deepEqual(await process(replacement),{applied:true,revision:1})
    assert.deepEqual(observer.prepare('SELECT provider,revision FROM processing_profiles WHERE prefix=? ORDER BY provider').all(prefix),pairs,'current provider/revision pairs reproduce the ABA state')
    const after=await revision()
    assert.notEqual(after,before,'no intermediate authority read is required to detect deletion/recreation')
    assert.ok(Number(observer.prepare('SELECT value FROM recall_authority_epoch WHERE slot=1').get()!.value)>Number(epoch),'persistent authority survives product deletion')
    await process(replacement);await process({action:'products'});await process({action:'status'})
    assert.equal(await revision(),after,'same-version replay and ordinary reads remain stable')
    observer.prepare('UPDATE processing_profiles SET revision=revision,payload_json=payload_json WHERE prefix=?').run(prefix)
    assert.equal(await revision(),after,'older-writer no-op updates do not churn authority')
  }finally{observer?.close();await first.close();await second.close();await rm(root,{recursive:true,force:true})}
})
