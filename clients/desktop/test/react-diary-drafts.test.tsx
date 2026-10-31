import test from 'node:test'
import assert from 'node:assert/strict'
import React,{act,useState} from 'react'
import {JSDOM} from 'jsdom'
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://nova.local/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
const {createRoot}=await import('react-dom/client')
const {ProactivityPanel}=await import('../src/renderer/react/settings/live')

async function mount(controlled=true){
 let state:any={settings:{diary_enabled:true,briefing_outlook_enabled:true,briefing_outlook_time:'08:30'},capabilities:{discovery:true}},reject=false,hold:any=null,setVisible:any,currentDraft:any
 const calls:any[]=[],api={personalCommand:async(method:string,params:any)=>{calls.push([method,params]);if(method==='discovery.configure'){if(hold)await hold;if(reject)throw Error('offline');state={...state,settings:{...state.settings,...params}}}return state}}
 function Harness(){const [visible,show]=useState(true),[draft,setDraft]=useState<any>(null);setVisible=show;currentDraft=draft;return visible?<ProactivityPanel api={api} diary {...(controlled?{briefingDraft:draft,onBriefingDraftChange:setDraft}:{})}/>:null}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 await act(async()=>root.render(<Harness/>))
 const field=(label:string)=>host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
 const click=async(label:string)=>{const node=[...host.querySelectorAll('button')].find(n=>n.textContent===label);assert.ok(node,label);await act(async()=>node.click())}
 const setTime=async(label:string,value:string)=>act(async()=>{const input=field(label);assert.ok(input,label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));input.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})
 const time=async(value:string)=>setTime('早间时间',value)
 const toggle=async(label:string)=>{const input=field(label);assert.ok(input,label);await act(async()=>input.click())}
 return {host,field,time,setTime,toggle,click,calls,draft:()=>currentDraft,setReject:(value:boolean)=>{reject=value},hold:(value:any)=>{hold=value},setServerTime:(value:string)=>{state={...state,settings:{...state.settings,briefing_outlook_time:value}}},toggleDiary:async()=>act(async()=>field('写每日日记').click()),show:async(visible:boolean)=>act(async()=>setVisible(visible)),close:async()=>{await act(async()=>root.unmount());host.remove()}}
}
test('briefing draft survives diary toggle and category navigation, failure retains it, success releases it',async()=>{
 const p=await mount();try{
  await p.time('09:45');await p.toggleDiary();assert.equal(p.field('早间时间').value,'09:45')
  await p.show(false);await p.show(true);assert.equal(p.field('早间时间').value,'09:45')
  p.setReject(true);await p.click('保存简报设置');assert.equal(p.field('早间时间').value,'09:45');assert.equal(p.draft().briefing_outlook_time,'09:45');assert.ok(p.host.textContent?.includes('offline'))
  p.setReject(false);await p.click('保存简报设置');assert.equal(p.draft(),null)
  p.setServerTime('10:15');await p.toggleDiary();assert.equal(p.field('早间时间').value,'10:15')
  assert.equal(p.calls.filter(([method,params])=>method==='discovery.configure'&&params.briefing_outlook_time==='09:45').length,2)
 }finally{await p.close()}
})
test('unedited briefing fields follow the latest server state',async()=>{
 const p=await mount();try{p.setServerTime('10:15');await p.toggleDiary();assert.equal(p.field('早间时间').value,'10:15');assert.equal(p.draft(),null)}finally{await p.close()}
})
test('standalone diary panel keeps a local draft through unrelated changes',async()=>{
 const p=await mount(false);try{await p.time('09:45');await p.toggleDiary();assert.equal(p.field('早间时间').value,'09:45');await p.click('保存简报设置');p.setServerTime('10:15');await p.toggleDiary();assert.equal(p.field('早间时间').value,'10:15')}finally{await p.close()}
})
test('pending briefing save locks fields and rejects duplicate submission',async()=>{
 const p=await mount();let release:any;try{await p.time('09:45');p.hold(new Promise(resolve=>{release=resolve}));await p.click('保存简报设置');assert.equal(p.field('早间时间').disabled,true);await p.click('保存简报设置');assert.equal(p.calls.filter(([method])=>method==='discovery.configure').length,1);await act(async()=>release());assert.equal(p.field('早间时间').disabled,false)}finally{release?.();await p.close()}
})
test('an older save response preserves a newer briefing draft after category navigation',async()=>{
 const p=await mount();let release:any;try{await p.time('09:45');p.hold(new Promise(resolve=>{release=resolve}));await p.click('保存简报设置');await p.show(false);await p.show(true);await p.time('10:15');await act(async()=>release());assert.equal(p.field('早间时间').value,'10:15');assert.equal(p.draft().briefing_outlook_time,'10:15')}finally{release?.();await p.close()}
})
test('diary and brief rows use switches, weekday chips and quiet-hours time inputs',async()=>{
 const p=await mount();try{
  assert.equal(p.field('写每日日记').getAttribute('role'),'switch')
  assert.equal((p.field('早间简报') as HTMLInputElement).checked,true)
  assert.equal((p.field('晚间简报') as HTMLInputElement).checked,false)
  assert.equal(p.field('晚间时间').disabled,true)
  await p.toggle('晚间简报');assert.equal(p.field('晚间时间').disabled,false)
  await p.setTime('晚间时间','19:15')
  await p.toggle('周六');await p.toggle('周一')
  await p.setTime('免打扰开始','21:30');await p.setTime('免打扰结束','07:15')
  await p.click('保存简报设置')
  assert.deepEqual(p.calls.filter(([method])=>method==='discovery.configure').at(-1)[1],{briefing_outlook_enabled:true,briefing_outlook_time:'08:30',briefing_review_enabled:true,briefing_review_time:'19:15',briefing_weekdays:[2,3,4,5,6],quiet_start:'21:30',quiet_end:'07:15'})
 }finally{await p.close()}
})
test('briefing save refuses a schedule without a weekday',async()=>{
 const p=await mount();try{
  for(const day of ['周一','周二','周三','周四','周五'])await p.toggle(day)
  const before=p.calls.filter(([method])=>method==='discovery.configure').length
  await p.click('保存简报设置')
  assert.equal(p.calls.filter(([method])=>method==='discovery.configure').length,before)
  assert.match(p.host.textContent??'',/请选择至少一天/)
 }finally{await p.close()}
})
