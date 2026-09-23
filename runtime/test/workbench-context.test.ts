import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkbenchContext,contextCardSchema} from '../src/personal-agent/workbench-context.js'
import {candidateId,type ContextInput} from '../src/personal-agent/context-candidates.js'
test('generated suggestion copy stays short enough for a single readable card',()=>{
 const card={candidate_id:'c',tab:'ideas',title:'具体提议',body:'一句简短的说明。',refs:[{entry_id:'source:doc',version:'v1'}]}
 assert.equal(contextCardSchema.safeParse(card).success,true)
 assert.equal(contextCardSchema.safeParse({...card,body:'细节'.repeat(61)}).success,false)
})
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
test('automatic generation waits for eligible candidate changes and persists its quota',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-clock-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v1',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0
 const context=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
 try{
  await context.open()
  for(let n=0;n<100;n++)context.update([])
  t.mock.timers.tick(600_000);assert.equal(calls,0)
  context.update([input]);t.mock.timers.tick(2_999);assert.equal(calls,0)
  t.mock.timers.tick(1);await context.refresh();assert.equal(calls,1)
  await context.refresh()
  context.update([{...input,version:'v2',mtime_ms:2}]);t.mock.timers.tick(119_999);assert.equal(calls,1)
  t.mock.timers.tick(1);await context.refresh();assert.equal(calls,2)
  await context.close()
  const reopened=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
  await reopened.open();reopened.update([{...input,version:'v3',mtime_ms:3}]);t.mock.timers.tick(119_999);assert.equal(calls,2)
  t.mock.timers.tick(1);await reopened.refresh();assert.equal(calls,3)
  await reopened.close()
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('continuous candidate churn has a maximum wait and pause cancels pending work',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-churn-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0
 const context=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
 try{
  await context.open();context.update([input])
  for(let n=1;n<10;n++){t.mock.timers.tick(1000);context.update([{...input,version:'v'+n}])}
  assert.equal(calls,0);t.mock.timers.tick(1000);await context.refresh();assert.equal(calls,1)
  context.update([{...input,version:'later0'}])
  for(let n=1;n<12;n++){t.mock.timers.tick(10_000);context.update([{...input,version:'later'+n}])}
  assert.equal(calls,1);t.mock.timers.tick(10_000);await context.refresh();assert.equal(calls,2)
  context.update([{...input,version:'paused'}]);context.update([]);t.mock.timers.tick(120_000);assert.equal(calls,2)
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic calls stop at six per hour and a capped candidate runs when eligible',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-limit-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0;const context=new WorkbenchContext(path,()=>{calls++;return Promise.resolve({cards:[]})},()=>undefined)
 try{
  await context.open();context.update([input]);t.mock.timers.tick(3000);await context.refresh();assert.equal(calls,1)
  for(let n=1;n<=5;n++){context.update([{...input,version:'v'+n}]);t.mock.timers.tick(120_000);await context.refresh();assert.equal(calls,n+1)}
  context.update([{...input,version:'v6'}]);await context.refresh();assert.equal(calls,7,'manual refresh bypasses the automatic quota')
  context.update([{...input,version:'v7'}]);t.mock.timers.tick(120_000);assert.equal(calls,7)
  t.mock.timers.tick(3_600_000-6*120_000);await context.refresh();assert.equal(calls,8,'manual refresh did not consume a quota slot')
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('candidate changes during generation queue one trailing automatic call',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']})
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-flight-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0,release:()=>void=()=>undefined
 const blocked=new Promise<void>(resolve=>{release=resolve})
 const context=new WorkbenchContext(path,async()=>{calls++;if(calls===1)await blocked;return {cards:[]}},()=>undefined)
 const until=async(check:()=>boolean)=>{for(let n=0;n<10000&&!check();n++)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(check(),`calls=${calls}`)}
 try{
  await context.open();context.update([input]);t.mock.timers.tick(3000);await until(()=>calls===1)
  context.update([{...input,version:'v1'}]);context.update([{...input,version:'v2'}]);t.mock.timers.tick(120_000);assert.equal(calls,1)
  release();await until(()=>context.snapshot().status==='ready');t.mock.timers.tick(0);await context.refresh();assert.equal(calls,2)
 }finally{release();t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic failures retry with backoff and retain the hourly cap after reopen',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});t.mock.method(console,'error',()=>undefined)
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-context-retry-')),path=join(dir,'cards.json')
 const input:ContextInput={kind:'file',id:'source:doc',version:'v0',content:'Next step: review the launch plan.',source_id:'s',file_id:'doc',root:'/project',rel_path:'plan.md',role:'document',mtime_ms:1,priority:2}
 let calls=0;const generate=()=>{calls++;return Promise.reject(Error('offline'))}
 const until=async(check:()=>boolean)=>{for(let n=0;n<10000&&!check();n++)await new Promise<void>(resolve=>setImmediate(resolve));assert.ok(check(),`calls=${calls}`)}
 const context=new WorkbenchContext(path,generate,()=>undefined)
 try{
  await context.open();context.update([input]);t.mock.timers.tick(3000);await until(()=>calls===1&&context.snapshot().status==='failed')
  t.mock.timers.tick(299_999);assert.equal(calls,1);t.mock.timers.tick(1);await until(()=>calls===2&&context.snapshot().status==='failed')
  for(let n=3;n<=6;n++){t.mock.timers.tick(300_000);await until(()=>calls===n&&context.snapshot().status==='failed')}
  const persisted=JSON.parse(await readFile(path,'utf8')) as {automatic_call_times:number[];retry_not_before:number}
  assert.equal(persisted.automatic_call_times.length,6);assert.ok(persisted.retry_not_before>Date.now())
  t.mock.timers.tick(300_000);assert.equal(calls,6,'automatic failures still consume the hourly quota')
  await context.close();const reopened=new WorkbenchContext(path,generate,()=>undefined)
  await reopened.open();reopened.update([input]);t.mock.timers.tick(1_799_999);assert.equal(calls,6)
  t.mock.timers.tick(1);await until(()=>calls===7&&reopened.snapshot().status==='failed');await reopened.close()
 }finally{t.mock.timers.reset();await context.close();await rm(dir,{recursive:true,force:true})}
})
