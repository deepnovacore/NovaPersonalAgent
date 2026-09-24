import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProfileWarmup} from '../src/personal-agent/profile-warmup.js'
const entries=[{id:'a',version:1,content:'I study voice interfaces',origin:'stated' as const}]
const draft={about:{text:'I study voice interfaces',refs:[{entry_id:'a',version:1}]},work:[],interests:[{text:'Voice interfaces',refs:[{entry_id:'a',version:1}]}]}
test('warmup caches grounded drafts without repeating generation on reopen',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let calls=0
 const make=()=>new ProfileWarmup(join(dir,'draft.json'),()=>{calls++;return Promise.resolve(draft)},()=>{/* observer fixture */})
 let service=make()
 try{await service.open();service.update(entries);await service.refresh();assert.equal(service.snapshot().status,'ready');assert.deepEqual(service.snapshot().draft,draft)
  await service.close();service=make();await service.open();service.update(entries);await service.refresh();assert.equal(calls,1)
  service.update([]);assert.equal(service.snapshot().draft,null);assert.equal(service.snapshot().status,'idle')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('revoked evidence and an abort-ignoring provider cannot restore a stale draft',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let resolve!:(v:typeof draft)=>void
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>new Promise(r=>{resolve=r}),()=>{/* observer fixture */})
 try{await service.open();service.update(entries);const run=service.refresh();assert.equal(service.snapshot().status,'working');service.update([]);resolve(draft);await run;assert.equal(service.snapshot().draft,null);assert.equal(service.snapshot().status,'idle')}
 finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('invalid model references fail safely and explicit retry recovers',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let invalid=true
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(invalid?{...draft,about:{text:'Invented',refs:[{entry_id:'unknown',version:1}]}}:draft),()=>{/* observer fixture */})
 try{await service.open();service.update(entries);await service.refresh();assert.equal(service.snapshot().status,'failed');assert.equal(service.snapshot().draft,null);invalid=false;await service.refresh(true);assert.equal(service.snapshot().status,'ready')}
 finally{await service.close();await rm(dir,{recursive:true,force:true})}
})

test('close terminates warmup even when a provider ignores its signal',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'))
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>new Promise(()=>{/* observer fixture */}),()=>{/* observer fixture */})
 try{await service.open();service.update(entries);assert.equal(service.snapshot().status,'working');await service.close();assert.equal(service.snapshot().draft,null)}finally{await rm(dir,{recursive:true,force:true})}
})
test('inferred memories may suggest topics but cannot supply personal facts',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'))
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(draft),()=>{/* observer fixture */})
 try{await service.open();service.update(entries.map(e=>({...e,origin:'inferred'})));await service.refresh();assert.equal(service.snapshot().status,'failed');assert.equal(service.snapshot().draft,null)}finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
