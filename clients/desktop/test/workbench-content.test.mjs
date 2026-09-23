import test from 'node:test'
import assert from 'node:assert/strict'
import {renderLife} from '../src/renderer/life-view.mjs'
import {renderNews} from '../src/renderer/news-view.mjs'
import {renderSourceSuggestions} from '../src/renderer/workbench-suggestions.mjs'

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
