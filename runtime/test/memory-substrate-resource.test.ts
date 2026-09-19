import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,stat,writeFile,symlink,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkspaceGraphStoreClient} from '../src/workspace-graph/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import type {ModelGateway} from '../src/model/model-gateway.js'

test('external ingestion without processing consent stays local even with conversation consent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-no-processing-'));let calls=0
 const gateway:ModelGateway={async *stream(){},complete(){calls++;return Promise.resolve({text:'{"entries":[]}'})}}
 const resource=new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(join(root,'memory.sqlite')),userId:'test',gateway,model:'fixture',inputConsent:true})
 try{
  await resource.open();await resource.ingestEvidence({sourceId:'old-im',locator:'one',text:'周五交报告',observedAt:new Date().toISOString(),kind:'im',embeddingConsent:true})
  await resource.flush();assert.equal(calls,0)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('revocation survives late admission and provider changes require fresh processing consent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-revoke-processing-'));const path=join(root,'memory.sqlite');let calls=0
 const gateway:ModelGateway={async *stream(){},complete(){calls++;return Promise.resolve({text:'{"entries":[]}'})}}
 let resource=new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(path),userId:'test',gateway,model:'fixture',extractionFingerprint:'provider-a'})
 try{
  await resource.open();const grant=resource.processingGrant(true)
  const input={sourceId:'im',locator:'one',text:'第一条',observedAt:new Date().toISOString(),kind:'im' as const,processingConsent:grant}
  await resource.ingestEvidence(input);await resource.flush();assert.equal(calls,1)
  await resource.setProcessingConsent('im',resource.processingGrant(false,2))
  await resource.ingestEvidence({...input,locator:'two',text:'撤销后的条目'});await resource.flush();assert.equal(calls,1)
  await resource.close();resource=new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(path),userId:'test',gateway,model:'fixture',extractionFingerprint:'provider-b'})
  await resource.open();await resource.ingestEvidence({...input,locator:'three',text:'新服务商'});await resource.flush();assert.equal(calls,1)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('substrate resource keeps identity, correction, restart and source deletion on worker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-substrate-'));const path=join(root,'memory.sqlite')
 let calls=0
 const gateway:ModelGateway={async *stream(){ /* unused by extraction */ },complete(){calls++;return Promise.resolve({text:JSON.stringify({entries:[{key:'weekly-report',text:'周五交报告',topic:'报告',kind:'commitment',due:'2026-09-18T10:00:00Z',direction:'owed_by_me',status:'open',valid_until:null}]})})}}
 let resource=new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(path),userId:'test',gateway,model:'test'})
 try{
  await resource.open()
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'chat:one',locator:'message:one',text:'我周五给你报告',observedAt:'2026-09-12T10:00:00Z',kind:'im',senderId:'sender',accountId:'account'})
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'chat:one',locator:'message:one',text:'我周五给你报告',observedAt:'2026-09-12T10:00:00Z',kind:'im',senderId:'sender',accountId:'account'})
  await resource.flush()
  assert.equal(calls,1,'completed evidence does not repeat extraction')
  const first=(await resource.list()).entries[0]!;assert.equal(first.kind,'commitment');assert.equal(first.commitment?.status,'open');assert.equal(first.origin,'inferred');assert.equal(first.version,1)
  assert.ok(first.commitment?.counterparty?.startsWith(resource.prefix+'person:'))
  assert.equal(first.evidence_refs?.length,1)
  assert.equal((await resource.readEvidence(first.evidence_refs[0]!))?.locator,'message:one')
  assert.ok(first.source_refs.length,'legacy source references remain available')
  await resource.reextract(first.id);assert.equal(calls,2);assert.equal((await resource.get(first.id))?.version,1,'equivalent re-extraction does not append revisions')
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'expired',locator:'expired',text:'旧消息',observedAt:'2020-01-01T00:00:00Z',kind:'im',retentionUntil:'2020-02-01T00:00:00Z'});await resource.flush();assert.equal(calls,2,'expired raw text never reaches the model')
  const corrected=await resource.correct(first.id,first.version,'改到下周一交报告',{type:'conversation',ref:'correction:one',observed_at:'2026-09-12T11:00:00Z'})
  assert.equal(corrected.entry.commitment?.due,null,'free-text correction must not retain a stale parsed deadline')
  assert.equal(corrected.entry.id,first.id);assert.equal(corrected.entry.version,2);assert.equal(corrected.entry.origin,'stated')
  await assert.rejects(resource.correct(first.id,1,'旧修改',{type:'conversation',ref:'correction:stale',observed_at:'2026-09-12T11:00:00Z'}),/CONFLICT/)
  await resource.forgetSource('chat:one');assert.equal((await resource.list()).entries[0]?.content,'改到下周一交报告')
  await resource.close();resource=new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(path),userId:'test',gateway,model:'test'});await resource.open()
  await resource.flush();assert.equal(calls,2,'correction evidence is never extracted after restart')
  assert.equal((await resource.get(first.id))?.version,2)
  await resource.forgetEntry(first.id,2);assert.equal((await resource.list()).entries.length,0)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})


