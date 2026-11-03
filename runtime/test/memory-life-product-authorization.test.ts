import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'

interface Batch {id:string;items:{evidence_id:string;stamp:string;start:number;end:number}[]}

test('second-client product publication/update/delete invalidates compact authority; reads and replay do not',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-product-authorization-')),path=join(root,'ledger.sqlite'),first=new MemoryLedgerClient(path),second=new MemoryLedgerClient(path),prefix='personal:owner:',namespace=prefix+'life:',provider='fixture-provider'
  const revision=()=>first.lifeAuthorizationRevision(namespace)
  const process=(request:Record<string,unknown>,participants=true)=>second.memory('source_processing',{prefix,provider,participants,...request})
  try{
    await first.open();await second.open()
    const now=new Date().toISOString(),id=prefix+'e:product'
    await second.memory('append_evidence',{id,source_id:prefix+'source:product',source_kind:'file',locator:'fixture',raw_text:'Synthetic project planning',hash:'product-version',observed_at:now,recorded_at:now,trust:'untrusted_external'})
    await second.memory('source_grant',{source_id:prefix+'source:product',expected_revision:0,grant:{revision:1,scope_revision:0,extraction_provider:provider,embedding_provider:null,conversation_providers:[]}})
    const batch=await process({action:'claim'}) as Batch;assert.ok(batch)
    const owner={batch_id:batch.id,task_id:'task:'+batch.id,run_id:'run:'+batch.id}
    await process({action:'bind',...owner});await process({action:'read',batch_id:batch.id})
    const before=await revision(),refs=[{entry_id:id,version:'product-version'}],draft={about:{text:'Synthetic project',refs},work:[],interests:[]}
    const publish={action:'publish',...owner,expected_revision:0,draft,refs:batch.items,products:{projects:[],suggestions:[{id:'review',kind:'action',title:'Review project',body:'Review it',project_id:null,todo_id:null,due:null,refs}]}}
    await process(publish)
    const published=await revision();assert.notEqual(published,before,'new provider publication changes token without Life/epoch changes')
    await process(publish);assert.equal(await revision(),published,'same publication/version replay is stable')
    await process({action:'products'});await process({action:'status'})
    assert.equal(await revision(),published,'ordinary profile/product reads are stable')
    await process({...publish,expected_revision:1,draft:{...draft,about:{...draft.about,text:'Updated synthetic project'}}})
    const updated=await revision();assert.notEqual(updated,published,'next provider revision changes token')
    await process({action:'status'},false)
    const deleted=await revision();assert.notEqual(deleted,updated,'supported participant-policy cleanup deletes publication metadata')
    await process({action:'status'},false);assert.equal(await revision(),deleted,'unchanged empty metadata is stable')
  }finally{await first.close();await second.close();await rm(root,{recursive:true,force:true})}
})
