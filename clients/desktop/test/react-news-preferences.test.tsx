import test from 'node:test'
import assert from 'node:assert/strict'
import React,{act,useState} from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://nova.local/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {createRoot}=await import('react-dom/client')
const {NewsPreferencesPanel}=await import('../src/renderer/react/settings/news')
test('an old interest save cannot clear a newer draft after leaving and reopening settings',async()=>{
 let finish:any,control:any;const pending=new Promise(resolve=>{finish=resolve}),state={news:{enabled:true,explore:false,interests:[{text:'科学'}],profile_version:8}};
 const api={personalCommand:async(method:string)=>method==='state'?state:pending};
 function Harness(){const [show,setShow]=useState(true),[local,setLocal]=useState<any>({interestEdit:{enabled:true,explore:false,interests:['科学'],version:8,custom:'A'}});control={setShow,setLocal,local};return show?<NewsPreferencesPanel api={api} local={local} setLocal={setLocal}/>:null}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{await act(async()=>root.render(<Harness/>));const save=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='完成调整');assert.ok(save,'interest editor is ready');await act(async()=>save.click());
 await act(async()=>control.setShow(false));await act(async()=>control.setShow(true));await act(async()=>control.setLocal((old:any)=>({...old,interestEdit:{...old.interestEdit,custom:'NEWER B'}})));
 await act(async()=>finish({ok:true}));assert.equal(control.local.interestEdit?.custom,'NEWER B');
 }finally{finish?.({ok:true});await act(async()=>root.unmount());host.remove()}
})

const {CompactNewsInterests}=await import('../src/renderer/react/pages/feeds')
const {PageContext}=await import('../src/renderer/react/pages/shared')
test('Feeds inline chips add and remove through news.configure with optimistic version',async()=>{
 const calls:any[]=[]
 function Harness(){
  const [news,setNews]=useState({enabled:true,explore:true,profile_version:3,interests:[{text:'健康'}]})
  const command=async(method:string,params:any)=>{calls.push([method,params]);setNews({...news,profile_version:news.profile_version+1,interests:params.interests.map((text:string)=>({text}))})}
  const context={command,connected:true,pending:new Set(),execute:async(_key:string,action:any)=>action()}
  return <PageContext.Provider value={context}><CompactNewsInterests news={news}/></PageContext.Provider>
 }
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{
  await act(async()=>root.render(<Harness/>));assert.match(host.textContent??'',/关注方向/)
  const input=host.querySelector('input')!
  // Use React's native value setter, then a bubbling input event.
  await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,'园艺');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))})
  await act(async()=>{host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}))})
  assert.deepEqual(calls[0],['news.configure',{enabled:true,explore:true,interests:['健康','园艺'],expected_version:3,keep_mined:true}])
  assert.equal(input.value,'')
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="移除关注：健康"]')!.click())
  assert.deepEqual(calls[1],['news.configure',{enabled:true,explore:true,interests:['园艺'],expected_version:4,keep_mined:true}])
 }finally{await act(async()=>root.unmount());host.remove()}
})
