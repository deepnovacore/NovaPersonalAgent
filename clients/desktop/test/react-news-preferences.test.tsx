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
