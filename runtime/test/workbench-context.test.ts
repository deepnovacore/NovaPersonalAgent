import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkbenchContext} from '../src/personal-agent/workbench-context.js'
import {candidateId,type ContextInput} from '../src/personal-agent/context-candidates.js'
test('automatic cards are grounded, persistent, dismissible, and disappear after source invalidation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-'));const path=join(dir,'cards.json')
 const entry:ContextInput={kind:'file',id:'source:m',version:'v1',content:'Next step: review the design.',source_id:'s',file_id:'m',root:'/project',rel_path:'notes.md',role:'document',mtime_ms:1,priority:2}
 const candidate_id=candidateId('todos','m','v1')
 let calls=0
 const generate=()=>{calls++;return Promise.resolve({cards:[{candidate_id,tab:'todos' as const,title:'Review documented next step',body:'Suggested from project notes, not a commitment.',refs:[{entry_id:'source:m',version:'v1'}]}]})}
 const context=new WorkbenchContext(path,generate,()=>undefined)
 try{
  await context.open();context.update([entry]);await context.refresh();assert.equal(context.snapshot().cards.length,1)
  await context.refresh();assert.equal(calls,1)
  const id=context.snapshot().cards[0]!.id;await context.dismiss(id);assert.equal(context.snapshot().cards.length,0)
  await context.close();const reopened=new WorkbenchContext(path,generate,()=>undefined);await reopened.open();reopened.update([entry]);assert.equal(reopened.snapshot().cards.length,0);await reopened.close()
  await context.open();context.update([entry]);await context.clear();assert.equal(context.snapshot().cards.length,0);context.update([entry]);await context.refresh();assert.equal(context.snapshot().cards.length,1,'clearing private drafts does not disable future generation');
  const invalid=new WorkbenchContext(join(dir,'invalid.json'),()=>Promise.resolve({cards:[{candidate_id:'invented',tab:'ideas',title:'Invalid',body:'Missing source',refs:[{entry_id:'invented',version:1}]}]}),()=>undefined)
  await invalid.open();invalid.update([entry]);await invalid.refresh();assert.equal(invalid.snapshot().cards.length,0);assert.equal(invalid.snapshot().status,'ready');await invalid.close()
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
test('dismissal follows evidence identity across model paraphrases and old cache is discarded',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-id-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v1',content:'Next step: compare voice flows.',source_id:'s',file_id:'doc',root:'/project',rel_path:'notes.md',role:'document',mtime_ms:1,priority:2}
 const id=candidateId('todos','doc','v1')
 let wording='Compare voice flows'
 const generator=()=>Promise.resolve({cards:[{candidate_id:id,tab:'todos' as const,title:wording,body:'Suggested by project notes.',refs:[{entry_id:'source:doc',version:'v1'}]}]})
 try{
  await writeFile(path,JSON.stringify({key:'legacy',dismissed:[],cards:[{tab:'profile',title:'Old profile',body:'Config guess',refs:[{entry_id:'source:doc',version:'v1'}]}]}),{mode:0o600})
  const context=new WorkbenchContext(path,generator,()=>undefined);await context.open();context.update([input])
  assert.equal(context.snapshot().cards.length,0)
  await context.refresh();assert.equal(context.snapshot().cards.length,1)
  await context.dismiss(id);wording='A different title';context.update([{...input,mtime_ms:2}]);await context.refresh()
  assert.equal(context.snapshot().cards.length,0)
  await context.close()
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('invalid or raw-field cards are omitted without hiding a valid suggestion',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-filter-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v1',content:'An idea for a simpler setup.',source_id:'s',file_id:'doc',root:'/project',rel_path:'notes.md',role:'document',mtime_ms:1,priority:2}
 const id=candidateId('ideas','doc','v1')
 const context=new WorkbenchContext(path,()=>Promise.resolve({cards:[
  {candidate_id:id,tab:'ideas',title:'Simplify setup',body:'The notes describe a simpler setup.',refs:[{entry_id:'source:doc',version:'v1'}]},
  {candidate_id:'invented',tab:'ideas',title:'Unrelated',body:'No evidence',refs:[{entry_id:'source:doc',version:'v1'}]},
  {candidate_id:id,tab:'ideas',title:'Leaked',body:'api_key: secret',refs:[{entry_id:'source:doc',version:'v1'}]},
 ]}),()=>undefined)
 try{await context.open();context.update([input]);await context.refresh();assert.deepEqual(context.snapshot().cards.map(card=>card.title),['Simplify setup'])}finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
