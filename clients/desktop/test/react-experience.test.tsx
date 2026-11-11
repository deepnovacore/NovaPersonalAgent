import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body><div id="personal-root"></div><div id="personal-orb-host"></div></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,NodeFilter:dom.window.NodeFilter,HTMLInputElement:dom.window.HTMLInputElement,getComputedStyle:dom.window.getComputedStyle,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,MutationObserver:dom.window.MutationObserver,CustomEvent:dom.window.CustomEvent,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})
dom.window.HTMLMediaElement.prototype.pause=function(){}
const {act,fireEvent,waitFor}=await import('@testing-library/react')
const {mountPersonalView}=await import('../src/renderer/react/personal-view.tsx')
const {personalState}=await import('./react-fixtures/personal-state.mjs')
let view:any
let off=0
afterEach(async()=>{if(view)await act(async()=>view.dispose());view=null;document.body.innerHTML='<div id="personal-root"></div><div id="personal-orb-host"></div>'})
test('ordinary pages render persona profile, readable sources and editable todo without a real runtime',async()=>{
 const snapshot:any=personalState();snapshot.experience={persona_id:'sample',name:'Sample'};snapshot.tasks=[];snapshot.feed=[];snapshot.soul={assistant_name:'Nova',available:false,role:'',reply_style:'',contact:{}}
 snapshot.profile_preparation={status:'ready',draft:{about:null,work:[{title:'Sample profile',text:'Synthetic profile body',refs:[{entry_id:'sample-source',version:1}]}],interests:[]},sources:[{id:'sample-source',label:'Readable synthetic evidence'}]}
 snapshot.life.profile={version:0,about:''};snapshot.life.todos=[{id:'sample-todo',kind:'todo',title:'Sample todo',note:'Local action',status:'open',version:1,importance:'normal',sources:[]}]
 snapshot.timeline={status:'ready',available:true,cards:[]}
 snapshot.conversations={...snapshot.conversations,selected_id:'chat:main',messages:[],home_messages:[],items:[{id:'chat:main',title:'Sample chat',kind:'chat',generation:0,mode:'chat'}]}
 let welcomeWrites=0
 const frames:any[]=[];let changed:(value:any)=>void=()=>{}
 const api:any={welcome:{save:async()=>{welcomeWrites++}},experience:{list:async()=>({available:true,active:'sample',epoch:1,snapshot}),onChanged:(callback:any)=>{changed=callback;return()=>{off++}},send:async(request:any)=>{frames.push(request.frame);const frame=request.frame;if(frame.method==='life.mutate'){snapshot.life.todos[0]={...snapshot.life.todos[0],...frame.params,version:2};snapshot.revision++;changed({id:'sample',epoch:1,frame:structuredClone(snapshot)})}return {frame:{type:frame.type==='input.text'?'input.text_result':'personal.result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:true,data:{}}}}},personal:{setUnread:async()=>{}},orbMenu:{openSettings:()=>{}},windowControls:{},computerUse:{clear:()=>{}}}
 await act(async()=>{view=mountPersonalView({api,send:()=>{throw Error('real runtime must not receive experience commands')},start:async()=>{throw Error('microphone must not start')},stop:async()=>{},tasks:()=>({tasks:[]}),results:()=>[]})})
 await waitFor(()=>assert.equal(view.controller.connected,true))
 await act(async()=>view.identity({profile:{assistantName:'PRIVATE ASSISTANT',avatar:'data:image/png;base64,PRIVATE_AVATAR'},defaultAvatar:'data:image/png;base64,NOVA_DEFAULT'}))
 assert.equal(document.querySelector<HTMLImageElement>('#chat-pane .idle-avatar img')?.getAttribute('src'),'data:image/png;base64,NOVA_DEFAULT')
 assert.equal(document.querySelector('#chat-pane')!.innerHTML.includes('PRIVATE_AVATAR'),false)
 const tab=(name:string)=>document.querySelector<HTMLButtonElement>(`[data-page="${name}"]`)!
 await act(async()=>fireEvent.click(tab('assistant')))
 assert.equal(document.querySelector('#workbench-panel')!.textContent!.includes('PRIVATE ASSISTANT'),false)
 const rename=[...document.querySelectorAll<HTMLButtonElement>('#workbench-panel button')].find(button=>button.textContent==='改名字')!
 assert.equal([...document.querySelectorAll<HTMLButtonElement>('#workbench-panel button')].find(button=>button.textContent==='去调整')!.disabled,true)
 assert.equal(rename.disabled,true);await act(async()=>fireEvent.click(rename));assert.equal(welcomeWrites,0)
 await act(async()=>fireEvent.click(tab('profile')))
 assert.match(document.querySelector('#workbench-panel')!.textContent!,/Synthetic profile body/)
 const source=document.querySelector<HTMLButtonElement>('.profile-work-item .source-info')!
 await act(async()=>fireEvent.click(source))
 assert.match(document.querySelector('.source-popover')!.textContent!,/Readable synthetic evidence/)
 await act(async()=>fireEvent.click(tab('timeline')))
 const complete=[...document.querySelectorAll<HTMLButtonElement>('#workbench-panel button')].find(button=>button.textContent==='标记完成')!
 assert.ok(complete)
 await act(async()=>fireEvent.click(complete))
 assert.equal(frames.find(frame=>frame.method==='life.mutate')?.params.status,'done')
 assert.match(document.querySelector('#workbench-panel')!.textContent!,/已完成/)
 await act(async()=>{view.controller.draft='Sample message';view.controller.submit()})
 assert.ok(frames.some(frame=>frame.type==='input.text'&&frame.text==='Sample message'))
 const personal=personalState(999);personal.life.profile.about='REAL PRIVATE DATA'
 await act(async()=>view.receive(personal))
 assert.equal(JSON.stringify(view.controller.snapshot).includes('REAL PRIVATE DATA'),false)
})
for(const selection of ['pending','failed','ordinary'] as const)test(`real identity and avatar require confirmed ordinary Space: ${selection}`,async()=>{
 let resolveList:(value:any)=>void=()=>{},rejectList:(error:Error)=>void=()=>{}
 const api:any={experience:{list:()=>new Promise((resolve,reject)=>{resolveList=resolve;rejectList=reject}),onChanged:()=>()=>{},send:async()=>{throw Error('not expected')}},personal:{setUnread:async()=>{}},windowControls:{},computerUse:{clear:()=>{}}}
 await act(async()=>{
  view=mountPersonalView({api,send:()=>true,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),results:()=>[]})
  await view.controller.connect();view.receive({type:'client.ready',input_instance_id:'sample',capabilities:['text_input']});view.receive(personalState())
  view.identity({profile:{assistantName:'PRIVATE_PENDING_NAME',avatar:'data:image/png;base64,PRIVATE_PENDING_AVATAR'}})
 })
 if(selection==='failed')await act(async()=>rejectList(Error('unavailable')))
 if(selection==='ordinary')await act(async()=>resolveList({active:null,epoch:0,available:false}))
 assert.equal(document.body.innerHTML.includes('PRIVATE_PENDING_NAME'),selection==='ordinary')
 assert.equal(document.body.innerHTML.includes('PRIVATE_PENDING_AVATAR'),selection==='ordinary')
})
