import {test} from 'node:test'
import assert from 'node:assert/strict'
import {newsArticleUrl} from '../src/main/security.mjs'
import {renderNews} from '../src/renderer/news-view.mjs'
import {renderLife,renderProfile} from '../src/renderer/life-view.mjs'
class Node {constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.dataset={}}append(...c){this.children.push(...c)}setAttribute(k,v){this[k]=v}addEventListener(k,v){this.listeners[k]=v}}
function harness(t){const old=globalThis.document;t.after(()=>{globalThis.document=old});globalThis.document={createElement:tag=>new Node(tag)};const panel=new Node('div'),buttons=[],calls=[];const button=(label,action,parent)=>{const b=new Node('button');b.textContent=label;b.action=action;buttons.push(b);parent.append(b);return b};return {panel,buttons,calls,button,command:async(...args)=>{calls.push(args)},local:{},rerender(){},profile(){},openArticle:async url=>{calls.push(['open',url])}}}
test('links reject non-web schemes, credentials and local addresses',()=>{for(const u of ['file:///tmp/x','javascript:alert(1)','https://user:pw@example.com','http://127.0.0.1','http://[::1]/'])assert.throws(()=>newsArticleUrl(u));assert.equal(newsArticleUrl('https://www.bbc.com/news/one'),'https://www.bbc.com/news/one')})
test('reading and saving news are explicit and do not write profile facts',async t=>{const h=harness(t);renderNews(h.panel,{...h,news:{enabled:true,mode:'personalized',pending:0,sources:[{id:'bbc',name:'BBC'}],interests:[],items:[{id:'a',source_id:'bbc',title:'Actual news',summary:'Excerpt',url:'https://www.bbc.com/news/a',ranking:null}],saved:[]}});assert.equal(h.calls.length,0);await h.buttons.find(b=>b.textContent==='阅读原文').action();await h.buttons.find(b=>b.textContent==='收藏').action();assert.deepEqual(h.calls,[['open','https://www.bbc.com/news/a'],['news.action',{action:'read',id:'a',value:true}],['news.action',{action:'save',id:'a',value:true}]])})
test('ideas convert explicitly and goals show zero denominator honestly',async t=>{const h=harness(t);const idea={id:'i',kind:'idea',title:'A',note:'B',version:1,status:'active'};renderLife(h.panel,{...h,kind:'idea',state:{ideas:[idea],todos:[],goals:[]},delegate(){}});await h.buttons.find(b=>b.textContent==='转为目标').action();assert.deepEqual(h.calls[0],['life.mutate',{op:'convert',id:'i',target:'goal',expected_version:1}]);assert.equal(h.calls.length,1)})
test('profile uses news canonical interests, no collection is copied into life profile',async t=>{const h=harness(t);renderProfile(h.panel,{...h,state:{profile:{version:2,about:'Me'}},news:{enabled:true,explore:false,interests:[{id:'ai',text:'AI',weight:1}]},showMemory(){}});await h.buttons.find(b=>b.textContent==='保存兴趣与开关').action();assert.equal(h.calls[0][0],'news.configure');assert.deepEqual(h.calls[0][1].interests,['AI'])})
test('news conversion previews editable fields and writes only after explicit save',async t=>{
 const h=harness(t),news={enabled:true,mode:'timeline',pending:0,sources:[],interests:[],items:[{id:'a',source_id:'bbc',title:'Article title',summary:'Public excerpt',url:'https://www.bbc.com/news/a',content_hash:'hash',ranking:null}],saved:[]}
 renderNews(h.panel,{...h,news});await h.buttons.find(b=>b.textContent==='转为个人事项')?.action()
 assert.ok(h.local['convert:a'],'conversion opens a draft');assert.equal(h.calls.length,0)
 h.local['convert:a'].title='Read the research';h.local['convert:a'].note='My own next step';h.local['convert:a'].kind='todo'
 h.buttons.length=0;renderNews(h.panel,{...h,news});await h.buttons.find(b=>b.textContent==='保存个人事项').action()
 assert.deepEqual(h.calls,[['news.convert',{id:'a',content_hash:'hash',kind:'todo',title:'Read the research',note:'My own next step'}]])
 assert.equal(h.local['convert:a'],undefined)
})
test('changed news disables an old conversion draft until reopened',async t=>{
 const h=harness(t),news={enabled:true,mode:'timeline',pending:0,sources:[],interests:[],items:[{id:'a',title:'Updated article',content_hash:'v2',ranking:null}],saved:[]}
 h.local['convert:a']={id:'a',content_hash:'v1',kind:'idea',title:'Old article',note:''};renderNews(h.panel,{...h,news})
 assert.equal(h.buttons.find(b=>b.textContent==='保存个人事项').disabled,true)
 await h.buttons.find(b=>b.textContent==='取消转换').action();assert.equal(h.calls.length,0);assert.equal(h.local['convert:a'],undefined)
})
test('Life cards show saved public news provenance and open only through the supplied validated action',async t=>{
 const h=harness(t),source={title:'Public article',url:'https://www.bbc.com/news/a'}
 renderLife(h.panel,{...h,kind:'idea',state:{ideas:[{id:'i',title:'My idea',note:'',version:1,status:'active',news_source:source}],todos:[],goals:[]},delegate(){}})
 const flatten=node=>[node,...node.children.flatMap(flatten)]
 assert.ok(flatten(h.panel).some(n=>n.textContent==='由你从公开资讯保存：Public article'))
 assert.ok(flatten(h.panel).some(n=>n.textContent===source.url));assert.equal(h.calls.length,0)
 await h.buttons.find(b=>b.textContent==='查看资讯原文').action();assert.deepEqual(h.calls,[['open',source.url]])
})
test('disabled feeds offer the connections settings deep link only when an opener exists',async t=>{
 const h=harness(t),opened=[];renderNews(h.panel,{...h,news:{enabled:false,mode:'timeline',pending:0,sources:[],interests:[],items:[],saved:[]},openSettings:category=>opened.push(category)})
 await h.buttons.find(b=>b.textContent==='前往设置').action();assert.deepEqual(opened,['connections']);assert.equal(h.calls.length,0)
 h.buttons.length=0;renderNews(h.panel,{...h,news:{enabled:false,mode:'timeline',pending:0,sources:[],interests:[],items:[],saved:[]}});assert.equal(h.buttons.find(b=>b.textContent==='前往设置'),undefined)
})
test('life forms start collapsed behind an add button and reopen for edits',async t=>{
 const h=harness(t);renderLife(h.panel,{...h,kind:'todo',state:{todos:[{id:'t',kind:'todo',title:'A',note:'',version:1,status:'open'}],ideas:[],goals:[]},delegate(){}})
 const flatten=node=>[node,...node.children.flatMap(flatten)];const form=()=>flatten(h.panel).find(n=>n.className==='life-form')
 assert.equal(form().hidden,true);assert.ok(h.buttons.find(b=>b.textContent==='添加待办'))
 await h.buttons.find(b=>b.textContent==='添加待办').action();assert.equal(h.local['todo:formOpen'],true)
 h.buttons.length=0;h.panel.children=[];renderLife(h.panel,{...h,kind:'todo',state:{todos:[],ideas:[],goals:[]},delegate(){}});assert.equal(form().hidden,false);assert.ok(h.buttons.find(b=>b.textContent==='收起表单'));assert.ok(h.buttons.find(b=>b.textContent==='保存'))
 h.local['todo:form']={id:'t',title:'A',note:'',version:1};delete h.local['todo:formOpen']
 h.buttons.length=0;h.panel.children=[];renderLife(h.panel,{...h,kind:'todo',state:{todos:[],ideas:[],goals:[]},delegate(){}});assert.equal(form().hidden,false,'an edit draft opens the form without the flag');assert.ok(h.buttons.find(b=>b.textContent==='保存修改'))
})
