import test from 'node:test'
import assert from 'node:assert/strict'
import {renderLife} from '../src/renderer/life-view.mjs'
import {renderNews} from '../src/renderer/news-view.mjs'
import {renderSourceSuggestions} from '../src/renderer/workbench-suggestions.mjs'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'
import {setLanguage} from '../src/renderer/locale.mjs'

class Node{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.dataset={};this.className=''}append(...nodes){this.children.push(...nodes)}setAttribute(k,v){this[k]=v}addEventListener(){}}
const all=node=>[node,...node.children.flatMap(all)]
function harness(t){const previous=globalThis.document;t.after(()=>{globalThis.document=previous});globalThis.document={createElement:tag=>new Node(tag)};const panel=new Node('main');const button=(label,action,parent)=>{const node=new Node('button');node.textContent=label;node.action=action;parent.append(node);return node};return {panel,button,command:async()=>{},local:{},rerender(){},delegate(){}}}
const text=panel=>all(panel).map(node=>node.textContent).filter(Boolean).join('\n')

test('daily workbench offers one refresh route on all tabs and saves inspiration',t=>{
 for(const tab of ['ideas','goals']){const h=harness(t),commands=[]
  renderSourceSuggestions(h.panel,{tab,context:{daily:true,status:'ready',automatic_available:false,candidate_count:1,cards:tab==='ideas'?[{id:'i',tab,title:'做一张预检清单',body:'可以先把重复操作记下来。',refs:[]}]:[]},sources:[],connected:true,button:h.button,command:(...args)=>commands.push(args),continueChat:()=>{}})
  assert.match(text(h.panel),/重新整理/u);assert.doesNotMatch(text(h.panel),/还没给我看过资料/u)
  all(h.panel).find(n=>n.textContent==='重新整理').action();assert.deepEqual(commands[0],['context.refresh',{}])
  if(tab==='ideas'){all(h.panel).find(n=>n.textContent==='保存想法').action();assert.deepEqual(commands[1],['context.adopt',{id:'i'}])}
 }
})

test('automatic goal can be undone but edited goal cannot',t=>{
 const h=harness(t),commands=[]
 const goal={id:'g',kind:'goal',title:'每天使用助手',note:'',status:'active',version:1,auto_recorded:true,workbench_source:{candidate_id:'c',refs:[]},progress:{done:0,total:0}}
 renderLife(h.panel,{...h,command:(...args)=>commands.push(args),kind:'goal',state:{todos:[],ideas:[],goals:[goal]}})
 all(h.panel).find(n=>n.textContent==='撤销自动记录').action();assert.deepEqual(commands[0],['context.undo',{id:'g'}])
 const edited=harness(t);renderLife(edited.panel,{...edited,kind:'goal',state:{todos:[],ideas:[],goals:[{...goal,version:2}]}});assert.doesNotMatch(text(edited.panel),/撤销自动记录/u)
})

