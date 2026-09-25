import test from 'node:test'
import assert from 'node:assert/strict'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'
class Node{
 constructor(tag,text){this.tag=tag;this.text=text;this.children=[];this.listeners={};this.dataset={};this.classList={add:()=>{}};this.attrs={};this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100}
 append(...c){this.children.push(...c)}prepend(...c){this.children.unshift(...c)}replaceChildren(...c){this.children=c}setAttribute(k,v){this[k]=v;this.attrs[k]=v}addEventListener(n,f){this.listeners[n]=f}getAttribute(k){return this.attrs[k]??null}
 get tagName(){return this.tag.toUpperCase()}
 querySelectorAll(sel){const tags=sel.split(',');return this.children.flatMap(n=>[...(tags.includes(n.tag)?[n]:[]),...n.querySelectorAll(sel)])}querySelector(sel){return this.querySelectorAll(sel)[0]}focus(){this.focused=(this.focused??0)+1;document.activeElement=this}contains(node){return node===this||this.children.some(child=>child.contains(node))}
 get childElementCount(){return this.children.length}
}
function mount(options={}){
 const body=new Node('body'),shell=new Node('div');body.append(shell);const sent=[]
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const view=mountPersonalView({send:frame=>(sent.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{}}},...options})
 view.controller.connect();view.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input']})
 const all=n=>[n,...n.children.flatMap(all)]
 return {body,sent,view,all:()=>all(body),receipts:()=>sent.filter(f=>f.type==='personal.command'&&f.method==='feed.action'&&f.params.action==='presented').map(f=>f.params.id)}
}
const feedState=(revision,selected='chat:proactive',extra={})=>({type:'personal.state',revision,memory:{entries:[]},feed:[{id:'f1',kind:'suggestion',title:'T',why_now:'W',lifecycle:'active',user_state:'new',task_ref:null,delivery:{presented_at:null},prepared:{text:'## 前瞻\n- 一条',trust:'untrusted_external',evidence_refs:[]}}],conversations:{selected_id:selected,voice_id:null,unread_count:1,items:[{id:'chat:proactive',kind:'proactive',title:'主动提醒',unread_count:1},{id:'c',kind:'chat',title:'C'}],messages:[{id:'feed:f1',conversation_id:'chat:proactive',role:'assistant',text:'T\n## 前瞻\n- 一条'}]},...extra})
test('duplicate historical conversation labels distinguish dates and ties while selecting unchanged IDs',async()=>{
 const m=mount(),items=[
  {id:'a',kind:'chat',title:'新对话',created_at:'2025-01-01T12:00:00Z'},
  {id:'b',kind:'chat',title:'新对话',created_at:'2025-02-01T12:00:00Z'},
  {id:'c',kind:'chat',title:'新对话',created_at:'2025-02-01T12:00:00Z'},
  {id:'d',kind:'chat',title:'Custom {1}',created_at:'2025-02-01T12:00:00Z'},
  {id:'e',kind:'chat',title:'Custom {1}',created_at:'2025-03-01T12:00:00Z'},
  {id:'f',kind:'chat',title:'Unique {1}',created_at:'2025-03-01T12:00:00Z'},
 ],original=structuredClone(items)
 try{
  m.view.receive(feedState(1,'a',{feed:[],conversations:{selected_id:'a',voice_id:'b',items,messages:[]}}))
  const buttons=m.all().filter(n=>n.className==='conversation-item')
  assert.equal(new Set(buttons.slice(0,3).map(n=>n.textContent)).size,3)
  assert.match(buttons[0].textContent,/2025/);assert.notEqual(buttons[0].textContent,buttons[1].textContent)
  assert.ok(buttons[1].attrs['aria-label'].startsWith(buttons[1].textContent))
  assert.ok(buttons[3].textContent.startsWith('Custom {1} · '));assert.ok(buttons[4].textContent.startsWith('Custom {1} · '))
  assert.notEqual(buttons[3].textContent,buttons[4].textContent);assert.equal(buttons[5].textContent,'Unique {1}')
  assert.equal(m.all().find(n=>n.className==='switcher-title').textContent,'新对话')
  for(const [i,b]of buttons.entries()){
   b.listeners.click();const request=m.sent.at(-1)
   assert.equal(request.method,'conversations.select');assert.deepEqual(request.params,{id:items[i].id})
   m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick()
  }
  assert.deepEqual(items,original)
 }finally{m.view.controller.disconnect();await tick()}
})
test('new conversation and target picker controls explicitly translate dynamic UI without translating custom titles',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en')
 const m=mount()
 try{
  m.view.receive(feedState(1,'c',{feed:[]}))
  assert.ok(m.all().some(n=>n.attrs['aria-label']==='Execution workspace'))
  assert.ok(m.all().some(n=>n.attrs['aria-label']==='Codex session (continuation target)'))
  for(const label of ['Execution workspace','Codex session (continuation target)','Refresh workspaces','No workspace selected','New session (default for new tasks)','New conversation'])assert.ok(m.all().some(n=>n.textContent===label),label)
  assert.equal(m.all().find(n=>n.className==='switcher-title').textContent,'C')
 }finally{m.view.controller.disconnect();await tick();setLanguage('zh-CN')}
})
test('dropdown and sidebar orb entry wait for the same host acknowledgement and preserve conversation drafts',async()=>{
 for(const route of ['dropdown','sidebar']){
  const applied=[],m=mount({applyPresentation:async mode=>{applied.push(mode)}}),c=m.view.controller
  try{
   let request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'workbench'}});await tick()
   m.view.receive(feedState(1,'c',{feed:[]}));c.draft='kept draft'
   if(route==='dropdown'){const select=m.all().find(n=>n.attrs['aria-label']==='显示模式');select.value='orb';select.listeners.change()}
   else m.all().find(n=>n.title==='收起 · 收起为悬浮球').listeners.click()
   request=m.sent.at(-1);assert.equal(request.method,'presentation.set');assert.equal(request.params.mode,'orb');assert.deepEqual(applied,['workbench'])
   m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'orb'}});await tick()
   assert.deepEqual(applied,['workbench','orb']);assert.equal(c.presentationMode,'orb');assert.equal(c.collapsed,true);assert.equal(c.selectedId,'c');assert.equal(c.draft,'kept draft')
  }finally{c.disconnect();await tick()}
 }
})
test('feed messages render as cards with the prepared body as markdown, and receipts follow visibility',()=>{
 const m=mount();m.view.controller.collapse(true);m.view.receive(feedState(1))
 const card=m.all().find(n=>n.className==='feed-card');assert.ok(card);assert.ok(m.all().some(n=>n.tag==='h2'&&n.text===undefined&&n.children.some(c=>c.text==='前瞻')),'prepared markdown heading rendered')
 assert.deepEqual(m.receipts(),[],'collapsed workbench sends no receipt')
 m.view.controller.collapse(false);assert.deepEqual(m.receipts(),['f1'],'expanding delivers the receipt without a transcript change')
 m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:false,error:'offline'})
})
test('collapsed chat pane defers receipts until it reopens, and failed receipts retry on the next update',async()=>{
 const m=mount();const toggle=m.all().find(n=>n.className==='chat-toggle');await toggle.listeners.click()
 m.view.receive(feedState(1));assert.deepEqual(m.receipts(),[])
 await toggle.listeners.click();assert.deepEqual(m.receipts(),['f1'])
 const request=m.sent.findLast(f=>f.method==='feed.action');m.view.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'offline'});await new Promise(r=>setImmediate(r))
 m.view.refresh();assert.deepEqual(m.receipts(),['f1','f1'],'a failed receipt is retried by a plain update')
})
test('a cold start before any connection shows a neutral connecting state, not the disconnect banner',()=>{
 const body=new Node('body'),shell=new Node('div');body.append(shell)
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const v=mountPersonalView({send:()=>true,start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{}}}})
 const all=()=>[body].flatMap(function walk(n){return [n,...n.children.flatMap(walk)]})
 const hint=all().find(n=>n.className==='hint composer-hint'),status=all().find(n=>n.className==='workbench-status')
 assert.equal(hint.textContent,'正在连接…');assert.equal(status.textContent,'正在连接');assert.equal(status.dataset.state,'connecting')
 v.controller.connect()
 v.controller.disconnect()
 assert.equal(hint.textContent,'连接已断开，草稿已保留');assert.equal(status.textContent,'已断开 · 草稿保留');assert.equal(status.dataset.state,'disconnected')
})
test('hidden or unfocused windows defer presented receipts until visible and focused',()=>{
 const m=mount();document.visibilityState='hidden';m.view.receive(feedState(1));assert.deepEqual(m.receipts(),[])
 document.visibilityState='visible';document.hasFocus=()=>false;m.view.refresh();assert.deepEqual(m.receipts(),[])
 document.hasFocus=()=>true;m.view.refresh();assert.deepEqual(m.receipts(),['f1'])
})


