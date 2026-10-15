import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,chmod,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ProfileWarmup,PROFILE_GENERATION_VERSION,type ProfileInput,type ProfileOutcome} from '../src/personal-agent/profile-warmup.js'
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
const fileA={id:'source:a',version:'f1',content:'Active voice project',origin:'inferred' as const,source:{project:'Nova',document:'README.md'}}
const fileB={id:'source:b',version:'f1',content:'Reads papers on speech models',origin:'inferred' as const,source:{project:'Notes',document:'papers.md'}}
const fileDraft={about:{text:'Builds a voice agent',refs:[{entry_id:fileA.id,version:fileA.version}]},work:[],interests:[{text:'Speech models',refs:[{entry_id:fileB.id,version:fileB.version}]}]}
test('incremental drafts retain grounded work and interests omitted by the next batch',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-incremental-'));let calls=0;
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(++calls===1?{...fileDraft,work:[{title:'Nova',text:'Builds the agent',refs:[{entry_id:fileA.id,version:fileA.version}]}]}:{about:{text:'Works on speech',refs:[{entry_id:fileA.id,version:fileA.version}]},work:[],interests:[]}),()=>{/* snapshot observer */});
 try{await service.open();service.update([fileA,fileB]);await service.refresh();service.update([fileA,fileB,{...fileB,id:'source:c'}]);await service.refresh();assert.equal(service.snapshot().draft?.work[0]?.title,'Nova');assert.equal(service.snapshot().draft?.interests[0]?.text,'Speech models');}
 finally{await service.close();await rm(dir,{recursive:true,force:true})}
});
test('external message facts disappear when their exact version changes',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-external-'));
 const own={...fileA,source:{project:'飞书',document:'本人消息',kind:'im' as const}};
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve({...fileDraft,interests:[]}),()=>{/* snapshot observer */});
 try{await service.open();service.update([own]);await service.refresh();assert(service.snapshot().draft);service.update([{...own,version:'f2'}]);assert.equal(service.snapshot().draft,null);}
 finally{await service.close();await rm(dir,{recursive:true,force:true})}
});
test('old facts keep authorized evidence outside the next generation sample',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-retained-'));
 const own={...fileA,source:{project:'飞书',document:'本人消息',kind:'im' as const}};
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve({...fileDraft,interests:[]}),()=>{/* snapshot observer */});
 try{
  await service.open();service.update([own]);await service.refresh();
  const newest=Array.from({length:24},(_,index)=>({...own,id:'recent:'+index}));
  service.update([...newest,own]);assert.equal(service.snapshot().draft?.about?.text,'Builds a voice agent');
  await service.forgetUnavailable(new Set(newest.map(input=>input.id)));assert.equal(service.snapshot().draft,null);
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
});
test('stable inputs still reach the first three profile stages after reopening',async context=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-stable-'));let calls=0;
 const make=()=>new ProfileWarmup(join(dir,'draft.json'),()=>{calls++;return Promise.resolve({...fileDraft,interests:[]})},()=>{/* snapshot observer */});
 let service=make();
 try{
  await service.open();context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});service.update([fileA]);
  context.mock.timers.tick(5*60_000);await service.refresh();assert.equal(calls,1);
  await service.close();service=make();await service.open();service.update([fileA]);
  context.mock.timers.tick(25*60_000);await service.refresh();assert.equal(calls,2);
  context.mock.timers.tick(210*60_000);await service.refresh();assert.equal(calls,3);
  await service.close();service=make();await service.open();service.update([{...fileA,version:'f2'}]);
  context.mock.timers.tick(239*60_000);assert.equal(calls,3);
  context.mock.timers.tick(60_000);await service.refresh();assert.equal(calls,4);
 }finally{context.mock.timers.reset();await service.close();await rm(dir,{recursive:true,force:true})}
});
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check())}
test('ongoing source changes produce drafts at 5 minutes, 30 minutes and 4 hours',async context=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-stages-'));let calls=0;
 const service=new ProfileWarmup(join(dir,'draft.json'),inputs=>{calls++;return Promise.resolve({about:{text:'Builds a voice agent',refs:[{entry_id:inputs[0]!.id,version:inputs[0]!.version!}]},work:[],interests:[]})},()=>{/* snapshot observer */});
 try{
  await service.open();context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  service.update([fileA]);
  context.mock.timers.tick(4*60_000);service.update([{...fileA,version:'f2'}]);assert.equal(calls,0);
  context.mock.timers.tick(60_000);await service.refresh();assert.equal(calls,1);
  service.update([{...fileA,version:'f3'}]);context.mock.timers.tick(24*60_000);assert.equal(calls,1);
  context.mock.timers.tick(60_000);await service.refresh();assert.equal(calls,2);
  service.update([{...fileA,version:'f4'}]);context.mock.timers.tick(209*60_000);assert.equal(calls,2);
  context.mock.timers.tick(60_000);await service.refresh();assert.equal(calls,3);
  context.mock.timers.tick(4*60*60_000);assert.equal(calls,3,'unchanged evidence does not trigger another request');
 }finally{context.mock.timers.reset();await service.close();await rm(dir,{recursive:true,force:true})}
});
test('a source change during generation keeps the in-flight answer and only the uncited facts disappear',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let resolve!:(v:typeof fileDraft)=>void
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>new Promise(r=>{resolve=r}),()=>{/* observer fixture */},{minIntervalMs:60_000})
 try{
  await service.open();service.update([fileA,fileB]);const run=service.refresh()
  service.update([fileA,{...fileB,id:'source:c'}]);assert.equal(service.snapshot().status,'working')
  resolve(fileDraft);await run
  assert.equal(service.snapshot().status,'ready');assert.deepEqual(service.snapshot().draft,{...fileDraft,interests:[]})
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('re-reading a cited file keeps the draft visible and waits before regenerating',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let calls=0
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>{calls++;return Promise.resolve(fileDraft)},()=>{/* observer fixture */},{minIntervalMs:60_000})
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh()
  service.update([{...fileA,version:'f2',content:'Active voice project, now with a workbench'},fileB])
  assert.equal(service.snapshot().status,'ready');assert.deepEqual(service.snapshot().draft,fileDraft)
  service.update([]);assert.equal(service.snapshot().draft,null)
  service.update([fileA,fileB]);assert.deepEqual(service.snapshot().draft,fileDraft,'a root that is briefly absent does not delete its facts');assert.equal(calls,1)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a withdrawn source leaves disk while the rest of the draft survives',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'))
 const make=()=>new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(fileDraft),()=>{/* observer fixture */},{minIntervalMs:60_000})
 let service=make()
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh()
  await service.forgetUnavailable(new Set([fileA.id]));await service.close()
  service=make();await service.open();service.update([fileA,fileB])
  assert.deepEqual(service.snapshot().draft,{...fileDraft,interests:[]})
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('invented references are dropped, and a draft with nothing grounded fails as evidence',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let invent=true;const outcomes:ProfileOutcome['outcome'][]=[]
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(invent?{...draft,about:{text:'Invented',refs:[{entry_id:'unknown',version:1}]},interests:[]}:{...draft,about:{text:'Invented',refs:[{entry_id:'unknown',version:1}]}}),()=>{/* observer fixture */},{report:r=>outcomes.push(r.outcome),backoffMs:[60_000]})
 try{
  await service.open();service.update(entries);await service.refresh()
  assert.equal(service.snapshot().status,'failed');assert.equal(service.snapshot().draft,null)
  invent=false;await service.refresh(true)
  assert.equal(service.snapshot().status,'ready');assert.deepEqual(service.snapshot().draft,{...draft,about:null})
  await until(()=>outcomes.length===2);assert.deepEqual(outcomes,['evidence','ok'])
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a timed-out generation retries on its own with backoff',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let calls=0;const outcomes:ProfileOutcome['outcome'][]=[]
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>++calls===1?new Promise(()=>{/* ignores its signal */}):Promise.resolve(draft),()=>{/* observer fixture */},{timeoutMs:20,backoffMs:[20],report:r=>outcomes.push(r.outcome)})
 try{
  await service.open();service.update(entries)
  await until(()=>service.snapshot().status==='ready')
  assert.equal(calls,2);assert.deepEqual(outcomes,['timeout','ok'])
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('automatic retries stop once the backoff ladder is spent',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let calls=0
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>{calls++;return Promise.reject(Error('provider_down'))},()=>{/* observer fixture */},{backoffMs:[5,5]})
 try{
  await service.open();service.update(entries)
  await until(()=>calls===3);await new Promise(r=>setTimeout(r,50))
  assert.equal(calls,3);assert.equal(service.snapshot().status,'failed')
  await service.refresh(true);assert.equal(calls,4)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a withdrawal during generation or during the draft write never leaves the withdrawn facts on disk',async()=>{
 for(const when of ['generating','writing'] as const){
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let resolve!:(v:typeof fileDraft)=>void
  const make=(generate:()=>Promise<typeof fileDraft>)=>new ProfileWarmup(join(dir,'draft.json'),generate,()=>{/* observer fixture */},{minIntervalMs:60_000})
  let service=make(()=>new Promise(r=>{resolve=r}))
  try{
   await service.open();service.update([fileA,fileB]);const run=service.refresh()
   if(when==='generating'){await service.forgetUnavailable(new Set([fileA.id]));resolve(fileDraft)}
   else{resolve(fileDraft);await until(()=>service.snapshot().draft!==null);await service.forgetUnavailable(new Set([fileA.id]))}
   await run;await service.close()
   service=make(()=>new Promise(()=>{/* never regenerates */}));await service.open();service.update([fileA,fileB])
   assert.deepEqual(service.snapshot().draft,{...fileDraft,interests:[]},when)
  }finally{await service.close();await rm(dir,{recursive:true,force:true})}
 }
})
test('a failed draft write after a withdrawal never restores the withdrawn facts',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-')),fileA2={...fileA,version:'f2'};let resolve!:(v:typeof fileDraft)=>void,calls=0
 const aOnly={about:{text:'Ships the voice agent',refs:[{entry_id:fileA2.id,version:fileA2.version}]},work:[],interests:[]}
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>++calls===1?Promise.resolve(fileDraft):new Promise(r=>{resolve=r}),()=>{/* observer fixture */})
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh();assert.equal(service.snapshot().draft?.interests.length,1)
  service.update([fileA2,fileB]);await chmod(dir,0o500);const run=service.refresh()
  resolve(aOnly)
  // Withdraw B after the A-only draft is installed and before its write fails.
  for(let i=0;i<50&&service.snapshot().draft?.about?.text!==aOnly.about.text;i++)await new Promise(r=>setImmediate(r))
  assert.equal(service.snapshot().status,'working','the withdrawal lands while the draft write is pending')
  await service.forgetUnavailable(new Set([fileA.id])).catch(()=>{/* the directory is read-only */});await run
  await chmod(dir,0o700);service.update([fileA2,{...fileB,version:'f2'}])
  assert.deepEqual(service.snapshot().draft?.interests??[],[],'resuming the source does not bring back its withdrawn facts')
 }finally{await chmod(dir,0o700);await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a source resumed with unchanged content is read again',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'))
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(fileDraft),()=>{/* observer fixture */})
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh()
  await service.forgetUnavailable(new Set([fileA.id]));assert.deepEqual(service.snapshot().sources.map(s=>s.id),[fileA.id])
  service.update([fileA,fileB]);assert.deepEqual(service.snapshot().sources.map(s=>s.id),[fileA.id,fileB.id])
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a profile answer citing a withdrawn project digest is dropped even when the project is re-digested before it returns',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'));let resolve!:(v:typeof fileDraft)=>void
 const project={id:'project:k',version:'d1',content:'Voice agent from secret notes',origin:'inferred' as const,source:{project:'Nova',document:''}}
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>new Promise(r=>{resolve=r}),()=>{/* observer fixture */})
 try{
  await service.open();service.update([project,fileB]);const run=service.refresh()
  await service.forgetUnavailable(new Set([fileB.id]))
  service.update([{...project,version:'d2',content:'Voice agent'},fileB])
  resolve({about:{text:'Works on secret notes',refs:[{entry_id:project.id,version:project.version}]},work:[],interests:[{text:'Speech models',refs:[{entry_id:fileB.id,version:fileB.version}]}]})
  await run
  assert.equal(service.snapshot().draft?.about??null,null,'the fact grounded in the withdrawn digest never lands')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a reply without about keeps the previous about only while its evidence is current and was not withdrawn',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-'))
 const withoutAbout={about:null,work:[],interests:[{text:'Speech models',refs:[{entry_id:fileB.id,version:'f2'}]}]}
 let reply:()=>Promise<unknown>=()=>Promise.resolve(fileDraft)
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>reply() as never,()=>{/* observer fixture */},{minIntervalMs:60_000})
 const fileB2={...fileB,version:'f2',content:'Reads papers on speech models and codecs'}
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh()
  reply=()=>Promise.resolve(withoutAbout);service.update([fileA,fileB2]);await service.refresh()
  assert.deepEqual(service.snapshot().draft,{...withoutAbout,about:fileDraft.about},'the new work and interests replace the old; the missing about is kept')
  reply=()=>service.forgetUnavailable(new Set([fileB2.id])).then(()=>{service.update([fileA,{...fileB2,version:'f3'}]);return withoutAbout})
  service.update([fileA,{...fileB2,version:'f4'}]);await service.refresh()
  assert.equal(service.snapshot().draft?.about??null,null,'an about whose source was withdrawn during the call is not kept, even when the source returns')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a corrected statement does not keep the about it grounded, on screen or on disk',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-')),path=join(dir,'draft.json')
 let reply:unknown=draft
 const service=new ProfileWarmup(path,()=>Promise.resolve(reply) as never,()=>{/* observer fixture */})
 try{
  await service.open();service.update(entries);await service.refresh()
  reply={about:null,work:[],interests:[{text:'Speech',refs:[{entry_id:'a',version:2}]}]}
  service.update([{...entries[0]!,version:2,content:'I study speech models'}]);await service.refresh()
  assert.equal(service.snapshot().draft?.about,null)
  assert.equal((JSON.parse(await readFile(path,'utf8')) as {draft:{about:unknown}}).draft.about,null)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a re-read source that now says something else does not keep the about it grounded, even after reopening',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-')),path=join(dir,'draft.json')
 let reply:unknown=fileDraft
 const make=()=>new ProfileWarmup(path,()=>Promise.resolve(reply) as never,()=>{/* observer fixture */})
 let service=make()
 const fileA2={...fileA,version:'f2',content:'Voice project cancelled; now a text editor'}
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh()
  reply={about:null,work:[{title:'Text editor',text:'Building a text editor',refs:[{entry_id:fileA.id,version:'f2'}]}],interests:[]}
  service.update([fileA2,fileB]);await service.refresh()
  assert.equal(service.snapshot().draft?.about,null)
  await service.close();service=make();await service.open();service.update([fileA2,fileB])
  assert.equal(service.snapshot().draft?.about,null,'the stale about is not on disk either')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})


