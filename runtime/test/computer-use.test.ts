import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sharp from 'sharp'
import {z} from '@midscene/core'
import {actionTapParamSchema,actionScrollParamSchema,actionKeyboardPressParamSchema} from '@midscene/core/device'
import {type ComputerSessionOptions,ComputerSession} from '../src/personal-agent/computer-use/session.js'
import {computerTools} from '../src/personal-agent/computer-use/tools.js'
import {taskResourcesBusy,releaseQuarantinedTaskResources} from '../src/executors/task-resources.js'
import {COMPUTER_RESOURCE} from '../src/personal-agent/computer-use/contract.js'
import type {startComputerBackend} from '../src/executors/computer-backend.js'

async function fixture(approve:(name:string)=>Promise<boolean>=()=>Promise.resolve(true),settings:Partial<ComputerSessionOptions>={}){
 const root=await mkdtemp(join(tmpdir(),'computer-session-'))
 const image='data:image/png;base64,'+(await sharp({create:{width:2560,height:1440,channels:3,background:'white'}}).png().toBuffer()).toString('base64')
 let target='window-one',closed=0,connected=0,cleanup=true,width=1024
 let backendWindow:unknown
 let closeGate=Promise.resolve(),writeFailure=false,afterWrite=()=>{ /* Optional failure hook. */ }
 const acting:string[]=[],events:string[]=[],points:({x:number;y:number}|undefined)[]=[]
 const writes:{name:string;params:unknown}[]=[],approvals:string[]=[]
 const backend:Awaited<ReturnType<typeof startComputerBackend>>={
  pid:process.pid,device:{interfaceType:'computer',size:()=>Promise.resolve({width,height:576}),screenshotBase64:()=>Promise.resolve(image),
   actionSpace:()=>['Tap','Input','Scroll','KeyboardPress'].map(name=>({name,paramSchema:name==='Tap'?actionTapParamSchema:name==='Input'?z.object({value:z.string()}):name==='Scroll'?actionScrollParamSchema:actionKeyboardPressParamSchema,call:(params:unknown)=>{events.push('input');writes.push({name,params});afterWrite();return writeFailure?Promise.reject(Error('cleanup_unknown')):Promise.resolve()}}))},
  connect:()=>{connected++;return Promise.resolve()},listDisplays:()=>Promise.resolve([{id:'1'}]),close:async()=>{closed++;await closeGate;return cleanup},
  windowTarget:()=>Promise.resolve({target,width,height:576}),releaseInput:()=>Promise.resolve(),
 }
 let observationId=''
 const session=new ComputerSession({signal:new AbortController().signal,config:{displayId:'1',lockRoot:root,baseUrl:'https://example.test',apiKey:'test',model:'test',modelFamily:'qwen3-vl',maxSteps:10,budgetMs:1000,settleMs:0},
  backend:(_display,_signal,_budget,_worker,_resources,_hold,window)=>{backendWindow=window;return Promise.resolve(backend)},foreground:()=>Promise.resolve({target,width,height:576}),approve:name=>{approvals.push(name);return approve(name)},acting:(name,point)=>{events.push('acting');acting.push(name);points.push(point)},...settings})
 return {session,backendWindow:()=>backendWindow,setWidth:(value:number)=>{width=value},observe:async()=>{const value=await session.observe();observationId=value.id;return value.image},action:(name:Parameters<ComputerSession['action']>[0],args:Record<string,unknown>)=>session.action(name,{observationId,...args}),writes,approvals,acting,events,points,afterWrite:(effect:()=>void)=>{afterWrite=effect},failWrite:()=>{writeFailure=true},setTarget:(value:string)=>{target=value},setCleanup:(value:boolean)=>{cleanup=value},delayClose:(gate:Promise<void>)=>{closeGate=gate},connected:()=>connected,closed:()=>closed,
  dispose:async()=>{await session.close().catch(()=>{ /* test asserts cleanup errors separately */ });releaseQuarantinedTaskResources([COMPUTER_RESOURCE]);await rm(root,{recursive:true,force:true})}}
}
test('computer tools restrict non-vision models to delegation',{timeout:5000},()=>{
 assert.deepEqual(computerTools(false).map(tool=>tool.name),['computer_run'])
 assert.equal(computerTools(true).length,6)
})
test('session requires observation, approves Connect once, scales screenshots and releases lease',{timeout:5000},async()=>{
 const f=await fixture()
 try{
  await assert.rejects(f.action('computer_click',{x:0,y:0}),/observe_required/)
  const image=await f.observe();assert.equal(image.width,1280);assert.equal(image.height,720)
  assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)
  await assert.rejects(f.action('computer_click',{x:1280,y:0}),/invalid_params/)
  await f.action('computer_click',{x:640,y:360})
  assert.deepEqual(f.writes,[{name:'Tap',params:{locate:{prompt:'screenshot coordinate',center:[512,288]}}}])
  assert.deepEqual(f.points,[{x:512,y:288}]);assert.deepEqual(f.events,['acting','input'])
  await f.observe()
  await f.action('computer_type',{text:'hello'})
  await f.observe()
  await f.action('computer_key',{keys:'Enter'})
  await assert.rejects(f.action('computer_click',{x:0,y:0}),/observe_required/)
  await f.observe()
  assert.deepEqual(f.approvals,['Connect','Tap','Input','KeyboardPress']);assert.equal(f.connected(),1)
  await f.session.close();assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),false);assert.equal(f.closed(),1)
 }finally{await f.dispose()}
})
test('declined Connect never connects or sends input and releases both locks',{timeout:5000},async()=>{
 const f=await fixture(()=>Promise.resolve(false))
 try{await assert.rejects(f.observe(),/declined/);assert.equal(f.connected(),0);assert.equal(f.writes.length,0);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),false)}
 finally{await f.dispose()}
})
test('foreground changed during approval blocks input',{timeout:5000},async()=>{
 const f=await fixture(name=>{if(name==='Tap')f.setTarget('other-window');return Promise.resolve(true)})
 try{await f.observe();await assert.rejects(f.action('computer_click',{x:10,y:10}),/screen_changed/);assert.equal(f.writes.length,0);assert.equal(f.acting.length,0)}
 finally{await f.dispose()}
})
test('unconfirmed backend cleanup quarantines the resource',{timeout:5000},async()=>{
 const f=await fixture()
 try{await f.observe();f.setCleanup(false);await assert.rejects(f.session.close(),/cleanup_unknown/);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)}
 finally{await f.dispose()}
})
test('concurrent close calls retain ownership until the backend is gone',{timeout:5000},async()=>{
 const f=await fixture();let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 try{
  await f.observe();f.delayClose(gate)
  const first=f.session.close(),second=f.session.close()
  assert.equal(first,second);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)
  release();await Promise.all([first,second]);assert.equal(f.closed(),1);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),false)
 }finally{release();await f.dispose()}
})
test('ambiguous input remains quarantined even when backend cleanup succeeds',{timeout:5000},async()=>{
 const f=await fixture()
 try{
  await f.observe();f.failWrite()
  await assert.rejects(f.action('computer_click',{x:10,y:10}),/cleanup_unknown/)
  await assert.rejects(f.session.close(),/cleanup_unknown/)
  assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)
 }finally{await f.dispose()}
})

