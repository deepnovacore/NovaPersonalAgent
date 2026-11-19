import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {t,setLanguage} from '../src/renderer/locale.mjs'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'
class Node{
 constructor(tag,text){this.tag=tag;this.tagName=tag.toUpperCase();this.text=text;this.children=[];this.listeners={};this.dataset=new Proxy({},{set:(object,key,value)=>{object[key]=String(value);return true}});this.classList={add:()=>{}};this.attrs={};this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100}
 append(...c){for(const n of c){if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(child=>child!==n);n.parentElement=this}this.children.push(...c)}prepend(...c){for(const n of c){if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(child=>child!==n);n.parentElement=this}this.children.unshift(...c)}replaceChildren(...c){this.children=[];this.append(...c)}setAttribute(k,v){this[k]=v;this.attrs[k]=v}getAttribute(k){return this.attrs[k]}addEventListener(n,f){this.listeners[n]=f}
 querySelectorAll(sel){const tags=sel.split(',');return this.children.flatMap(n=>[...(tags.includes(n.tag)?[n]:[]),...n.querySelectorAll(sel)])}querySelector(sel){return this.querySelectorAll(sel)[0]}focus(){this.focused=(this.focused??0)+1;document.activeElement=this}contains(node){return this===node||this.children.some(child=>child.contains?.(node))}
 dispatchEvent(event){this.listeners[event.type]?.(event);if(event.bubbles)this.parentElement?.dispatchEvent(event)}
 get childElementCount(){return this.children.length}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this)}
 showModal(){}
 close(){}
}
const controllers=[]
afterEach(async()=>{for(const c of controllers.splice(0))c.disconnect();await new Promise(resolve=>setImmediate(resolve))})
function mount(options={}){
 const body=new Node('body'),shell=new Node('div');body.append(shell);const sent=[],callbacks={}
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const view=mountPersonalView({send:frame=>(sent.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{},onPresentationRequest:fn=>{callbacks.presentation=fn},onCollapsed:fn=>{callbacks.collapsed=fn}}},...options})
 controllers.push(view.controller);view.controller.connect();view.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input']})
 const all=n=>[n,...n.children.flatMap(all)]
 if(!options.defaultHome)all(body).find(n=>n.dataset.page==='ideas').listeners.click()
 return {body,sent,view,callbacks,all:()=>all(body),receipts:()=>sent.filter(f=>f.type==='personal.command'&&f.method==='feed.action'&&f.params.action==='presented').map(f=>f.params.id)}
}
const feedState=(revision,selected='chat:main',extra={})=>({type:'personal.state',revision,memory:{entries:[]},feed:[{id:'f1',kind:'suggestion',title:'T',why_now:'W',lifecycle:'active',user_state:'new',task_ref:null,delivery:{presented_at:null},prepared:{text:'## 前瞻\n- 一条',trust:'untrusted_external',evidence_refs:[]}}],conversations:{selected_id:selected,voice_id:null,unread_count:1,items:[{id:'chat:main',kind:'chat',title:'主对话',unread_count:1},{id:'c',kind:'chat',title:'C'}],messages:[{id:'feed:f1',conversation_id:'chat:main',role:'assistant',origin:'proactive',text:'T\n## 前瞻\n- 一条'}]},...extra})
test('system notification destination returns the legacy view to main chat ahead of an unrelated approval',async()=>{
 const m=mount();m.view.receive(feedState(1));await tick()
 m.view.receive(feedState(2,'c',{pending_approvals:[{task_id:'other',conversation_id:'c',approval_id:'approval',summary:'Unrelated'}]}))
 const start=m.sent.length,opening=m.callbacks.presentation('workbench',{attention:true,conversationId:'chat:main'})
 await tick()
 const presentation=m.sent.slice(start).find(frame=>frame.method==='presentation.set')
 if(presentation){m.view.receive({type:'personal.result',request_id:presentation.request_id,ok:true,data:{mode:'workbench'}});await tick()}
 const selected=m.sent.slice(start).find(frame=>frame.method==='conversations.select')
 assert.equal(selected?.params.id,'chat:main')
 m.view.receive({type:'personal.result',request_id:selected.request_id,ok:true,data:{...m.view.controller.snapshot.conversations,selected_id:'chat:main'}})
 await opening;assert.equal(m.view.controller.selectedId,'chat:main')
 assert.equal(m.sent.slice(start).some(frame=>frame.method==='tasks.get'),false)
})
test('workbench chrome and composer follow the selected language without translating conversation content',()=>{
 try{for(const [language,title,placeholder,status]of [['zh-CN','主对话','输入消息…','运行中 · 0 个后台任务'],['en','Main conversation','Type a message…','Running · 0 background tasks']]){
  setLanguage(language);const m=mount()
  m.view.receive({type:'personal.state',revision:1,memory:{entries:[]},feed:[],tasks:[],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat',title:'stored title'}],messages:[{id:'u',conversation_id:'chat:main',role:'user',text:'保留原文 Settings'}]}})
  assert.equal(m.all().find(n=>n.className==='conversation-title').textContent,title)
   assert.equal(m.all().find(n=>n.tag==='textarea'&&n.attrs['aria-label']===t('消息草稿')).placeholder,placeholder)
  assert.equal(m.all().find(n=>n.className==='workbench-status').textContent,status)
  assert(m.all().some(n=>n.textContent==='保留原文 Settings'||n.text==='保留原文 Settings'))
 }}finally{setLanguage('zh-CN')}
})
test('the left pane has no conversation switcher; Tasks owns select and create',async()=>{
 const m=mount(),items=[{id:'chat:main',kind:'chat',title:'Home'},{id:'c',kind:'chat',title:'Custom {1}',updated_at:new Date().toISOString()}]
 m.view.receive(feedState(1,'c',{feed:[],conversations:{selected_id:'c',voice_id:null,items,messages:[]}}))
 assert.equal(m.all().some(n=>n.className==='conversation-switcher'||n.attrs['aria-label']==='切换会话'),false)
 assert.equal(m.all().find(n=>n.className==='conversation-title').textContent,'Custom {1}');assert.equal(m.all().find(n=>n.className==='chat-home').hidden,false)
 selectPage(m,'任务')
 const row=m.all().find(n=>n.className==='conversation-task');assert.equal(row.attrs['aria-current'],'true')
 row.listeners.click();let request=m.sent.at(-1);assert.equal(request.method,'conversations.select');assert.deepEqual(request.params,{id:'c'})
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick()
 m.all().find(n=>n.textContent==='创建任务').listeners.click();request=m.sent.at(-1);assert.equal(request.method,'conversations.create')
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick()
 m.view.receive(feedState(2,'chat:main',{feed:[]}));assert.equal(m.all().find(n=>n.className==='chat-home').hidden,true)
})
test('new conversation and target menu controls explicitly translate dynamic UI without translating custom titles',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs');setLanguage('en')
 const m=mount()
 try{
  m.view.receive(feedState(1,'c',{feed:[]}))
  m.view.receive({type:'executor.state',state:'idle'})
  assert.ok(m.all().some(n=>n.attrs['aria-label']==='Execution place'))
  for(const label of ['Choose workspace'])assert.ok(m.all().some(n=>n.textContent===label),label)
  assert.equal(m.all().find(n=>n.className==='conversation-title').textContent,'C')
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
const enterOrb=async m=>{
 let request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'workbench'}});await tick()
 m.view.receive(feedState(1,'c',{feed:[]}))
 m.all().find(n=>n.title==='收起 · 收起为悬浮球').listeners.click()
 request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'orb'}});await tick()
}
const ackVoice=async(m,revision)=>{
 const request=m.sent.findLast(f=>f.method==='conversations.voice');const state=feedState(revision,'c',{feed:[]});state.conversations.voice_id=request.params.enabled?request.params.id:null
 m.view.receive(state);m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick();await tick()
}
test('an orb opens its voice conversation without waking a sleeping orb, and reopens one the host ends',async()=>{
 const starts=[],m=mount({applyPresentation:async()=>{},start:async options=>{starts.push(options)}}),c=m.view.controller
 try{
  await enterOrb(m);await ackVoice(m,2)
  assert.deepEqual(starts,[{wake:false}]);assert.equal(c.mode,'voice')
  assert.equal(m.sent.filter(f=>f.method==='conversations.voice').length,1)
  // The host ends the session (a purge, another device): the orb must not stay deaf.
  m.view.receive(feedState(3,'c',{feed:[]}));await tick();await ackVoice(m,4)
  assert.equal(c.mode,'voice');assert.deepEqual(starts,[{wake:false},{wake:false}])
  assert.equal(m.sent.filter(f=>f.method==='conversations.voice').length,2)
 }finally{c.disconnect();await tick()}
})
test('a refused microphone reports once on the orb instead of retrying',async()=>{
 let attempts=0
 const m=mount({applyPresentation:async()=>{},start:async()=>{attempts++;throw new Error('麦克风权限不可用，原有草稿已保留')}}),c=m.view.controller
 try{
  await enterOrb(m);await ackVoice(m,2);await ackVoice(m,3)
  for(let revision=4;revision<7;revision++){m.view.receive(feedState(revision,'c',{feed:[]}));await tick()}
  assert.equal(attempts,1);assert.equal(c.mode,'text');assert.match(c.error,/麦克风权限不可用/)
 }finally{c.disconnect();await tick()}
})
test('feed messages render as plain messages with the prepared body as markdown, and receipts follow visibility',()=>{
 const m=mount();m.view.controller.collapse(true);m.view.receive(feedState(1))
 assert.equal(m.all().some(n=>n.className==='feed-card'),false,'no card chrome in the chat');assert.ok(m.all().some(n=>n.tag==='h2'&&n.text===undefined&&n.children.some(c=>c.text==='前瞻')),'prepared markdown heading rendered')
 assert.deepEqual(m.receipts(),[],'collapsed workbench sends no receipt')
 m.view.controller.collapse(false);assert.deepEqual(m.receipts(),['f1'],'expanding delivers the receipt without a transcript change')
 m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:false,error:'offline'})
})

