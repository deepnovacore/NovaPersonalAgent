import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ExperienceSpaces} from '../src/main/experience-spaces.mjs'
import {bindExperienceController} from '../src/renderer/experience-controller.mjs'
import {PersonalController} from '../src/renderer/personal-controller.mjs'

const files={profile:Buffer.from('{}'),sources:Buffer.from('{"records":[]}'),memory:Buffer.from('{"entries":[]}'),snapshot:Buffer.from('{"source_version":"sample","profile":[],"timeline":[]}'),avatar:Buffer.from('sample')}
const assets={manifest:{version:1,personas:[{id:'sample-a',name:'Sample A',occupation:'Research',sha256:{sources:'a'.repeat(64)}},{id:'sample-b',name:'Sample B',occupation:'Design',sha256:{sources:'b'.repeat(64)}}]},files:new Map([['sample-a',files],['sample-b',files]])}
const codec={available:()=>true,encrypt:value=>Buffer.from('encrypted:'+value),decrypt:value=>value.toString().slice(10)}
test('absent optional bundle leaves ordinary runtime untouched',async()=>{
 const service=new ExperienceSpaces({directory:'/unused',codec,loadAssets:async()=>null,loadRuntime:async()=>{throw Error('must not load')}})
 assert.deepEqual(await service.list(),{available:false,active:null,epoch:0,personas:[],snapshot:null})
})
test('persona uses separate host paths, gateway scope and encrypted install identity; selection survives restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'experience-service-')),hosts=[],requests=[],changes=[]
 const loadRuntime=async()=>({createExperienceHost:async options=>{hosts.push(options);return {snapshot:()=>({type:'personal.state',revision:1,experience:{name:options.name}}),command:async()=>({ok:true}),close:async()=>{}}}})
 const fetcher=async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body,headers:options.headers});if(url.endsWith('/token'))return Response.json({token:'sample-token',expires_at:Date.now()+300000,tester_id:'sample-tester'});if(url.endsWith('/v1/chat/completions'))return Response.json({choices:[{message:{content:'sample reply'}}]});return Response.json({ok:true})}
 const make=()=>new ExperienceSpaces({directory,codec,loadAssets:async()=>assets,loadRuntime,fetcher,changed:value=>changes.push(value)})
 const service=make()
 try{
  await service.list();await service.select('sample-a');const before=service.epoch
  await service.redeem('sample-code')
  assert.equal(await hosts[0].complete([{role:'user',content:'sample'}],new AbortController().signal),'sample reply')
  assert.equal(requests.find(row=>row.url.endsWith('/token')).body.scope,'text')
  const secret=requests[0].body.installation_secret
  assert.ok((await readFile(join(directory,'installation.secret'),'utf8')).startsWith('encrypted:'))
  assert.equal(JSON.stringify(service.view()).includes(secret),false)
  await service.select('sample-b');assert.notEqual(hosts[0].path,hosts[1].path)
  await assert.rejects(service.send({id:'sample-a',epoch:before,frame:{type:'personal.command'}}),/experience_space_changed/)
  const restarted=make();assert.equal((await restarted.list()).active,'sample-b')
 }finally{await rm(directory,{recursive:true,force:true})}
})
test('late async model completion is fenced after switching persona',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'experience-fence-'));let resolveReply,optionsA
 const service=new ExperienceSpaces({directory,codec,loadAssets:async()=>assets,loadRuntime:async()=>({createExperienceHost:async options=>{optionsA??=options;return {snapshot:()=>({}),close:async()=>{}}}}),fetcher:async url=>url.endsWith('/token')?Response.json({token:'sample',expires_at:Date.now()+300000}):new Promise(resolve=>{resolveReply=resolve})})
 try{
  await service.list();await service.select('sample-a');const reply=optionsA.complete([],new AbortController().signal);while(!resolveReply)await new Promise(resolve=>setImmediate(resolve))
  await service.select('sample-b');resolveReply(Response.json({choices:[{message:{content:'stale'}}]}));await assert.rejects(reply,/experience_space_changed/)
 }finally{await rm(directory,{recursive:true,force:true})}
})
test('experience controller never sends to personal transport and rejects stale persona frames',async()=>{
 const real=[],experience=[],state={type:'personal.state',revision:1,conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main'}],messages:[]}}
 let changed,resolveReply
 const api={list:async()=>({available:true,active:'sample-a',epoch:1,snapshot:state}),onChanged:callback=>{changed=callback;return()=>{}},send:request=>{experience.push(request);return new Promise(resolve=>{resolveReply=resolve})}}
 const controller=new PersonalController({send:frame=>{real.push(frame);return true},start:async()=>{},stop:async()=>{}})
 const binding=bindExperienceController(controller,api)
 await new Promise(resolve=>setImmediate(resolve));assert.equal(controller.connected,true)
 const pending=controller.command('life.mutate',{op:'create',kind:'todo',title:'Sample'});const rejection=assert.rejects(pending,/Space changed/)
 assert.equal(real.length,0);assert.equal(experience.length,1)
 changed({type:'selection',active:'sample-b',epoch:2,snapshot:{...state,experience:{name:'Sample B'}}});await rejection
 resolveReply({frame:{type:'personal.result',request_id:experience[0].frame.request_id,ok:true,data:{}}});await new Promise(resolve=>setImmediate(resolve))
 assert.equal(controller.snapshot.experience.name,'Sample B')
 assert.equal(binding.acceptBackend({...state,revision:999}),false)
 binding.dispose()
})
test('unresolved or failed selection never opens the real transport',async()=>{
 for(const failure of [false,true]){
  let resolveList,rejectList;const sent=[],controller=new PersonalController({send:frame=>{sent.push(frame);return true},start:async()=>{},stop:async()=>{}})
  const binding=bindExperienceController(controller,{list:()=>new Promise((resolve,reject)=>{resolveList=resolve;rejectList=reject}),onChanged:()=>()=>{},send:async()=>{throw Error('unexpected')}})
  await controller.connect()
  assert.equal(binding.acceptBackend({type:'personal.state',revision:1}),false)
  assert.equal(controller.send({type:'input.text'}),false);assert.equal(sent.length,0)
  if(failure)rejectList(Error('unavailable'));else resolveList({active:null,epoch:0,available:false})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(binding.acceptBackend({type:'client.ready'}),!failure)
  if(failure){assert.equal(controller.connected,false);assert.ok(controller.error)}else assert.equal(controller.connected,true)
  binding.dispose()
 }
})
test('switching A to B to A restores an unsettled draft without permanently holding the composer',async()=>{
 const state={type:'personal.state',revision:1,conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main'}],messages:[]}}
 let changed,resolveReply
 const controller=new PersonalController({send:()=>{throw Error('real transport')},start:async()=>{},stop:async()=>{}})
 const binding=bindExperienceController(controller,{list:async()=>({active:'sample-a',epoch:1,snapshot:state}),onChanged:callback=>{changed=callback;return()=>{}},send:()=>new Promise(resolve=>{resolveReply=resolve})})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(controller.submitText('Pending sample'),true)
 assert.ok(controller.state().submission)
 changed({type:'selection',active:'sample-b',epoch:2,snapshot:state})
 resolveReply({frame:{type:'input.text_result',ok:true}})
 changed({type:'selection',active:'sample-a',epoch:3,snapshot:state})
 assert.equal(controller.state().submission,null);assert.equal(controller.draft,'Pending sample')
 assert.equal(controller.submitText('Next sample'),true)
 binding.dispose()
})

test('profile tokens reserve a full refresh window while text keeps its short margin',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'experience-token-window-')),requests=[]
 const service=new ExperienceSpaces({directory,codec,loadAssets:async()=>null,fetcher:async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({token:'renewed',expires_at:Date.now()+300000})}})
 try{
  await service.list()
  service.tokens.set('profile',{token:'too-short',expires:Date.now()+200000})
  service.tokens.set('text',{token:'valid-text',expires:Date.now()+200000})
  assert.equal(await service.token('profile'),'renewed')
  assert.equal(await service.token('text'),'valid-text')
  assert.equal(await service.token('profile'),'renewed')
  assert.deepEqual(requests.map(row=>row.scope),['profile'])
 }finally{await rm(directory,{recursive:true,force:true})}
})
