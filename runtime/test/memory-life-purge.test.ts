import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,realpath,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkspaceGraphStoreClient} from '../src/workspace-graph/store-client.js'
import {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

// Real host -> LifeService -> resource -> worker/SQLite/Markdown. Only the public feed is synthetic.
test('purged Profile stays absent across Life and news commands, recreates once, and purges again',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-life-purge-')),path=join(root,'memory.sqlite');let client=new WorkspaceGraphStoreClient(path)
 const makeResource=()=>new SubstrateMemoryResource({client,userId:'life-purge',model:'unused',gateway:{async *stream(){throw Error('unexpected model call')},async complete(){throw Error('unexpected model call')}}})
 let resource=makeResource()
 const make=()=>{const host=new PersonalAgentHost({path:join(root,'personal.json'),userScope:'life-purge',memory:()=>resource,pool:new SuggestionPool(),evidence:()=>null});host.news.options.firstRefreshMs=null;host.news.options.fetcher=async()=>new Response('<rss><channel><item><title>Synthetic news</title><link>https://example.com/synthetic</link><description>Public article</description></item></channel></rss>');return host}
 let host=make()
 const rows=async()=>await client.memory('list',{include_history:true}) as EntryRevision[]
 const command=async(method:string,params:Record<string,unknown>,request_id:string)=>{const result=await host.command({type:'personal.command',method,params,request_id}) as {ok:boolean;data:unknown;error?:string};assert.equal(result.ok,true,JSON.stringify(result));return result}
 try{
  await resource.open();await host.open()
  await command('life.mutate',{op:'profile',expected_version:0,about:'FIRST PRIVATE PROFILE'},'first-profile')
  const first=(await rows()).find(row=>row.kind==='profile')!
  const savedEvidence=[await client.memory('evidence',{id:first.evidence_refs[0]})]
  await command('memory.purge',{id:first.entry_id,expected_version:first.revision},'first-purge')
  assert.deepEqual(host.life.snapshot().profile,{about:'',version:0})
  await host.close();await resource.close();client=new WorkspaceGraphStoreClient(path);resource=makeResource();await resource.open();host=make();await host.open()
  for(const kind of ['todo','idea','goal']){
   const input={op:'create',kind,title:'Retained '+kind};await command('life.mutate',input,'create-'+kind);await command('life.mutate',input,'create-'+kind)
  }
  await host.news.refresh();const article=host.news.snapshot().items[0]!
  const conversion={id:article.id,content_hash:article.content_hash,kind:'idea',title:'News idea'}
  await command('news.convert',conversion,'convert-news');await command('news.convert',conversion,'convert-news');await command('news.convert',conversion,'convert-news-again')
  assert.equal((await rows()).filter(row=>row.kind==='profile').length,0)
  assert.equal(host.life.snapshot().ideas.length,2)
  assert.equal(host.life.snapshot().ideas.find(row=>row.title==='News idea')!.news_source!.article_id,article.id)
  await assert.rejects(host.life.mutate({op:'profile',expected_version:0,about:'FIRST PRIVATE PROFILE'},'first-profile'),{code:'STORE_PURGED_ID'})
  const backend=resource.lifeBackend(),snapshot=(await backend.peek!())!
  const attempts=await Promise.allSettled(['recreated','racing'].map(requestId=>backend.mutate({requestId,expectedRevision:snapshot.revision,input:{op:'profile',expected_version:0,about:'SECOND PRIVATE PROFILE'}})))
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1)
  const rejected=attempts.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.match(String(rejected.reason),/version_conflict/)
  await host.life.refresh();const second=(await rows()).find(row=>row.kind==='profile')!
  assert.notEqual(second.entry_id,first.entry_id)
  await command('life.mutate',{op:'profile',expected_version:1,about:'SECOND EDITED PROFILE'},'edit-recreated')
  assert.equal((await rows()).filter(row=>row.kind==='profile').length,1)
  const updated=(await rows()).find(row=>row.kind==='profile')!;assert.equal(updated.entry_id,second.entry_id)
  await command('life.mutate',{op:'profile',expected_version:0,about:'FIRST PRIVATE PROFILE'},'first-profile')
  assert.equal(host.life.snapshot().profile.about,'SECOND EDITED PROFILE','old host receipt cannot edit the new incarnation')
  const evidence=[...first.evidence_refs,...second.evidence_refs,...updated.evidence_refs]
  for(const id of [...second.evidence_refs,...updated.evidence_refs])savedEvidence.push(await client.memory('evidence',{id}))
  await command('memory.purge',{id:updated.entry_id,expected_version:updated.revision},'second-purge')
  assert.equal((await rows()).filter(row=>row.kind==='profile').length,0)
  assert.equal(host.life.snapshot().todos.length,1);assert.equal(host.life.snapshot().ideas.length,2);assert.equal(host.life.snapshot().goals.length,1)
  for(const id of evidence)assert.equal(await client.memory('evidence',{id}),null)
  for(const row of [first,updated])await assert.rejects(client.memory('merge',{entry_id:row.entry_id,expected_revision:0,kind:'profile',origin:'stated',written_by:'user_correction',evidence_refs:row.evidence_refs,content:row.content,recorded_at:new Date().toISOString()}),{code:'STORE_PURGED_ID'})
  for(const record of savedEvidence){assert.ok(record);await assert.rejects(client.memory('append_evidence',record),{code:'STORE_PURGED_ID'})}
  await assert.rejects(readFile(join(root,'personal.json.life.json')),{code:'ENOENT'})
  await host.close();await resource.close()
  const files=[path,...(await readdir(path+'.memory',{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name))]
  for(const suffix of ['-wal','-journal'])if((await readdir(root)).includes('memory.sqlite'+suffix))files.push(path+suffix)
  for(const file of files){const bytes=await readFile(file);for(const secret of ['FIRST PRIVATE PROFILE','SECOND PRIVATE PROFILE','SECOND EDITED PROFILE'])assert.equal(bytes.includes(Buffer.from(secret)),false,file+' retains '+secret)}
 }finally{await host.close();await resource.close();await rm(root,{recursive:true,force:true})}
})