test('the permanent chat delivers visible receipts and retries failed receipts on the next update',async()=>{
 const m=mount();m.view.receive(feedState(1));assert.deepEqual(m.receipts(),['f1'])
 await m.all().find(n=>n.dataset.page==='profile').listeners.click()
 const request=m.sent.findLast(f=>f.method==='feed.action');m.view.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'offline'});await new Promise(r=>setImmediate(r))
 m.view.refresh();assert.deepEqual(m.receipts(),['f1','f1'],'a failed receipt is retried by a plain update')
})
test('durable task detail browses a persistent central detail through snapshots, executor frames, and focusout',async()=>{
 const m=mount(),task={id:'t1',goal:'Task one',conversation_id:'c',phase:'running',controller:{kind:'nova'},control_revision:0,goal_revision:0,session_ids:['s1'],events:{items:[]},capabilities:{input:true},viewer:{client_id:'a',can_takeover:true}}
 m.view.receive(feedState(1,'c',{feed:[],tasks:[task,{...task,id:'t2',goal:'Task two'}],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}))
 assert.equal(m.all().some(n=>n.className==='task-card'),false,'the chat has no task strip')
 const open=async()=>{const opening=m.view.openTask('t1'),req=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:req.request_id,ok:true,data:task});await opening}
 await open()
 assert.equal(document.activeElement.textContent,'返回任务卡片');document.activeElement.dispatchEvent({type:'keydown',key:'Escape',bubbles:true,preventDefault(){}});assert.equal(m.all().some(n=>n.className==='task-detail'),false);await open()
 const draft=m.all().find(n=>n['aria-label']==='回复执行器'),panel=m.all().find(n=>n.className==='workbench-page');draft.value='keep';draft.focus();panel.scrollTop=88
 assert.equal(m.sent.some(f=>f.method==='tasks.control'),false)
 m.view.receive({type:'executor.tasks',tasks:[]});assert.ok(m.all().includes(draft));assert.equal(panel.scrollTop,88)
})

test('suggestion body is an accessible control and remains expanded after a snapshot refresh',()=>{
 const m=mount();const context={cards:[{id:'s1',tab:'ideas',title:'Review',body:'A long recommendation '.repeat(30),refs:[]}],status:'ready'}
 m.view.receive(feedState(1,'c',{workbench_context:context,sources:[{id:'local'}]}))
 const body=()=>m.all().find(n=>n.className==='card-body')
 assert.equal(body().tag,'button')
 assert.equal(body().attrs['aria-expanded'],'false')
 body().listeners.click()
 assert.equal(body().attrs['aria-expanded'],'true')
 body().focus()
 m.view.receive(feedState(2,'c',{workbench_context:context,sources:[{id:'local'}]}))
 assert.equal(body().attrs['aria-expanded'],'true')
 assert.equal(document.activeElement,body())
})
test('a personal idea with a long note can expand its four-line body',()=>{
 const m=mount();m.view.receive(feedState(1,'c',{sources:[{id:'local'}],life:{todos:[],ideas:[{id:'idea1',title:'Prepare',note:'Detailed note '.repeat(30),status:'active',version:1}],goals:[]}}))
 const note=m.all().find(n=>n.className==='card-body'&&n.dataset.cardBodyId==='life:idea:idea1')
 assert.equal(note?.tag,'button')
 note.listeners.click()
 assert.equal(note.attrs['aria-expanded'],'true')
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

test('task approval header stays in workbench and remains actionable while presentation sync is pending',async()=>{
 const m=mount(),task={id:'t',conversation_id:'c',goal:'Task',phase:'running',controller:{kind:'nova'},session_ids:[],approvals:[],viewer:{client_id:'a'},capabilities:{input:false}}
 m.view.receive(feedState(1,'c',{feed:[],tasks:[task],pending_approvals:[{task_id:'t',conversation_id:'c',approval_id:'original',summary:'Run'}],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}));m.view.controller.presentationPending=true;m.view.controller.presentationReady=false;m.view.refresh()
 const header=m.all().find(n=>n.textContent==='处理审批：Run');assert.equal(header.disabled,false);const opening=header.listeners.click(),request=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:task});await opening
 assert.equal(m.sent.some(f=>f.method==='presentation.set'||f.method==='conversations.select'),false);assert.ok(m.all().some(n=>n.className==='task-detail'))
})

test('orb task deep link enters workbench before reading detail and never takes control',async()=>{
 const m=mount();m.view.controller.presentationMode='orb';const opening=m.view.openTask('exact-task'),mode=m.sent.at(-1)
 assert.equal(mode.method,'presentation.set');assert.equal(mode.params.mode,'workbench');assert.equal(m.sent.some(f=>f.method==='tasks.get'),false)
 m.view.receive({type:'personal.result',request_id:mode.request_id,ok:true,data:{mode:'workbench',returned_task_ids:[]}});await new Promise(r=>setImmediate(r))
 const read=m.sent.at(-1);assert.equal(read.method,'tasks.get');assert.equal(read.params.task_id,'exact-task');assert.equal(read.params.after,0)
 m.view.receive({type:'personal.result',request_id:read.request_id,ok:true,data:{id:'exact-task',goal:'Result',phase:'completed',controller:{kind:'nova'},events:{items:[],next:8}}});await opening
 assert.equal(m.sent.some(f=>f.method==='tasks.control'),false)
})


test('main presentation request enters host path while collapsed display ACK sends no command',async()=>{
 const m=mount(),change=m.callbacks.presentation('orb'),request=m.sent.at(-1)
 assert.equal(request.method,'presentation.set');assert.equal(request.params.mode,'orb');const count=m.sent.length;m.callbacks.collapsed(true);assert.equal(m.sent.length,count)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'orb',returned_task_ids:['t'],task_control_revisions:{t:2}}});await change
 assert.equal(m.view.controller.taskNotice,'已交还 Nova，未发送的草稿已保留')
})

test('late detail response after background exit neither steals focus nor advances the viewed cursor',async()=>{
 const m=mount(),origin=new Node('button');origin.focus();const opening=m.view.openTask('late'),read=m.sent.at(-1)
 m.view.controller.presentationMode='background';m.view.receive({type:'personal.result',request_id:read.request_id,ok:true,data:{id:'late',goal:'Late result',phase:'completed',controller:{kind:'nova'},events:{items:[{seq:9,text:'Unseen'}],next:9}}});await opening;assert.equal(document.activeElement,origin)
 m.view.controller.presentationMode='workbench';const again=m.view.openTask('late'),request=m.sent.at(-1);assert.equal(request.params.after,9)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{id:'late',goal:'Late result',phase:'completed',controller:{kind:'nova'},events:{items:[],next:9}}});await again
})


test('empty durable task aggregate does not expose a phantom null deep link',()=>{const m=mount();m.view.refresh();const button=m.all().find(n=>n.className==='personal-orb-task');assert.equal(button.hidden,true);assert.equal(button.dataset.taskId,'')})

test('closing and reopening detail retains earlier public history alongside the viewed cursor',async()=>{
 const m=mount(),task={id:'history',goal:'History',phase:'running',controller:{kind:'nova'},events:{items:[{seq:9,text:'Earlier public event'}],next:9}}
 const opening=m.view.openTask('history');m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:task});await opening
 m.all().find(n=>n.textContent==='返回任务卡片').listeners.click()
 const reopened=m.view.openTask('history');m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:{...task,events:{items:[{seq:12,text:'Later public event'}],next:12}}});await reopened
 assert.ok(m.all().some(n=>n.textContent==='Earlier public event'));assert.ok(m.all().some(n=>n.textContent==='Later public event'));assert.ok(m.all().some(n=>n.textContent==='自上次查看后有 1 条新活动'))
})

test('completion arriving in a visible inspector is already viewed in the orb aggregate',async()=>{
 const m=mount(),task={id:'visible',goal:'Visible',phase:'running',controller:{kind:'nova'},events:{items:[],next:0}}
 const opening=m.view.openTask(task.id);m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:task});await opening
 m.view.receive(feedState(1,'c',{tasks:[{...task,phase:'completed'}]}));m.view.receive({type:'personal.result',request_id:m.sent.at(-1).request_id,ok:true,data:{...task,phase:'completed'}});await new Promise(r=>setImmediate(r));m.view.refresh()
 assert.match(m.all().find(n=>n.className==='personal-orb-task').textContent,/0 新结果/)
})


const tick=()=>new Promise(resolve=>setImmediate(resolve))
const selectPage=(m,label)=>m.all().find(n=>n.className==='workspace-tab'&&n.children.some(c=>c.className==='workspace-tab-label'&&c.textContent===t(label))).listeners.click()

