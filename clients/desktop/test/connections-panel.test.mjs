import test from 'node:test'
import assert from 'node:assert/strict'
import {createConnectionsPanel} from '../src/renderer/connections-panel.mjs'
class Node{constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.className='';this.textContent=''}append(...c){this.children.push(...c)}replaceChildren(...c){this.children=c}setAttribute(k,v){this[k]=v}addEventListener(k,v){this.listeners[k]=v}
 querySelectorAll(sel){const tags=sel.split(',');return this.children.flatMap(n=>[...(tags.includes(n.tag)?[n]:[]),...n.querySelectorAll(sel)])}querySelector(sel){return this.querySelectorAll(sel)[0]}focus(){}}
const all=n=>[n,...n.children.flatMap(all)]
function harness(snapshot,{failState=false}={}){
 const root=new Node('div'),error=new Node('p'),calls=[],chosen=[],opened=[]
 const document={querySelector:sel=>sel==='#connections-panel'?root:error,createElement:tag=>new Node(tag),createTextNode:text=>{const n=new Node('#text');n.textContent=text;return n}}
 const api={personalCommand:async(method,params)=>{calls.push([method,params]);if(method==='state')return failState?{error:'unavailable'}:snapshot();return {ok:true}},chooseDirectory:async()=>{chosen.push(1);return '/tmp/docs'},openConnectorAuthorization:async url=>{opened.push(url)}}
 const panel=createConnectionsPanel({document,api})
 return {root,error,calls,chosen,opened,panel,button:label=>all(root).find(n=>n.tag==='button'&&n.textContent===label)}
}
const snapshot=(o={})=>({capabilities:{sources:true,discovery:true},sources:[{id:'s1',path:'/Users/me/notes',state:'connected',scanned:3,read:2,skipped:1,last_sync:'today'}],connectors:{available:false,memory_available:true},settings:{discovery_enabled:true,discovery_interval_minutes:30},...o})
test('load fetches state once and renders sources, connectors, brief and discovery from it',async()=>{
 const h=harness(snapshot);assert.ok(all(h.root).some(n=>n.textContent==='正在读取连接状态…'))
 await h.panel.load();assert.deepEqual(h.calls,[['state',{}]])
 const titles=all(h.root).filter(n=>n.tag==='h3').map(n=>n.textContent);assert.deepEqual(titles,['本机目录','/Users/me/notes','邮件与日历','每日简报','主动发现'])
 assert.equal(all(h.root).find(n=>n.tag==='select'&&n['aria-label']==='主动发现间隔').value,'30');assert.equal(h.error.textContent,'')
})
test('mutations go through the bridge and refresh the snapshot; failures surface in the status line',async()=>{
 const h=harness(snapshot);await h.panel.load()
 await h.button('立即同步').listeners.click();await new Promise(r=>setImmediate(r))
 assert.deepEqual(h.calls.slice(1),[['sources.sync',{id:'s1'}],['state',{}]])
 const check=all(h.root).find(n=>n.tag==='input'&&n.type==='checkbox');assert.equal(h.button('选择并授权目录').disabled,true)
 check.checked=true;check.listeners.change();assert.equal(h.button('选择并授权目录').disabled,false)
 await h.button('选择并授权目录').listeners.click();await new Promise(r=>setImmediate(r))
 assert.deepEqual(h.chosen,[1]);assert.deepEqual(h.calls.at(-2),['sources.add',{path:'/tmp/docs',consent:true}])
 assert.equal(h.button('确认删除来源数据').parentHidden,undefined);await h.button('删除来源数据').listeners.click();await new Promise(r=>setImmediate(r))
 const select=all(h.root).find(n=>n.tag==='select');select.value='0';select.listeners.change();await new Promise(r=>setImmediate(r))
 assert.deepEqual(h.calls.at(-2),['discovery.configure',{enabled:false}])
 const failing=harness(snapshot,{failState:true});await failing.panel.load();assert.equal(failing.error.textContent,'unavailable');assert.ok(all(failing.root).some(n=>n.textContent==='未能读取连接状态，请重试。'))
})
test('the panel never asks for memory, feed or conversation methods',async()=>{
 const h=harness(snapshot);await h.panel.load();for(const b of all(h.root).filter(n=>n.tag==='button'))if(b.listeners.click){await b.listeners.click();await new Promise(r=>setImmediate(r))}
 assert.ok(h.calls.every(([m])=>/^(state|sources\.|connector\.|discovery\.configure)/.test(m)),JSON.stringify(h.calls.map(c=>c[0])))
})
test('whole-computer authorization is explicit and never accepts a renderer supplied root',async()=>{
 const h=harness(snapshot);await h.panel.load()
 const whole=h.button('授权本机全部可访问数据');assert.ok(whole);assert.equal(whole.disabled,true)
 const check=all(h.root).find(n=>n.tag==='input'&&n.type==='checkbox');check.checked=true;check.listeners.change()
 assert.equal(whole.disabled,false);await whole.listeners.click();await new Promise(r=>setImmediate(r))
 assert.deepEqual(h.calls.at(-2),['sources.authorize_computer',{consent:true}])
})
test('English connections settings use secondary tabs without translating source data',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en')
 try{
  const h=harness(()=>snapshot({sources:[{path:'/资料/原始内容',state:'connected',scope:'computer',indexed:2,scan_pending:true}]}));await h.panel.load()
  assert.deepEqual(all(h.root).filter(n=>n.role==='tab').map(n=>n.textContent),['Local files','Mail & calendar','Proactive reminders'])
  assert.equal(all(h.root).filter(n=>n.role==='tabpanel'&&!n.hidden).length,1)
  for(const tab of ['Mail & calendar','Proactive reminders','Local files']){await h.button(tab).listeners.click();await new Promise(r=>setImmediate(r));assert.equal(all(h.root).find(n=>n.role==='tab'&&n['aria-selected']==='true').textContent,tab)}
  const copy=all(h.root).map(n=>n.textContent).join('\n').replaceAll('/资料/原始内容','');assert.ok(!/[\u4e00-\u9fff]/u.test(copy),copy)
 }finally{setLanguage('zh-CN')}
})