const tick=()=>new Promise(resolve=>setImmediate(resolve))
const taskRow=(id,phase='working')=>({work_id:id,title:'任务 '+id,phase,project:'Project',executor:'codex',summary:'执行中'})
const selectPage=(m,label)=>m.all().find(n=>n.className==='rail-item'&&n.children.some(c=>c.className==='rail-label'&&c.textContent===label)).listeners.click()
const taskCard=(m,id)=>m.all().find(n=>n.tag==='article'&&n.children.some(c=>c.tag==='h3'&&c.textContent==='任务 '+id))
const descendants=n=>[n,...n.children.flatMap(descendants)]
const clickProgress=(m,id)=>descendants(taskCard(m,id)).find(n=>n.tag==='button'&&n.textContent==='询问任务进展').listeners.click()
const textOf=n=>descendants(n).map(n=>n.textContent??'').join(' ')
const resultFor=(id,summary)=>({delegateId:id,executor:'codex',outcome:'ok',summary,startedAt:10,endedAt:20,changedFiles:2})

test('task progress fills only the original draft, preserves voice and pending state, and never sends',async()=>{
 const m=mount({tasks:()=>({connected:true,tasks:[taskRow('a','completed')]})}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));c.state('chat:proactive').draft='原有内容';c.state('c').draft='别的草稿'
  const pending={request_id:'kept',text:'sending'};c.state('chat:proactive').submission=pending
  selectPage(m,'任务');m.all().find(n=>n.className==='chat-toggle').listeners.click()
  clickProgress(m,'a');const request=m.sent.findLast(f=>f.method==='conversations.open_work')
  assert.ok(request);assert.deepEqual(request.params,{work_id:'a'})
  const owner=feedState(2,'chat:proactive',{feed:[]});owner.conversations.voice_id='chat:proactive';m.view.receive(owner)
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  const filled=c.state('chat:proactive').draft
  assert.equal(filled,'原有内容\n请告诉我「任务 a」（任务 a）的最新进展。')
  assert.equal(c.state('c').draft,'别的草稿');assert.equal(c.state('chat:proactive').submission,pending)
  assert.equal(c.voiceId,'chat:proactive');assert.equal(m.all().find(n=>n.id==='chat-pane').hidden,false)
  assert.equal(m.all().find(n=>n.attrs['aria-label']==='消息草稿').disabled,true)
  clickProgress(m,'a');const repeated=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:repeated.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft,filled,'repeat click must not duplicate the trailing prompt')
  assert.equal(m.sent.some(f=>f.type==='input.text'||['conversations.create','conversations.open_feed'].includes(f.method)),false)
 }finally{c.disconnect();await tick()}
})

