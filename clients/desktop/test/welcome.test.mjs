import test from 'node:test'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createWelcomeStore} from '../src/main/welcome-store.mjs'
import {readDesktopPermissions, requestDesktopPermission} from '../src/main/desktop-permissions.mjs'
import {welcomePhase} from '../src/renderer/welcome-flow.mjs'

test('welcome profile survives restart and concurrent independent edits; invalid images cannot become URLs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-welcome-')),path=join(root,'welcome.json')
 try{
  const store=createWelcomeStore(path)
  assert.equal((await store.get()).assistantName,'nova')
  await Promise.all([store.update({assistantName:'  小星  '}),store.update({userName:'小林'})])
  await store.update({permissionsSeen:true,introduced:true})
  const restored=await createWelcomeStore(path).get()
  assert.equal(restored.assistantName,'小星');assert.equal(restored.userName,'小林');assert.equal(restored.introduced,true)
  await assert.rejects(store.update({assistantName:'x'.repeat(41)}))
  await assert.rejects(store.update({avatar:'https://tracking.example/avatar.png'}))
  await assert.rejects(store.update({avatar:'data:image/svg+xml,<svg/>'}))
  await assert.rejects(store.update({surprise:true}))
  assert.equal(JSON.parse(await readFile(path,'utf8')).assistantName,'小星')
  await store.update({assistantName:' '});assert.equal((await store.get()).assistantName,'nova')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('unreadable or corrupt existing profile is reported, not overwritten with defaults',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-welcome-')),path=join(root,'welcome.json')
 try{await writeFile(path,'broken');await assert.rejects(createWelcomeStore(path).get());assert.equal(await readFile(path,'utf8'),'broken')}finally{await rm(root,{recursive:true,force:true})}
})
test('system permission inspection is read-only; granted permissions do not imply a configured computer executor',()=>{
 const calls=[],systemPreferences={getMediaAccessStatus:kind=>(calls.push(kind),'granted'),isTrustedAccessibilityClient:prompt=>{assert.equal(prompt,false);return true}}
 const status=readDesktopPermissions({platform:'darwin',systemPreferences,environment:{},backendReady:true})
 assert.equal(status.screen,'granted');assert.equal(status.accessibility,'granted');assert.equal(status.computerConfigured,false);assert.equal(status.computerReady,false)
 assert.deepEqual(calls,['microphone','screen'])
 const configured=readDesktopPermissions({platform:'darwin',systemPreferences,backendReady:true,environment:{EXECUTORS:'computer',COMPUTER_DISPLAY_ID:'0',EXECUTOR_MODEL:'model',EXECUTOR_MODEL_FAMILY:'qwen3-vl',EXECUTOR_BASE_URL:'https://example.com/v1',EXECUTOR_API_KEY:'key'}})
 assert.equal(configured.computerReady,true)
})
test('permission requests only open a fixed system pane after explicit action; unsupported OS is not granted',async()=>{
 const opened=[],deps={platform:'darwin',systemPreferences:{isTrustedAccessibilityClient:()=>false,getMediaAccessStatus:()=> 'denied'},shell:{openExternal:async url=>opened.push(url)}}
 await requestDesktopPermission('screen',deps)
 assert.deepEqual(opened,['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'])
 await assert.rejects(requestDesktopPermission('https://example.com',deps))
 assert.equal(readDesktopPermissions({platform:'linux'}).screen,'unsupported')
 assert.equal(readDesktopPermissions({platform:'win32'}).accessibility,'not_required')
})
test('first-run order is real startup, permissions, then chat; reconnect never reopens onboarding',()=>{
 assert.equal(welcomePhase({startup:{stage:'backend'},profile:{permissionsSeen:false},entered:false}),'loading')
 assert.equal(welcomePhase({startup:{stage:'ready'},profile:{permissionsSeen:false},entered:false}),'permissions')
 assert.equal(welcomePhase({startup:{stage:'ready'},profile:{permissionsSeen:true},entered:false}),'chat')
 assert.equal(welcomePhase({startup:{stage:'failed'},profile:{permissionsSeen:false},entered:false}),'failed')
 assert.equal(welcomePhase({startup:{stage:'reconnecting'},profile:{permissionsSeen:false},entered:true}),'chat')
})

