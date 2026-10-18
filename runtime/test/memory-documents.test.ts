import {execFileSync} from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {MarkdownRepository} from '../src/memory-substrate/markdown-repository.js'
import type {EntryRevision} from '../src/memory-substrate/store.js'

const first:EntryRevision={entry_id:'personal:test:name',revision:1,supersedes:null,kind:'preference',origin:'stated',written_by:'user_correction',evidence_refs:['e:name'],entity_refs:[],content:{text:'old-name',memory_slot:'preferred_name'},valid_until:null,op:'add',recorded_at:'2026-10-18T00:00:00.000Z'}
const next:EntryRevision={...first,revision:2,supersedes:1,op:'update',content:{...first.content,text:'new-name'}}
function setup(t:{after:(fn:()=>void)=>void}){const root=mkdtempSync(join(tmpdir(),'nova-documents-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,repo:new MarkdownRepository(root)}}

test('current USER and object documents contain readable facts without historical values',t=>{
 const {root,repo}=setup(t)
 const objects=(['goal','todo','idea'] as const).map(kind=>({...first,entry_id:'personal:test:'+kind,kind,content:{text:kind+' title\nUseful notes',life_data:{status:kind==='todo'?'open':'active',due:'2026-10-20',goal_id:'g1'}}}))
 repo.open([first,next,...objects]);assert.ok(existsSync(join(root,'USER.md')))
 const user=readFileSync(join(root,'USER.md'),'utf8');assert.match(user,/new-name/);assert.doesNotMatch(user,/old-name/)
 for(const kind of ['goal','todo','idea']){const dir=join(root,kind+'s'),files=readdirSync(dir);assert.equal(files.length,1);assert.match(readFileSync(join(dir,files[0]!), 'utf8'),/Useful notes/)}
 assert.match(readFileSync(join(root,'MEMORY.md'),'utf8'),/goals\//)
 assert.deepEqual(repo.read().revisions.length,5)
})

test('USER body edits return the original stable reference and require controlled admission',t=>{
 const {root,repo}=setup(t);repo.open([first]);const path=join(root,'USER.md')
 writeFileSync(path,readFileSync(path,'utf8').replace('old-name','corrected-name'))
 const snapshot=repo.read();assert.equal(snapshot.edits.length,1);assert.equal(snapshot.edits[0]?.entry_id,first.entry_id);assert.equal(snapshot.edits[0]?.content.text,'corrected-name')
 assert.throws(()=>repo.publish([first]),/UNADMITTED_EDIT/)
 const corrected={...next,content:{...first.content,text:'corrected-name'}}
 repo.publish([first,corrected]);assert.equal(repo.read().edits.length,0)
 assert.match(readFileSync(path,'utf8'),/corrected-name/)
})

test('semantic structural changes and generated index edits cannot delete facts or change authority',t=>{
 const {root,repo}=setup(t);repo.open([first]);const path=join(root,'USER.md'),original=readFileSync(path,'utf8')
 writeFileSync(path,original.replace(first.entry_id,'different-id'));assert.throws(()=>repo.read(),/FORMAT|CONFLICT/)
 writeFileSync(path,original);writeFileSync(join(root,'MEMORY.md'),'invented index');assert.throws(()=>repo.read(),/FORMAT|CONFLICT/)
})

test('forget and permanent purge clear current semantic documents and prevent stale index entries',t=>{
 const {root,repo}=setup(t);repo.open([first,next]);const forgotten:EntryRevision={...next,revision:3,supersedes:2,op:'tombstone'}
 repo.publish([first,next,forgotten]);assert.doesNotMatch(readFileSync(join(root,'USER.md'),'utf8'),/new-name|old-name/)
 assert.doesNotMatch(readFileSync(join(root,'MEMORY.md'),'utf8'),/new-name|old-name/)
 const baseline=repo.read().baselines;repo.purge([],'erase-name',baseline);assert.deepEqual(repo.read().revisions,[])
})

test('legacy format migrates on open without changing stable IDs or revision history',t=>{
 const {root,repo}=setup(t);repo.open([first,next])
 writeFileSync(join(root,'.nova-memory.json'),'{"format":"nova-understanding","version":1}\n')
 rmSync(join(root,'USER.md'));rmSync(join(root,'MEMORY.md'))
 const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@localhost','-C',root,...args],{stdio:'pipe'})
 git(['add','entries','.nova-memory.json']);git(['commit','-m','Synthetic legacy snapshot'])
 const reopened=new MarkdownRepository(root);const snapshot=reopened.open([])
 assert.deepEqual(snapshot.revisions,[first,next]);assert.match(readFileSync(join(root,'USER.md'),'utf8'),/new-name/)
 assert.equal(reopened.needsDocumentMigration(),false)
})

test('changing the layout marker cannot bypass semantic document edit checks',t=>{
 const {root,repo}=setup(t);repo.open([first]);writeFileSync(join(root,'.nova-memory.json'),'{"format":"nova-understanding","version":1}\n')
 assert.throws(()=>repo.read(),/CONFLICT|FORMAT/)
})

test('recovery rejects semantic bytes that disagree with its recorded target revisions',t=>{
 const {root,repo}=setup(t);repo.open([first]);const operation=repo.prepare([first,next])
 const path=join(root,'.nova-memory-batch.json'),journal=JSON.parse(readFileSync(path,'utf8')) as {files:{path:string;after:string}[]}
 const user=journal.files.find(file=>file.path==='USER.md')!;user.after=user.after.replace('new-name','invented-name');writeFileSync(path,JSON.stringify(journal))
 assert.throws(()=>repo.recover(operation),/CONFLICT|FORMAT/)
 assert.doesNotMatch(readFileSync(join(root,'USER.md'),'utf8'),/invented-name/)
})

for(const character of ['x','界'])test(`oversized USER aggregation (${character}) fails before writing a recovery journal`,t=>{
 const {root,repo}=setup(t);repo.open([first]);const original=readFileSync(join(root,'USER.md'),'utf8')
 const rows=Array.from({length:5},(_,i)=>({...first,entry_id:`large:${i}`,content:{text:character.repeat(character==='x'?1_800_000:900_000)}}))
 assert.throws(()=>repo.prepare([first,...rows]),/LIMIT/)
 assert.equal(repo.pendingOperationId(),null)
 assert.equal(readFileSync(join(root,'USER.md'),'utf8'),original)
 assert.deepEqual(repo.read().revisions,[first])
})
