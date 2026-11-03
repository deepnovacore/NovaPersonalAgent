import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Worker} from 'node:worker_threads'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerStore} from '../src/memory-ledger/store.js'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {emptyLifeState} from '../src/personal-agent/life.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

const gateway:ModelGateway={async *stream(){await Promise.reject(Error('no model expected'))},complete(){throw Error('no model expected')}}

test('Life authorization revision uses one readonly compact SQL snapshot without projections or file work',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-life-revision-read-'))
  const database=new DatabaseSync(join(root,'ledger.sqlite'))
  const store=new MemoryLedgerStore(join(root,'ledger.sqlite'),()=>database)
  try{
    store.open()
    const prepare=database.prepare.bind(database),queries:string[]=[]
    t.mock.method(database,'prepare',(sql:string)=>{queries.push(sql);return prepare(sql)})
    t.mock.method(database,'exec',()=>{throw Error('authorization revision must not execute writes or transactions')})
    t.mock.method(store,'withMemoryFilesLock',()=>{throw Error('authorization revision must not acquire file locks')})
    const before=store.lifeAuthorizationRevision('personal:owner:life:')
    assert.deepEqual(store.lifeAuthorizationRevision('personal:owner:life:'),before)
    assert.equal(queries.length,2)
    for(const sql of queries){assert.match(sql,/^SELECT/u);assert.match(sql,/json_extract\(payload_json,'\$\.revision'\)/u);assert.ok(!/memory_revisions|memory_evidence|expire/iu.test(sql))}
    t.mock.restoreAll()
  }finally{t.mock.restoreAll();store.close();await rm(root,{recursive:true,force:true})}
})

test('Life authorization token is stable for reads/publication and changes for real second-client Life/grant updates',async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-life-revision-shared-')),path=join(root,'ledger.sqlite')
  const client=new MemoryLedgerClient(path),otherClient=new MemoryLedgerClient(path)
  const create=(ledger:MemoryLedgerClient)=>new SubstrateMemoryResource({client:ledger,userId:'owner',gateway,model:'fixture',inputConsent:true,conversationProviders:['consumer']})
  const first=create(client),second=create(otherClient)
  try{
    await first.open({deferBackground:true});await second.open({deferBackground:true})
    const backend=first.lifeBackend(),other=second.lifeBackend()
    const revision=()=>backend.authorizationRevision!()
    const absent=await revision();assert.match(absent,/^[a-f0-9]{64}$/u)
    assert.equal(await revision(),absent)
    const initial=await backend.load(emptyLifeState())
    const loaded=await revision();assert.notEqual(loaded,absent,'namespace meta initialization is authoritative')
    await backend.peek!();await backend.peek!()
    await client.memory('source_grant',{action:'get',source_id:first.prefix+'missing'})
    await client.memory('engine_outbox',{action:'register',scope:first.prefix,engine:'publication'})
    const job=await client.memory('engine_outbox',{action:'claim',scope:first.prefix,engine:'publication',embedding:'embedding',extraction:'extraction'}) as {owner:string;generation:number}
    await client.memory('engine_outbox',{action:'ack',scope:first.prefix,engine:'publication',owner:job.owner,generation:job.generation})
    assert.equal(await revision(),loaded,'reads and outbox publication do not advance authority')
    await other.mutate({input:{op:'create',kind:'todo',title:'Synthetic authorization item'},requestId:'create',expectedRevision:initial.revision})
    const mutated=await revision();assert.notEqual(mutated,loaded,'second-client Life mutation invalidates next token')
    await second.setProcessingConsent('source',second.processingGrant(true,1))
    const granted=await revision();assert.notEqual(granted,mutated)
    await second.setProcessingConsent('source',second.processingGrant(false,2))
    const revoked=await revision();assert.notEqual(revoked,granted,'second-client grant revoke invalidates next token')
    await second.setProcessingConsent('source',second.processingGrant(false,2))
    assert.equal(await revision(),revoked,'replayed/no-op consent does not invalidate')
    await assert.rejects(backend.authorizationRevision!(AbortSignal.abort()),{code:'REQUEST_ABORTED'})
    assert.equal(await revision(),revoked,'cancelled readonly token does not invalidate')
  }finally{await first.close();await second.close();await rm(root,{recursive:true,force:true})}
})

test('Life authorization token fences session-consent loss and real worker replacement', {timeout:15_000},async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-life-revision-session-')),path=join(root,'ledger.sqlite')
  let worker:Worker|undefined
  const client=new MemoryLedgerClient(path,{workerFactory:(url,options)=>{worker=new Worker(url,options);return worker}})
  const memory=new SubstrateMemoryResource({client,userId:'owner',gateway,model:'fixture',inputConsent:true,conversationProviders:['consumer']})
  try{
    await memory.open({deferBackground:true})
    const revision=()=>memory.lifeBackend().authorizationRevision!(),grant=memory.processingGrant(true)
    const initial=await revision()
    await memory.feishuProcessingConsent('activate',[],grant)
    const active=await revision();assert.notEqual(active,initial,'session activation changes the compact token')
    await memory.feishuProcessingConsent('activate',[],grant)
    assert.equal(await revision(),active,'identical session activation is a no-op')
    await memory.feishuProcessingConsent('suspend',[],grant)
    const suspended=await revision();assert.notEqual(suspended,active,'session consent loss changes the token')
    await memory.feishuProcessingConsent('suspend',[],grant)
    assert.equal(await revision(),suspended,'suspending an absent session does not auto-advance')
    await worker!.terminate()
    let reopened:string|undefined
    for(let attempt=0;attempt<100;attempt++)try{reopened=await revision();break}catch{await new Promise(resolve=>setTimeout(resolve,20))}
    assert.ok(reopened);assert.notEqual(reopened,suspended,'worker replacement fences even without persistent changes or active session consent')
    assert.equal(await revision(),reopened,'unchanged replacement worker returns a stable token')
    await memory.feishuProcessingConsent('activate',[],grant)
    const reactivated=await revision()
    await worker!.terminate()
    let lost:string|undefined
    for(let attempt=0;attempt<100;attempt++)try{lost=await revision();break}catch{await new Promise(resolve=>setTimeout(resolve,20))}
    assert.ok(lost);assert.notEqual(lost,reactivated,'replacement also discards actual TEMP consent')
  }finally{await memory.close();await rm(root,{recursive:true,force:true})}
})