test('shared worker creates a private database and rejects symlink targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-private-memory-'));const path=join(root,'new','memory.sqlite')
 const client=new WorkspaceGraphStoreClient(path)
 try {
  await client.open();await client.open()
  if(process.platform!=='win32'){assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await stat(join(root,'new'))).mode&0o777,0o700)}
  await client.close()
  const target=join(root,'other.sqlite');await writeFile(target,'',{mode:0o644});const linked=join(root,'linked.sqlite');await symlink(target,linked)
  const rejected=new WorkspaceGraphStoreClient(linked)
  try{await assert.rejects(rejected.open());if(process.platform!=='win32')assert.equal((await stat(target)).mode&0o777,0o644)}finally{await rejected.close()}
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('connector admission resolves while model extraction is still pending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-admit-'))
 let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve})
 let finish!:(value:{text:string})=>void;const response=new Promise<{text:string}>(resolve=>{finish=resolve})
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){start();return response}}
 const resource=new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(join(root,'memory.sqlite')),userId:'test',gateway,model:'test'})
 try {
  await resource.open();let admitted=false
  const admission=resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'chat',locator:'one',text:'待提取消息',observedAt:new Date().toISOString(),kind:'im'}).then(()=>{admitted=true})
  await started;assert.equal(admitted,true,'sync cursor must not wait for model completion')
  finish({text:'{"entries":[]}'});await admission;await resource.flush()
 }finally{finish({text:'{"entries":[]}'});await resource.close();await rm(root,{recursive:true,force:true})}
})

test('semantic memory retrieval finds paraphrases and hydrates only current evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-semantic-'));const client=new WorkspaceGraphStoreClient(join(root,'memory.sqlite'))
 let release!:(vectors:Float32Array[])=>void;let markStarted!:()=>void
 const started=new Promise<void>(resolve=>{markStarted=resolve})
 const embedding={id:'fixture',dims:2,embed(texts:readonly string[]){if(texts[0]==='延迟查询'){markStarted();return new Promise<Float32Array[]>(resolve=>{release=resolve})}return Promise.resolve(texts.map(text=>new Float32Array(text.includes('旅行')||text.includes('假期')?[1,0]:[0,1])))}}
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(request){const {source}=JSON.parse(request.prompt) as {source:string};return Promise.resolve({text:JSON.stringify({entries:[{key:source,text:source,topic:'生活',kind:'fact',due:null,direction:null,status:null,valid_until:null}]})})}}
 const resource=new SubstrateMemoryResource({client,userId:'semantic',gateway,model:'fixture',embedding,embeddingFingerprint:'endpoint-a:fixture:2'})
 try {
  await resource.open()
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'trip',locator:'trip',observedAt:new Date().toISOString(),text:'喜欢去海边旅行',kind:'im',embeddingConsent:true})
  await resource.ingestEvidence({processingConsent:resource.processingGrant(true),sourceId:'food',locator:'food',observedAt:new Date().toISOString(),text:'吃饭不放辣椒',kind:'im',embeddingConsent:true})
  await resource.flush()
  const answer=await resource.recall('假期安排',{limit:1});assert.equal(answer.degraded,false);assert.equal(answer.hits[0]?.text,'喜欢去海边旅行')
  const hit=answer.hits[0]
  assert.equal((await resource.evidenceFor(hit.memoryId,hit.revision))[0]?.text,'喜欢去海边旅行')
  assert.deepEqual(await resource.evidenceFor(hit.memoryId,999),[])
  const mismatched=await client.memory('search',{entry_prefix:resource.prefix,provider:'endpoint-b:fixture:2',query:'假期安排',vector:[1,0],scope:'any',limit:1}) as {hits:unknown[];degraded:boolean}
  assert.equal(mismatched.hits.length,0);assert.equal(mismatched.degraded,true,'different provider fingerprints never mix vectors')
  const pending=resource.recall('延迟查询');await started
  await resource.forgetSource('trip');release([new Float32Array([1,0])])
  assert.ok(!(await pending).hits.some(row=>row.memoryId===hit.memoryId),'deletion during provider work cannot return a stale hit')
  assert.deepEqual(await resource.evidenceFor(hit.memoryId,hit.revision),[])
 }finally{release?.([new Float32Array([1,0])]);await resource.close();await rm(root,{recursive:true,force:true})}
})

