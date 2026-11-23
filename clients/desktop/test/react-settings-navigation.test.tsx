import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {render,fireEvent,waitFor,cleanup,act,within}=await import('@testing-library/react')
const {default:SettingsApp}=await import('../src/renderer/react/settings.tsx')
const {SETTINGS_CATEGORIES}=await import('../src/renderer/settings-categories.mjs')
afterEach(()=>{cleanup();dom.window.localStorage.clear()})
function base(extra:any={}){return {language:'zh-CN',startupView:'workbench',pipelineMode:'integrated',integratedProvider:'qwen',integratedModel:'qwen-audio-3.1-realtime-plus',integratedVoice:'longanqian_v3.1',cascadedAsrProvider:'volcengine',cascadedLlmProvider:'deepseek',cascadedLlmModels:{deepseek:'deepseek-flash'},cascadedTtsProvider:'volcengine',cascadedTtsVoice:'zh_female_vv_uranus_bigtts',codexBinaryMode:'auto',codexApprovalMode:'ask',proactivity:'balanced',codexHeartbeatSeconds:30,settingsApplyStatus:'applied',backendStatus:'connected',secretsPresent:{dashscopeApiKey:true},secretSources:{},capabilitiesDocument:{version:1},capabilities:{},...extra}}
function bridge(view=base(),set?:any){let push:any;const calls:any[]=[];let off=0;const api={get:async()=>view,onChanged:(fn:any)=>{push=fn;return()=>{off++}},personalCommand:async()=>({settings:{},capabilities:{}}),feishuCommand:async()=>({available:false,configured:false}),voiceprint:async()=>({healthy:false}),set:async(commit:any)=>{calls.push(structuredClone(commit));return set?set(commit):base({...view,...commit.settingsPatch,saved:true,restarted:false})}};return {api,bridge:{settings:api,wakeWord:{activity(){}},camera:{requestPermission:async()=>({status:'granted'}),listDevices:async()=>[]}},calls,push:(v:any)=>push(v),off:()=>off}}
test('the rail orders API keys before models and splits MCP out below 执行器',async()=>{
 const b=bridge(),v=render(<SettingsApp bridge={b.bridge}/>)
 try{
  await waitFor(()=>assert.equal((v.container.querySelector('#startup-view') as HTMLSelectElement).value,'workbench'))
  const rail=[...v.container.querySelectorAll('#settings-nav .nav-item')].map(node=>node.textContent)
  assert.deepEqual(rail,['通用','简报','主题','用量','API 密钥','模型','技能','执行器','MCP','连接器','设备','权限','隐私与数据','知识库'])
  assert.equal(v.container.querySelector('#category-codex'),null,'编程 is no longer a top-level tab')
  // 执行器 only offers coding in v1.0; Loop Camera (vision) controls are hidden.
  fireEvent.click(v.container.querySelector('#category-capabilities')!)
  assert.equal(v.container.querySelector('#executor-tab-vision'),null)
  assert.equal(v.container.querySelector('[data-executor-pane="vision"]'),null)
  assert.equal(v.container.querySelector('#monitor-camera'),null)
  assert.equal(v.container.querySelector('#watch-model'),null)
  assert.equal(v.container.querySelector('#camera-executor-toggle'),null)
  assert.equal((v.container.querySelector('#executor-tab-coding') as HTMLElement).getAttribute('aria-selected'),'true')
  assert.equal((v.container.querySelector('[data-executor-pane="coding"]') as HTMLElement).hidden,false)
  assert.equal((v.container.querySelector('#codex-projects') as HTMLElement).hidden,false,'the coding pane also owns the executor config')
  // MCP is its own page and the capability editor no longer lives on 执行器.
  fireEvent.click(v.container.querySelector('#category-mcp')!)
  assert.equal((v.container.querySelector('#mcp-section') as HTMLElement).hidden,false)
  assert.equal((v.container.querySelector('#executors-section') as HTMLElement).hidden,true)
  assert.ok(v.getByRole('heading',{name:'MCP'}))
  assert.ok(v.container.querySelector('#capabilities-editor'))
 }finally{v.unmount()}
})
