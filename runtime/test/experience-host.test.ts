import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath,readFile,writeFile,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createExperienceHost} from '../src/experience/host.js'
import {resolveTimelineTime} from '../src/personal-agent/timeline-time.js'

test('isolated experience uses host life persistence and retains multi-turn history',async()=>{
 const directory=await mkdtemp(join(await realpath(tmpdir()),'experience-host-'))
 const calls:any[]=[]
 const options={path:join(directory,'personal.json'),personaId:'sample',name:'Sample',sourceVersion:'a'.repeat(64),records:[{id:'sample:1',source_id:'sample',kind:'mail',text:'Sample evidence',observed_at:'2026-01-01T00:00:00Z'}],memory:[{key:'sample',text:'Sample memory',kind:'fact',source:'sample:1',quote:'Sample'}],profile:{occupation:'Research'},snapshot:{source_version:'a'.repeat(64),profile:[{title:'Profile',text:'Sample profile',refs:['sample:1']}],timeline:[{title:'Sample event',summary:'Sample summary',refs:['sample:1']}]},complete:async(messages:any[])=>{calls.push(messages);return 'Sample reply'},refresh:async()=>({profile:[{title:'Updated',text:'New profile',refs:['sample:1']}],timeline:[]}),emit:()=>{}}
 let host=await createExperienceHost(options)
 try{
  assert.equal(host.snapshot().profile_preparation.draft.work[0]!.text,'Sample profile')
  assert.equal(host.snapshot().memory.entries[0]!.content,'Sample memory')
  assert.equal(host.snapshot().memory.entries[0]!.source_refs[0]!.ref,'sample:1')
  const result:any=await host.command({type:'personal.command',request_id:'new',method:'life.mutate',params:{op:'create',kind:'todo',title:'Sample todo'}})
  assert.equal(result.ok,true)
  const todo=host.snapshot().life.todos[0]!
  await host.command({type:'personal.command',request_id:'done',method:'life.mutate',params:{op:'update',kind:'todo',id:todo.id,expected_version:todo.version,status:'done'}})
  await host.input('chat:main','First','one');await host.wait('chat:main')
  await host.input('chat:main','Second','two');await host.wait('chat:main')
  assert.ok(calls[1].some((message:any)=>message.content==='First'))
  await host.command({type:'personal.command',request_id:'refresh',method:'profile.refresh',params:{}})
  assert.equal(JSON.parse(await readFile(options.path+'.experience.json','utf8')).source_version,options.sourceVersion)
  await host.close();host=await createExperienceHost(options)
  assert.equal(host.snapshot().life.todos[0]!.status,'done')
  assert.equal(host.snapshot().conversations.messages.length,4)
  assert.equal(host.snapshot().profile_preparation.draft.work[0]!.text,'New profile')
  const discussed:any=await host.command({type:'personal.command',request_id:'discuss',method:'conversations.discuss',params:{text:'Review this completed action',references:[{kind:'todo',id:todo.id,version:2}]}})
  assert.equal(discussed.ok,false);assert.equal(discussed.error,'stale_reference')
  await host.command({type:'personal.command',request_id:'reopen',method:'life.mutate',params:{op:'update',kind:'todo',id:todo.id,expected_version:2,status:'open'}})
  const nextDiscussion:any=await host.command({type:'personal.command',request_id:'discuss-open',method:'conversations.discuss',params:{text:'Plan this action',references:[{kind:'todo',id:todo.id,version:3}]}})
  assert.equal(nextDiscussion.ok,true);await host.wait('chat:main')
  const source:any=await host.command({type:'personal.command',request_id:'read',method:'source.read',params:{id:'sample:1'}})
  assert.equal(source.data.text,'Sample evidence')
 }finally{await host.close();await rm(directory,{recursive:true,force:true})}
})