test('a verified newer message draft does not resurrect omitted historical plans',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-profile-retired-plan-'));let calls=0;
 const old={id:'old-message',version:1,content:'Plan to deploy',origin:'inferred' as const,observed_at:'2026-10-01T00:00:00Z',source:{kind:'im' as const,project:'IM',document:'Message',relation:'self' as const}};
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(++calls===1?{about:{text:'Building a UI',refs:[{entry_id:old.id,version:1}]},work:[{title:'Deployment',text:'Plans deployment',refs:[{entry_id:old.id,version:1}]}],interests:[]}:{about:{text:'Working on the UI; deployment cancelled',refs:[{entry_id:'new-message',version:1}]},work:[],interests:[]}),()=>{/* observer */});
 try{await service.open();service.update([old]);await service.refresh();service.update([old,{...old,id:'new-message',content:'Deployment cancelled',observed_at:'2026-10-10T00:00:00Z'}]);await service.refresh();assert.deepEqual(service.snapshot().draft?.work,[])}finally{await service.close();await rm(dir,{recursive:true,force:true})}
});

const cites=(file:typeof fileA)=>[{entry_id:file.id,version:file.version}]
const oldWork={title:'Old pipeline project list',text:'Written by the previous pipeline',refs:cites(fileA)}
test('a draft written by an older pipeline stays visible, is regenerated at once and is replaced whole',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-version-')),path=join(dir,'draft.json');let phase=1,calls=0
 const reply=()=>{calls++;return Promise.resolve(phase===1?{...fileDraft,work:[oldWork]}:{about:{text:'A fresh understanding',refs:cites(fileA)},work:[],interests:[]})}
 let service=new ProfileWarmup(path,reply,()=>{/* snapshot observer */})
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh();assert.equal(service.snapshot().draft?.work.length,1);await service.close()
  const disk=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;assert.equal(disk.generation_version,PROFILE_GENERATION_VERSION)
  await writeFile(path,JSON.stringify({...disk,generation_version:'a-previous-pipeline'}))
  phase=2;let release:(()=>void)|undefined
  service=new ProfileWarmup(path,async()=>{await new Promise<void>(resolve=>{release=resolve});return reply()},()=>{/* snapshot observer */})
  await service.open();service.update([fileA,fileB])
  assert.equal(service.snapshot().status,'working','an old draft is regenerated at once, not on the 5/30/240 minute ladder')
  assert.equal(service.snapshot().draft?.work[0]?.title,'Old pipeline project list','the old draft stays visible while the new one is written')
  release?.();await service.refresh()
  const after=service.snapshot().draft;assert.equal(after?.about?.text,'A fresh understanding');assert.equal(after?.work.length,0,'nothing from the old pipeline is mixed into the new draft')
  assert.equal((JSON.parse(await readFile(path,'utf8')) as {generation_version:string}).generation_version,PROFILE_GENERATION_VERSION)
  const before=calls;service.update([fileA,fileB]);await service.refresh();assert.equal(calls,before,'once replaced, the same inputs are not regenerated again')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('a cache file from before versions were stored is read and counts as an older pipeline',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-legacy-')),path=join(dir,'draft.json');let calls=0
 const make=()=>new ProfileWarmup(path,()=>{calls++;return Promise.resolve({...fileDraft,work:[oldWork]})},()=>{/* snapshot observer */})
 let service=make()
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh();await service.close()
  const {generation_version:_dropped,...legacy}=JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;void _dropped
  await writeFile(path,JSON.stringify(legacy));service=make();await service.open()
  service.update([fileA,fileB]);assert.equal(service.snapshot().status,'working');await service.refresh();assert.equal(calls,2)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})
