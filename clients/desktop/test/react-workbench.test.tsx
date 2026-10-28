import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body><div id="personal-root"></div><div id="personal-orb-host"></div></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,CustomEvent:dom.window.CustomEvent,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true})
dom.window.HTMLMediaElement.prototype.pause=function(){}
const {act,fireEvent,waitFor}=await import('@testing-library/react')
const {mountPersonalView}=await import('../src/renderer/react/personal-view.tsx')
const {personalState}=await import('./react-fixtures/personal-state.mjs')
const views:any[]=[]
afterEach(async()=>{for(const view of views.splice(0))await act(async()=>view.dispose());document.body.innerHTML='<div id="personal-root"></div><div id="personal-orb-host"></div>';localStorage.clear()})
async function mount(){
 let view:any;const sent:any[]=[];const listeners=new Map<string,Function>();let stops=0
 const on=(name:string)=>(callback:Function)=>{listeners.set(name,callback);return()=>{stops++;listeners.delete(name)}}
 const api={personal:{onPresentationRequest:on('presentation'),onCollapsed:on('collapsed'),onMaximized:on('maximized'),setUnread:async()=>{}},orbMenu:{openSettings:()=>{}},windowControls:{},computerUse:{onStop:on('computer-stop'),overlay:()=>{},clear:()=>{}}}
 const send=(frame:any)=>{sent.push(frame);queueMicrotask(()=>{if(frame.type==='personal.command')view.receive({type:'personal.result',request_id:frame.request_id,ok:true,data:frame.method==='presentation.set'?{mode:frame.params.mode}:{}});if(frame.type==='input.text')view.receive({type:'input.text_result',request_id:frame.request_id,conversation_id:frame.conversation_id,ok:true})});return true}
 await act(async()=>{view=mountPersonalView({api,send,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),results:()=>[]});views.push(view);await view.controller.connect();view.receive({type:'client.ready',input_instance_id:'ui-test',capabilities:['text_input']});view.receive(personalState())})
 return {view,sent,listeners,stops:()=>stops}
}
test('React workbench preserves left chat and right workspace while keyboard tabs move focus',async()=>{
 const {view}=await mount()
 const root=document.getElementById('personal-workspace')!,chat=root.querySelector('.nova-column')!,workspace=root.querySelector('.workspace')!
 assert.equal(chat.nextElementSibling,workspace)
 const first=root.querySelector<HTMLButtonElement>('[role="tab"][data-page="timeline"]')!
 assert.equal(first.getAttribute('aria-selected'),'true')
 await act(async()=>fireEvent.keyDown(first,{key:'ArrowRight'}))
 const ideas=root.querySelector<HTMLButtonElement>('[data-page="ideas"]')!
 assert.equal(ideas.getAttribute('aria-selected'),'true');assert.equal(document.activeElement,ideas)
 assert.equal(document.getElementById('workbench-panel')!.getAttribute('aria-labelledby'),ideas.id)
 assert.equal(view.controller.selectedId,'chat:main')
})
test('controller updates preserve focused composer text, and disconnect retains the draft',async()=>{
 const {view}=await mount(),draft=document.querySelector<HTMLTextAreaElement>('[aria-label="消息草稿"]')!
 await act(async()=>fireEvent.change(draft,{target:{value:'未发送的草稿'}}))
 draft.focus();const controller=view.controller
 await act(async()=>view.receive(personalState(2)))
 assert.equal(view.controller,controller);assert.equal(document.querySelector('[aria-label="消息草稿"]'),draft);assert.equal(draft.value,'未发送的草稿');assert.equal(document.activeElement,draft)
 await act(async()=>view.controller.disconnect())
 assert.equal(draft.value,'未发送的草稿');assert.equal(view.controller.draft,'未发送的草稿')
 assert.ok(document.querySelector('.workbench-status')!.textContent!.includes('草稿保留'))
})
test('disposing the workbench releases presentation/window/overlay subscriptions',async()=>{
 const {view,listeners,stops}=await mount();assert.equal(listeners.size,4)
 await act(async()=>view.dispose());views.splice(views.indexOf(view),1)
 assert.equal(stops(),4);assert.equal(listeners.size,0);assert.equal(document.getElementById('personal-workspace'),null)
})

test('unsaved workspace edits survive Tasks and return without changing the conversation',async()=>{
 const {view}=await mount()
 const tab=(page:string)=>document.querySelector<HTMLButtonElement>(`[role="tab"][data-page="${page}"]`)!
 await act(async()=>fireEvent.click(tab('ideas')))
 const edit=[...document.querySelectorAll<HTMLButtonElement>('#workbench-panel button')].find(button=>button.textContent==='编辑')!
 await act(async()=>fireEvent.click(edit))
 const title=document.querySelector<HTMLInputElement>('[aria-label="想法标题"]')!
 await act(async()=>fireEvent.change(title,{target:{value:'保留跨页面草稿'}}))
 await act(async()=>fireEvent.click(tab('tasks')))
 await act(async()=>fireEvent.click(tab('ideas')))
 assert.equal(document.querySelector<HTMLInputElement>('[aria-label="想法标题"]')?.value,'保留跨页面草稿')
 assert.equal(view.controller.selectedId,'chat:main')
})

test('executor progress resets revisions on reconnect and malformed frames cannot poison sequencing',async()=>{
 const {view}=await mount()
 const frame=(revision:number,title:string)=>({type:'executor.tasks',revision,active_project:'Project',tasks:[{work_id:'w',executor:'codex',project:'Project',title,phase:'working',summary:'Public progress',ts:1}]})
 await act(async()=>view.receive(frame(100,'Old executor')))
 let pill=document.querySelector<HTMLButtonElement>('.executor-float-pill')!;assert.ok(pill)
 await act(async()=>fireEvent.click(pill));assert.ok(document.querySelector('.executor-float')!.textContent!.includes('Old executor'))
 await act(async()=>view.receive({type:'client.ready',input_instance_id:'restarted',capabilities:['text_input']}))
 assert.equal((document.querySelector('.executor-float') as HTMLElement).hidden,true)
 await act(async()=>view.receive({...frame(Infinity,'Malformed'),tasks:[{bad:true}]}))
 await act(async()=>view.receive(frame(1,'Fresh executor')))
 pill=document.querySelector<HTMLButtonElement>('.executor-float-pill')!;assert.ok(pill)
 await act(async()=>fireEvent.click(pill));assert.ok(document.querySelector('.executor-float')!.textContent!.includes('Fresh executor'))
})

test('React theme sets the document language without translating user message content',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs')
 setLanguage('en')
 try{await mount();assert.equal(document.documentElement.lang,'en');assert.ok(document.querySelector('.chat-history')!.textContent!.includes('Help me plan a focused week.'))}finally{setLanguage('zh-CN')}
})
