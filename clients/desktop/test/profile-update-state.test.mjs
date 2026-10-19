import test from 'node:test'
import assert from 'node:assert/strict'
import {renderProfile} from '../src/renderer/life-view.mjs'
import {initialInterests} from '../src/renderer/profile-preferences.mjs'
class Element{
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.dataset={}}
 append(...children){this.children.push(...children)}
 setAttribute(){}
 addEventListener(){}
}
test('a prior profile awaiting the current recipe is shown as needing an update, not as a first-time empty profile',()=>{
 const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)}
 try{
  const panel=new Element('main'),buttons=[]
  const button=(text,_click,host)=>{const item=new Element('button',text);host.append(item);buttons.push(item);return item}
  renderProfile(panel,{state:{profile:{version:0,about:''}},news:{},warmup:{status:'idle',draft:null,needs_update:true},command(){},button,local:{},rerender(){}})
  const texts=node=>[node.textContent,...node.children.flatMap(texts)],all=texts(panel)
  assert.ok(all.includes('个人资料需要更新，原有资料仍保存在本机。'))
  assert.equal(all.some(text=>text.includes('我还不太了解你')),false)
  assert.ok(buttons.some(button=>button.textContent==='立即更新'&&!button.disabled))
 }finally{globalThis.document=previous}
})


test('complete published portrait stays visible when current projection loses some references',()=>{
 const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)}
 try{
  const panel=new Element('main'),button=(text,_click,host)=>{const item=new Element('button',text);host.append(item);return item},ref={entry_id:'s',version:'v'}
  const last_success={draft:{about:{text:'Complete prior portrait',refs:[ref]},work:[{title:'Prior work',text:'Established work',refs:[ref]}],interests:[{text:'Private historical topic',refs:[ref]}]},generation_version:'understanding-v7',generated_at:'2026-10-18T12:00:00Z',unavailable_sources:1,sources:[{id:'s',label:'Prior source',available:false}],projects:[],suggestions:[]}
  renderProfile(panel,{state:{profile:{version:0,about:''}},news:{},warmup:{status:'failed',draft:{about:null,work:[{title:'Partial current work',text:'partial',refs:[ref]}],interests:[]},last_success},command(){},button,local:{},rerender(){}})
  const texts=node=>[node.textContent??'',...node.children.flatMap(texts)],all=texts(panel)
  assert.ok(all.includes('Complete prior portrait'));assert.ok(all.includes('Prior work'));assert.ok(!all.some(t=>t.includes('understanding-v7')),'implementation version stays out of ordinary UI');assert.ok(all.includes('部分原始来源已不可用，已整理的历史内容仍保留。'));assert.ok(all.includes('Private historical topic'),'historical interests remain visible as records');assert.ok(!initialInterests({}, {draft:{interests:[]},last_success}).includes('Private historical topic'),'historical interests must not seed current news controls')
 }finally{globalThis.document=previous}
})
