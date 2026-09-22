import test,{afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'
class Node{
 constructor(tag,text){this.tag=tag;this.tagName=tag.toUpperCase();this.text=text;this.children=[];this.listeners={};this.dataset={};this.classList={add:()=>{}};this.attrs={};this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100}
 append(...c){for(const n of c)n.parentElement=this;this.children.push(...c)}prepend(...c){for(const n of c)n.parentElement=this;this.children.unshift(...c)}replaceChildren(...c){this.children=[];this.append(...c)}setAttribute(k,v){this[k]=v;this.attrs[k]=v}addEventListener(n,f){this.listeners[n]=f}
 querySelectorAll(sel){const tags=sel.split(',');return this.children.flatMap(n=>[...(tags.includes(n.tag)?[n]:[]),...n.querySelectorAll(sel)])}querySelector(sel){return this.querySelectorAll(sel)[0]}focus(){this.focused=(this.focused??0)+1;document.activeElement=this}contains(node){return this===node||this.children.some(child=>child.contains(node))}
 dispatchEvent(event){this.listeners[event.type]?.(event);if(event.bubbles)this.parentElement?.dispatchEvent(event)}
 get childElementCount(){return this.children.length}
}
const controllers=[]
afterEach(async()=>{for(const c of controllers.splice(0))c.disconnect();await new Promise(resolve=>setImmediate(resolve))})
function mount(){
 const body=new Node('body'),shell=new Node('div');body.append(shell);const sent=[],callbacks={}
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const view=mountPersonalView({send:frame=>(sent.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],openResults(){},api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{},onPresentationRequest:fn=>{callbacks.presentation=fn},onCollapsed:fn=>{callbacks.collapsed=fn}}}})
 controllers.push(view.controller);view.controller.connect();view.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input']})
 const all=n=>[n,...n.children.flatMap(all)]
 return {body,sent,view,callbacks,all:()=>all(body),receipts:()=>sent.filter(f=>f.type==='personal.command'&&f.method==='feed.action'&&f.params.action==='presented').map(f=>f.params.id)}
}
const feedState=(revision,selected='chat:proactive',extra={})=>({type:'personal.state',revision,memory:{entries:[]},feed:[{id:'f1',kind:'suggestion',title:'T',why_now:'W',lifecycle:'active',user_state:'new',task_ref:null,delivery:{presented_at:null},prepared:{text:'## 前瞻\n- 一条',trust:'untrusted_external',evidence_refs:[]}}],conversations:{selected_id:selected,voice_id:null,unread_count:1,items:[{id:'chat:proactive',kind:'proactive',title:'主动提醒',unread_count:1},{id:'c',kind:'chat',title:'C'}],messages:[{id:'feed:f1',conversation_id:'chat:proactive',role:'assistant',text:'T\n## 前瞻\n- 一条'}]},...extra})
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
test('durable cards browse a persistent central detail through snapshots, executor frames, and focusout',async()=>{
 const m=mount(),task={id:'t1',goal:'Task one',conversation_id:'c',phase:'running',controller:{kind:'nova'},control_revision:0,goal_revision:0,session_ids:['s1'],events:{items:[]},capabilities:{input:true},viewer:{client_id:'a',can_takeover:true}}
 m.view.receive(feedState(1,'c',{feed:[],tasks:[task,{...task,id:'t2',goal:'Task two'}],conversations:{selected_id:'c',items:[{id:'c',title:'C'}],messages:[]}}))
 const cards=m.all().filter(n=>n.className==='task-card');assert.equal(cards.length,2)
 cards[0].focus();const opening=cards[0].listeners.click(),req=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:req.request_id,ok:true,data:task});await opening
 assert.equal(document.activeElement.textContent,'返回任务卡片');document.activeElement.dispatchEvent({type:'keydown',key:'Escape',bubbles:true,preventDefault(){}});assert.equal(document.activeElement,cards[0]);const reopened=cards[0].listeners.click(),again=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:again.request_id,ok:true,data:task});await reopened
 const draft=m.all().find(n=>n['aria-label']==='回复执行器'),panel=m.all().find(n=>n.className==='workbench-page');draft.value='keep';draft.focus();panel.scrollTop=88
 assert.equal(m.sent.some(f=>f.method==='tasks.control'),false)
 m.view.receive({type:'executor.tasks',tasks:[]});assert.ok(m.all().includes(draft));assert.equal(panel.scrollTop,88)
 m.view.receive({...m.view.controller.snapshot,revision:2,tasks:[{...task,phase:'waiting'}]});const refresh=m.sent.findLast(f=>f.method==='tasks.get');m.view.receive({type:'personal.result',request_id:refresh.request_id,ok:true,data:{...task,phase:'waiting'}});await new Promise(r=>setImmediate(r));assert.ok(m.all().includes(draft))
 const nova=m.all().find(n=>n['aria-label']==='消息草稿');nova.focus();panel.listeners.focusout();await new Promise(r=>setTimeout(r,1));assert.ok(m.all().includes(draft));assert.equal(draft.value,'keep')
 nova.value='Ask Nova';nova.listeners.input();await nova.listeners.keydown({key:'Enter',preventDefault(){}});assert.ok(m.sent.some(f=>f.type==='input.text'&&f.text==='Ask Nova'));assert.equal(m.sent.some(f=>f.method==='tasks.input'),false)
 m.all().find(n=>n.className==='task-detail').listeners.keydown({key:'Escape',preventDefault(){}});assert.equal(document.activeElement,cards[0]);assert.equal(m.sent.some(f=>f.method==='tasks.control'),false)
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
 m.view.controller.presentationMode='workbench';const again=m.view.openTask('late'),request=m.sent.at(-1);assert.equal(request.params.after,0)
 m.view.receive({type:'personal.result',request_id:request.request_id,ok:true,data:{id:'late',goal:'Late result',phase:'completed',controller:{kind:'nova'},events:{items:[],next:9}}});await again
})
