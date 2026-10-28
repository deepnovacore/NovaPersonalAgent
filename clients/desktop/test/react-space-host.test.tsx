import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {render,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react')
const {SpaceHostPanel}=await import('../src/renderer/react/settings/space-host.tsx')
afterEach(cleanup)
test('React Space panel requires the phone fingerprint and explicit revocation confirmation',async()=>{
 const calls:any[]=[];let pending=true;
 const api={personalCommand:async(method:string,params:any)=>{calls.push([method,params]);if(method==='space.status')return {mode:'host',space:'safe-space',clients:['phone']};if(method==='space.pairings')return pending?[{id:'pair',device:'new-phone',fingerprint:'phone-fingerprint'}]:[];if(method==='space.confirm_pairing')pending=false;if(method==='space.invitation')return {space:'safe-space',qr_image:'data:image/png;base64,cXJjb2Rl',secret:'one-time'};return {}}};
 const v=render(<SpaceHostPanel api={api}/>);
 await waitFor(()=>assert.ok(v.queryByRole('button',{name:'确认绑定'})));
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'确认绑定'})));await waitFor(()=>assert.match(v.container.textContent??'',/指纹不匹配/));assert.ok(!calls.some(([m])=>m==='space.confirm_pairing'));
 fireEvent.change(v.getByLabelText('输入手机显示的完整指纹'),{target:{value:'phone-fingerprint'}});await act(async()=>fireEvent.click(v.getByRole('button',{name:'确认绑定'})));await waitFor(()=>assert.ok(calls.some(([m,p])=>m==='space.confirm_pairing'&&p.id==='pair'&&p.fingerprint==='phone-fingerprint')));
 await waitFor(()=>assert.ok(!v.queryByRole('button',{name:'确认绑定'})));
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'生成一次性配对码'})));await waitFor(()=>assert.ok(v.queryByAltText('使用手机扫码绑定')));
 assert.deepEqual(JSON.parse((v.getByLabelText('配对内容') as HTMLTextAreaElement).value),{space:'safe-space',secret:'one-time'});
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'撤销 phone'})));assert.ok(!calls.some(([m])=>m==='space.revoke'));await act(async()=>fireEvent.click(v.getByRole('button',{name:'取消'})));assert.ok(!v.queryByRole('button',{name:'确认撤销并轮换密钥'}));
 await act(async()=>fireEvent.click(v.getByRole('button',{name:'撤销 phone'})));await act(async()=>fireEvent.click(v.getByRole('button',{name:'确认撤销并轮换密钥'})));await waitFor(()=>assert.ok(calls.some(([m,p])=>m==='space.revoke'&&p.device==='phone')));
})
test('pairing list failures are visible and late reads after unmount do not restore a panel',async()=>{
 let resolve:any;const api={personalCommand:async(method:string)=>method==='space.status'?{mode:'host',space:'safe',clients:[]}:new Promise(r=>{resolve=r})};
 const v=render(<SpaceHostPanel api={api}/>);await waitFor(()=>assert.ok(resolve));v.unmount();await act(async()=>resolve([{id:'late',fingerprint:'late'}]));assert.equal(v.container.textContent,'');
 const failed=render(<SpaceHostPanel api={{personalCommand:async(method:string)=>{if(method==='space.status')return {mode:'host',clients:[]};throw Error('pairings unavailable')}}}/>);await waitFor(()=>assert.match(failed.container.textContent??'',/pairings unavailable/));
})
