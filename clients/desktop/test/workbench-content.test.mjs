import test from 'node:test'
import assert from 'node:assert/strict'
import {renderLife} from '../src/renderer/life-view.mjs'
import {renderNews} from '../src/renderer/news-view.mjs'
import {renderSourceSuggestions} from '../src/renderer/workbench-suggestions.mjs'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'

class Node{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.dataset={};this.className=''}append(...nodes){this.children.push(...nodes)}setAttribute(k,v){this[k]=v}addEventListener(){}}
const all=node=>[node,...node.children.flatMap(all)]
function harness(t){const previous=globalThis.document;t.after(()=>{globalThis.document=previous});globalThis.document={createElement:tag=>new Node(tag)};const panel=new Node('main');const button=(label,action,parent)=>{const node=new Node('button');node.textContent=label;node.action=action;parent.append(node);return node};return {panel,button,command:async()=>{},local:{},rerender(){},delegate(){}}}
const text=panel=>all(panel).map(node=>node.textContent).filter(Boolean).join('\n')

test('saved Todo renders before suggestions and populated content has no saved-empty copy',t=>{
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'todo',state:{todos:[{id:'t',kind:'todo',title:'Call supplier',note:'',status:'open',version:1}],ideas:[],goals:[]}})
 renderSourceSuggestions(h.panel,{tab:'todos',context:{status:'ready',candidate_count:1,cards:[{id:'c',tab:'todos',title:'Compare flows',body:'The note lists a next step.',refs:[]}]},sources:[{state:'connected'}],button:h.button,command:h.command,continueChat:()=>{}})
 const output=text(h.panel)
 assert.ok(output.indexOf('Call supplier')<output.indexOf('Compare flows'))
 assert.doesNotMatch(output,/还没有待办/u)
})
test('empty Life and source states use specific copy without inventing work',t=>{
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'goal',state:{todos:[],ideas:[],goals:[]}})
 assert.match(text(h.panel),/还没有设定目标/u)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:{status:'ready',candidate_count:0,cards:[],empty_reason:'no_eligible_sources'},sources:[{state:'connected',scan_pending:true}],button:h.button,command:h.command,continueChat:()=>{}})
 assert.match(text(h.panel),/正在整理已授权的资料/u)
 assert.doesNotMatch(text(h.panel),/值得关注|持续推进/u)
})
test('unloaded Life data and paused sources never claim an empty list or active scan',t=>{
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'todo',state:undefined})
 assert.match(text(h.panel),/正在读取已保存的内容/u)
 assert.doesNotMatch(text(h.panel),/还没有待办/u)
 renderSourceSuggestions(h.panel,{tab:'todos',context:{status:'idle',candidate_count:0,cards:[]},sources:[{state:'paused',scan_pending:true}],button:h.button,command:h.command,continueChat:()=>{}})
 assert.match(text(h.panel),/资料来源已暂停/u)
 assert.doesNotMatch(text(h.panel),/正在整理已授权的资料/u)
})
test('disconnected source state does not claim that no sources are connected',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:null,sources:[],button:h.button,command:h.command,continueChat:()=>{},connected:false})
 assert.match(text(h.panel),/资料来源状态暂不可用/u)
 assert.doesNotMatch(text(h.panel),/还没有连接资料/u)
})
test('a partial source failure remains visible beside available suggestions',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:{status:'ready',cards:[{id:'card',tab:'ideas',title:'Simplify setup',body:'The note suggests a shorter setup.',refs:[]}]},sources:[{scope:'computer',state:'error'}],button:h.button,command:h.command,continueChat:()=>{},openSettings:()=>{}})
 assert.match(text(h.panel),/Simplify setup/u)
 assert.match(text(h.panel),/整机资料尚未读完/u)
 assert.match(text(h.panel),/查看来源/u)
})
test('disabled news has an honest empty state',t=>{
 const h=harness(t)
 renderNews(h.panel,{...h,news:{enabled:false,items:[],saved:[],sources:[],interests:[],profile_version:0}})
 assert.match(text(h.panel),/资讯更新已关闭/u)
 assert.doesNotMatch(text(h.panel),/资讯精选|好内容正在路上/u)
})
test('scan progress preserves a focused Todo draft and material content refresh restores it',t=>{
 const previous=globalThis.document,oldWindow=globalThis.window
 t.after(()=>{globalThis.document=previous;globalThis.window=oldWindow})
 class DomNode extends Node{
  constructor(tag){super(tag);this.listeners={};this.scrollTop=0;this.attrs={};this.classList={add(){}}}
  prepend(...nodes){this.children.unshift(...nodes)}replaceChildren(...nodes){this.children=nodes}
  addEventListener(name,fn){this.listeners[name]=fn}
  querySelectorAll(selector){const tags=selector.split(',');return this.children.flatMap(node=>[...(tags.includes(node.tag)?[node]:[]),...node.querySelectorAll(selector)])}
  querySelector(selector){return this.querySelectorAll(selector)[0]}
  contains(node){return this.children.some(child=>child===node||child.contains(node))}
  getAttribute(name){return this.attrs[name]}
  setAttribute(name,value){this.attrs[name]=value}
  focus(){document.activeElement=this}
  get childElementCount(){return this.children.length}
 }
 const body=new DomNode('body'),shell=new DomNode('div');body.append(shell)
 globalThis.window={addEventListener(){}}
 globalThis.document={body,activeElement:null,visibilityState:'hidden',hasFocus:()=>false,addEventListener(){},createElement:tag=>new DomNode(tag),createElementNS:(_,tag)=>new DomNode(tag),createTextNode:()=>new DomNode('text'),querySelector:()=>shell}
 const view=mountPersonalView({send:()=>true,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],openResults(){},api:{orbMenu:{},personal:{}}})
 view.controller.connect()
 const state=(revision,title,scanned)=>({type:'personal.state',revision,life:{todos:[{id:'t',kind:'todo',title,note:'',status:'open',version:title==='Updated'?2:1}],ideas:[],goals:[]},sources:[{state:'connected',scanned}],conversations:{items:[]},memory:{entries:[]}})
 view.receive(state(1,'Original',1))
 const panel=body.querySelector('.workbench-page')??all(body).find(node=>node.className==='workbench-page')
 const edit=panel.querySelectorAll('textarea')[0];edit.value='Unsaved words';edit.selectionStart=2;edit.selectionEnd=7;edit.focus();panel.scrollTop=73
 view.receive(state(2,'Original',2));assert.equal(panel.querySelectorAll('textarea')[0],edit);assert.equal(document.activeElement,edit);assert.equal(panel.scrollTop,73);assert.match(all(body).find(node=>node.className==='page-title').textContent,/Todos/u)
 view.receive(state(3,'Updated',2));assert.match(all(panel).map(node=>node.textContent).join(' '),/Updated/u)
 const restored=panel.querySelectorAll('textarea')[0];assert.equal(document.activeElement,restored);assert.equal(restored.value,'Unsaved words');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,7);assert.equal(panel.scrollTop,73)
 const candidate=id=>({id,kind:'todo',text:`Candidate ${id}`,quote:'said'})
 const withCandidates=(revision,ids)=>({...state(revision,'Updated',2),understanding:{items:ids.map(candidate)}})
 view.receive(withCandidates(4,['a','b']))
 const editors=()=>panel.querySelectorAll('textarea').filter(node=>node.getAttribute('aria-label')==='候选内容')
 const b=editors()[1];b.value='Unsaved B';b.selectionStart=1;b.selectionEnd=5;b.scrollTop=12;b.focus();panel.scrollTop=81
 view.receive(withCandidates(5,['x','a','b']))
 assert.deepEqual(editors().map(node=>node.value),['Candidate x','Candidate a','Unsaved B'])
 assert.equal(document.activeElement,editors()[2]);assert.equal(editors()[2].selectionStart,1);assert.equal(editors()[2].selectionEnd,5);assert.equal(editors()[2].scrollTop,12);assert.equal(panel.scrollTop,81)
 view.receive(withCandidates(6,['b']))
 assert.equal(document.activeElement,editors()[0]);assert.equal(editors()[0].value,'Unsaved B');assert.equal(editors()[0].selectionStart,1);assert.equal(editors()[0].scrollTop,12);assert.equal(panel.scrollTop,81)
})
