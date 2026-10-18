import test from 'node:test'
import assert from 'node:assert/strict'
import {startupMessage} from '../src/renderer/startup-notice.mjs'
import {mountWelcomeFlow} from '../src/renderer/welcome-flow.mjs'

test('welcome progress and actionable notices expose the stage actually rendered',t=>{
 class Node {
  constructor(){this.children=[];this.dataset={};this.textContent='';this.selectors=new Map()}
  append(...nodes){this.children.push(...nodes)}
  setAttribute(){}
  toggleAttribute(){}
  addEventListener(){}
  querySelector(selector){if(!this.selectors.has(selector))this.selectors.set(selector,new Node());return this.selectors.get(selector)}
 }
 const previous={document:globalThis.document,window:globalThis.window,MutationObserver:globalThis.MutationObserver},root=new Node()
 globalThis.document={body:new Node(),createElement:()=>new Node(),querySelector:selector=>selector==='#welcome-screen'?root:new Node()}
 globalThis.window={addEventListener(){}}
 globalThis.MutationObserver=class {observe(){}}
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value}})
 const flow=mountWelcomeFlow({api:{welcome:{get:()=>new Promise(()=>{}),onChanged(){}},orbMenu:{}},onProfile(){}})
 const spinner=root.querySelector('.welcome-spinner'),status=root.querySelector('[data-welcome-status]')
 assert.equal(spinner.dataset.stage,'configuration');assert.equal(spinner.hidden,false);assert.equal(status.hidden,true)
 flow.startup({stage:'credentials'})
 assert.equal(status.dataset.stage,'credentials');assert.equal(status.hidden,false);assert.match(status.textContent,/授权/)
 flow.startup({stage:'failed',code:'credential_invalid'})
 assert.equal(spinner.hidden,true);assert.equal(status.hidden,false);assert.match(status.textContent,/密钥/)
 assert.equal(root.querySelector('[data-welcome-settings]').hidden,false)
})

test('normal startup uses the spinner; actionable credential and failure text remains',()=>{
 assert.equal(startupMessage({stage:'backend'}),'')
 assert.equal(startupMessage({stage:'configuration'}),'')
 assert.match(startupMessage({stage:'credentials'}),/授权/)
 assert.match(startupMessage({stage:'failed',code:'credential_invalid'}),/密钥/)
})