test('worker distinguishes purged identifiers, stated evidence trust and stale revisions without leaking content',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'nova-life-errors-')),client=new WorkspaceGraphStoreClient(join(root,'memory.sqlite')),prefix='personal:errors:',now=new Date().toISOString()
 const evidence={id:prefix+'e',source_id:prefix+'source',source_kind:'task_result',locator:'fixture',observed_at:now,recorded_at:now,raw_text:'PRIVATE DIAGNOSTIC TEXT',hash:'fixture',trust:'trusted_system'}
 const candidate={entry_id:prefix+'profile',expected_revision:0,kind:'profile',origin:'stated',written_by:'merge',evidence_refs:[evidence.id],content:{text:'PRIVATE DIAGNOSTIC TEXT'},recorded_at:now}
 const code=(expected:string)=>(error:unknown)=>{assert.equal((error as {code:string}).code,expected);assert.doesNotMatch(String(error),/PRIVATE DIAGNOSTIC TEXT/);return true}
 try{
  await client.open();await client.memory('enable_files',{});await client.memory('append_evidence',evidence)
  await assert.rejects(client.memory('merge',candidate),code('STORE_STATED_EVIDENCE_REQUIRED'))
  await client.memory('merge',{...candidate,origin:'inferred'})
  await assert.rejects(client.memory('merge',{...candidate,origin:'inferred'}),code('STORE_STALE_REVISION'))
  await client.memory('purge',{request_id:'purge',entry_prefix:prefix,selection:{kind:'entry',id:candidate.entry_id,expected_revision:1}})
  await assert.rejects(client.memory('merge',candidate),code('STORE_PURGED_ID'))
  await assert.rejects(client.memory('append_evidence',evidence),code('STORE_PURGED_ID'))
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})
