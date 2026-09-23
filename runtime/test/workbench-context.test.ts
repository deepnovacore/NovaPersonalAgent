import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkbenchContext} from '../src/personal-agent/workbench-context.js'
import type {MemoryEntry} from '../src/memory/entry.js'
test('automatic cards are grounded, persistent, dismissible, and disappear after source invalidation',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-'));const path=join(dir,'cards.json')
 const entry={id:'m',version:1,status:'active',content:'Documented next step'} as MemoryEntry
 let calls=0
 const generate=()=>{calls++;return Promise.resolve({cards:[{tab:'todos' as const,title:'Review documented next step',body:'Suggested from project notes, not a commitment.',refs:[{entry_id:'m',version:1}]}]})}
 const context=new WorkbenchContext(path,generate,()=>undefined)
 try{
  await context.open();context.update([entry]);await context.refresh();assert.equal(context.snapshot().cards.length,1)
  await context.refresh();assert.equal(calls,1)
  const id=context.snapshot().cards[0]!.id;await context.dismiss(id);assert.equal(context.snapshot().cards.length,0)
  await context.close();const reopened=new WorkbenchContext(path,generate,()=>undefined);await reopened.open();reopened.update([entry]);assert.equal(reopened.snapshot().cards.length,0);await reopened.close()
  await context.open();context.update([entry]);await context.clear();assert.equal(context.snapshot().cards.length,0);context.update([entry]);await context.refresh();assert.equal(context.snapshot().cards.length,1,'clearing private drafts does not disable future generation');
  const invalid=new WorkbenchContext(join(dir,'invalid.json'),()=>Promise.resolve({cards:[{tab:'profile',title:'Invalid',body:'Missing source',refs:[{entry_id:'invented',version:1}]}]}),()=>undefined)
  await invalid.open();invalid.update([entry]);await invalid.refresh();assert.equal(invalid.snapshot().cards.length,0);assert.equal(invalid.snapshot().status,'failed');await invalid.close()
 }finally{await context.close();await rm(dir,{recursive:true,force:true})}
})