test('task progress races and failures remain scoped to the owning draft and originating card',async()=>{
 const m=mount({tasks:()=>({connected:true,tasks:[taskRow('a'),taskRow('b','failed')]})}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务');c.state('c').draft='Other draft'
  clickProgress(m,'a');let request=m.sent.findLast(f=>f.method==='conversations.open_work');assert.ok(request)
  const owner=feedState(2,'chat:proactive',{feed:[]});m.view.receive(owner)
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations})
  m.view.receive(feedState(3,'c',{feed:[]}));await tick()
  assert.equal(c.selectedId,'c');assert.equal(c.state('c').draft,'Other draft');assert.match(c.state('chat:proactive').draft,/任务 a/u)
  for(const response of [{ok:false,error:'conversation_not_found'},{ok:false,error:'network failed'},{ok:true},{ok:true,data:{selected_id:''}},{ok:true,data:{selected_id:'missing'}},{ok:true,data:{selected_id:'chat:proactive',items:{}}},{ok:true,data:{selected_id:'chat:proactive',items:[null]}}]){
   const before=c.state('chat:proactive').draft
   clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
   m.view.receive({type:'personal.result',request_id:request.request_id,...response});await tick()
   const errors=descendants(taskCard(m,'a')).filter(n=>n.attrs.role==='alert')
   assert.equal(errors.length,1);assert.ok(errors[0].textContent)
   assert.equal(descendants(taskCard(m,'b')).some(n=>n.attrs.role==='alert'),false)
   assert.equal(c.state('chat:proactive').draft,before);assert.equal(c.state('c').draft,'Other draft')
  }
  c.state('chat:proactive').draft='x'.repeat(4000)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft,'x'.repeat(4000));assert.match(textOf(taskCard(m,'a')),/4000/u)
  const prompt='请告诉我「任务 a」（任务 a）的最新进展。'
  c.state('chat:proactive').draft='x'.repeat(4000-prompt.length-1)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft.length,4000);assert.ok(c.state('chat:proactive').draft.endsWith(prompt))
  c.state('chat:proactive').draft='😀'.repeat(2000)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('chat:proactive').draft,'😀'.repeat(2000));assert.match(textOf(taskCard(m,'a')),/4000/u)
  assert.equal(c.drafts.has(undefined),false);assert.equal(c.drafts.has('missing'),false)
 }finally{c.disconnect();await tick()}
})

