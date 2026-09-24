import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {ProjectDigests,projectKey,type ProjectInput,type DigestOutcome} from '../src/personal-agent/project-digests.js'
import {profileInputsFromDigests} from '../src/personal-agent/profile-sources.js'
const file=(root:string,name:string,version='v1',extra:Record<string,unknown>={})=>({kind:'file' as const,id:'source:'+createHash('sha256').update(root+name).digest('hex').slice(0,12),version,content:`${name} of ${root.split("/").pop()!}`,source_id:'s',file_id:name,root,rel_path:name,role:'document' as const,mtime_ms:Date.now(),priority:1,...extra})
const answer=(projects:readonly ProjectInput[])=>({digests:projects.map(p=>({project_key:p.project_key,role:'own',summary:`${p.name} summary`,focus:null,next_step:null,refs:[{entry_id:p.documents[0]!.entry_id,version:p.documents[0]!.version}]}))})
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check())}
const setup=async(generate:(p:readonly ProjectInput[])=>Promise<{digests:unknown[]}>,options={})=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-digest-')),calls:ProjectInput[][]=[],outcomes:DigestOutcome[]=[]
 const make=()=>new ProjectDigests(join(dir,'digests.json'),p=>{calls.push([...p]);return generate(p)},()=>{/* observer fixture */},{idleMs:10,report:o=>outcomes.push(o),...options})
 return {dir,calls,outcomes,make}
}
test('only projects whose documents changed are sent again, and the model never sees a path',async()=>{
 const t=await setup(p=>Promise.resolve(answer(p)));let service=t.make()
 try{
  await service.open();service.update([file('/home/u/nova','README.md'),file('/home/u/notes','plan.md')])
  await until(()=>service.digests().length===2);assert.equal(t.calls.length,1)
  assert.ok(!JSON.stringify(t.calls[0]).includes('/home/u'),'no absolute paths reach the model')
  await service.close();service=t.make();await service.open()
  service.update([file('/home/u/nova','README.md'),file('/home/u/notes','plan.md','v2')])
  assert.equal(service.digests().length,2,'a project being re-read keeps its digest')
  await until(()=>t.calls.length===2);assert.deepEqual(t.calls[1]!.map(p=>p.name),['notes'])
 }finally{await service.close();await rm(t.dir,{recursive:true,force:true})}
})
test('a digest citing another project or an unknown version is dropped and the project backs off',async()=>{
 const t=await setup(p=>Promise.resolve({digests:[{...answer(p).digests[0],refs:[{entry_id:'source:elsewhere',version:'v1'}]}]}))
 const service=t.make()
 try{
  await service.open();service.update([file('/r/a','README.md')])
  await until(()=>t.outcomes.length===1);assert.equal(service.digests().length,0);assert.equal(t.outcomes[0]!.digests,0)
  await new Promise(r=>setTimeout(r,50));assert.equal(t.calls.length,1,'no immediate retry after a rejected digest')
 }finally{await service.close();await rm(t.dir,{recursive:true,force:true})}
})
test('batches respect the hourly project budget',async()=>{
 const t=await setup(p=>Promise.resolve(answer(p)),{batch:2,hourlyProjects:3})
 const service=t.make()
 try{
  await service.open();service.update(['a','b','c','d','e'].map(n=>file('/r/'+n,'README.md')))
  await until(()=>t.calls.length===2);await new Promise(r=>setTimeout(r,50))
  assert.deepEqual(t.calls.map(c=>c.length),[2,1]);assert.equal(service.pending(),2)
 }finally{await service.close();await rm(t.dir,{recursive:true,force:true})}
})
test('withdrawn files remove their digests from disk',async()=>{
 const t=await setup(p=>Promise.resolve(answer(p)));let service=t.make()
 try{
  await service.open();const files=[file('/r/a','README.md'),file('/r/b','README.md')];service.update(files)
  await until(()=>service.digests().length===2)
  await service.forgetUnavailable(new Set([files[1]!.id]));assert.deepEqual(service.digests().map(d=>d.name),['b'])
  await service.close();service=new ProjectDigests(join(t.dir,'digests.json'),undefined,()=>{/* observer fixture */});await service.open();service.update(files)
  assert.deepEqual(service.digests().map(d=>d.name),['b'])
 }finally{await service.close();await rm(t.dir,{recursive:true,force:true})}
})
test('only own projects become profile input, and the input version follows the digest text',()=>{
 const base={focus:null,next_step:null,refs:[{entry_id:'source:x',version:'v1'}]}
 const inputs=profileInputsFromDigests([{...base,project_key:projectKey('/a'),name:'nova',role:'own',summary:'Voice agent'},{...base,project_key:projectKey('/b'),name:'lib',role:'third_party',summary:'Cloned library'}])
 assert.deepEqual(inputs.map(i=>i.source?.project),['nova'])
 const again=profileInputsFromDigests([{...base,project_key:projectKey('/a'),name:'nova',role:'own',summary:'Voice agent, workbench shipped'}])
 assert.notEqual(inputs[0]!.version,again[0]!.version);assert.equal(inputs[0]!.id,again[0]!.id)
})
test('a withdrawal while the digest call runs keeps the withdrawn project off disk',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 const t=await setup(async p=>{await gate;return answer(p)});let service=t.make()
 try{
  await service.open();const files=[file('/r/a','README.md'),file('/r/b','README.md')];service.update(files)
  await until(()=>t.calls.length===1)
  const forgot=service.forgetUnavailable(new Set([files[1]!.id]));release();await forgot
  await until(()=>t.outcomes.length===1);assert.deepEqual(service.digests().map(d=>d.name),['b'])
  await service.close();service=new ProjectDigests(join(t.dir,'digests.json'),undefined,()=>{/* observer fixture */});await service.open();service.update(files)
  assert.deepEqual(service.digests().map(d=>d.name),['b'],'the withdrawn project never reached disk')
 }finally{await service.close();await rm(t.dir,{recursive:true,force:true})}
})