test('an explicit refresh replaces the draft whole, while ordinary source churn still keeps grounded work',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-manual-'));let calls=0
 const service=new ProfileWarmup(join(dir,'draft.json'),()=>Promise.resolve(++calls===1?{...fileDraft,work:[oldWork]}:{about:{text:'Written on request',refs:cites(fileA)},work:[],interests:[]}),()=>{/* snapshot observer */})
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh();assert.equal(service.snapshot().draft?.work.length,1)
  await service.refresh(true);const replaced=service.snapshot().draft
  assert.equal(calls,2);assert.equal(replaced?.about?.text,'Written on request');assert.equal(replaced?.work.length,0,'a manual update drops the previous draft instead of merging it')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})

test('a draft written while other people\'s messages were read leaves disk when that switch is off',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-participants-')),path=join(dir,'draft.json')
 const make=(participants:boolean)=>new ProfileWarmup(path,()=>Promise.resolve(fileDraft),()=>{/* snapshot observer */},{participants})
 let service=make(true)
 try{
  await service.open();service.update([fileA,fileB]);await service.refresh();assert.ok(service.snapshot().draft);await service.close()
  assert.equal((JSON.parse(await readFile(path,'utf8')) as {participants:boolean}).participants,true)
  service=make(true);await service.open();service.update([fileA,fileB]);assert.ok(service.snapshot().draft,'with the switch still on the draft is kept');await service.close()
  service=make(false);await service.open()
  const disk=JSON.parse(await readFile(path,'utf8')) as {draft:unknown;participants:boolean};assert.equal(disk.draft,null,'the draft is removed from disk, not only hidden');assert.equal(disk.participants,false)
  service.update([fileA,fileB]);assert.equal(service.snapshot().draft,null)
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})