test('whole-screen Connect approval may change foreground before the first observation',{timeout:5000},async()=>{
 const f=await fixture(name=>{if(name==='Connect')f.setTarget('approval-window');return Promise.resolve(true)})
 try{await f.observe();assert.equal(f.connected(),1);await f.action('computer_click',{x:10,y:10});assert.equal(f.writes.length,1)}
 finally{await f.dispose()}
})

test('an intentional app switch accepts a fresh screenshot and targets the new app',{timeout:5000},async()=>{
 const f=await fixture()
 try{
  await f.observe();f.afterWrite(()=>f.setTarget('launched-app'))
  await f.action('computer_key',{keys:'cmd+tab'})
  await f.observe()
  await f.action('computer_click',{x:10,y:10})
  assert.deepEqual(f.writes.map(write=>write.name),['KeyboardPress','Tap'])
 }finally{await f.dispose()}
})

test('observation exposes identity and rejects stale writes',async()=>{
 const f=await fixture()
 try{
  const observation=await f.session.observe()
  assert.equal(observation.image.width,1280)
  assert.equal(observation.space.logical_width,1024)
  assert.equal(observation.ax.status,'unavailable')
  await assert.rejects(f.session.action('computer_click',{x:10,y:10,observationId:'stale'}),/observe_required/)
  await f.session.action('computer_type',{text:'hello',mode:'append',observationId:observation.id})
  await assert.rejects(f.session.action('computer_key',{keys:'Enter',observationId:observation.id}),/observe_required/)
 }finally{await f.dispose()}
})