test('native task details isolate results, preserve expansion across refresh/reset, and display row errors',async()=>{
 let state={connected:true,selected:{work_id:'b'},error:'B error',tasks:[taskRow('a'),{...taskRow('b','failed'),error:'B error',opening:true},taskRow('c','completed'),taskRow('d','cancelled')]}
 let results=[resultFor('a','A result'),resultFor('d','D result')]
 const actions=[],m=mount({tasks:()=>state,results:()=>results,taskAction:(...args)=>actions.push(args)}),c=m.view.controller
 const details=id=>descendants(taskCard(m,id)).find(n=>n.tag==='details')
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务')
  assert.equal(m.all().filter(n=>n.tag==='details'&&n.dataset.workId).length,4)
  assert.match(textOf(details('b')),/暂无结果/u);assert.doesNotMatch(textOf(details('b')),/A result|D result/u)
  assert.match(textOf(details('a')),/A result/u);assert.doesNotMatch(textOf(details('a')),/D result/u)
  assert.equal(descendants(taskCard(m,'a')).some(n=>n.attrs.role==='alert'),false)
  assert.equal(m.all().filter(n=>n.attrs.role==='alert'&&n.textContent==='B error').length,1)
  assert.equal(descendants(taskCard(m,'b')).find(n=>n.textContent==='正在打开…').disabled,true)
  details('b').open=true // refresh before the browser delivers the queued toggle event
  results=[...results,{...resultFor('b','B result'),outcome:'failed',diagnostic:{method:'turn/start',server_code:500,message:'<b>literal</b>'}}]
  m.view.refresh();assert.equal(details('b').open,true);assert.match(textOf(details('b')),/B result/u)
  assert.match(textOf(details('b')),/<b>literal<\/b>/u);assert.equal(descendants(details('b')).some(n=>n.tag==='b'),false)
  assert.match(textOf(details('b')),/2/u);assert.match(textOf(details('b')),/耗时：10\.0 秒/u)
  selectPage(m,'Todos');selectPage(m,'任务');assert.equal(details('b').open,true)
  results=[];m.view.refresh();assert.equal(details('b').open,true);assert.match(textOf(details('b')),/暂无结果/u)
  assert.doesNotMatch(textOf(details('b')),/B result/u)
  details('a').open=true;details('a').listeners.toggle()
  state={connected:true,tasks:[taskRow('b','failed')]};m.view.refresh()
  state={connected:true,tasks:[taskRow('a'),taskRow('b','failed')]};m.view.refresh()
  assert.equal(details('a').open,false,'an evicted work loses its local expansion')
  state={...state,connected:false};m.view.refresh()
  assert.equal(descendants(taskCard(m,'a')).filter(n=>n.tag==='button').every(n=>n.disabled),true)
  assert.deepEqual(actions,[])
 }finally{c.disconnect();await tick()}
})


test('result and reset wire handlers refresh expanded task details after retaining validated results',async()=>{
 const {readFile}=await import('node:fs/promises'),{createContext,runInContext}=await import('node:vm')
 const wire=await import('../src/renderer/wire-frame-types.mjs'),{parseLastResultFrame}=await import('../src/renderer/bubbles.mjs')
 const results=new Map(),m=mount({tasks:()=>({connected:true,tasks:[taskRow('a'),taskRow('b')]}),results:()=>[...results.values()]})
 const source=await readFile(new URL('../src/renderer/index.mjs',import.meta.url),'utf8')
 const context=createContext({...wire,personalView:m.view,retainedResults:results,parseLastResultFrame,updateResultButton(){},render(){}})
 runInContext(source.slice(source.indexOf('async function handleControl(message)'),source.indexOf('async function handleSocketMessage')),context)
 const details=id=>descendants(taskCard(m,id)).find(n=>n.tag==='details')
 const frame=id=>({type:'executor.result',work_id:id,result:{delegate_id:id,executor:'codex',outcome:'ok',summary:id+' finished',started_at:1,ended_at:2,changed_files:1}})
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务');details('a').open=true
  await context.handleControl(frame('a'))
  assert.equal(details('a').open,true);assert.match(textOf(details('a')),/a finished/u);assert.match(textOf(details('b')),/暂无结果/u)
  await context.handleControl({...frame('b'),result:frame('a').result})
  assert.match(textOf(details('b')),/暂无结果/u,'cross-work payload must not be retained')
  await context.handleControl(frame('b'));await context.handleControl({type:'executor.result',work_id:'a',result:null})
  assert.match(textOf(details('a')),/暂无结果/u);assert.equal(details('a').open,true);assert.match(textOf(details('b')),/b finished/u)
  await context.handleControl({type:'executor.results.reset',extra:true});assert.match(textOf(details('b')),/b finished/u)
  await context.handleControl({type:'executor.results.reset'});assert.match(textOf(details('b')),/暂无结果/u);assert.equal(details('a').open,true)
 }finally{m.view.controller.disconnect();await tick()}
})

