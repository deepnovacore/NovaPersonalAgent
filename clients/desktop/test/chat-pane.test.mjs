import test from 'node:test'
import assert from 'node:assert/strict'
import {mountPersonalView} from '../src/renderer/personal-view.mjs'
class Node{
 constructor(tag,text){this.tag=tag;this.tagName=tag.toUpperCase();this.text=text;this.children=[];this.listeners={};this.dataset={};this.classList={add:()=>{}};this.attrs={};this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100}
 append(...c){this.children.push(...c)}prepend(...c){this.children.unshift(...c)}replaceChildren(...c){this.children=c}setAttribute(k,v){this[k]=v;this.attrs[k]=v}getAttribute(k){return this.attrs[k]}addEventListener(n,f){this.listeners[n]=f}
 querySelectorAll(sel){const tags=sel.split(',');return this.children.flatMap(n=>[...(tags.includes(n.tag)?[n]:[]),...n.querySelectorAll(sel)])}querySelector(sel){return this.querySelectorAll(sel)[0]}focus(){this.focused=(this.focused??0)+1;document.activeElement=this}contains(node){return this===node||this.children.some(child=>child.contains?.(node))}
 get childElementCount(){return this.children.length}
}
function mount(){
 const body=new Node('body'),shell=new Node('div');body.append(shell);const sent=[]
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const view=mountPersonalView({send:frame=>(sent.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>({tasks:[]}),taskAction(){},results:()=>[],openResults(){},api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{}}}})
 view.controller.connect();view.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input']})
 const all=n=>[n,...n.children.flatMap(all)]
 return {body,sent,view,all:()=>all(body),receipts:()=>sent.filter(f=>f.type==='personal.command'&&f.method==='feed.action'&&f.params.action==='presented').map(f=>f.params.id)}
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
test('suggestion body is an accessible control and remains expanded after a snapshot refresh',()=>{
 const m=mount();const context={cards:[{id:'s1',tab:'todos',title:'Review',body:'A long recommendation '.repeat(30),refs:[]}],status:'ready'}
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
test('a personal todo with a long note can expand its four-line body',()=>{
 const m=mount();m.view.receive(feedState(1,'c',{sources:[{id:'local'}],life:{todos:[{id:'todo1',title:'Prepare',note:'Detailed note '.repeat(30),status:'open',version:1}],ideas:[],goals:[]}}))
 const note=m.all().find(n=>n.className==='card-body'&&n.dataset.cardBodyId==='life:todo:todo1')
 assert.equal(note?.tag,'button')
 note.listeners.click()
 assert.equal(note.attrs['aria-expanded'],'true')
})
test('asking for task progress through a feed opens the chat pane', async()=>{
 const state={tasks:[{work_id:'w1',title:'修复',phase:'working',project:'p',executor:'codex',summary:''}]}
 const body=new Node('body'),shell=new Node('div');body.append(shell);const sent=[]
 globalThis.window={addEventListener(){}};globalThis.document={addEventListener(){},body,visibilityState:'visible',hasFocus:()=>true,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>new Node('#text',text),querySelector:()=>shell}
 const v=mountPersonalView({send:frame=>(sent.push(frame),true),start:async()=>{},stop:async()=>{},tasks:()=>state,taskAction(){},results:()=>[],openResults(){},api:{orbMenu:{},personal:{setUnread(){},openArticle:async()=>{}}}})
 v.controller.connect();v.receive({type:'client.ready',input_instance_id:'i',capabilities:['text_input']})
 const all=()=>[body].flatMap(function walk(n){return [n,...n.children.flatMap(walk)]})
 const s=feedState(1,'c');s.feed[0].task_ref={work_id:'w1'};v.receive(s)
 await all().find(n=>n.className==='chat-toggle').listeners.click();assert.equal(all().find(n=>n.id==='chat-pane').hidden,true)
 all().find(n=>n.className==='rail-item'&&n.children.some(c=>c.className==='rail-label'&&c.textContent==='任务')).listeners.click()
 const ask=all().find(n=>n.tag==='button'&&n.textContent==='询问任务进展');assert.ok(ask,'task page shows the progress action')
 const pending=ask.listeners.click();const req=sent.findLast(f=>f.method==='conversations.open_feed');assert.ok(req)
 v.receive({type:'personal.result',request_id:req.request_id,ok:true,data:{}});await pending
 assert.equal(all().find(n=>n.id==='chat-pane').hidden,false,'pane revealed after the feed conversation opens')
})

test('hidden or unfocused windows defer presented receipts until visible and focused',()=>{
 const m=mount();document.visibilityState='hidden';m.view.receive(feedState(1));assert.deepEqual(m.receipts(),[])
 document.visibilityState='visible';document.hasFocus=()=>false;m.view.refresh();assert.deepEqual(m.receipts(),[])
 document.hasFocus=()=>true;m.view.refresh();assert.deepEqual(m.receipts(),['f1'])
})