test('routine startup keeps the text notice hidden; failed start exposes settings',()=>{
 const m=mount(),notice=m.all().find(n=>n.id==='startup-notice'),settings=notice.children[1]
 m.view.startup({stage:'backend'})
 assert.equal(notice.className,'page-notice');assert.equal(notice.attrs.role,'status');assert.equal(notice.hidden,true);assert.equal(settings.hidden,true)
 m.view.startup({stage:'failed',code:'workspace_not_found'})
 assert.equal(notice.className,'page-error');assert.equal(notice.attrs.role,'alert');assert.equal(settings.hidden,false)
 m.view.startup({stage:'ready'})
 assert.equal(notice.hidden,true);assert.equal(settings.hidden,true)
})
test('a failed first start stops claiming to connect, and retry restores loading',()=>{
 const m=mount();m.view.controller.everConnected=false;m.view.controller.disconnect()
 const text=()=>m.all().map(n=>n.textContent).join('\n')
 m.view.startup({stage:'backend'})
 assert.match(text(),/正在连接后台/u)
 m.view.startup({stage:'failed',code:'workspace_not_found'})
 assert.doesNotMatch(text(),/正在连接后台/u);assert.match(text(),/暂时连不上后台/u)
 assert.equal(m.all().find(n=>n.className==='workbench-status').textContent,'启动失败')
 assert.equal(m.all().find(n=>n.className==='workbench-status').dataset.state,'disconnected')
 m.view.startup({stage:'backend'})
 assert.match(text(),/正在连接后台/u);assert.doesNotMatch(text(),/暂时连不上后台/u)
 assert.equal(m.all().find(n=>n.className==='workbench-status').dataset.state,'connecting')
})
test('the mic starts dictation on one click and finishes it on the next',async()=>{
 let stops=0
 const m=mount({stop:async()=>{stops++}})
 try{
  m.view.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input','dictation']})
  m.view.receive(feedState(1,'c',{feed:[]}))
  const mic=m.all().find(n=>n.className==='composer-dictate')
  assert.equal(mic.attrs['aria-pressed'],'false')
  await mic.listeners.click();await tick()
  const start=m.sent.find(f=>f.type==='input.dictation'&&f.action==='start')
  assert.ok(start);assert.equal(mic.attrs['aria-label'],'停止录音');assert.equal(mic.attrs['aria-pressed'],'true')
  await mic.listeners.click();await tick()
  assert.ok(m.sent.some(f=>f.type==='input.dictation'&&f.action==='finish'&&f.id===start.id))
  assert.equal(m.sent.filter(f=>f.type==='input.dictation'&&f.action==='start').length,1)
 }finally{m.view.controller.disconnect();await tick()}
})
test('the round composer action is voice until there is a draft, then send; voice shows a stop cross while running',async()=>{
 const m=mount()
 try{
  m.view.receive(feedState(1,'c',{feed:[]}))
  const byClass=name=>m.all().find(n=>n.className===name)
  const voice=byClass('composer-voice'),submit=byClass('composer-submit'),draft=m.all().find(n=>n.attrs['aria-label']==='消息草稿')
  assert.equal(voice.hidden,false);assert.equal(submit.hidden,true)
  assert.equal(voice.attrs['aria-label'],'持续对话');assert.equal(voice.attrs['aria-pressed'],'false')
  draft.value='hello';draft.listeners.input()
  assert.equal(voice.hidden,true);assert.equal(submit.hidden,false)
  draft.value='   ';draft.listeners.input()
  assert.equal(voice.hidden,false);assert.equal(submit.hidden,true)
  assert.equal(byClass('composer-dictate').attrs['aria-label'],'语音输入')
  assert.ok(voice.children[0].tag==='svg'&&submit.children[0].tag==='svg'&&byClass('composer-dictate').children[0].tag==='svg')
  m.view.receive(feedState(2,'c',{feed:[],conversations:{selected_id:'c',voice_id:'c',items:[{id:'c',kind:'chat',title:'C'}],messages:[]}}))
  assert.equal(voice.attrs['aria-label'],'结束语音');assert.equal(voice.attrs['aria-pressed'],'true')
 }finally{m.view.controller.disconnect();await tick()}
})
test('continuous voice shows the orb stage with its status line and removes it when voice ends',async()=>{
 const m=mount()
 try{
  m.view.receive(feedState(1,'c',{feed:[]}))
  const stage=m.all().find(n=>n.className==='voice-stage'),label=m.all().find(n=>n.className==='voice-stage-label')
  assert.equal(stage.hidden,true)
  m.view.setOrb({name:'listening',statusLine:'正在听'});m.view.setOrb({name:'not-a-state',statusLine:'x'});m.view.setOrbLevel(0.5)
  m.view.receive(feedState(2,'c',{feed:[],conversations:{selected_id:'c',voice_id:'c',items:[{id:'c',kind:'chat',title:'C'}],messages:[]}}))
  assert.equal(stage.hidden,false)
  m.view.setOrb({name:'speaking',statusLine:'正在说'});m.view.setOrbLevel(0.2)
  assert.equal(label.textContent,'正在说')
  m.view.receive(feedState(3,'c',{feed:[]}))
  assert.equal(stage.hidden,true)
 }finally{m.view.controller.disconnect();await tick()}
})
test('pending suggestion actions survive refresh, reject double clicks and recover after failure',async()=>{
 const m=mount(),context={cards:[{id:'s1',tab:'ideas',title:'Review',body:'Details',next:'Start',refs:[]}],status:'ready'}
 const state=revision=>feedState(revision,'c',{workbench_context:context,sources:[{id:'local',health:String(revision)}],conversations:{selected_id:'c',voice_id:'c',items:[{id:'c',title:'C'}],messages:[]}})
 m.view.receive(state(1))
 const action=()=>m.all().find(n=>n.textContent==='聊聊这个')
 const first=action();first.listeners.click();const request=m.sent.at(-1)
 assert.equal(request.method,'conversations.create');assert.equal(first.attrs['aria-busy'],'true');assert.equal(first.disabled,true)
 first.listeners.click();m.view.receive(state(2));assert.notEqual(action(),first)
 assert.equal(action().disabled,true);action().listeners.click()
 assert.equal(m.sent.filter(f=>f.method==='conversations.create').length,1)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:false,error:'操作超时，请刷新状态后重试'});await tick()
 assert.equal(action().disabled,false);assert.equal(action().attrs['aria-busy'],'false')
 assert.match(m.view.controller.error,/超时/)
})
test('life status shows saving, survives refresh and does not restore an obsolete focused value',async()=>{
 const m=mount(),row={id:'goal1',kind:'goal',title:'Prepare',note:'',status:'active',version:1,progress:{total:0,done:0}}
 const state=(revision,item)=>feedState(revision,'c',{life:{todos:[],ideas:[],goals:[item]}})
 m.view.receive(state(1,row));m.all().find(n=>n.dataset.page==='goals').listeners.click();const select=()=>m.all().find(n=>n.attrs['aria-label']==='Prepare状态')
 select().focus();select().value='paused';select().listeners.change();const request=m.sent.at(-1)
 assert.equal(request.method,'life.mutate');assert.equal(select().attrs['aria-busy'],'true')
 assert.equal(m.all().find(n=>n.textContent==='正在保存…').hidden,false)
 m.view.receive(state(2,{...row,note:'Updated elsewhere'}));assert.equal(select().disabled,true);select().listeners.change()
 assert.equal(m.sent.filter(f=>f.method==='life.mutate').length,1)
 m.view.receive(state(3,{...row,status:'paused',version:2}));m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick()
 assert.equal(select().disabled,false);assert.equal(select().value,'paused')
 select().focus();m.view.receive(state(4,{...row,status:'active',version:3}));assert.equal(select().value,'active')
})
test('goal adoption and status changes use the shared pending guard; conflicts refresh with readable feedback',async()=>{
 const m=mount(),goal={id:'g1',kind:'goal',title:'Goal',note:'',status:'active',version:1,progress:{total:0,done:0}}
 const state=revision=>feedState(revision,'c',{life:{todos:[],ideas:[],goals:[goal]},workbench_context:{cards:[{id:'s1',tab:'goals',title:'Suggested goal',body:'Details',refs:[]}]}})
 m.view.receive(state(1));m.all().find(n=>n.dataset.page==='goals').listeners.click()
 const adopt=()=>m.all().find(n=>n.textContent==='设为目标')
 adopt().listeners.click();const request=m.sent.at(-1);assert.equal(request.method,'context.adopt');assert.equal(adopt().disabled,true)
 const state2=state(2);state2.life.goals=[{...goal,note:'changed'}];m.view.receive(state2)
 adopt().listeners.click();assert.equal(m.sent.filter(f=>f.method==='context.adopt').length,1)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick();assert.equal(adopt().disabled,false)
 const select=()=>m.all().find(n=>n.attrs['aria-label']==='Goal状态');select().value='paused';select().listeners.change()
 const mutation=m.sent.at(-1);assert.equal(select().disabled,true)
 m.view.receive({type:'personal.result',request_id:mutation.request_id,ok:false,error:'version_conflict'});await tick()
 assert.match(m.view.controller.error,/核对最新状态/);const refresh=m.sent.at(-1);assert.equal(refresh.method,'state')
 m.view.receive({type:'personal.result',request_id:refresh.request_id,ok:true,data:{}});await tick()
 assert.equal(select().disabled,false);assert.equal(select().value,'active')
})

 test('the permanent Nova conversation opens beside the full Timeline and keeps reminder identity',async()=>{
 const m=mount({defaultHome:true});const main={id:'chat:main',kind:'chat',title:'Historical main',unread_count:1};
 m.view.receive(feedState(1,'chat:main',{life:{todos:[],goals:[]},conversations:{selected_id:'chat:main',items:[main],messages:[{id:'feed:f1',conversation_id:'chat:main',role:'assistant',origin:'proactive',text:'Reminder'}],home_messages:[]}}));
 assert.equal(m.all().find(n=>n.dataset.page==='timeline').attrs['aria-selected'],'true');
 assert.ok(m.all().some(n=>n.className==='timeline-axis'),'default right pane renders a date axis');assert.ok(m.all().some(n=>n.className==='message assistant message-feed'));
 assert.equal(m.all().some(n=>n.dataset.page==='nova'),false);
 assert.equal(m.all().find(n=>n.className==='conversation-title').textContent,'主对话');
 const request=m.sent.find(f=>f.method==='conversations.read');assert.equal(request.params.id,'chat:main','the unread reminder is acknowledged in the main chat');
 assert.equal(request.params.through_message_id,'feed:f1');
 })