test('an empty saved list beside suggestions says whose list it is instead of claiming nothing is there',t=>{
 for(const [kind,tab] of [['idea','ideas'],['goal','goals']]){
  const h=harness(t)
  renderLife(h.panel,{...h,kind,state:{todos:[],ideas:[],goals:[]},suggested:1})
  assert.doesNotMatch(text(h.panel),/还没有(保存想法|设定目标)/u,tab)
  assert.match(text(h.panel),/不会自动加进来/u)
  const bare=harness(t);renderLife(bare.panel,{...bare,kind,state:{todos:[],ideas:[],goals:[]}})
  assert.match(text(bare.panel),/还没有(保存想法|设定目标)/u,'without suggestions the empty state stays')
 }
})
test('there is no Todo section: the old tab renders nothing and ideas cards hand a prepared request to Nova',t=>{
 const none=harness(t)
 renderSourceSuggestions(none.panel,{tab:'todos',context:{status:'ready',candidate_count:1,recap:{text:'最近主要在做语音 Agent 的工作台。',projects:[{name:'nova',line:'正在修工作台内容'}]},cards:[{id:'a',tab:'todos',title:'完成摘要层',body:'x',refs:[]}]},sources:[{state:'connected'}],button:none.button,command:none.command,continueChat:()=>{}})
 assert.deepEqual(none.panel.children,[],'no recap, no todo cards')
 const h=harness(t),chats=[]
 const context={status:'ready',candidate_count:2,cards:[
  {id:'a',tab:'ideas',title:'完成摘要层',body:'已接入项目摘要。',why:'下一步已经写明',next:'跑一次原生验收',refs:[{entry_id:'source:x',label:'notes.md'}]},
  {id:'b',tab:'ideas',title:'Old card',body:'Only a body.',why:null,next:null,refs:[]},
 ]}
 renderSourceSuggestions(h.panel,{tab:'ideas',context,sources:[{state:'connected'}],button:h.button,command:h.command,continueChat:x=>chats.push(x)})
 const nodes=all(h.panel),output=text(h.panel)
 const section=nodes.find(node=>node.className==='workbench-suggestions')
 assert.ok(!nodes.some(node=>node.className==='workbench-recap'),'no recap block any more')
 assert.equal(section.children.filter(node=>node.tag==='article').length,2)
 assert.match(output,/我想到的/u);assert.match(output,/下一步：跑一次原生验收/u);assert.match(output,/Only a body/u)
 assert.doesNotMatch(output,/加入待办|帮我做|可以接着做/u)
 const [first,second]=section.children.filter(node=>node.tag==='article')
 const row=card=>card.children.find(node=>node.className==='card-actions')
 const firstButtons=row(first).children;assert.deepEqual(firstButtons.map(node=>node.textContent),['聊聊这个','隐藏'],'actions share one row')
 assert.equal(firstButtons[1].className,'quiet')
 firstButtons[0].action();assert.deepEqual(chats,['完成摘要层：已接入项目摘要。'])
 assert.equal(row(second).children[0].textContent,'聊聊这个')
 const popover=first.children.find(node=>node.className==='source-popover');assert.equal(popover.hidden,true);assert.match(text(popover),/notes\.md/u)
 assert.equal(first.dataset.sources,'true');assert.ok(!first.children.some(node=>node.tag==='details'))
 assert.ok(!second.children.some(node=>node.className==='source-info'),'no sources, no icon')
})
test('empty Life and source states use specific copy without inventing work',t=>{
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'goal',state:{todos:[],ideas:[],goals:[]}})
 assert.match(text(h.panel),/还没有设定目标/u)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:{status:'ready',candidate_count:0,cards:[],empty_reason:'no_eligible_sources'},sources:[{state:'connected',scan_pending:true}],button:h.button,command:h.command,continueChat:()=>{}})
 assert.match(text(h.panel),/资料索引仍在更新/u)
 assert.doesNotMatch(text(h.panel),/值得关注|持续推进/u)
})
test('unloaded Life data and paused sources never claim an empty list or active scan',t=>{
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'goal',state:undefined})
 assert.match(text(h.panel),/正在读取已保存的内容/u)
 assert.doesNotMatch(text(h.panel),/还没有设定目标/u)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:{status:'idle',candidate_count:0,cards:[]},sources:[{state:'paused',scan_pending:true}],button:h.button,command:h.command,continueChat:()=>{}})
 assert.match(text(h.panel),/资料来源已暂停/u)
 assert.doesNotMatch(text(h.panel),/资料索引仍在更新/u)
})
test('disconnected source state does not claim that no sources are connected',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:null,sources:[],button:h.button,command:h.command,continueChat:()=>{},connected:false,everConnected:true})
 assert.match(text(h.panel),/暂时连不上后台/u)
 assert.doesNotMatch(text(h.panel),/还没给我看过资料/u)
})
test('first connection reads as loading, not an outage, and offers no dead source button',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:null,sources:[],button:h.button,command:h.command,continueChat:()=>{},openSettings:()=>{},connected:false,everConnected:false})
 assert.match(text(h.panel),/正在连接后台/u)
 assert.doesNotMatch(text(h.panel),/暂时连不上后台|连接资料/u)
})
test('first connection copy is translated in English',async t=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en');t.after(()=>setLanguage('zh-CN'))
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',sources:[],button:h.button,command:h.command,connected:false,everConnected:false})
 assert.match(text(h.panel),/Connecting to the backend/u)
 assert.match(text(h.panel),/I'll look through your sources once connected\./u)
})
test('a partial source failure remains visible beside available suggestions',t=>{
 const h=harness(t)
 renderSourceSuggestions(h.panel,{tab:'ideas',context:{status:'ready',cards:[{id:'card',tab:'ideas',title:'Simplify setup',body:'The note suggests a shorter setup.',refs:[]}]},sources:[{scope:'computer',state:'error'}],button:h.button,command:h.command,continueChat:()=>{},openSettings:()=>{}})
 assert.match(text(h.panel),/Simplify setup/u)
 assert.match(text(h.panel),/部分来源暂不可用/u)
 assert.match(text(h.panel),/来源设置/u)
})
test('disabled news has an honest empty state',t=>{
 const h=harness(t)
 renderNews(h.panel,{...h,news:{enabled:false,items:[],saved:[],sources:[],interests:[],profile_version:0}})
 assert.match(text(h.panel),/资讯更新已关闭/u)
 assert.doesNotMatch(text(h.panel),/资讯精选|好内容正在路上/u)
})
test('scan progress preserves a focused Goal draft and material content refresh restores it',t=>{
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
 all(body).find(node=>node.dataset.page==='goals').listeners.click()
 view.controller.connect()
 const state=(revision,title,scanned)=>({type:'personal.state',revision,life:{todos:[],ideas:[],goals:[{id:'t',kind:'goal',title,note:'',status:'active',success_criteria:'',progress:{total:0,done:0},version:title==='Updated'?2:1}]},sources:[{state:'connected',scanned}],conversations:{items:[]},memory:{entries:[]}})
 view.receive(state(1,'Original',1))
 const panel=body.querySelector('.workbench-page')??all(body).find(node=>node.className==='workbench-page')
 const edit=panel.querySelectorAll('textarea')[0];edit.value='Unsaved words';edit.selectionStart=2;edit.selectionEnd=7;edit.focus();panel.scrollTop=73
 view.receive(state(2,'Original',2));assert.equal(panel.querySelectorAll('textarea')[0],edit);assert.equal(document.activeElement,edit);assert.equal(panel.scrollTop,73);assert.equal(all(body).find(node=>node.className==='page-title').textContent,'目标')
 view.receive(state(3,'Updated',2));assert.match(all(panel).map(node=>node.textContent).join(' '),/Updated/u)
 const restored=panel.querySelectorAll('textarea')[0];assert.equal(document.activeElement,restored);assert.equal(restored.value,'Unsaved words');assert.equal(restored.selectionStart,2);assert.equal(restored.selectionEnd,7);assert.equal(panel.scrollTop,73)
 const candidate=id=>({id,kind:'goal',text:`Candidate ${id}`,quote:'said'})
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
test('a goal suggestion becomes a goal only when the user sets it, and the page stays quiet without one',async t=>{
 const h=harness(t),calls=[]
 const command=(method,params)=>{calls.push([method,params]);return Promise.resolve()}
 renderSourceSuggestions(h.panel,{tab:'goals',context:{status:'ready',candidate_count:1,cards:[],empty_reasons:{goals:'model_abstained'}},sources:[{state:'connected'}],button:h.button,command,continueChat:()=>{}})
 assert.deepEqual(h.panel.children,[],'no empty suggestion block under the goal list')
 const context={status:'ready',candidate_count:2,cards:[
  {id:'g',tab:'goals',title:'让 Nova 成为每天在用的助手',body:'一周里大部分事情都交给它。',why:null,next:'先把待办页跑顺',refs:[{entry_id:'source:x',label:'README.md'}]},
  {id:'t',tab:'ideas',title:'Not a goal',body:'x',refs:[]},
 ]}
 renderSourceSuggestions(h.panel,{tab:'goals',context,sources:[{state:'connected'}],button:h.button,command,continueChat:()=>{}})
 const output=text(h.panel),nodes=all(h.panel)
 assert.match(output,/可以定下的方向/u);assert.match(output,/先从：先把待办页跑顺/u);assert.doesNotMatch(output,/Not a goal/u)
 const actions=nodes.find(node=>node.className==='card-actions')
 assert.deepEqual(actions.children.map(node=>node.textContent),['设为目标','隐藏'])
 assert.equal(calls.length,0,'nothing is saved by rendering')
 let settle;const pending=new Promise(resolve=>{settle=resolve})
 h.panel.children.length=0;renderSourceSuggestions(h.panel,{tab:'goals',context,sources:[{state:'connected'}],button:h.button,command:(method,params)=>{calls.push([method,params]);return pending},continueChat:()=>{}})
 const adopt=all(h.panel).find(node=>node.className==='card-actions').children[0]
 const done=adopt.action()
 settle();await done // Pending feedback is exercised through mountPersonalView in chat-pane.test.mjs.
 assert.deepEqual(calls,[['context.adopt',{id:'g'}]],'adoption is one backend command keyed by the suggestion')
})

test('the frameless workbench draws its own edge in both light and dark themes',async()=>{
 const {readFile}=await import('node:fs/promises')
 const css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
 assert.match(css,/\.workbench\{[^}]*border:1px solid var\(--frame\);border-radius:var\(--radius-window\)/)
 assert.doesNotMatch(css,/\.workbench::after\{/)
 const light=css.slice(0,css.indexOf('@media(prefers-color-scheme:dark)')),dark=css.slice(css.indexOf('@media(prefers-color-scheme:dark)'),css.indexOf('body[data-personal-collapsed="false"]'))
 assert.match(light,/--frame:rgba\(20,24,31,/);assert.match(dark,/--frame:rgba\(255,255,255,/)
})

test('Life and suggestion cards show only supplied source badges; old reference labels remain available',t=>{
 const sources=[{type:'mail',evidence_id:'opaque',observed_at:'2026-10-04T00:00:00Z',summary:'确认的邮件'},{type:'im',provider:'feishu',mentioned_me:true,observed_at:'2026-10-04T00:00:00Z'}]
 const h=harness(t)
 renderLife(h.panel,{...h,kind:'goal',state:{todos:[],ideas:[],goals:[{id:'t',title:'完成文档',note:'',version:1,status:'active',progress:{total:0,done:0},sources,auto_recorded:true,source_changed:true}]}})
 assert.deepEqual(all(h.panel).find(n=>n.className==='source-tags').children.map(n=>n.textContent),['@我','自动记录','来源有更新'])
 const suggestions=harness(t)
 renderSourceSuggestions(suggestions.panel,{...suggestions,tab:'ideas',context:{cards:[{id:'i',tab:'ideas',title:'讨论',body:'内容',sources,refs:[{entry_id:'opaque'}]},{id:'old',tab:'ideas',title:'旧建议',body:'内容',refs:[{entry_id:'private-id',label:'旧笔记'}]},{id:'unknown',tab:'ideas',title:'飞书邮件',body:'内容',refs:[{entry_id:'another-private-id'}]}]}})
 const nodes=all(suggestions.panel)
 assert.equal(nodes.filter(n=>n.className==='source-tags').length,1)
 assert.match(text(suggestions.panel),/旧笔记/u)
 assert.doesNotMatch(text(suggestions.panel),/opaque|private-id/u)
})

test('status changes offer updating the original record rather than adding another one',t=>{
 for(const tab of ['goals']){
  const h=harness(t),calls=[]
  renderSourceSuggestions(h.panel,{tab,context:{daily:true,cards:[{id:'u',tab,title:'交付事项',body:'后续资料显示已完成',refs:[],update:{id:'existing',kind:'goal',version:1,status:'completed'}}]},sources:[],button:h.button,command:(...args)=>calls.push(args),continueChat:()=>{}})
  assert.doesNotMatch(text(h.panel),/加入待办|设为目标/)
  all(h.panel).find(n=>n.textContent==='更新原记录').action();assert.deepEqual(calls,[['context.adopt',{id:'u'}]])
 }
})

test('suggestion chrome and empty states are fully translated in English',t=>{
 setLanguage('en');t.after(()=>setLanguage('zh-CN'))
 const card=tab=>({id:'c',tab,title:'Compare flows',body:'The note lists a next step.',why:'Because of the note.',next:'Draft the comparison',refs:[]})
 const empty=reason=>({status:'ready',candidate_count:0,cards:[],empty_reason:reason})
 const scenarios=[
  ['ideas',{daily:true,status:'working',automatic_available:true,cards:[card('ideas')]},[{state:'connected'}]],
  ['ideas',{daily:true,status:'ready',cards:[card('ideas')]},[{state:'connected'}]],
  ['goals',{daily:true,status:'ready',cards:[card('goals')]},[{state:'connected'}]],
  ['ideas',empty('validation_filtered'),[{state:'connected'}]],
  ['ideas',empty('model_abstained'),[{state:'connected'}]],
  ['ideas',empty('no_eligible_sources'),[{state:'connected'}]],
  ['ideas',{status:'working',cards:[]},[{state:'connected'}]],
  ['ideas',{status:'failed',cards:[]},[{state:'connected'}]],
  ['ideas',{status:'idle',cards:[]},[]],
  ['ideas',{status:'idle',cards:[]},[{state:'paused'}]],
  ['ideas',{status:'idle',cards:[],candidate_count:0},[{state:'connected',processing_consent_required:true}]],
  ['ideas',{status:'idle',cards:[]},[{state:'error',scope:'computer'},{state:'error',path:'/tmp/notes'}]],
  ['ideas',{status:'idle',cards:[]},[{state:'connected',scan_pending:true}]],
 ]
 for(const [tab,context,sources] of scenarios){
  const h=harness(t)
  renderSourceSuggestions(h.panel,{tab,context,sources,button:h.button,command:h.command,continueChat:()=>{},openSettings:()=>{}})
  assert.doesNotMatch(text(h.panel),/[\u4e00-\u9fff]/u,`${tab} ${JSON.stringify(context.empty_reason??context.status)}`)
 }
 for(const [connected,everConnected] of [[false,false],[false,true]]){
  const h=harness(t)
  renderSourceSuggestions(h.panel,{tab:'ideas',context:null,sources:[],button:h.button,command:h.command,continueChat:()=>{},connected,everConnected})
  assert.doesNotMatch(text(h.panel),/[\u4e00-\u9fff]/u,`connected=${connected}`)
 }
})

test('goal card cadence menu sends a life.mutate update',async t=>{
 class Listening extends Node{constructor(tag){super(tag);this.listeners={}}addEventListener(type,fn){this.listeners[type]=fn}}
 const h=harness(t),commands=[];globalThis.document={createElement:tag=>new Listening(tag)}
 const goal={id:'g',kind:'goal',title:'学英语',note:'',status:'active',version:3,cadence:'off',success_criteria:'',progress:{done:0,total:0}}
 renderLife(h.panel,{...h,command:async(...args)=>{commands.push(args)},kind:'goal',state:{todos:[],ideas:[],goals:[goal]}})
 const menu=all(h.panel).find(n=>n.tag==='select'&&n['aria-label']==='学英语的提醒节奏')
 assert.deepEqual(menu.children.map(o=>o.value),['daily','progress','off']);assert.equal(menu.value,'off')
 menu.value='daily';await menu.listeners.change()
 assert.deepEqual(commands,[['life.mutate',{op:'update',kind:'goal',id:'g',expected_version:3,cadence:'daily'}]])
})
