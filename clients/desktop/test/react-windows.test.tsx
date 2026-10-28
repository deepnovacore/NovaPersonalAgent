import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://nova.local',pretendToBeVisual:true})
const media={matches:false,addEventListener(){},removeEventListener(){}}
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true,matchMedia:()=>media})
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true})
Object.defineProperty(dom.window,'matchMedia',{value:()=>media})
Object.defineProperty(dom.window,'AnimationEvent',{value:dom.window.Event})
const {render,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react')
const {ComputerBarApp,ComputerEdgeApp,VisorControlsApp,VisorApp,ReleaseCameraApp,MemoryBoardApp}=await import('../src/renderer/react/auxiliary.tsx')
const {WelcomeScreen}=await import('../src/renderer/react/windows/welcome.tsx')
afterEach(()=>cleanup())
const deferred=()=>{let resolve:any,reject:any;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function hostApi(initial:any) {let listener:any,stopped=0;return{language:'zh-CN',snapshot:async()=>initial,onChanged(fn:any){listener=fn;return()=>{stopped++}},push(next:any){listener?.(next)},get stopped(){return stopped}}}

test('computer stop stays single flight and reports a host failure before retry',async()=>{
 const request=deferred(),api={...hostApi({state:'acting',action:'computer_click',point:{x:10,y:20}}),stop:()=>{calls++;return request.promise}};let calls=0
 const v=render(<ComputerBarApp api={api}/>);await waitFor(()=>assert.equal((v.getByText('停止') as HTMLButtonElement).closest('button')?.disabled,false))
 fireEvent.click(v.getByText('停止'));fireEvent.click(v.getByText('停止'));assert.equal(calls,1);assert.ok(v.getByText('正在停止…'))
 await act(async()=>request.reject(Error('stopped failed')));assert.ok(v.getByText('停止失败，请在工作台点击停止'));assert.equal(v.container.querySelector('button')?.disabled,false)
})

test('host snapshot cannot overwrite a newer pushed overlay frame and unmount unsubscribes',async()=>{
 const request=deferred(),api=hostApi(null);api.snapshot=()=>request.promise
 const v=render(<ComputerBarApp api={api}/>);await act(async()=>api.push({state:'acting',awaiting_approval:true}));await act(async()=>request.resolve({state:'idle',summary:'stale'}));assert.ok(v.getByText('等待你在工作台批准下一步'));v.unmount();assert.equal(api.stopped,1)
})

test('computer point marks deduplicate action and location and keep only four entries',async()=>{
 const api=hostApi(null),v=render(<ComputerEdgeApp api={api}/>),frame={state:'acting',action:'computer_click',point:{x:110,y:220},origin:{x:100,y:200}}
 await act(async()=>api.push(frame));assert.equal(v.container.querySelectorAll('.computer-mark').length,1);assert.equal((v.container.querySelector('.computer-mark') as HTMLElement).style.left,'10px')
 await act(async()=>api.push({...frame}));assert.equal(v.container.querySelectorAll('.computer-mark').length,1)
 for(let i=0;i<5;i++)await act(async()=>api.push({...frame,point:{x:111+i,y:220}}));assert.equal(v.container.querySelectorAll('.computer-mark').length,4)
 const mark=v.container.querySelector('.computer-mark')!;fireEvent.animationEnd(mark);assert.equal(v.container.querySelectorAll('.computer-mark').length,3)
})

test('visor controls send mode, hide and orb commands and consume changed preferences',async()=>{
 const calls:any[]=[],api={...hostApi({preferences:{mode:'focus'}}),configure:async(value:any)=>{calls.push(value)},orb:async()=>calls.push('orb')},v=render(<VisorControlsApp api={api}/>);
 await waitFor(()=>assert.equal(v.getByText('专注').getAttribute('aria-pressed'),'true'));fireEvent.click(v.getByText('展示'));fireEvent.click(v.getByText('收起 ↘'));fireEvent.click(v.getByText('◉ NOVA'));assert.deepEqual(calls,[{mode:'showcase'},{enabled:false},'orb']);await act(async()=>api.push({preferences:{mode:'showcase'}}));assert.equal(v.getByText('展示').getAttribute('aria-pressed'),'true')
})

const boardPayload=(extra:any={})=>({backend_generation:1,conversation_epoch:1,channels:[{name:'conversation',item_count:1,retention_revision:1,items:[{seq:1,ts:1,trust:'trusted_user',content:JSON.stringify({role:'user',text:'hello'})}],has_more:false},{name:'watch',item_count:1,items:[{seq:2,ts:2,trust:'untrusted',content:'<script>not executable</script>'}]}],diagnostics:{version:1,records:[{seq:1,ts:1,kind:'audio',payload:{active:true}}]},...extra})

test('memory board uses local channel selection, keyboard tabs, safe text and conversation details',async()=>{
 let requests=0;const api={request:async()=>{requests++;return boardPayload()}},v=render(<MemoryBoardApp api={api}/>);await waitFor(()=>assert.ok(v.getByText('hello')))
 const channelTabs=v.container.querySelectorAll('.channel-tab');fireEvent.click(channelTabs[1]);assert.ok(v.getByText('<script>not executable</script>'));assert.equal(v.container.querySelector('script'),null);assert.equal(requests,1)
 fireEvent.keyDown(channelTabs[1],{key:'Home'});assert.ok(v.getByText('hello'));assert.equal(document.activeElement?.id,'channel-tab-conversation')
 const item=v.getByText('hello').closest('article')!;fireEvent.contextMenu(item);assert.equal(item.getAttribute('aria-expanded'),'true');fireEvent.keyDown(item,{key:'Escape'});assert.equal(item.getAttribute('aria-expanded'),'false')
 fireEvent.keyDown(v.container.querySelector('#memory-tab')!,{key:'End'});assert.equal(v.container.querySelector('#diagnostics-panel')?.hasAttribute('hidden'),false);assert.equal(document.activeElement?.id,'diagnostics-tab');await act(async()=>{})
})

test('memory clear invalidates an in-flight page and copy is disabled until fresh payload',async()=>{
 const page=deferred(),clear=deferred();let count=0,clearCalls=0;const api={request:async(query:any)=>{count++;if(query)return page.promise;return boardPayload({channels:[{...boardPayload().channels[0],has_more:true,next_before_seq:1}]})},clear:()=>{clearCalls++;return clear.promise}},v=render(<MemoryBoardApp api={api}/>);await waitFor(()=>assert.ok(v.getByText('hello')))
 fireEvent.click(v.getByText('向上滚动加载更早记录'));fireEvent.click(v.getByText('清除近期会话记录'));fireEvent.click(v.getByText('清除近期会话记录'));assert.equal(clearCalls,1)
 await act(async()=>clear.resolve({cleared:true}));assert.equal(v.queryByText('hello'),null);assert.equal(v.container.querySelector<HTMLButtonElement>('#copy-json')?.disabled,true)
 await act(async()=>page.resolve(boardPayload()));assert.equal(v.queryByText('hello'),null);assert.equal(count,2)
})

test('personal memory search ignores replies for an edited query and next page carries exact cursor',async()=>{
 const first=deferred(),queries:any[]=[];const api={request:async(query:any)=>{queries.push(query);if(query?.channel==='personal'){if(query.query==='old')return first.promise;return{personal:{entries:[{id:'a',state:'learned',recordedAt:'2026-10-28',memories:['learned note'],original:'source'}],next:25}}}return boardPayload()}},v=render(<MemoryBoardApp api={api}/>);await waitFor(()=>assert.ok(v.getByText('hello')));fireEvent.click(v.getByText('本机记忆'));await waitFor(()=>assert.ok(v.getByText('learned note')))
 const search=v.getByLabelText('搜索记忆来源原话');fireEvent.change(search,{target:{value:'old'}});fireEvent.click(v.getByText('搜索',{selector:'button'}));fireEvent.change(search,{target:{value:'new'}});await act(async()=>first.resolve({personal:{entries:[],next:null}}));assert.ok(v.getByText('learned note'))
 fireEvent.click(v.getByText('搜索',{selector:'button'}));await waitFor(()=>assert.ok(v.getByText('learned note')));fireEvent.click(v.getByText('下一页'));await waitFor(()=>assert.ok(queries.some(q=>q?.before_seq===25&&q.query==='new')))
})

test('welcome saves consent once, keeps failed state retryable and releases listener',async()=>{
 const save=deferred(),view={profile:{assistantName:'Nova',permissionsSeen:false},defaultAvatar:'data:image/png;base64,',permissions:{microphone:'denied',screen:'granted',accessibility:'not_required'}},apiHost=hostApi(view),profiles:any[]=[],visibility:any[]=[];let saves=0
 const api={welcome:{get:async()=>view,onChanged:apiHost.onChanged,save:(value:any)=>{assert.deepEqual(value,{permissionsSeen:true});saves++;return save.promise}},orbMenu:{openSettings(){}},windowControls:{}}
 const v=render(<WelcomeScreen api={api} startup={{stage:'ready'}} onProfile={(p:any)=>profiles.push(p)} onVisible={(value:any)=>visibility.push(value)}/>);await waitFor(()=>assert.equal(v.container.querySelector('.welcome-permissions')?.hasAttribute('hidden'),false));fireEvent.click(v.getByText('继续，认识 nova'));fireEvent.click(v.getByText('继续，认识 nova'));assert.equal(saves,1)
 await act(async()=>save.reject(Error('settings unavailable')));assert.ok(v.getByRole('alert').textContent?.includes('暂时无法读取'));assert.equal((v.getByText('继续，认识 nova') as HTMLButtonElement).disabled,false);v.unmount();assert.equal(apiHost.stopped,1);assert.equal(profiles.length,1);assert.equal(visibility.at(-1),true)
})


test('visor resizes its declarative armor and suspends canvas frames on reduced motion and unmount',async()=>{
 let change:any,scheduled=0,cancelled=0,raf=0
 const query={matches:false,addEventListener(_name:string,fn:any){change=fn},removeEventListener(){change=null}}
 const original=dom.window.HTMLCanvasElement.prototype.getContext
 dom.window.HTMLCanvasElement.prototype.getContext=(()=>({clearRect(){},beginPath(){},arc(){},stroke(){},fill(){},fillRect(){},createRadialGradient(){return{addColorStop(){}}}})) as any
 Object.assign(globalThis,{innerWidth:1200,innerHeight:900,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:()=>{scheduled++;return ++raf},cancelAnimationFrame:()=>{cancelled++},matchMedia:()=>query})
 const api=hostApi({preferences:{enabled:true,motion:true,mode:'focus',hardware:true,ai:true,opacity:.8},hardware:{cpu:25,memoryUsed:2**30,memoryTotal:8*2**30,disk:30,updatedAt:Date.now()},ai:{backend:'connected',state:'idle',activated:true}})
 const v=render(<VisorApp api={api}/>);await waitFor(()=>assert.equal(v.container.querySelector('#cpu')?.textContent,'25%'));assert.ok(scheduled>0)
 assert.equal(v.container.querySelector('#frame-right g')?.getAttribute('transform'),'translate(1200 0) scale(-1 1)')
 await act(async()=>{(globalThis as any).innerWidth=900;window.dispatchEvent(new dom.window.Event('resize'))});assert.equal(v.container.querySelector('#frame-right g')?.getAttribute('transform'),'translate(900 0) scale(-1 1)')
 await act(async()=>{query.matches=true;change()});assert.ok(v.container.querySelector('#visor')?.classList.contains('no-motion'));assert.ok(cancelled>0)
 const before=scheduled;await act(async()=>window.dispatchEvent(new dom.window.Event('visibilitychange')));assert.equal(scheduled,before)
 v.unmount();assert.equal(api.stopped,1);assert.equal(change,null);dom.window.HTMLCanvasElement.prototype.getContext=original;(globalThis as any).matchMedia=()=>media
})

test('release camera reports unavailable codecs once and tears down the React probe video',async()=>{
 const reports:any[]=[],pause=dom.window.HTMLMediaElement.prototype.pause,load=dom.window.HTMLMediaElement.prototype.load
 dom.window.HTMLMediaElement.prototype.pause=()=>{};dom.window.HTMLMediaElement.prototype.load=()=>{}
 const v=render(<ReleaseCameraApp api={{report:(value:any)=>reports.push(value)}}/>);await waitFor(()=>assert.deepEqual(reports,['chromium_codec_unavailable']));assert.equal(v.container.querySelector('video')?.getAttribute('src'),null);v.unmount();assert.deepEqual(reports,['chromium_codec_unavailable']);dom.window.HTMLMediaElement.prototype.pause=pause;dom.window.HTMLMediaElement.prototype.load=load
})

test('orb unread indicator follows host-owned conversation unread projection',async()=>{
 const {DesktopShell}=await import('../src/renderer/react/shell.tsx'),{createShellStore}=await import('../src/renderer/react/windows/store.ts')
 dom.window.HTMLMediaElement.prototype.pause=function(){}
 const store=createShellStore({unread:true} as any)
 const v=render(<DesktopShell store={store} api={{}} refs={{orb:React.createRef(),canvas:React.createRef(),video:React.createRef()}}/> )
 assert.equal((v.container.querySelector('#unread-indicator') as HTMLElement).hidden,false)
 await act(async()=>store.set({unread:false} as any))
 assert.equal((v.container.querySelector('#unread-indicator') as HTMLElement).hidden,true)
})