test('missing embeddings report lexical degradation explicitly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-lexical-'))
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){return Promise.resolve({text:'{"entries":[]}'})}}
 const resource=new SubstrateMemoryResource({client:new WorkspaceGraphStoreClient(join(root,'memory.sqlite')),userId:'lexical',gateway,model:'fixture'})
 try{await resource.open();assert.equal((await resource.recall('旅行')).degraded,true)}finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('A backs document originals and denies automatic embedding without consent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-memory-consent-'));let embeddings=0;let extractions=0
 const embedding={id:'consent',dims:2,embed(texts:readonly string[]){embeddings+=texts.length;return Promise.resolve(texts.map(()=>new Float32Array([1,0])))}}
 const gateway:ModelGateway={async *stream(){ /* unused */ },complete(){extractions++;return Promise.resolve({text:'{"entries":[{"key":"private","text":"本地笔记","topic":"生活","kind":"fact","due":null,"direction":null,"status":null,"valid_until":null}]}'})}}
 const client=new WorkspaceGraphStoreClient(join(root,'memory.sqlite'));const resource=new SubstrateMemoryResource({client,userId:'consent',gateway,model:'fixture',embedding})
 try{
  await resource.open();await resource.observeSource({source_ref:{type:'file',ref:'local',observed_at:new Date().toISOString()},content:'本地笔记'});await resource.flush()
  assert.equal(embeddings,0,'merge alone does not authorize uploading a derived entry')
  const count=extractions
  const record=await resource.recordEvidence({sourceId:'knowledge:one',locator:'document#chunk:1',text:'原始文档内容',observedAt:new Date().toISOString(),kind:'file',embeddingConsent:true})
  assert.ok(record.evidence_id.startsWith(resource.prefix+'e:'));assert.equal((await resource.readEvidence(record.evidence_id))?.text,'原始文档内容')
  const pending=await client.memory('pending_evidence',{source_prefix:resource.prefix}) as {id:string}[];assert.ok(!pending.some(row=>row.id===record.evidence_id));assert.equal(extractions,0,'unconsented local observation waits without extraction')
  await resource.flush();assert.equal(extractions,count,'document index owns extraction rather than maintenance')
  assert.equal(await resource.readEvidence('someone-else:e:1'),null)
  await resource.forgetSource('knowledge:one');assert.equal(await resource.readEvidence(record.evidence_id),null)
 }finally{await resource.close();await rm(root,{recursive:true,force:true})}
})

test('directory summary uses indexed A chunks and replacement withdraws obsolete facts',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-canonical-directory-'))
 let calls=0
 const gateway:ModelGateway={async *stream(){ /* extraction is non-streaming */ },complete(){calls++;return Promise.resolve({text:JSON.stringify({entries:[{key:calls<3?'old':'new',text:calls<3?'旧计划':'新计划',topic:'计划',kind:'fact',due:null,direction:null,status:null,valid_until:null}]})})}}
 const client=new WorkspaceGraphStoreClient(join(root,'memory.sqlite'))
 const resource=new SubstrateMemoryResource({client,userId:'directory',gateway,model:'fixture'})
 const knowledge=new KnowledgeService({store:new KnowledgeStoreClient({path:join(root,'index','knowledge.sqlite')}),embedding:{id:'fixture',dims:2,embed:texts=>Promise.resolve(texts.map(()=>new Float32Array([1,0])))}})
 try{
  await resource.open();await knowledge.open();await knowledge.bindEvidenceLedger({processingGrant:(...args)=>resource.processingGrant(...args),canProcess:(...args)=>resource.canProcessEvidence(...args),record:input=>resource.recordEvidence(input),read:id=>resource.readEvidence(id),remove:id=>resource.forgetSource(id)})
  const path=join(root,'README.md');await writeFile(path,'旧计划')
  const first=await knowledge.syncFile(path,root,new AbortController().signal,undefined,resource.processingGrant(true))
  assert.equal(first.evidence_ids?.length,1)
  const observation={source_ref:{type:'file' as const,ref:'knowledge:'+first.id,observed_at:new Date().toISOString()},content:'should never replace canonical original',evidence_ids:first.evidence_ids}
  await resource.observeSource(observation)
  let rows=await resource.list();assert.equal(rows.entries.length,1)
  const original=await resource.evidenceFor(rows.entries[0]!.id,rows.entries[0]!.version)
  assert.equal(original[0]?.id,first.evidence_ids[0]);assert.equal(original[0]?.text,'旧计划')
  const version=rows.entries[0]!.version
  await resource.observeSource(observation)
  assert.equal((await resource.list()).entries[0]!.version,version,'repeat extraction is a no-op revision')
  await assert.rejects(resource.observeSource({...observation,source_ref:{...observation.source_ref,ref:'knowledge:other'}}),/source_mismatch/u)
  await writeFile(path,'新计划')
  const next=await knowledge.syncFile(path,root,new AbortController().signal,first.id,resource.processingGrant(true))
  assert.notEqual(next.id,first.id)
  assert.equal(await resource.readEvidence(first.evidence_ids[0]!),null)
  assert.equal((await resource.list()).entries.length,0,'retiring previous A withdraws all old B facts')
  await resource.observeSource({...observation,source_ref:{...observation.source_ref,ref:'knowledge:'+next.id},evidence_ids:next.evidence_ids!})
  rows=await resource.list();assert.equal(rows.entries[0]?.content,'新计划')
  assert.equal((await resource.evidenceFor(rows.entries[0].id,rows.entries[0].version))[0]?.id,next.evidence_ids![0])
 }finally{await knowledge.close();await resource.close();await rm(root,{recursive:true,force:true})}
})