test('article reference choices refresh when personal objects change while Feeds remains open',async()=>{
 const m=mount(),news={enabled:false,interests:[],items:[{id:'article',content_hash:'hash',source_id:'s',title:'Article',summary:'Summary',url:'https://example.org/a',ranking:null}],saved:[],sources:[]}
 const snapshot=(revision,version,status='open')=>feedState(revision,'chat:main',{news,feed:[],life:{todos:[{id:'todo',title:'Current item',version,status}],goals:[]},conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat',title:'Main'}],messages:[],home_messages:[]}})
 m.view.receive(snapshot(1,1));await m.all().find(n=>n.dataset.page==='feeds').listeners.click();const choice=()=>m.all().find(n=>n.attrs['aria-label']==='结合哪个事项');const first=choice();first.value='todo:todo';first.listeners.change()
 m.view.receive(snapshot(2,2));assert.notEqual(choice(),first);assert.equal(choice().value,'todo:todo');await m.all().find(n=>n.textContent==='整理应用思路').listeners.click();await tick();const request=m.sent.findLast(f=>f.method==='conversations.discuss');assert.equal(request.params.references.find(ref=>ref.kind==='todo').version,2)
 m.view.receive(snapshot(3,3,'done'));await m.all().find(n=>n.dataset.page==='feeds').listeners.click();assert.equal(choice().children.some(n=>n.value==='todo:todo'),false)
})


test('adding a Timeline reference preserves the draft and earlier references; limit rejection is atomic',async()=>{
 const m=mount({defaultHome:true}),c=m.view.controller,todos=['a','b','c'].map(id=>({id,title:'Item '+id,status:'open',due:'2026-10-12',version:1,note:''}))
 m.view.receive(feedState(1,'chat:main',{feed:[],life:{todos,goals:[]},conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
 c.draft='Existing draft';c.state().references=[{kind:'todo',id:'a',version:1}]
 await m.all().find(n=>n.textContent==='Item b').listeners.click();await tick()
 assert.equal(c.draft,'Existing draft');assert.deepEqual(c.state().references.map(ref=>ref.id),['a','b'])
 await m.all().find(n=>n.textContent==='Item c').listeners.click();await tick()
 assert.deepEqual(c.state().references.map(ref=>ref.id),['a','b']);assert.equal(c.draft,'Existing draft');assert.match(c.error,/2/)
})

test('right pane switches keep Nova mounted, visible, and preserve the main draft at every window width',async()=>{
 const previous=globalThis.matchMedia
 try{
  for(const width of [1200,900,720,600]){
   globalThis.matchMedia=query=>({matches:width<=Number(query.match(/max-width:\s*(\d+)px/)?.[1]??0)})
   const m=mount({defaultHome:true}),c=m.view.controller
   m.view.receive(feedState(1,'chat:main',{feed:[],life:{todos:[],goals:[]},conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
   const pane=m.all().find(n=>n.id==='chat-pane'),parent=pane.parentElement,draft=m.all().find(n=>n.attrs['aria-label']==='消息草稿')
   draft.value='Keep this thought';draft.listeners.input()
   assert.equal(m.all().find(n=>n.dataset.page==='timeline').attrs['aria-selected'],'true')
   assert.ok(m.all().some(n=>n.className==='timeline-axis'))
   const commandCount=m.sent.length
   for(const page of ['goals','ideas','profile','timeline']){
    await m.all().find(n=>n.dataset.page===page).listeners.click()
    assert.equal(pane.hidden,false,String(width));assert.equal(pane.parentElement,parent)
    assert.equal(c.selectedId,'chat:main');assert.equal(c.draft,'Keep this thought')
    assert.equal(m.all().find(n=>n.attrs['aria-label']==='消息草稿'),draft)
    assert.equal(m.all().find(n=>n.dataset.page===page).attrs['aria-selected'],'true')
   }
   assert.equal(m.sent.length,commandCount,'page switches do not select or create conversations')
   assert.equal(m.all().some(n=>n.className==='chat-toggle'||n.className==='timeline-toggle'),false)
  }
 }finally{globalThis.matchMedia=previous}
})


 test('switching the right tab out of task details keeps focus on the chosen tab',async()=>{
 const m=mount(),task={id:'t1',goal:'Task one',conversation_id:'c',phase:'running',controller:{kind:'nova'},control_revision:0,goal_revision:0,session_ids:[],events:{items:[]},capabilities:{},viewer:{client_id:'a'}}
 m.view.receive(feedState(1,'c',{feed:[],life:{todos:[],goals:[]},tasks:[task],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}))
 const opening=m.view.openTask('t1'),request=m.sent.findLast(f=>f.method==='tasks.get')
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:task});await opening
 const tab=m.all().find(n=>n.dataset.page==='timeline');tab.focus();await tab.listeners.click()
 assert.ok(document.activeElement===tab);assert.equal(tab.attrs['aria-selected'],'true')
 assert.ok(m.all().some(n=>n.className==='timeline-axis'));assert.equal(m.all().some(n=>n.className==='task-detail'),false)
})

 test('right tab navigation keeps a conversation error visible and unchanged approval controls focused',async()=>{
 const m=mount(),state=feedState(1,'c',{feed:[],life:{todos:[],goals:[]},pending_approvals:[{id:'a1',summary:'Run',conversation_id:'c'}]})
 m.view.receive(state);const approval=m.all().find(n=>n.textContent==='处理审批：Run');approval.focus();m.view.refresh()
 assert.ok(m.all().includes(approval));assert.ok(document.activeElement===approval)
 m.view.controller.error='Send failed; draft kept';m.view.refresh();await m.all().find(n=>n.dataset.page==='profile').listeners.click()
 assert.equal(m.view.controller.error,'Send failed; draft kept')
 const error=m.all().find(n=>n.className==='page-error');assert.equal(error.textContent,'Send failed; draft kept');assert.equal(error.parentElement.className,'nova-column')
 })

test('the chat shows no task strip, and the background task summary still counts user tasks only',()=>{
 const m=mount(),task={id:'internal',goal:'Use source__process internal prompt',phase:'waiting',trigger:{schedule_id:'builtin-source-test'},work_ids:[],conversation_id:'schedule:builtin-source-test'}
 m.view.receive(feedState(1,'chat:main',{feed:[],tasks:[task,{id:'user',goal:'整理我的报告',phase:'completed',conversation_id:'chat:main',work_ids:[]}],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat',title:'主对话'}],messages:[]}}))
 assert.equal(m.all().filter(n=>n.className==='task-card').length,0)
 assert.ok(m.all().some(n=>n.textContent==='运行中 · 0 个后台任务'))
})

test('the animated companion only stands in for an empty main transcript',()=>{
 const m=mount({defaultHome:true,api:{orbMenu:{},personal:{setUnread(){},onPresentationRequest(){},onCollapsed(){}},welcome:{}}})
 const snapshot=(revision,messages=[])=>feedState(revision,'chat:main',{feed:[],conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main',kind:'chat'}],messages}})
 m.view.receive(snapshot(1));m.view.identity({profile:{assistantName:'nova',userName:'',avatar:null,introduced:true},defaultAvatar:''})
 const companion=m.all().find(n=>n.className==='chat-companion'),history=m.all().find(n=>n.className==='chat-history')
 assert.ok(companion);assert.equal(companion.hidden,false);assert.equal(history.contains(companion),false,'the intro avatar stays outside the transcript')
 m.view.receive(snapshot(2,[{id:'u1',role:'user',text:'今天想聊聊',conversation_id:'chat:main'},{id:'a1',role:'assistant',text:'我在这里。',conversation_id:'chat:main'}]))
 assert.equal(m.all().find(n=>n.className==='chat-companion'),companion)
 assert.equal(companion.hidden,true,'a persisted transcript replaces the intro companion')
 m.view.controller.state().submission={request_id:'waiting'};m.view.refresh();m.view.setOrb({name:'speaking',codexWorking:true})
 assert.equal(companion.hidden,true,'sending and voice states keep the transcript companion hidden')
 m.view.controller.disconnect();m.view.refresh();assert.equal(companion.hidden,true)
 m.view.receive(feedState(3,'other',{feed:[]}));assert.equal(companion.hidden,true,'another conversation never shows the main intro companion')
 m.view.receive(snapshot(4));assert.equal(companion.hidden,false,'an empty main conversation brings the companion back')
})

test('assistant replies carry the identity avatar in a grid gutter while user messages stay clean',()=>{
 const m=mount({defaultHome:true})
 const convo=(revision,messages)=>({type:'personal.state',revision,feed:[],memory:{entries:[]},tasks:[],conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main',kind:'chat'}],messages,home_messages:[]}})
 const message=(id,role,text,created_at)=>({id,conversation_id:'chat:main',role,text,created_at})
 m.view.receive(convo(1,[]))
 m.view.identity({profile:{assistantName:'Nova',userName:'Alice',avatar:'data:image/png;base64,AVATAR',introduced:true},defaultAvatar:'default-avatar.png'})
 m.view.receive(convo(2,[
  message('a1','assistant','第一段','2026-10-27T10:00:01Z'),
  message('a2','assistant','第二段','2026-10-27T10:00:02Z'),
  message('u1','user','你好','2026-10-27T10:00:03Z'),
  message('a3','assistant','重置后','2026-10-27T10:00:04Z'),
 ]))
 const articles=()=>m.all().filter(n=>typeof n.className==='string'&&n.className.split(' ').includes('message')&&n.dataset.messageId)
 const byId=id=>articles().find(node=>node.dataset.messageId===id)
 const has=(id,name)=>byId(id).className.split(' ').includes(name)
 const avatarOf=node=>node.children.find(child=>child.className==='message-avatar')
 assert.ok(avatarOf(byId('a1')),'the first assistant reply of a group carries the avatar')
 assert.equal(avatarOf(byId('a2')),undefined,'a consecutive assistant reply continues without a second avatar')
 assert.ok(has('a2','message-continuation'))
 assert.ok(has('a2','assistant'))
 assert.equal(avatarOf(byId('u1')),undefined,'user messages never carry an avatar')
 assert.ok(has('u1','user'))
 assert.equal(has('u1','message-continuation'),false)
 assert.ok(avatarOf(byId('a3')),'a user message resets the assistant group')
 const avatar=avatarOf(byId('a1')),image=avatar.children[0]
 assert.equal(image.src,'data:image/png;base64,AVATAR')
 assert.equal(image.alt,'')
 assert.equal(image.attrs['aria-hidden'],'true')
})

test('the avatar falls back to the default identity image and is decorative',()=>{
 const m=mount({defaultHome:true})
 const convo=(revision,messages)=>({type:'personal.state',revision,feed:[],memory:{entries:[]},tasks:[],conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main',kind:'chat'}],messages,home_messages:[]}})
 m.view.receive(convo(1,[]))
 m.view.identity({profile:{assistantName:'Nova',userName:'',avatar:null,introduced:true},defaultAvatar:'default-avatar.png'})
 m.view.receive(convo(2,[{id:'a1',conversation_id:'chat:main',role:'assistant',text:'你好','created_at':'2026-10-27T10:00:01Z'}]))
 const article=m.all().find(node=>typeof node.className==='string'&&node.className.split(' ').includes('message')&&node.dataset.messageId==='a1')
 const image=article.children[0].children[0]
 assert.equal(image.src,'default-avatar.png','without a profile avatar the identity default is used')
 assert.equal(article.children.filter(child=>child.className==='message-avatar').length,1)
})

test('feed messages count as assistant turns for avatar grouping',()=>{
 const m=mount({defaultHome:true})
 m.view.receive(feedState(1,'chat:main',{conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main',kind:'chat'}],messages:[]}}))
 m.view.identity({profile:{assistantName:'Nova',userName:'',avatar:'data:image/png;base64,AVATAR',introduced:true},defaultAvatar:'default-avatar.png'})
 m.view.receive(feedState(2,'chat:main',{conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main',kind:'chat'}],messages:[
  {id:'feed:f1',conversation_id:'chat:main',role:'assistant',origin:'proactive',text:'T\n## 前瞻\n- 一条',created_at:'2026-10-27T10:00:01Z'},
  {id:'a2',conversation_id:'chat:main',role:'assistant',text:'跟进','created_at':'2026-10-27T10:00:02Z'},
  {id:'u1',conversation_id:'chat:main',role:'user',text:'收到','created_at':'2026-10-27T10:00:03Z'},
  {id:'a3',conversation_id:'chat:main',role:'assistant',text:'好的','created_at':'2026-10-27T10:00:04Z'},
 ]}}))
 const articles=()=>m.all().filter(n=>typeof n.className==='string'&&n.className.split(' ').includes('message')&&n.dataset.messageId)
 const byId=id=>articles().find(node=>node.dataset.messageId===id)
 const avatarOf=node=>node?.children.find(child=>child.className==='message-avatar')
 assert.ok(avatarOf(byId('feed:f1')),'a feed card is an assistant turn and opens the group')
 assert.equal(avatarOf(byId('a2')),undefined)
 assert.ok(byId('a2').className.split(' ').includes('message-continuation'))
 assert.ok(avatarOf(byId('a3')),'a user message resets the feed group')
})
test('a goal check-in in the main chat is plain text without tags or action buttons',()=>{
 const m=mount({defaultHome:true})
 const checkin={id:'ck',kind:'question',title:'问问你的目标',why_now:'',lifecycle:'active',user_state:'new',task_ref:null,delivery:{presented_at:null},expires_at:null,memory_refs:[],evidence_refs:[],goal_checkin:{local_date:'2026-10-12',items:[{goal_id:'g',goal_version:1,text:'今天练口语了吗？',recalled:null}]}}
 m.view.receive(feedState(1,'chat:main',{feed:[checkin],life:{todos:[],goals:[{id:'g',title:'学英语口语',status:'active',cadence:'daily',version:2}]},conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[{id:'feed:ck',conversation_id:'chat:main',role:'assistant',origin:'proactive',text:'问问你的目标\n· 今天练口语了吗？'}],home_messages:[]}}))
 assert.ok(m.all().some(n=>n.textContent==='今天练口语了吗？'||n.text==='今天练口语了吗？'))
 for(const label of ['回复进展','不再提醒','待回应','已有结果'])assert.equal(m.all().some(n=>n.textContent===label),false,label)
})

test('a live caption stays where it arrived instead of sinking below newer persisted messages',async()=>{
 const {orderTranscript}=await import('../src/renderer/chat-pane.mjs')
 const at=ms=>new Date(Date.UTC(2026,9,26,8,0,0)+ms).toISOString()
 const persisted=[
  {id:'u1',role:'user',text:'打开飞书',created_at:at(0)},
  {id:'a1',role:'assistant',text:'需要你授权',created_at:at(3000)},
  {id:'u2',role:'user',text:'允许',created_at:at(6000)},
 ]
 const handoff={conversation_id:'c',turn_id:'t-handoff',role:'assistant',text:'好的，我现在把任务交给 Codex 执行。',seen_at:Date.UTC(2026,9,26,8,0,0)+1000}
 assert.deepEqual(orderTranscript(persisted,[handoff]).map(m=>m.id??m.turn_id),['u1','t-handoff','a1','u2'])
 const current={conversation_id:'c',turn_id:'t-now',role:'assistant',text:'处理中…',seen_at:Date.UTC(2026,9,26,8,0,0)+7000}
 assert.deepEqual(orderTranscript(persisted,[current]).map(m=>m.id??m.turn_id),['u1','a1','u2','t-now'])
})

test('a live caption is dropped once the persisted reply of that turn carries the same text',async()=>{
 const {orderTranscript}=await import('../src/renderer/chat-pane.mjs')
 const base=Date.UTC(2026,9,26,8,0,0)
 const persisted=[{id:'u1',role:'user',text:'x',created_at:new Date(base).toISOString()},{id:'a1',role:'assistant',turn_id:'t1',text:'好的，我现在把任务交给 Codex 执行。',created_at:new Date(base+2000).toISOString()}]
 const caption={conversation_id:'c',turn_id:'t1',role:'assistant',text:'好的，我现在把任务交给 Codex 执行。',seen_at:base+1000}
 assert.deepEqual(orderTranscript(persisted,[caption]).map(m=>m.id??m.turn_id),['u1','a1'])
 // Identity, not text, decides: a rewritten persisted reply is still the same turn, not a second bubble.
 assert.deepEqual(orderTranscript(persisted,[{...caption,text:'好的，交给 Codex 了。'}]).map(m=>m.id??m.turn_id),['u1','a1'])
 // A persisted reply that is shorter than the caption must not swallow the head already on screen.
 assert.deepEqual(orderTranscript(persisted,[{...caption,text:'第一段先说明。好的，我现在把任务交给 Codex 执行。'}]).map(m=>m.id??m.turn_id),['u1','t1','a1'])
})

test('a streamed assistant caption renders as it arrives instead of waiting for the next state frame',async()=>{
 const m=mount({defaultHome:true})
 m.view.receive(feedState(1,'chat:main',{feed:[],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[{id:'u1',conversation_id:'chat:main',role:'user',text:'你好',created_at:new Date(Date.now()-5000).toISOString()}],home_messages:[]}}))
 const caption=text=>({type:'caption',role:'assistant',text,full_text:text,conversation_id:'chat:main',turn_id:'t1',final:false})
 m.view.receive(caption('正在'));await tick()
 assert.ok(m.all().some(n=>n.textContent==='正在'||n.text==='正在'),'first delta is on screen')
 m.view.receive(caption('正在说话'));await tick()
 assert.ok(m.all().some(n=>n.textContent==='正在说话'||n.text==='正在说话'),'the cumulative text replaces the earlier delta')
})

test('a pending executor approval shows allow and deny buttons above the composer and decides through conversations.approve',async()=>{
 const m=mount({defaultHome:true})
 m.view.receive(feedState(1,'chat:main',{feed:[],pending_approvals:[{approval_id:'a1',conversation_id:'chat:main',summary:'Codex 请求执行一条工作区命令。',queued:false}],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
 const dock=m.all().find(n=>n.className==='approval-dock');assert.ok(dock&&!dock.hidden)
 m.all().find(n=>n.tag==='button'&&n.textContent==='允许').listeners.click();await tick()
 const sent=m.sent.findLast(f=>f.method==='conversations.approve');assert.deepEqual(sent.params,{id:'chat:main',approval_id:'a1',approved:true})
})

test('the first message in Build starts a direct Build in the chosen workspace instead of a chat turn',async()=>{
 const m=mount({defaultHome:true}),c=m.view.controller
 m.view.receive(feedState(1,'chat:main',{feed:[],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
 c.state('chat:main').execution='build';c.state('chat:main').workspace={project:'/work/demo'};c.draft='写一个俄罗斯方块';m.view.refresh()
 const bar=m.all().find(n=>n.className==='workspace-bar'&&!n.hidden);assert.equal(bar.hidden,false)
 const send=m.all().find(n=>n.className==='composer-submit');const sending=send.listeners.click();await tick()
 const request=m.sent.findLast(f=>f.method==='build.begin');assert.deepEqual(request.params,{text:'写一个俄罗斯方块',project:'/work/demo'})
 assert.equal(m.sent.some(f=>f.type==='input.text'),false,'no chat submission')
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await sending;await tick()
 assert.equal(c.draft,'');assert.equal(c.state('chat:main').execution,undefined)
})

test('a direct Build keeps text typed while the host starts it, and locks the draft until then',async()=>{
 const m=mount({defaultHome:true}),c=m.view.controller
 m.view.receive(feedState(1,'chat:main',{feed:[],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
 c.state('chat:main').execution='build';c.state('chat:main').workspace={project:'/work/demo'};c.draft='先做第一件事';m.view.refresh()
 const draft=m.all().find(n=>n.tag==='textarea'&&n.attrs['aria-label']===t('消息草稿'))
 const sending=m.all().find(n=>n.className==='composer-submit').listeners.click();await tick()
 assert.equal(draft.disabled,true,'the draft is locked while build.begin is pending')
 c.state('chat:main').draft='先做第一件事 补充';c.state('chat:main').execution='plan'
 const request=m.sent.findLast(f=>f.method==='build.begin')
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await sending;await tick()
 assert.equal(c.draft,'先做第一件事 补充','newer text is not discarded');assert.equal(c.state('chat:main').execution,'plan','a mode chosen meanwhile is not discarded')
})

test('an empty final caption retracts the live caption of that turn so a discarded preview leaves no ghost bubble',async()=>{
 const m=mount({defaultHome:true})
 m.view.receive(feedState(1,'chat:main',{feed:[],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[{id:'u1',conversation_id:'chat:main',role:'user',text:'你好',created_at:new Date(Date.now()-5000).toISOString()}],home_messages:[]}}))
 const caption=(text,final=false)=>({type:'caption',role:'assistant',text,full_text:text,conversation_id:'chat:main',turn_id:'t1',final})
 m.view.receive(caption('我先帮你看一下'));await tick()
 assert.ok(m.all().some(n=>n.textContent==='我先帮你看一下'||n.text==='我先帮你看一下'))
 m.view.receive(caption('',true));await tick()
 assert.equal(m.all().some(n=>n.textContent==='我先帮你看一下'||n.text==='我先帮你看一下'),false,'the retracted preview is gone')
})


test('a long live reply keeps its opening while the separate subtitle remains short',async()=>{
 const m=mount({defaultHome:true})
 m.view.receive(feedState(1,'chat:main',{feed:[],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
 const full='开头不能消失：'+'正文'.repeat(100)
 m.view.receive({type:'caption',role:'assistant',text:full.slice(-160),full_text:full,conversation_id:'chat:main',turn_id:'t-long',final:false});await tick()
 assert.ok(m.all().some(n=>n.textContent===full||n.text===full))
 m.view.receive({type:'caption',role:'assistant',text:'',full_text:'',conversation_id:'chat:main',turn_id:'t-long',final:true});await tick()
 assert.equal(m.all().some(n=>n.textContent===full||n.text===full),false)
})

test('task conversation has a visible home action that survives assistant identity updates',async()=>{
 const m=mount()
 m.view.receive(feedState(1,'c',{feed:[]}))
 m.view.identity({profile:{assistantName:'nova',userName:'',avatar:null,introduced:true},defaultAvatar:''})
 const home=m.all().find(node=>node.textContent==='← 返回主对话')
 assert.ok(home);assert.equal(home.hidden,false)
 assert.equal(m.all().find(node=>node.className==='conversation-title').textContent,'C')
 home.listeners.click();const request=m.sent.at(-1)
 assert.equal(request.method,'conversations.select');assert.deepEqual(request.params,{id:'chat:main'})
 m.view.receive(feedState(2,'chat:main',{feed:[]}))
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{}});await tick()
 assert.equal(home.hidden,true);assert.equal(m.all().find(node=>node.className==='conversation-title').textContent,'主对话')
})


test('published plans preview on the right without taking back a tab the user selected',async()=>{
 const m=mount(),state=revision=>feedState(revision,'c',{feed:[],conversations:{selected_id:'c',items:[{id:'c',title:'Task',mode:'plan',plan:{id:'p',version:1}}],messages:[]}})
 m.view.receive(state(1))
 const right=m.all().find(n=>n.className==='workspace'),left=m.all().find(n=>n.className==='nova-column'),card=()=>m.all().find(n=>n.className==='workbench-plan'),preview=m.all().find(n=>n.className==='chat-preview-plan')
 const tasksTab=m.all().find(n=>n.dataset.page==='tasks')
 assert.equal(right.contains(card()),false,'a published plan must not take back the tab the user selected')
 assert.equal(left.contains(card()),false);assert.equal(preview.hidden,false,'the chat-head entry stays available')
 assert.equal(tasksTab.dataset.plan,'true','Tasks carries a pending-plan indicator instead')
 await preview.listeners.click()
 assert.ok(right.contains(card()));assert.equal(tasksTab.dataset.plan,undefined,'opening the plan clears the indicator')
 const editor=card().children.find(n=>n.tag==='textarea');editor.value='unsaved plan draft'
 selectPage(m,'时间线');m.view.receive(state(2));assert.equal(right.contains(card()),false)
 const panel=m.all().find(n=>n.className==='workbench-page');panel.scrollTop=420
 await preview.listeners.click();assert.ok(right.contains(card()));assert.equal(editor.value,'unsaved plan draft');assert.equal(panel.scrollTop,0)
 await m.all().find(n=>n.textContent==='← 返回任务列表').listeners.click();assert.equal(right.contains(card()),false)
 selectPage(m,'时间线');assert.equal(panel.scrollTop,420,'opening a plan never resets another page position')
 m.view.receive(state(3));assert.equal(right.contains(card()),false)
 await preview.listeners.click();m.view.receive(feedState(4,'chat:main',{feed:[]}));assert.equal(right.contains(card()),false);assert.equal(preview.hidden,true)
})

test('the cold-start chat hides the return-to-main action until a conversation is selected',()=>{
 const m=mount(),home=m.all().find(n=>n.className==='chat-home')
 assert.equal(home.hidden,true,'a null selectedId is not a reason to offer the main conversation')
 m.view.receive(feedState(1,'c',{feed:[]}))
 assert.equal(home.hidden,false)
 m.view.receive(feedState(2,'chat:main',{feed:[]}))
 assert.equal(home.hidden,true)
})

test('each workspace page remembers its own scroll position across tab switches',async()=>{
 const m=mount(),panel=()=>m.all().find(n=>n.className==='workbench-page')
 const open=page=>m.all().find(n=>n.dataset.page===page).listeners.click()
 m.view.receive(feedState(1,'chat:main',{feed:[],life:{todos:[],goals:[]},conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
 await open('timeline');panel().scrollTop=310
 await open('goals');assert.equal(panel().scrollTop,0,'a freshly visited page starts at the top')
 panel().scrollTop=140
 await open('timeline');assert.equal(panel().scrollTop,310,'returning restores the previous offset')
 await open('goals');assert.equal(panel().scrollTop,140)
 await open('ideas');assert.equal(panel().scrollTop,0)
})

test('Build with attached references asks before dropping them and only continues on consent',async()=>{
 const m=mount(),c=m.view.controller
 m.view.receive(feedState(1,'c',{feed:[]}))
 const reference={kind:'todo',id:'t1',version:1}
 c.draft='build this';c.state().execution='build';c.state().references=[reference]
 m.view.refresh()
 const submit=()=>m.all().find(n=>n.className==='composer-submit')
 submit().listeners.click();await tick()
 const dialogs=()=>m.all().filter(n=>n.tag==='dialog')
 assert.equal(dialogs().length,1,'attached references trigger a confirmation before build.begin')
 assert.equal(m.sent.some(f=>f.method==='build.begin'),false)
 const button=dialogs()[0].children.flatMap(function walk(n){return [n,...n.children.flatMap(walk)]}).find(n=>n.textContent==='取消')
 button.listeners.click();await tick()
 assert.equal(c.draft,'build this');assert.deepEqual(c.state().references,[reference],'cancelling keeps the references and sends nothing')
 assert.equal(dialogs().length,0)
 submit().listeners.click();await tick()
 dialogs()[0].children.flatMap(function walk(n){return [n,...n.children.flatMap(walk)]}).find(n=>n.textContent==='继续并新建任务').listeners.click();await tick()
 const begin=m.sent.find(f=>f.type==='personal.command'&&f.method==='build.begin')
 assert.ok(begin,'continuing starts the new Build task')
 assert.equal(begin.params.text,'build this')
 assert.equal(c.state().references.length,1,'a pending host call keeps the chips until it succeeds')
 m.view.receive({type:'personal.result',request_id:begin.request_id,ok:true,data:{}});await tick()
 assert.equal(c.state().references.length,0);assert.equal(c.state().source_todo,null)
})

test('clearing or replacing a conversation drops a stale Build choice so Enter sends text',async()=>{
 const m=mount(),c=m.view.controller
 const state=(revision,generation)=>({type:'personal.state',revision,feed:[],memory:{entries:[]},tasks:[],conversations:{selected_id:'c',voice_id:null,items:[{id:'c',kind:'chat',title:'C',generation}],messages:[]}})
 m.view.receive(state(1,1))
 c.state().execution='build';c.state().workspace={workspace_id:'w1'}
 m.view.refresh()
 assert.equal(m.all().find(n=>n.className==='composer-mode-active').textContent,'Build')
 m.view.receive(state(2,2))
 assert.equal(c.state().execution,undefined,'a host generation change retires the renderer intent')
 assert.equal(c.state().workspace,undefined)
 m.view.refresh()
 assert.equal(m.all().find(n=>n.className==='composer-mode-active').textContent,'Chat')
 const draft=m.all().find(n=>n.attrs['aria-label']==='消息草稿');draft.value='hello';draft.listeners.input()
 m.all().find(n=>n.className==='composer-submit').listeners.click();await tick()
 assert.ok(m.sent.some(f=>f.type==='input.text'&&f.text==='hello'))
 assert.equal(m.sent.some(f=>f.method==='build.begin'),false)
})

test('English covers user labels, generation status, voice ownership and the approval line',async()=>{
 const {setLanguage}=await import('../src/renderer/locale.mjs')
 setLanguage('en')
 try{
  const m=mount()
  const convo=(revision,voice='')=>({type:'personal.state',revision,feed:[],memory:{entries:[]},tasks:[],pending_approvals:[{conversation_id:'c',approval_id:'a1',summary:'Approve run'}],conversations:{selected_id:'c',voice_id:voice||null,items:[{id:'c',kind:'chat',title:'C'}],messages:[{id:'u',conversation_id:'c',role:'user',text:'hi'},{id:'r',conversation_id:'c',role:'assistant',text:'ok',generation_status:'failed'}]}})
  m.view.receive(convo(1))
  assert.ok(m.all().some(n=>n.textContent==='You'),'the user role falls back to a translated label')
  assert.ok(m.all().some(n=>n.textContent==='Reply failed. Send again.'))
  assert.ok(m.all().some(n=>n.textContent==='Handle approval: Approve run'))
  m.view.identity({profile:{assistantName:'Nova',userName:'Alice',avatar:null,introduced:true},defaultAvatar:''})
  assert.ok(m.all().some(n=>n.textContent==='Alice'),'a profile user name labels the user bubble')
  m.view.receive(convo(2,'c'))
  assert.ok(m.all().some(n=>n.textContent==='Voice: C'),'voice ownership names the speaking conversation')
 }finally{setLanguage('zh-CN')}
})

test('a published plan never steals the panel while a task inspector is open',async()=>{
 const m=mount()
 const task={id:'t1',goal:'Task one',conversation_id:'c',phase:'running',controller:{kind:'nova'},control_revision:0,goal_revision:0,session_ids:[],events:{items:[],next:0},capabilities:{},viewer:{client_id:'a'}}
 m.view.receive(feedState(1,'c',{feed:[],tasks:[task],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}))
 const opening=m.view.openTask('t1'),request=m.sent.findLast(frame=>frame.method==='tasks.get')
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:task});await opening
 assert.ok(m.all().some(node=>node.className==='task-detail'))
 m.view.receive(feedState(2,'c',{feed:[],conversations:{selected_id:'c',items:[{id:'c',title:'C',mode:'plan',plan:{id:'p',version:1}}],messages:[]}}))
 assert.ok(m.all().some(node=>node.className==='task-detail'),'the inspector keeps the panel')
 assert.equal(m.all().find(node=>node.dataset.page==='tasks').dataset.plan,'true','the publish is flagged on Tasks instead')
})

const textPresent=(m,text)=>m.all().some(n=>n.textContent===text||n.text===text)
const containsText=(m,text)=>m.all().some(n=>String(n.textContent??n.text??'').includes(text))
const assistantArticles=m=>m.all().filter(n=>typeof n.className==='string'&&n.className.split(' ').includes('message')&&n.className.split(' ').includes('assistant'))

test('the approval dock is the only approval surface and sits directly above the composer',()=>{
 const m=mount({defaultHome:true})
 m.view.receive(feedState(1,'chat:main',{feed:[],pending_approvals:[{approval_id:'a1',conversation_id:'chat:main',summary:'Codex 请求执行一条工作区命令。',queued:false}],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[],home_messages:[]}}))
 const pane=m.all().find(n=>n.id==='chat-pane'),dock=pane.children.findIndex(n=>n.className==='approval-dock'),composer=pane.children.findIndex(n=>n.className==='composer')
 assert.ok(dock>=0,'the dock is mounted');assert.ok(composer>dock,'the dock precedes the composer')
 assert.equal(composer-dock,1,'nothing sits between the dock and the composer')
 assert.equal(pane.children[dock].hidden,false)
})

test('legacy decision and progress notification bubbles stay out of the transcript',()=>{
 const message=(id,text)=>({id,conversation_id:'chat:main',role:'assistant',origin:'proactive',text,created_at:'2026-10-27T10:00:00Z'})
 const snapshot=(revision,pendingApprovals)=>feedState(revision,'chat:main',{feed:[],pending_approvals:pendingApprovals,conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[
  {id:'u1',conversation_id:'chat:main',role:'user',text:'开始吧',created_at:'2026-10-27T09:59:00Z'},
  message('notification:approval','需要你处理\nCodex 请求执行一条工作区命令。\n请在 Nova 中查看并处理。'),
  message('notification:progress','任务进展\n正在运行测试'),
 ],home_messages:[]}})
 const m=mount({defaultHome:true})
 m.view.receive(snapshot(1,[{approval_id:'a1',conversation_id:'chat:main',summary:'Codex 请求执行一条工作区命令。',queued:false}]))
 assert.equal(containsText(m,'请在 Nova 中查看并处理'),false,'the decision duplicate is hidden')
 assert.equal(containsText(m,'正在运行测试'),false,'progress is noise while a decision blocks the task')
 assert.equal(m.all().some(n=>n.className==='approval-dock'&&!n.hidden),true,'the dock is the one decision surface')
 m.view.receive(snapshot(2,[]))
 assert.equal(containsText(m,'正在运行测试'),true,'without a pending decision the progress row is the transcript record')
 assert.equal(containsText(m,'请在 Nova 中查看并处理'),false,'a decided legacy row never comes back')
})

test('captions are ordered by sequence and an older segment retraction cannot erase the newer reply',async()=>{
 const m=mount({defaultHome:true})
 m.view.receive(feedState(1,'chat:main',{feed:[],conversations:{selected_id:'chat:main',items:[{id:'chat:main',kind:'chat'}],messages:[{id:'u1',conversation_id:'chat:main',role:'user',text:'介绍一下',created_at:new Date(Date.now()-5000).toISOString()}],home_messages:[]}}))
 const caption=(sequence,text,{final=false,messageId='assistant:1:r1'}={})=>({type:'caption',role:'assistant',text,full_text:text,conversation_id:'chat:main',turn_id:'t1',message_id:messageId,sequence,final})
 m.view.receive(caption(1,'我先看一下'));
 m.view.receive(caption(2,'',{final:true}));
 await tick()
 assert.equal(textPresent(m,'我先看一下'),false)
 m.view.receive(caption(4,'权威回复',{messageId:'assistant:1:r2'}))
 await tick()
 assert.equal(textPresent(m,'权威回复'),true)
 m.view.receive(caption(3,'',{final:true}))
 await tick()
 assert.equal(textPresent(m,'权威回复'),true,'a late retraction of the retired segment leaves the newer segment alone')
 m.view.receive(caption(2,'迟到的预览'))
 await tick()
 assert.equal(textPresent(m,'权威回复'),true,'a delayed delta cannot regress the visible text')
 assert.equal(textPresent(m,'迟到的预览'),false)
})

test('a persisted reply shorter than the streamed caption keeps the caption text in one bubble',async()=>{
 const m=mount({defaultHome:true})
 const at=ms=>new Date(Date.now()-10000+ms).toISOString()
 const user={id:'u1',conversation_id:'chat:main',role:'user',text:'介绍一下',created_at:at(0)}
 const snapshot=(revision,assistant)=>({type:'personal.state',revision,feed:[],memory:{entries:[]},tasks:[],conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main',kind:'chat'}],messages:[user,...(assistant?[assistant]:[])],home_messages:[]}})
 m.view.receive(snapshot(1))
 const full='第一段先说清楚。第二段给出结果。'
 m.view.receive({type:'caption',role:'assistant',text:full.slice(-8),full_text:full,conversation_id:'chat:main',turn_id:'t1',sequence:2,final:false})
 await tick()
 assert.equal(textPresent(m,full),true)
 m.view.receive(snapshot(2,{id:'a1',conversation_id:'chat:main',role:'assistant',text:'第二段给出结果。',turn_id:'t1',created_at:at(9000)}))
 await tick()
 assert.equal(textPresent(m,full),true,'the persisted row borrows the longer caption text')
 assert.equal(textPresent(m,'第二段给出结果。'),false)
 assert.equal(assistantArticles(m).length,1,'the turn renders as exactly one assistant bubble')
})

test('a pending approval without a task stays reachable from the orb',async()=>{
 const m=mount({applyPresentation:async()=>{}}),c=m.view.controller
 try{
  let request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'workbench'}});await tick()
  m.view.receive(feedState(1,'c',{feed:[],pending_approvals:[{approval_id:'a1',conversation_id:'c',summary:'Run'}],conversations:{selected_id:'c',items:[{id:'c',kind:'chat',title:'C'}],messages:[]}}))
  const pill=()=>m.all().find(n=>n.className==='personal-orb-task')
  assert.equal(pill().hidden,false,'the orb pill surfaces a decision that has no task detail page')
  assert.match(pill().textContent,/Run/)
  m.all().find(n=>n.title==='收起 · 收起为悬浮球').listeners.click()
  request=m.sent.findLast(f=>f.method==='presentation.set');m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{mode:'orb'}});await tick()
  assert.equal(c.presentationMode,'orb');assert.equal(pill().hidden,false)
  pill().listeners.click();await tick()
  const present=m.sent.findLast(f=>f.method==='presentation.set')
  assert.equal(present.params.mode,'workbench','the orb fallback opens the workbench where the dock answers the approval')
  m.view.receive({type:'personal.result',request_id:present.request_id,ok:true,data:{mode:'workbench'}});await tick();await tick()
  assert.equal(c.presentationMode,'workbench')
  assert.equal(m.all().some(n=>n.className==='approval-dock'&&!n.hidden),true)
 }finally{c.disconnect();await tick()}
})

test('the workbench waiting list sends a taskless approval to the dock instead of the orb',async()=>{
 const m=mount(),c=m.view.controller
 try{
  m.view.receive(feedState(1,'c',{feed:[],pending_approvals:[{approval_id:'a1',conversation_id:'other',summary:'Run'}],conversations:{selected_id:'c',items:[{id:'c',kind:'chat'},{id:'other',kind:'chat'}],messages:[]}}))
  const waiting=m.all().find(n=>n.textContent==='处理审批：Run')
  assert.ok(waiting,'the workbench lists the pending decision')
  waiting.listeners.click();await tick()
  const select=m.sent.findLast(f=>f.method==='conversations.select')
  assert.equal(select?.params?.id,'other','the owning conversation is selected so its dock can show the approval')
  m.view.receive({type:'personal.result',request_id:select.request_id,ok:true,data:{selected_id:'other',items:[{id:'c',kind:'chat'},{id:'other',kind:'chat'}]}});await tick()
  const present=m.sent.findLast(f=>f.method==='presentation.set')
  assert.equal(present.params.mode,'workbench','a decision must never hand off to the orb HUD')
  m.view.receive({type:'personal.result',request_id:present.request_id,ok:true,data:{mode:'workbench'}});await tick()
 }finally{c.disconnect();await tick()}
})

const traceState=(revision,messages)=>({type:'personal.state',revision,feed:[],memory:{entries:[]},tasks:[],conversations:{selected_id:'chat:main',voice_id:null,items:[{id:'chat:main',kind:'chat'}],messages,home_messages:[]}})
const traceNodes=m=>m.all().filter(n=>n.className?.split(' ').includes('chat-tool-trace'))

test('a persisted tool trace renders as one collapsed card under its assistant turn',()=>{
 setLanguage('en')
 const m=mount({defaultHome:true})
 try{
  m.view.receive(traceState(1,[
   {id:'u1',conversation_id:'chat:main',role:'user',text:'查一下我的安排',created_at:'2026-10-28T10:00:00Z'},
   {id:'a1',conversation_id:'chat:main',role:'assistant',turn_id:'t1',text:'找到了两件事。',created_at:'2026-10-28T10:00:02Z',tool_trace:[
    {name:'memory__recall',state:'ok',summary:'2 matching facts',args:{query:'secret query'},result:'raw result'},
    {name:'search__search',state:'error',summary:'offline'},
   ]},
  ]))
  const cards=traceNodes(m)
  assert.equal(cards.length,1,'one card per assistant turn')
  const card=cards[0]
  assert.equal(card.tag,'details')
  assert.equal(card.open,false,'the trace starts collapsed')
  assert.equal(card.dataset.state,'error','an error stays visible in the aggregate dot')
  assert.equal(card.dataset.live,'false')
  const summary=card.children[0]
  assert.equal(summary.children[0].className,'chat-tool-trace-dot')
  assert.equal(summary.children[0].dataset.state,'error')
  assert.equal(summary.children[1].textContent,'Tool calls · 2')
  const rows=card.children[1].children
  assert.equal(rows.length,2)
  assert.equal(rows[0].dataset.state,'ok')
  assert.equal(rows[0].children[1].textContent,'Search memory')
  assert.equal(rows[0].children[2].textContent,'2 matching facts')
  assert.equal(rows[1].children[1].textContent,'Web search')
  assert.equal(rows[1].children[2].textContent,'offline')
  const text=m.all().map(n=>n.textContent??'').join('\n')
  assert.doesNotMatch(text,/secret query|raw result/,'arguments and results never render')
  const article=m.all().find(n=>n.dataset.messageId==='a1')
  const body=article.children.find(n=>n.className==='message-body')
  assert.equal(body.children.at(-1),card,'the card sits under the reply text, not in the header')
  const ids=m.all().filter(n=>n.dataset.messageId==='u1'||n.dataset.messageId==='a1').map(n=>n.dataset.messageId)
  assert.deepEqual(ids,['u1','a1'],'existing message order is preserved')
 }finally{setLanguage('zh-CN')}
})

test('live conversation.tool frames update one card per turn and retire when the reply is persisted',async()=>{
 const m=mount({defaultHome:true})
 const user={id:'u1',conversation_id:'chat:main',role:'user',text:'查一下我的安排',created_at:'2026-10-28T10:00:00Z'}
 m.view.receive(traceState(1,[user]))
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'memory__recall',state:'running',summary:'检索中',args:{query:'secret query'}})
 await tick()
 let cards=traceNodes(m)
 assert.equal(cards.length,1,'retrieval shows before the first caption arrives')
 assert.equal(cards[0].dataset.live,'true')
 assert.equal(cards[0].dataset.state,'running')
 assert.equal(cards[0].open,false)
 assert.equal(cards[0].children[1].children.length,1)
 const liveTurn=m.all().find(n=>typeof n.className==='string'&&n.className.includes('message-tool-trace-live'))
 assert.ok(liveTurn,'the live trace opens its own assistant turn')
 assert.doesNotMatch(m.all().map(n=>n.textContent??'').join('\n'),/secret query/,'frame extras never render')
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'memory__recall',state:'ok',summary:'找到 2 条'})
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1)
 assert.equal(cards[0].dataset.state,'ok')
 assert.equal(cards[0].children[1].children.length,1,'the same tool updates in place instead of duplicating')
 assert.equal(cards[0].children[1].children[0].children[2].textContent,'找到 2 条')
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'search__search',state:'running'})
 await tick()
 cards=traceNodes(m)
 assert.equal(cards[0].children[1].children.length,2,'a second tool appends')
 assert.equal(cards[0].children[0].children[1].textContent,'工具调用 · 2')
 assert.equal(cards[0].dataset.state,'running','running outranks the finished call until it settles')
 for(const frame of [
  {type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'',state:'ok'},
  {type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'memory__recall',state:'unknown'},
  {type:'conversation.tool',conversation_id:'chat:main',turn_id:'',name:'memory__recall',state:'ok'},
 ])m.view.receive(frame)
 await tick()
 assert.equal(traceNodes(m)[0].children[1].children.length,2,'malformed frames are ignored')
 m.view.receive(traceState(2,[user,{id:'a1',conversation_id:'chat:main',role:'assistant',turn_id:'t1',text:'找到了两件事。',created_at:'2026-10-28T10:00:02Z',tool_trace:[
  {name:'memory__recall',state:'ok',summary:'找到 2 条'},
  {name:'search__search',state:'ok',summary:'2 results'},
 ]}]))
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1,'the durable reply replaces the live card instead of stacking on it')
 assert.equal(cards[0].dataset.live,'false')
 assert.equal(cards[0].dataset.state,'ok')
 assert.equal(m.all().some(n=>typeof n.className==='string'&&n.className.includes('message-tool-trace-live')),false)
})

test('a live tool trace rides with its streamed caption instead of opening a second bubble',async()=>{
 const m=mount({defaultHome:true})
 const user={id:'u1',conversation_id:'chat:main',role:'user',text:'查一下我的安排',created_at:'2026-10-28T10:00:00Z'}
 m.view.receive(traceState(1,[user]))
 m.view.receive({type:'caption',role:'assistant',text:'我查一下。',full_text:'我查一下。',conversation_id:'chat:main',turn_id:'t1',final:false})
 await tick()
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'memory__recall',state:'running',summary:'检索中'})
 await tick()
 let cards=traceNodes(m)
 assert.equal(cards.length,1)
 assert.equal(m.all().some(n=>typeof n.className==='string'&&n.className.includes('message-tool-trace-live')),false,'the turn already has a caption bubble')
 const bubble=m.all().find(n=>n!==cards[0]&&typeof n.className==='string'&&n.className.split(' ').includes('assistant')&&n.contains(cards[0]))
 assert.ok(bubble,'the card sits inside the streaming reply bubble')
 assert.ok(m.all().some(n=>String(n.textContent??'').includes('我查一下')||String(n.text??'').includes('我查一下')),'the swept caption is still the same bubble')
 m.view.receive(traceState(2,[user,{id:'a1',conversation_id:'chat:main',role:'assistant',turn_id:'t1',text:'我查一下。找到了两件事。',created_at:'2026-10-28T10:00:02Z',tool_trace:[{name:'memory__recall',state:'ok',summary:'找到 2 条'}]}]))
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1,'the persisted reply owns the turn; the caption and its live card retire together')
 assert.equal(cards[0].dataset.live,'false')
 assert.equal(m.all().some(n=>n.textContent==='我查一下。'||n.text==='我查一下。'),false,'the merged persisted text replaced the caption')
 assert.ok(m.all().some(n=>String(n.text??'').includes('找到了两件事')),'the merged persisted reply is rendered')
})

test('a tool frame that arrives before its turn id is adopted by the turn instead of vanishing',async()=>{
 const m=mount({defaultHome:true})
 const user={id:'u1',conversation_id:'chat:main',role:'user',text:'查一下我的安排',created_at:'2026-10-28T10:00:00Z'}
 m.view.receive(traceState(1,[user]))
 // The runtime reports retrieval before the turn has streamed a caption, so no turn_id is available yet.
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',name:'memory__recall',state:'running',summary:'检索中'})
 await tick()
 let cards=traceNodes(m)
 assert.equal(cards.length,1)
 assert.equal(cards[0].dataset.state,'running')
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',name:'memory__recall',state:'ok',summary:'找到 2 条'})
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1,'a completion without a turn id updates the same row')
 assert.equal(cards[0].children[1].children.length,1)
 m.view.receive({type:'caption',role:'assistant',text:'我查一下。',full_text:'我查一下。',conversation_id:'chat:main',turn_id:'t1',final:false})
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1,'the announced turn adopts the anonymous card')
 assert.equal(m.all().some(n=>typeof n.className==='string'&&n.className.includes('message-tool-trace-live')),false)
 assert.equal(cards[0].children[1].children[0].children[1].textContent,'检索记忆')
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',name:'memory__recall',state:'ok',summary:'找到 3 条'})
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1)
 assert.equal(cards[0].children[1].children[0].children[2].textContent,'找到 3 条','a late anonymous update still finds the adopted turn')
 m.view.receive(traceState(2,[user,{id:'a1',conversation_id:'chat:main',role:'assistant',turn_id:'t1',text:'我查一下。找到了两件事。',created_at:'2026-10-28T10:00:02Z',tool_trace:[{name:'memory__recall',state:'ok',summary:'找到 3 条'}]}]))
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1,'the durable reply takes over without a ghost card')
 assert.equal(cards[0].dataset.live,'false')
})


test('a no-summary trace stays static through live captions and persisted replies',async()=>{
 const m=mount({defaultHome:true})
 const user={id:'u1',conversation_id:'chat:main',role:'user',text:'记住称呼',created_at:'2026-10-28T10:00:00Z'}
 m.view.receive(traceState(1,[user]))
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'memory__remember',state:'running'})
 await tick()
 let cards=traceNodes(m)
 assert.equal(cards.length,1)
 assert.equal(cards[0].tag,'div')
 assert.equal(cards[0].dataset.live,'true')
 assert.equal(cards[0].children[1].textContent,'更新记忆')
 m.view.receive({type:'caption',role:'assistant',text:'好。',full_text:'好。',conversation_id:'chat:main',turn_id:'t1',final:false})
 await tick()
 assert.equal(traceNodes(m).length,1)
 assert.equal(traceNodes(m)[0].tag,'div')
 m.view.receive({type:'conversation.tool',conversation_id:'chat:main',turn_id:'t1',name:'memory__remember',state:'ok',summary:'已保存 · 称呼'})
 await tick()
 assert.equal(traceNodes(m)[0].tag,'details','a receipt makes the trace expandable')
 m.view.receive(traceState(2,[user,{id:'a1',conversation_id:'chat:main',role:'assistant',turn_id:'t1',text:'好。',created_at:'2026-10-28T10:00:02Z',tool_trace:[{name:'memory__remember',state:'ok'}]}]))
 await tick()
 cards=traceNodes(m)
 assert.equal(cards.length,1)
 assert.equal(cards[0].tag,'div')
 assert.equal(cards[0].dataset.live,'false')
 assert.equal(cards[0].dataset.state,'ok')
})