test('new task result text and progress drafts use English UI translations without translating task identity',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en')
 const results=[],m=mount({tasks:()=>({connected:true,tasks:[taskRow('a')]}),results:()=>results}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务')
  assert.match(textOf(taskCard(m,'a')),/No result yet/u)
  clickProgress(m,'a');assert.match(textOf(taskCard(m,'a')),/Opening conversation/u)
  let request=m.sent.findLast(f=>f.method==='conversations.open_work')
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'conversation_not_found'});await tick()
  assert.match(textOf(taskCard(m,'a')),/original task conversation no longer exists/u)
  clickProgress(m,'a');request=m.sent.findLast(f=>f.method==='conversations.open_work')
  const owner=feedState(2,'chat:proactive',{feed:[]});m.view.receive(owner)
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.draft,'Please update me on “任务 a” (task a).')
  results.push(resultFor('a','User summary 中文'));m.view.refresh()
  assert.match(textOf(taskCard(m,'a')),/Changed files: 2/u);assert.match(textOf(taskCard(m,'a')),/Duration: 10\.0 seconds/u)
  assert.match(textOf(taskCard(m,'a')),/User summary 中文/u)
  for(const [outcome,label] of [['failed','Failed'],['refused','Rejected'],['cancelled','Stopped'],['unknown','Awaiting confirmation']]){
   results[0]={...resultFor('a','User summary 中文'),outcome,changedFiles:null};m.view.refresh()
   const detail=descendants(taskCard(m,'a')).find(n=>n.tag==='details')
   assert.ok(descendants(detail).some(n=>n.textContent===label));assert.match(textOf(detail),/Changed files: Unknown/u)
  }
 }finally{c.disconnect();await tick();setLanguage('zh-CN')}
})


test('refresh restores keyboard focus to the same task result summary instead of the first identical label',async()=>{
 let results=[],state={connected:true,tasks:[taskRow('a'),taskRow('b')]}
 const m=mount({tasks:()=>state,results:()=>results}),summary=id=>descendants(taskCard(m,id)).find(n=>n.tag==='summary')
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));selectPage(m,'任务')
  summary('b').focus();descendants(taskCard(m,'b')).find(n=>n.tag==='details').open=true
  results=[resultFor('b','B finished')];m.view.refresh()
  assert.equal(document.activeElement,summary('b'),'result arrival preserves the focused work ID')
  assert.notEqual(document.activeElement,summary('a'))
  assert.equal(descendants(taskCard(m,'b')).find(n=>n.tag==='details').open,true)
  state={...state,tasks:[taskRow('a'),taskRow('b','completed')]};m.view.refresh()
  assert.equal(document.activeElement,summary('b'),'progress refresh preserves the focused work ID')
 }finally{m.view.controller.disconnect();await tick()}
})


test('task progress accepts the command owner snapshot before a later state broadcast',async()=>{
 const m=mount({tasks:()=>({connected:true,tasks:[taskRow('a')]})}),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[]}));c.draft='Keep current draft';selectPage(m,'任务')
  clickProgress(m,'a');const request=m.sent.findLast(f=>f.method==='conversations.open_work')
  const owner=feedState(2,'late-owner',{feed:[]});owner.conversations.items.push({id:'late-owner',kind:'chat',title:'Original owner'})
  m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:owner.conversations});await tick()
  assert.equal(c.state('late-owner').draft,'请告诉我「任务 a」（任务 a）的最新进展。')
  assert.equal(c.selectedId,'c');assert.equal(c.draft,'Keep current draft')
  m.view.receive(owner);assert.equal(c.draft,'请告诉我「任务 a」（任务 a）的最新进展。')
  assert.equal(m.sent.some(f=>f.type==='input.text'||['conversations.select','conversations.create'].includes(f.method)),false)
 }finally{c.disconnect();await tick()}
})