function sampleOptions(path:string,version='a'.repeat(64),id='sample:1'){
 return {path,personaId:'sample',name:'Sample',sourceVersion:version,records:[{id,source_id:'sample',kind:'mail',text:'Current source '+version[0],observed_at:'2026-01-01T00:00:00Z'}],memory:[],profile:{},snapshot:{source_version:version,profile:[{title:'Baseline',text:'Baseline '+version[0],refs:[id]}],timeline:[{title:'Current event',summary:'Current summary',refs:[id]}]},complete:async()=> 'Sample reply',refresh:async()=>({profile:[],timeline:[]}),emit:()=>{}}
}
test('source upgrades and malformed saved projections recover the bundled baseline without losing old bytes',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'experience-upgrade-')),path=join(root,'personal.json'),file=path+'.experience.json'
 try{
  for(const [bytes,id] of [[JSON.stringify({source_version:'a'.repeat(64),profile:[{title:'Old',text:'Old profile',refs:['sample:1']}],timeline:[]}),'sample:1'],[JSON.stringify({source_version:'a'.repeat(64),profile:[{title:'Old',text:'Old profile',refs:['retired']}],timeline:[]}),'sample:2'],['{broken','sample:3']] as const){
   await writeFile(file,bytes,{mode:0o600})
   const host=await createExperienceHost(sampleOptions(path,'b'.repeat(64),id))
   try{assert.equal(host.snapshot().profile_preparation.draft.work[0]!.text,'Baseline b')}finally{await host.close()}
   assert.ok((await readdir(root)).some(name=>name.startsWith('personal.json.experience.json.recovery-')))
   const backups=await Promise.all((await readdir(root)).filter(name=>name.startsWith('personal.json.experience.json.recovery-')).map(name=>readFile(join(root,name),'utf8')))
   assert.ok(backups.includes(bytes))
  }
  const mismatched=sampleOptions(path);mismatched.snapshot.source_version='c'.repeat(64)
  await assert.rejects(createExperienceHost(mismatched),/experience_source_version_mismatch/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('displayed Timeline card discussion and draft use exact versioned source context',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'experience-timeline-')),calls:any[]=[]
 const options={...sampleOptions(join(root,'personal.json')),complete:async(messages:any[])=>{calls.push(messages);return 'Grounded sample reply'}}
 const host=await createExperienceHost(options)
 try{
  const card=host.snapshot().timeline.cards[0]!
  const request={type:'personal.command',request_id:'timeline-discuss',method:'conversations.discuss',params:{text:'Discuss this event',references:[{kind:'timeline',id:card.id,version:String(card.version)}]}}
  const result:any=await host.command(request);assert.equal(result.ok,true,JSON.stringify(result));await host.wait('chat:main')
  assert.ok(calls[0][0].content.includes('Current event'));assert.ok(calls[0][0].content.includes('referenced_material'))
  const started:any=await host.command({...request,request_id:'timeline-draft',method:'conversations.start',params:{...request.params,title:'Draft',references:[{kind:'timeline',id:card.id,version:String(card.version),interaction:'draft'}]}})
  assert.equal(started.ok,true,JSON.stringify(started));await host.wait(started.data.conversation_id)
  const stale:any=await host.command({...request,request_id:'stale-timeline',params:{...request.params,references:[{kind:'timeline',id:card.id,version:'retired'}]}})
  assert.equal(stale.ok,false);assert.equal(stale.error,'stale_reference')
  assert.ok(host.snapshot().timeline.cards[0]!.actions.length>=2)
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})

test('gateway timeline time survives projection, discussion, refresh versioning and restart while legacy snapshots still load',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'experience-time-')),calls:any[]=[]
 const base=sampleOptions(join(root,'personal.json'))
 const records=[{...base.records[0]!,text:'Deadline 2026-01-10. Meeting 2026-01-12. Revised deadline 2026-01-13.'}]
 const resolve=(kind:'deadline'|'scheduled',date:string)=>resolveTimelineTime({kind,dates:[{role:kind,date,ref:'sample:1',quote:records[0]!.text}]},records,{local_date:'2026-01-20',timezone:'UTC'})!
 const due=resolve('deadline','2026-01-10'),scheduled=resolve('scheduled','2026-01-12')
 assert.equal(due.due_on,'2026-01-10');assert.equal(scheduled.scheduled_on,'2026-01-12')
 assert.notEqual(due.anchor_date,due.last_reported_on);assert.notEqual(scheduled.anchor_date,scheduled.last_reported_on)
 let timeline=[{title:'Deadline',summary:'Sample deadline',refs:['sample:1'],time:due},{title:'Meeting',summary:'Sample meeting',refs:['sample:1'],time:scheduled}]
 const options={...base,records,refresh:async()=>({profile:[],timeline}),complete:async(messages:any[])=>{calls.push(messages);return 'Grounded sample reply'}}
 let host=await createExperienceHost(options)
 const refresh=()=>host.command({type:'personal.command',request_id:'time-refresh',method:'timeline.refresh',params:{}})
 try{
  assert.deepEqual(host.snapshot().timeline.cards[0]!.time,{as_of:'2026-01-01',kind:'event',last_reported_on:'2026-01-01'})
  await refresh()
  const cards=host.snapshot().timeline.cards
  assert.deepEqual(cards.map(card=>card.time),[due,scheduled])
  for(const [index,card] of cards.entries()){
   const result:any=await host.command({type:'personal.command',request_id:'time-discuss-'+index,method:'conversations.discuss',params:{text:'Discuss the actual date',references:[{kind:'timeline',id:card.id,version:card.version}]}})
   assert.equal(result.ok,true,JSON.stringify(result));await host.wait('chat:main')
   const system=JSON.parse(calls[index][0].content.split('\n')[1])
   assert.deepEqual(JSON.parse(system.referenced_material.text).card.time,card.time)
  }
  timeline=[{...timeline[0]!,time:resolve('deadline','2026-01-13')},timeline[1]!]
  await refresh()
  const changed=host.snapshot().timeline.cards
  assert.notEqual(changed[0]!.version,cards[0]!.version)
  assert.equal(changed[1]!.version,cards[1]!.version)
  const stale:any=await host.command({type:'personal.command',request_id:'stale-time',method:'conversations.discuss',params:{text:'Discuss old date',references:[{kind:'timeline',id:cards[0]!.id,version:cards[0]!.version}]}})
  assert.equal(stale.ok,false);assert.equal(stale.error,'stale_reference')
  const saved=JSON.parse(await readFile(options.path+'.experience.json','utf8'))
  assert.equal(saved.source_version,options.sourceVersion);assert.deepEqual(saved.timeline.map((row:any)=>row.time),timeline.map(row=>row.time))
  await host.close();host=await createExperienceHost(options)
  assert.deepEqual(host.snapshot().timeline.cards.map(card=>({time:card.time,version:card.version})),changed.map(card=>({time:card.time,version:card.version})))
 }finally{await host.close();await rm(root,{recursive:true,force:true})}
})