test('welcome IPC rejects foreign frames, preserves canceled selections and stores only decoded avatar bytes',async()=>{
 const {installWelcomeIpc}=await import('../src/main/welcome-ipc.mjs')
 const root=await mkdtemp(join(tmpdir(),'nova-welcome-ipc-'))
 try{
  const handlers=new Map(),sent=[],mainFrame={},webContents={mainFrame,send:(...args)=>sent.push(args)},window={webContents,isDestroyed:()=>false}
  const event={sender:webContents,senderFrame:mainFrame},file=join(root,'picked.png')
  await writeFile(file,'source bytes')
  let selection={canceled:true,filePaths:[]},empty=false
  installWelcomeIpc({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},app:{getPath:()=>root},dialog:{showOpenDialog:async()=>selection},nativeImage:{createFromBuffer:()=>({isEmpty:()=>empty,getSize:()=>({width:100,height:200}),resize:options=>{assert.deepEqual(options,{height:512});return {toPNG:()=>Buffer.from('normalized png')}}})},systemPreferences:{getMediaAccessStatus:()=> 'denied',isTrustedAccessibilityClient:()=>false},shell:{openExternal:async()=>{}},windows:()=>[window],environment:()=>({}),backendReady:()=>false})
  const invoke=(name,...args)=>handlers.get('nova:welcome:'+name)(event,...args)
  const publicIcon=await readFile(new URL('../src/main/nova-avatar.png',import.meta.url))
  const actualAvatar=(await invoke('get')).defaultAvatar
  assert.ok(actualAvatar.startsWith('data:image/png;base64,'))
  assert.equal(createHash('sha256').update(Buffer.from(actualAvatar.split(',')[1],'base64')).digest('hex'),createHash('sha256').update(publicIcon).digest('hex'))
  assert.throws(()=>handlers.get('nova:welcome:get')({...event,senderFrame:{}}),/access_denied/)
  assert.throws(()=>handlers.get('nova:welcome:get')({...event,sender:{}}),/access_denied/)
  await assert.rejects(invoke('save',{avatar:null}),/use_avatar_picker/)
  assert.equal((await invoke('avatar')).profile.avatar,null)
  selection={canceled:false,filePaths:[file]}
  const updated=await invoke('avatar')
  assert.equal(updated.profile.avatar,'data:image/png;base64,'+Buffer.from('normalized png').toString('base64'))
  assert.equal(sent.at(-1)[0],'nova:welcome:changed')
  empty=true;await assert.rejects(invoke('avatar'),/invalid_avatar/)
  assert.equal((await invoke('get')).profile.avatar,updated.profile.avatar)
  assert.equal((await invoke('avatar',true)).profile.avatar,null)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('runtime names replace stale welcome names after chat rename and reconnect',async()=>{
 const {mountAssistantWelcome}=await import('../src/renderer/assistant-welcome.mjs')
 class Node {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={}}
  append(...nodes){this.children.push(...nodes)}
  replaceChildren(...nodes){this.children=nodes}
  setAttribute(){}
  addEventListener(name,fn){this.listeners[name]=fn}
  querySelectorAll(tag){return this.children.flatMap(n=>[...(n.tagName===tag.toUpperCase()?[n]:[]),...n.querySelectorAll(tag)])}
 }
 const previous=globalThis.document
 globalThis.document={createElement:tag=>new Node(tag)}
 try{
  const calls=[],saved=[],c={connected:true,presentationReady:false,snapshot:{settings:{assistant_name:'小星',user_name:'新名字'}},command:async(method,params)=>{calls.push([method,params]);return {}}}
  let welcome
  const api={save:async patch=>{saved.push(patch);return {profile:{...patch,introduced:true,avatar:null},defaultAvatar:''}}}
  welcome=mountAssistantWelcome(new Node('div'),{api,c,onIdentity:value=>welcome.update(value)})
  welcome.update({profile:{assistantName:'小星',userName:'旧名字',introduced:true,avatar:null},defaultAvatar:''})
  assert.equal(saved.length,0)
  c.presentationReady=true;welcome.sync();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls.length,0);assert.equal(saved.at(-1).userName,'新名字')
  welcome.sync();assert.equal(saved.length,1)
  c.connected=false;welcome.sync();c.connected=true;c.presentationReady=false;welcome.sync()
  c.snapshot={settings:{assistant_name:'小星',user_name:'重启后的名字'}}
  c.presentationReady=true;welcome.sync();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls.length,0);assert.equal(saved.at(-1).userName,'重启后的名字')
 }finally{globalThis.document=previous}
})
