import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {render,fireEvent,waitFor,cleanup,act,within}=await import('@testing-library/react')
const {default:SettingsApp}=await import('../src/renderer/react/settings.tsx')
afterEach(()=>{cleanup();dom.window.localStorage.clear()})
function base(extra:any={}){return {language:'zh-CN',startupView:'workbench',pipelineMode:'integrated',integratedProvider:'qwen',integratedModel:'qwen-audio-3.1-realtime-plus',integratedVoice:'longanqian_v3.1',cascadedAsrProvider:'volcengine',cascadedLlmProvider:'deepseek',cascadedLlmModels:{deepseek:'deepseek-flash'},cascadedTtsProvider:'volcengine',cascadedTtsVoice:'zh_female_vv_uranus_bigtts',codexBinaryMode:'auto',codexApprovalMode:'ask',proactivity:'balanced',codexHeartbeatSeconds:30,settingsApplyStatus:'applied',backendStatus:'connected',secretsPresent:{dashscopeApiKey:true},secretSources:{},capabilitiesDocument:{version:1},capabilities:{},...extra}}
function bridge(view=base(),set?:any){let push:any;const calls:any[]=[];let off=0;const api={get:async()=>view,onChanged:(fn:any)=>{push=fn;return()=>{off++}},personalCommand:async()=>({settings:{},capabilities:{}}),feishuCommand:async()=>({available:false,configured:false}),voiceprint:async()=>({healthy:false}),set:async(commit:any)=>{calls.push(structuredClone(commit));return set?set(commit):base({...view,...commit.settingsPatch,saved:true,restarted:false})}};return {api,bridge:{settings:api,wakeWord:{activity(){}},camera:{requestPermission:async()=> 'granted',listDevices:async()=>[]}},calls,push:(v:any)=>push(v),off:()=>off}}
test('knowledge page is a compact toolbar, URL row and source list with icon actions',async()=>{
 const view=base({focusCategory:'knowledge',capabilities:{runtime:{modules:{knowledge:{enabled:true}}}}})
 const b=bridge(view);const calls:any[]=[];const sources=[{id:'source-1',title:'产品手册.md',status:'ready'},{id:'source-2',title:'价格表.pdf',status:'failed'}]
 ;(b.api as any).knowledgeAction=async(input:any)=>{calls.push(structuredClone(input));return input.action==='status'?{sources,fts:true,jobs:[]}:{ok:true}}
 const v=render(<SettingsApp bridge={b.bridge}/>)
 await waitFor(()=>assert.equal(v.container.querySelector('#knowledge-panel')?.hasAttribute('hidden'),false))
 const toolbar=v.getByRole('toolbar',{name:'知识库操作'})
 for(const name of ['添加文件','添加文件夹','刷新'])assert.ok(within(toolbar).getByRole('button',{name}),name)
 fireEvent.click(within(toolbar).getByRole('button',{name:'刷新'}))
 await waitFor(()=>assert.ok(calls.some(call=>call.action==='status'),'refresh should read the status'))
 await waitFor(()=>assert.equal(v.container.querySelectorAll('.knowledge-source').length,2))
 assert.equal(v.getAllByRole('button',{name:/^重建索引 /}).length,2)
 assert.ok(v.getByRole('button',{name:'移除 产品手册.md'}),'remove buttons name their source')
 assert.equal(v.getAllByRole('button',{name:/^移除 /}).length,2)
 const status=v.container.querySelector('#knowledge-status') as HTMLElement
 assert.equal(status.getAttribute('role'),'status')
 assert.match(status.textContent??'',/2 个来源/)
 fireEvent.click(v.getByRole('button',{name:'移除 产品手册.md'}))
 await waitFor(()=>assert.ok(v.getByRole('button',{name:'确认移除 产品手册.md'}),'first click only arms the removal'))
 assert.equal(calls.some(call=>call.action==='remove'),false)
 fireEvent.click(v.getByRole('button',{name:'确认移除 产品手册.md'}))
 await waitFor(()=>assert.ok(calls.some(call=>call.action==='remove'&&call.id==='source-1'),'second click removes'))
 fireEvent.click(v.getAllByRole('button',{name:/^重建索引 /})[0])
 await waitFor(()=>assert.ok(calls.some(call=>call.action==='reindex'&&call.id==='source-1'&&call.consent===true),'reindex should carry consent'))
 const url=v.getByLabelText('公开网页 URL') as HTMLInputElement
 assert.equal(url.getAttribute('maxlength'),'2048')
 fireEvent.change(url,{target:{value:'https://example.com/notes'}})
 fireEvent.click(v.getByRole('button',{name:'导入网页'}))
 await waitFor(()=>assert.ok(calls.some(call=>call.action==='url'&&call.url==='https://example.com/notes'&&call.consent===true),'import should carry consent'))
})
test('knowledge page stays hidden until the knowledge module is enabled',async()=>{
 const b=bridge(base({focusCategory:'knowledge'}));const v=render(<SettingsApp bridge={b.bridge}/>)
 await waitFor(()=>assert.equal(v.container.querySelector('#knowledge-panel')?.hasAttribute('hidden'),true))
})
test('secret rows expose one-line present/source badges and hide configured inputs',async()=>{
 const b=bridge(base({focusCategory:'secrets',secretsPresent:{dashscopeApiKey:true,stepfunApiKey:false},secretSources:{dashscopeApiKey:'dotenv'}}))
 const v=render(<SettingsApp bridge={b.bridge}/>)
 await waitFor(()=>assert.ok(v.container.querySelector('#secrets')))
 const managed=v.container.querySelector('.secret[data-key="dashscopeApiKey"]') as HTMLElement
 assert.equal(managed.firstElementChild?.tagName,'LABEL')
 const managedBadge=managed.querySelector('.badge') as HTMLElement
 assert.equal(managedBadge.getAttribute('data-present'),'1')
 assert.equal(managedBadge.getAttribute('data-source'),'dotenv')
 assert.equal(managedBadge.textContent,'来自 .env')
 assert.equal((managed.querySelector('.key-usage') as HTMLElement).textContent,'')
 const managedInput=managed.querySelector('input[type="password"]') as HTMLInputElement
 assert.equal(managedInput.hidden,true)
 assert.equal(managedInput.disabled,true)
 assert.equal((managed.querySelector('button.clear') as HTMLButtonElement).disabled,true)
 assert.ok(managed.querySelector('.key-link'),'key rows keep the get-key link')
 const editable=v.container.querySelector('.secret[data-key="stepfunApiKey"]') as HTMLElement
 const editableBadge=editable.querySelector('.badge') as HTMLElement
 assert.equal(editableBadge.getAttribute('data-present'),'0')
 assert.equal(editableBadge.getAttribute('data-source'),'none')
 assert.equal(editableBadge.textContent,'未设置')
 assert.equal((editable.querySelector('input[type="password"]') as HTMLInputElement).hidden,false)
})
