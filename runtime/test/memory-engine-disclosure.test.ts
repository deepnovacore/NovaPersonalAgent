import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServer} from 'node:http'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryLedgerClient} from '../src/memory-ledger/store-client.js'
import {ProductionMemoryEngine} from '../src/memory/production-engine.js'
import {initializeMemory,memoryOperation} from '../src/memory-substrate/store.js'

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
async function transport(onRequest:(body:string)=>'fail'|'ok'|Promise<'fail'|'ok'>){
  const requests:string[]=[]
  const server=createServer((req,res)=>{void(async()=>{
    let raw='';for await(const chunk of req)raw+=String(chunk)
    requests.push(raw)
    if(await onRequest(raw)==='fail'){res.writeHead(503,{'retry-after-ms':'350'});res.end('{}');return}
    res.setHeader('content-type','application/json')
    const body=JSON.parse(raw) as {input?:string|string[]}
    res.end(JSON.stringify(req.url==='/v1/embeddings'?{data:(Array.isArray(body.input)?body.input:[body.input]).map((_,index)=>({index,embedding:[1,0]}))}:{choices:[{message:{content:JSON.stringify({memory:[],traits:[],emotion:'sad'})}}]}))
  })().catch(()=>{res.destroy()})})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  return {requests,baseUrl:`http://127.0.0.1:${address.port}/v1`,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())})}
}
const prefix='personal:disclosure:'
const grant={revision:1,scope_revision:0,embedding_provider:'embedding',extraction_provider:'extraction',conversation_providers:['consumer']}
async function seed(client:MemoryLedgerClient,id:string,text:string,retentionUntil?:string,entry=true){
  const now=new Date().toISOString(),ref=prefix+'e:'+id
  await client.memory('append_evidence',{id:ref,source_id:prefix+id,source_kind:'conversation',locator:id,observed_at:now,recorded_at:now,raw_text:text,hash:id,trust:'trusted_user',...(retentionUntil?{retention_until:retentionUntil}:{})})
  await client.memory('source_grant',{source_id:prefix+id,expected_revision:0,grant})
  if(entry)await client.memory('merge',{entry_id:prefix+id,kind:'fact',origin:'stated',written_by:'user_correction',evidence_refs:[ref],content:{text},recorded_at:now})
}
function adapter(client:MemoryLedgerClient,root:string,baseUrl:string,engine:'mem0'|'voicemem',styles=false){return new ProductionMemoryEngine({engine,styles,path:join(root,'engines'),userId:'owner',embedding:{baseUrl,apiKey:'fixture',model:'fixture',dimensions:2},extraction:{baseUrl,apiKey:'fixture'},extractionModel:'fixture'},client,prefix,'embedding','extraction')}

for(const backend of ['mem0','voicemem'] as const)test(`real ${backend} HTTP 503 then revoke cannot retry plaintext`,{timeout:12_000},async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-disclosure-retry-')),failed=deferred(),sentinel='RETRY_PRIVATE_SYNTHETIC'
  const provider=await transport(raw=>{if(raw.includes(sentinel)){failed.resolve();return 'fail'}return 'ok'})
  const client=new MemoryLedgerClient(join(root,'ledger.sqlite')),engine=adapter(client,root,provider.baseUrl,backend,backend==='voicemem')
  try{
    await client.open();await seed(client,'source',sentinel,undefined,backend==='mem0');await engine.open()
    const indexing=engine.flush();const settled=indexing.then(()=>false,()=>true)
    await Promise.race([failed.promise,pause(5000).then(()=>{throw Error('expected SDK HTTP attempt')})])
    await client.memory('source_grant',{source_id:prefix+'source',expected_revision:1,grant:{...grant,revision:2,embedding_provider:null,extraction_provider:null,conversation_providers:[]}})
    assert.equal(await settled,true,'provider failure remains a failed, retryable job')
    await pause(1200)
    assert.equal(provider.requests.filter(raw=>raw.includes(sentinel)).length,1,'no internal SDK backoff retry or later outbox retry may resend revoked plaintext')
  }finally{await engine.close();await client.close();await provider.close();await rm(root,{recursive:true,force:true})}
})

for(const mode of ['mem0-entry','voicemem-entry','voicemem-style'] as const)test(`real ${mode} blocks later send when source expires during earlier provider wait`,{timeout:14_000},async()=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'nova-disclosure-expiry-')),entered=deferred(),release=deferred(),deadline=Date.now()+3500
  const first='EARLIER_PROVIDER_WAIT',expired='EXPIRED_PRIVATE_SYNTHETIC'
  let held=false
  const provider=await transport(async raw=>{if(!held&&raw.includes(first)){held=true;entered.resolve();await release.promise}return 'ok' as const})
  const client=new MemoryLedgerClient(join(root,'ledger.sqlite')),backend=mode==='mem0-entry'?'mem0':'voicemem',styles=mode==='voicemem-style',engine=adapter(client,root,provider.baseUrl,backend,styles)
  try{
    await client.open();await seed(client,'A',first,undefined,!styles);await seed(client,'B',expired,new Date(deadline).toISOString(),!styles);await engine.open()
    const indexing=engine.flush(),settled=indexing.then(()=>false,()=>true)
    await Promise.race([entered.promise,pause(5000).then(()=>{throw Error('expected held SDK request')})])
    assert.equal(engine.flush(),indexing,'second flush must not fake a new claim while provider work is held')
    await pause(Math.max(0,deadline-Date.now()+40));release.resolve()
    assert.equal(await settled,true,'expired owned ticket must fail at the next authorization check')
    for(let n=0;n<10;n++)try{await engine.flush();break}catch(error){if(n===9)throw error;await pause(30)}
    assert.equal(provider.requests.filter(raw=>raw.includes(expired)).length,0,'expired canonical evidence/style source must never reach the provider')
  }finally{release.resolve();await engine.close();await client.close();await provider.close();await rm(root,{recursive:true,force:true})}
})

test('owned unacknowledged ticket expires without another claim and cannot acknowledge',()=>{
  const db=new DatabaseSync(':memory:');initializeMemory(db)
  const ticket={scope:prefix,engine:'fixture'}
  const run=(action:string,extra:Record<string,unknown>={})=>memoryOperation(db,'engine_outbox',{action,...ticket,...extra})
  try{
    run('register')
    const job=run('claim',{embedding:'embedding',extraction:'extraction'}) as {owner:string;generation:number}
    const owner={owner:job.owner,generation:job.generation}
    assert.equal(run('check',owner),true)
    db.prepare('UPDATE memory_engine_outbox SET next_expiry=?').run(Date.now()-1)
    assert.equal(run('check',owner),false,'still-owned ticket expires even with no new claim/generation')
    assert.equal(db.prepare('SELECT generation FROM memory_engine_outbox').get()!.generation,job.generation)
    run('ack',owner)
    assert.equal(run('status'),false,'expired work cannot be acknowledged as current')
  }finally{db.close()}
})
