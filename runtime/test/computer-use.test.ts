import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sharp from 'sharp'
import {z} from '@midscene/core'
import {actionTapParamSchema,actionScrollParamSchema,actionKeyboardPressParamSchema} from '@midscene/core/device'
import {ComputerSession} from '../src/personal-agent/computer-use/session.js'
import {computerTools} from '../src/personal-agent/computer-use/tools.js'
import {taskResourcesBusy,releaseQuarantinedTaskResources} from '../src/executors/task-resources.js'
import {COMPUTER_RESOURCE} from '../src/personal-agent/computer-use/contract.js'
import type {startComputerBackend} from '../src/executors/computer-backend.js'

async function fixture(approve:(name:string)=>Promise<boolean>=()=>Promise.resolve(true)){
 const root=await mkdtemp(join(tmpdir(),'computer-session-'))
 const image='data:image/png;base64,'+(await sharp({create:{width:2560,height:1440,channels:3,background:'white'}}).png().toBuffer()).toString('base64')
 let target='window-one',closed=0,connected=0,cleanup=true
 let closeGate=Promise.resolve(),writeFailure=false,afterWrite=()=>{}
 const acting:string[]=[],events:string[]=[],points:({x:number;y:number}|undefined)[]=[]
 const writes:{name:string;params:unknown}[]=[],approvals:string[]=[]
 const backend:Awaited<ReturnType<typeof startComputerBackend>>={
  pid:process.pid,device:{interfaceType:'computer',size:()=>Promise.resolve({width:1024,height:576}),screenshotBase64:()=>Promise.resolve(image),
   actionSpace:()=>['Tap','Input','Scroll','KeyboardPress'].map(name=>({name,paramSchema:name==='Tap'?actionTapParamSchema:name==='Input'?z.object({value:z.string()}):name==='Scroll'?actionScrollParamSchema:actionKeyboardPressParamSchema,call:(params:unknown)=>{events.push('input');writes.push({name,params});afterWrite();return writeFailure?Promise.reject(Error('cleanup_unknown')):Promise.resolve()}}))},
  connect:()=>{connected++;return Promise.resolve()},listDisplays:()=>Promise.resolve([{id:'1'}]),close:async()=>{closed++;await closeGate;return cleanup},
  windowTarget:()=>Promise.resolve({target,width:1024,height:576}),releaseInput:()=>Promise.resolve(),
 }
 const session=new ComputerSession({signal:new AbortController().signal,config:{displayId:'1',lockRoot:root,baseUrl:'https://example.test',apiKey:'test',model:'test',modelFamily:'qwen3-vl',maxSteps:10,budgetMs:1000,settleMs:0},
  backend:()=>Promise.resolve(backend),foreground:()=>Promise.resolve({target,width:1024,height:576}),approve:name=>{approvals.push(name);return approve(name)},acting:(name,point)=>{events.push('acting');acting.push(name);points.push(point)}})
 return {session,writes,approvals,acting,events,points,afterWrite:(effect:()=>void)=>{afterWrite=effect},failWrite:()=>{writeFailure=true},setTarget:(value:string)=>{target=value},setCleanup:(value:boolean)=>{cleanup=value},delayClose:(gate:Promise<void>)=>{closeGate=gate},connected:()=>connected,closed:()=>closed,
  dispose:async()=>{await session.close().catch(()=>{ /* test asserts cleanup errors separately */ });releaseQuarantinedTaskResources([COMPUTER_RESOURCE]);await rm(root,{recursive:true,force:true})}}
}
test('computer tools restrict non-vision models to delegation',{timeout:5000},()=>{
 assert.deepEqual(computerTools(false).map(tool=>tool.name),['computer_run'])
 assert.equal(computerTools(true).length,6)
})
test('session requires observation, approves Connect once, scales screenshots and releases lease',{timeout:5000},async()=>{
 const f=await fixture()
 try{
  await assert.rejects(f.session.action('computer_click',{x:0,y:0}),/observe_required/)
  const image=await f.session.screenshot();assert.equal(image.width,1280);assert.equal(image.height,720)
  assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)
  await assert.rejects(f.session.action('computer_click',{x:1280,y:0}),/invalid_params/)
  await f.session.action('computer_click',{x:640,y:360})
  assert.deepEqual(f.writes,[{name:'Tap',params:{locate:{prompt:'screenshot coordinate',center:[512,288]}}}])
  assert.deepEqual(f.points,[{x:512,y:288}]);assert.deepEqual(f.events,['acting','input'])
  await f.session.action('computer_type',{text:'hello'})
  await f.session.action('computer_key',{keys:'Enter'})
  await assert.rejects(f.session.action('computer_click',{x:0,y:0}),/observe_required/)
  await f.session.screenshot()
  assert.deepEqual(f.approvals,['Connect','Tap','Input','KeyboardPress']);assert.equal(f.connected(),1)
  await f.session.close();assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),false);assert.equal(f.closed(),1)
 }finally{await f.dispose()}
})
test('declined Connect never connects or sends input and releases both locks',{timeout:5000},async()=>{
 const f=await fixture(()=>Promise.resolve(false))
 try{await assert.rejects(f.session.screenshot(),/declined/);assert.equal(f.connected(),0);assert.equal(f.writes.length,0);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),false)}
 finally{await f.dispose()}
})
test('foreground changed during approval blocks input',{timeout:5000},async()=>{
 const f=await fixture(name=>{if(name==='Tap')f.setTarget('other-window');return Promise.resolve(true)})
 try{await f.session.screenshot();await assert.rejects(f.session.action('computer_click',{x:10,y:10}),/screen_changed/);assert.equal(f.writes.length,0);assert.equal(f.acting.length,0)}
 finally{await f.dispose()}
})
test('unconfirmed backend cleanup quarantines the resource',{timeout:5000},async()=>{
 const f=await fixture()
 try{await f.session.screenshot();f.setCleanup(false);await assert.rejects(f.session.close(),/cleanup_unknown/);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)}
 finally{await f.dispose()}
})
test('concurrent close calls retain ownership until the backend is gone',{timeout:5000},async()=>{
 const f=await fixture();let release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 try{
  await f.session.screenshot();f.delayClose(gate)
  const first=f.session.close(),second=f.session.close()
  assert.equal(first,second);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)
  release();await Promise.all([first,second]);assert.equal(f.closed(),1);assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),false)
 }finally{release();await f.dispose()}
})
test('ambiguous input remains quarantined even when backend cleanup succeeds',{timeout:5000},async()=>{
 const f=await fixture()
 try{
  await f.session.screenshot();f.failWrite()
  await assert.rejects(f.session.action('computer_click',{x:10,y:10}),/cleanup_unknown/)
  await assert.rejects(f.session.close(),/cleanup_unknown/)
  assert.equal(taskResourcesBusy([COMPUTER_RESOURCE]),true)
 }finally{await f.dispose()}
})

test('whole-screen Connect approval may change foreground before the first observation',{timeout:5000},async()=>{
 const f=await fixture(name=>{if(name==='Connect')f.setTarget('approval-window');return Promise.resolve(true)})
 try{await f.session.screenshot();assert.equal(f.connected(),1);await f.session.action('computer_click',{x:10,y:10});assert.equal(f.writes.length,1)}
 finally{await f.dispose()}
})

test('an intentional app switch accepts a fresh screenshot and targets the new app',{timeout:5000},async()=>{
 const f=await fixture()
 try{
  await f.session.screenshot();f.afterWrite(()=>f.setTarget('launched-app'))
  await f.session.action('computer_key',{keys:'cmd+tab'})
  await f.session.screenshot()
  await f.session.action('computer_click',{x:10,y:10})
  assert.deepEqual(f.writes.map(write=>write.name),['KeyboardPress','Tap'])
 }finally{await f.dispose()}
})