const message=(id:string,relation:'self'|'addressed'|'participant'):ProfileInput=>({id,version:'m1',content:'message '+id,origin:'inferred',source:{project:'chat',document:'',kind:'im',relation}})
test('other people\'s messages keep their own slots after the user\'s 96 messages, and are left out when the switch is off',async()=>{
 const own=Array.from({length:64},(_,i)=>message('own-'+i,i%2?'self':'addressed')),others=Array.from({length:32},(_,i)=>message('other-'+i,'participant'))
 for(const participants of [true,false]){
  const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-warmup-slots-'));let seen:readonly ProfileInput[]=[]
  const service=new ProfileWarmup(join(dir,'draft.json'),entries=>{seen=entries;return Promise.resolve({about:{text:'x',refs:[{entry_id:'own-0',version:'m1'}]},work:[],interests:[]})},()=>{/* snapshot observer */},{participants})
  try{
   await service.open();service.update([...own,...Array.from({length:32},(_,i)=>message('more-'+i,'addressed')),...others]);await service.refresh()
   assert.equal(seen.filter(e=>e.source?.relation==='participant').length,participants?32:0,participants?'all 32 other-people messages reach the generator':'none do when the switch is off')
   assert.equal(seen.filter(e=>e.source?.relation!=='participant').length,96,'the user\'s own messages keep their 96')
  }finally{await service.close();await rm(dir,{recursive:true,force:true})}
 }
})