test('environment window does not leak into whole-screen session',async()=>{
 const f=await fixture()
 try{
  const config={...f.session.config,macWindow:{pid:123,windowId:456}}
  const other=new ComputerSession({config,signal:new AbortController().signal,approve:()=>Promise.resolve(true),acting:()=>{ /* No physical input. */ }})
  assert.equal(other.config.macWindow,undefined)
  assert.deepEqual(config.macWindow,{pid:123,windowId:456})
  await other.close()
  await f.observe();assert.equal(f.backendWindow(),undefined)
 }finally{await f.dispose()}
})
for(const status of ['ok','unavailable','timeout','truncated'] as const)test(`foreground AX reports ${status} without binding screenshot to environment`,async()=>{
 const calls:Record<string,unknown>[]=[]
 const f=await fixture(undefined,{foreground:()=>Promise.resolve({target:JSON.stringify([123,'test.app',456,{}]),width:1024,height:576}),nativeRequest:input=>{
  calls.push(input)
  return Promise.resolve(input.op==='target'?{target:'native-window'}:{status,available:false,...(status==='ok'||status==='truncated'?{native_ui:{source:'accessibility',content:[],truncated:status==='truncated'}}:{})})
 }})
 try{const observed=await f.session.observe();assert.equal(observed.ax.status,status);assert.equal(observed.target,null);assert.deepEqual(observed.focus,{pid:123,window_id:456});assert.equal(calls.at(-1)?.op,'editor')}
 finally{await f.dispose()}
})
test('geometry change during approval refuses input',async()=>{
 const f=await fixture(name=>{if(name==='Tap')f.setWidth(1000);return Promise.resolve(true)})
 try{await f.observe();await assert.rejects(f.action('computer_click',{x:10,y:10}),/screen_changed/);assert.equal(f.writes.length,0)}finally{await f.dispose()}
})
test('session wall clock cancels a pending consent without input',async()=>{
 const f=await fixture(()=>new Promise(()=>{ /* Consent never arrives. */ }))
 try{await assert.rejects(f.observe(),/cancelled/);assert.equal(f.writes.length,0);assert.equal(f.connected(),0)}finally{await f.dispose()}
})
for(const mode of ['append','replace'] as const)test(`type ${mode} reaches driver unchanged`,async()=>{
 const f=await fixture()
 try{await f.observe();const result=await f.action('computer_type',{text:'hello',mode});assert.equal(result.executionMode,'activated');assert.deepEqual(f.writes[0],{name:'Input',params:{value:'hello',mode}})}finally{await f.dispose()}
})
test('explicit application binds background input and returns its window metadata',async()=>{
 const f=await fixture(undefined,{nativeRequest:input=>Promise.resolve(input.op==='applicationTarget'?{pid:123,windowId:456,target:'window-one',title:'Document',application:{name:'Editor',bundleId:'test.editor',path:'/Applications/Editor.app'}}:{status:'unavailable',available:false})})
 try{
  const observed=await f.session.observe('Editor')
  assert.deepEqual(observed.target,{application:'test.editor',pid:123,window_id:456,title:'Document'})
  assert.deepEqual(f.backendWindow(),{pid:123,windowId:456})
  const receipt=await f.session.action('computer_type',{text:'new value',mode:'replace',observationId:observed.id})
  assert.equal(receipt.executionMode,'background')
 }finally{await f.dispose()}
})
test('background target is independent of unavailable foreground metadata',async()=>{
 const f=await fixture(undefined,{foreground:()=>Promise.reject(Error('multiple displays')),nativeRequest:input=>Promise.resolve(input.op==='applicationTarget'?{pid:123,windowId:456,target:'window-one',application:{name:'Editor',bundleId:'test.editor',path:'/Applications/Editor.app'}}:{status:'unavailable',available:false})})
 try{const observed=await f.session.observe('Editor');assert.equal(observed.target?.pid,123);assert.equal(observed.focus,null)}finally{await f.dispose()}
})
test('Windows-shaped focus metadata does not imply AX support',async()=>{
 const f=await fixture(undefined,{foreground:()=>Promise.resolve({target:JSON.stringify([123,456,[0,0,1024,576]]),width:1024,height:576})})
 try{const observed=await f.session.observe();assert.deepEqual(observed.focus,{pid:123,window_id:456});assert.equal(observed.ax.status,'unavailable')}finally{await f.dispose()}
})
