import {test} from 'node:test'
import assert from 'node:assert/strict'
import {newsArticleUrl} from '../src/main/security.mjs'
import {renderNews} from '../src/renderer/news-view.mjs'
import {renderLife,renderProfile} from '../src/renderer/life-view.mjs'
class Node {constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.dataset={}}append(...c){this.children.push(...c)}setAttribute(k,v){this[k]=v}addEventListener(k,v){this.listeners[k]=v}}
function harness(t){const old=globalThis.document;t.after(()=>{globalThis.document=old});globalThis.document={createElement:tag=>new Node(tag)};const panel=new Node('div'),buttons=[],calls=[];const button=(label,action,parent)=>{const b=new Node('button');b.textContent=label;b.action=action;buttons.push(b);parent.append(b);return b};return {panel,buttons,calls,button,command:async(...args)=>{calls.push(args)},local:{},rerender(){},profile(){},openArticle:async url=>{calls.push(['open',url])}}}
test('links reject non-web schemes, credentials and local addresses',()=>{for(const u of ['file:///tmp/x','javascript:alert(1)','https://user:pw@example.com','http://127.0.0.1','http://[::1]/'])assert.throws(()=>newsArticleUrl(u));assert.equal(newsArticleUrl('https://www.bbc.com/news/one'),'https://www.bbc.com/news/one')})
test('reading and saving news are explicit and do not write profile facts',async t=>{const h=harness(t);renderNews(h.panel,{...h,news:{enabled:true,mode:'personalized',pending:0,sources:[{id:'bbc',name:'BBC'}],interests:[],items:[{id:'a',source_id:'bbc',title:'Actual news',summary:'Excerpt',url:'https://www.bbc.com/news/a',ranking:null}],saved:[]}});assert.equal(h.calls.length,0);await h.buttons.find(b=>b.textContent==='阅读原文').action();await h.buttons.findLast(b=>b.textContent==='收藏').action();assert.deepEqual(h.calls,[['open','https://www.bbc.com/news/a'],['news.action',{action:'read',id:'a',value:true}],['news.action',{action:'save',id:'a',value:true}]])})
test('ideas convert explicitly and goals show zero denominator honestly',async t=>{const h=harness(t);const idea={id:'i',kind:'idea',title:'A',note:'B',version:1,status:'active'};renderLife(h.panel,{...h,kind:'idea',state:{ideas:[idea],todos:[],goals:[]},delegate(){}});await h.buttons.find(b=>b.textContent==='转为目标').action();assert.deepEqual(h.calls[0],['life.mutate',{op:'convert',id:'i',target:'goal',expected_version:1}]);assert.equal(h.calls.length,1)})
test('profile adjustments use canonical news interests without copying collection into profile',async t=>{
 const h=harness(t),args={...h,state:{profile:{version:2,about:'Me'}},news:{enabled:true,explore:false,profile_version:3,interests:[{id:'ai',text:'AI',weight:1}]}}
 renderProfile(h.panel,args);await h.buttons.find(b=>b.textContent==='调整兴趣').action()
 h.buttons.length=0;renderProfile(h.panel,args);await h.buttons.find(b=>b.textContent==='完成调整').action()
 assert.deepEqual(h.calls,[['news.configure',{enabled:true,explore:false,interests:['AI'],expected_version:3}]])
})
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
test('disabled feeds can be enabled in place without a settings detour',async t=>{
 const h=harness(t);renderNews(h.panel,{...h,news:{enabled:false,mode:'timeline',pending:0,profile_version:0,sources:[],interests:[],items:[],saved:[]}})
 assert.ok(h.buttons.find(b=>b.textContent==='开启资讯'));assert.equal(h.buttons.find(b=>b.textContent==='前往设置'),undefined);assert.equal(h.calls.length,0)
})
test('disconnected Feeds does not present a false news-loading state',t=>{
 const h=harness(t);renderNews(h.panel,{...h,news:undefined,connected:false})
 const copy=h.panel.children.map(node=>node.textContent).join(' ')
 assert.match(copy,/资讯暂不可用/u)
 assert.doesNotMatch(copy,/正在连接资讯/u)
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

test('profile starts with a readable preview and editing is optional',async t=>{
 const h=harness(t),args={...h,state:{profile:{version:2,about:'I build audio tools'}},news:{enabled:true,explore:false,profile_version:3,interests:[{id:'ai',text:'AI',weight:1}]}}
 renderProfile(h.panel,args)
 const flatten=node=>[node,...node.children.flatMap(flatten)]
 assert.equal(flatten(h.panel).filter(n=>n.tag==='textarea').length,0)
 assert.ok(flatten(h.panel).some(n=>n.textContent==='I build audio tools'))
 await h.buttons.find(b=>b.textContent==='编辑概览').action()
 h.panel.children=[];h.buttons.length=0;renderProfile(h.panel,args)
 assert.equal(flatten(h.panel).filter(n=>n.tag==='textarea').length,1)
 assert.equal(h.calls.length,0)
})

test('generated interests are previews until explicitly enabled',async t=>{
 const h=harness(t),args={...h,news:{enabled:false,explore:true,profile_version:0,interests:[],items:[],saved:[],sources:[]},warmup:{status:'ready',draft:{about:null,interests:[{text:'Voice design',refs:[]}]}}}
 renderNews(h.panel,args);assert.equal(h.calls.length,0)
 await h.buttons.find(b=>b.textContent==='开启资讯').action()
 assert.deepEqual(h.calls,[['news.configure',{enabled:true,explore:true,interests:['Voice design'],expected_version:0}]])
})

test('a failed save preserves the exact draft across newer generated suggestions',async t=>{
 const h=harness(t),args={...h,command:async()=>{throw Error('version_conflict')},state:{profile:{version:0,about:''}},news:{enabled:false,explore:true,profile_version:0,interests:[]},warmup:{status:'ready',draft:{interests:[{text:'Voice'}]}}}
 renderProfile(h.panel,args);await h.buttons.find(b=>b.textContent==='调整兴趣').action();h.local.interestEdit.interests=['My topic']
 args.warmup.draft.interests=[{text:'Other topic'}];h.buttons.length=0;renderProfile(h.panel,args)
 await h.buttons.find(b=>b.textContent==='完成调整').action();assert.deepEqual(h.local.interestEdit.interests,['My topic']);assert.ok(h.local.interestError)
})
test('a user-cleared profile and interests are not repopulated by generated defaults',async t=>{
 const h=harness(t);renderProfile(h.panel,{...h,state:{profile:{version:3,about:''}},news:{enabled:false,explore:true,profile_version:2,interests:[]},warmup:{status:'ready',draft:{about:{text:'Old suggestion',refs:[{entry_id:'s',version:'v'}]},work:[{title:'Old project',text:'Old work',refs:[{entry_id:'s',version:'v'}]}],interests:[{text:'Voice'}]},sources:[{id:'s',version:'v',label:'project/readme.md'}]}})
 const flatten=node=>[node,...node.children.flatMap(flatten)]
 assert.equal(flatten(h.panel).some(n=>n.textContent==='Old suggestion'||n.textContent==='Old project'),false)
 assert.equal(flatten(h.panel).some(n=>n.className==='profile-work-item'),false)
 assert.ok(flatten(h.panel).some(n=>n.textContent==='你已清空个人介绍，可以随时重新写一段。'))
 await h.buttons.find(b=>b.textContent==='自己写一段').action()
 assert.equal(h.local.profile.about,'')
 assert.equal(h.buttons.find(b=>b.textContent==='开启资讯').disabled,true)
})
test('generated work is readable and its sources stay behind disclosure',t=>{
 const h=harness(t);renderProfile(h.panel,{...h,state:{profile:{version:0,about:''}},news:{enabled:false,explore:true,profile_version:0,interests:[]},warmup:{status:'ready',draft:{about:{text:'Builds audio software',refs:[{entry_id:'s',version:'v'}]},work:[{title:'Audio Agent',text:'Works on voice interaction',refs:[{entry_id:'s',version:'v'}]}],interests:[]},sources:[{id:'s',version:'v',label:'NovaAudioAgent/README.md'}]}})
 const flatten=node=>[node,...node.children.flatMap(flatten)],nodes=flatten(h.panel)
 assert.ok(nodes.some(n=>n.textContent==='Builds audio software'))
 assert.ok(nodes.some(n=>n.className==='profile-work-item'))
 assert.equal(nodes.filter(n=>n.className==='profile-sources').length,2)
 assert.ok(nodes.some(n=>n.textContent==='NovaAudioAgent/README.md'))
 assert.equal(h.buttons.some(b=>b.textContent==='确认介绍'),false)
})
