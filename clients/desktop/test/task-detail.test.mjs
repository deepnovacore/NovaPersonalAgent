import test from 'node:test'
import assert from 'node:assert/strict'
import {mountTaskDetail,taskDraftKey} from '../src/renderer/task-detail.mjs'
class Node {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.dataset={};this.scrollTop=0}
 append(...nodes){this.children.push(...nodes)} replaceChildren(...nodes){this.children=nodes} setAttribute(k,v){this[k]=v} addEventListener(k,f){this.listeners[k]=f} removeEventListener(k){delete this.listeners[k]} focus(){document.activeElement=this}
}
const task=(overrides={})=>({id:'t',goal:'Fix login',phase:'running',control_revision:0,goal_revision:0,controller:{kind:'nova'},session_ids:['s1','s2'],events:{items:[]},artifact_refs:[],approvals:[],input_receipts:[],viewer:{client_id:'client',can_takeover:true},capabilities:{detail:'conversation',input:true},...overrides})
function mount(command=async()=>{}){globalThis.document={createElement:tag=>new Node(tag)};const root=new Node('div'),data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};const calls=[];const view=mountTaskDetail(root,{command:(...args)=>{calls.push(args);return command(...args)},storage,onClose:()=>{}});const all=()=>[root].flatMap(function walk(n){return [n,...n.children.flatMap(walk)]});return {root,view,calls,all,storage,find:label=>all().find(n=>n['aria-label']===label||n.textContent===label)}}
test('draft keys isolate trusted clients and exact task sessions',()=>{assert.notEqual(taskDraftKey('a','t','s1'),taskDraftKey('a','t','s2'));assert.notEqual(taskDraftKey('a','t','s1'),taskDraftKey('b','t','s1'))})
test('browsing is inert; receipt enables explicit executor composer, with stable draft and scroll',async()=>{
 let resolve;const m=mount(method=>method==='tasks.get'?Promise.resolve(task({controller:{kind:'user',client_id:'client'},control_revision:1})):new Promise(r=>{resolve=r}));m.view.update(task());assert.deepEqual(m.calls,[])
 const draft=m.find('回复执行器'),select=m.find('执行器会话');assert.equal(draft.disabled,true)
 const takeover=m.find('接管并回复').listeners.click();assert.equal(draft.disabled,true)
 resolve(task({controller:{kind:'user',client_id:'client'},control_revision:1}));await takeover;assert.equal(draft.disabled,false)
 draft.value='first';draft.listeners.input();m.root.scrollTop=57;m.view.update(task({controller:{kind:'user',client_id:'client'},control_revision:1,events:{items:[{seq:1,text:'<img onerror=alert(1)>',sender:'executor',kind:'message'}]}}));assert.equal(m.find('回复执行器'),draft);assert.equal(m.root.scrollTop,57);assert.equal(draft.value,'first');assert.ok(m.all().some(n=>n.textContent==='<img onerror=alert(1)>'))
 select.value='s2';select.listeners.change();assert.equal(draft.value,'');draft.value='second';draft.listeners.input();select.value='s1';select.listeners.change();assert.equal(draft.value,'first');assert.equal(m.calls.filter(([method])=>method!=='tasks.get').length,1)
})
test('unknown input retains exact draft and blocks retry; accepted receipt alone clears it',async()=>{
 let mode='unknown';const m=mount(async(method)=>{if(method==='tasks.input'){if(mode==='unknown')throw Error('task_input_unknown');return {status:'accepted'}}return task({controller:{kind:'user',client_id:'client'},control_revision:1})});m.view.update(task({controller:{kind:'user',client_id:'client'},control_revision:1}));const draft=m.find('回复执行器');draft.value='keep';draft.listeners.input();await m.find('发送给执行器').listeners.click();assert.equal(draft.value,'keep');assert.equal(m.find('发送给执行器').disabled,true)
})
test('unsupported detail preserves summary and disallows input; Escape closes without returning control',()=>{const m=mount();m.view.update(task({capabilities:{detail:'summary-only',input:false}}));assert.equal(m.find('回复执行器').disabled,true);assert.ok(m.all().some(n=>n.textContent?.includes('仅提供任务摘要')));m.root.listeners.keydown({key:'Escape',preventDefault(){}});assert.deepEqual(m.calls,[])})

test('only exact accepted input receipt clears pending draft, and stale errors retain text',async()=>{
 const owned=task({controller:{kind:'user',client_id:'client'},control_revision:1});let stale=false
 const m=mount(async method=>{if(method==='tasks.input')throw Object.assign(Error(stale?'stale_task':'task_input_unknown'),{input_status:stale?'failed':'unknown'});return owned});m.view.update(owned)
 const draft=m.find('回复执行器');draft.value='exact';draft.listeners.input();await m.find('发送给执行器').listeners.click();const request=m.calls.find(([method])=>method==='tasks.input')[2].request_id
 m.view.update({...owned,input_receipt:{request_id:'other',status:'accepted'}});assert.equal(draft.value,'exact');assert.equal(draft.disabled,true)
 m.view.update({...owned,input_receipt:{request_id:request,status:'accepted'}});assert.equal(draft.value,'');assert.equal(draft.disabled,false)
 stale=true;draft.value='retain stale';draft.listeners.input();await m.find('发送给执行器').listeners.click();assert.equal(draft.value,'retain stale');assert.equal(draft.disabled,false)
})

test('accepted adapter input followed by unclassified status persistence error retains exact pending request',async()=>{
 const owned=task({controller:{kind:'user',client_id:'client'},control_revision:1});let writes=0
 const m=mount(async method=>{if(method==='tasks.input'){writes++;throw Error('EIO: status rename failed')}return owned});m.view.update(owned)
 const draft=m.find('回复执行器');draft.value='sent once';draft.listeners.input();await m.find('发送给执行器').listeners.click()
 const request=m.calls.find(([method])=>method==='tasks.input')[2].request_id
 assert.equal(draft.disabled,true);assert.equal(JSON.parse(m.storage.getItem(taskDraftKey('client','t','s1'))).pending.request_id,request)
 await m.find('发送给执行器').listeners.click();assert.equal(writes,1);assert.ok(m.calls.some(([method,params])=>method==='tasks.get'&&params.input_request_id===request))
 m.view.update({...owned,input_receipt:{request_id:request,status:'accepted'}});assert.equal(draft.value,'')
})

test('single-panel task inspection uses the same breakpoint as the chat overlay drawer',async()=>{
 const {readFile}=await import('node:fs/promises'),css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
 const drawer=css.match(/@media\s*\(max-width:\s*(\d+)px\)\{[\s\S]*?\.chat-pane\{position:absolute/)[1]
 const detail=css.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.workbench\[data-task-detail/)[1]
 assert.equal(detail,drawer);assert.ok(Number(detail)>=959)
})

test('event refresh uses the exact received cursor and retains preceding public events',async()=>{
 const m=mount(async()=>task({events:{items:[{seq:9,text:'New result'}],next:9}}))
 m.view.update(task({events:{items:[{seq:7,text:'Viewed result'}],next:7}}));m.view.receive({type:'personal.state',tasks:[]});await new Promise(r=>setImmediate(r))
 assert.equal(m.calls.at(-1)[1].after,7)
 assert.ok(m.all().some(n=>n.textContent==='Viewed result'));assert.ok(m.all().some(n=>n.textContent==='New result'))
})

test('missing and truncated public history remains visibly incomplete after incremental refresh',()=>{
 const m=mount();m.view.update(task({events:{items:[],next:4,incomplete:true,truncated:true}}));assert.ok(m.all().some(n=>n.textContent==='部分公开活动缺失，请核对执行器与任务结果。'))
 m.view.update(task({events:{items:[],next:4,incomplete:false,truncated:false}}));assert.ok(m.all().some(n=>n.textContent==='部分公开活动缺失，请核对执行器与任务结果。'));assert.ok(m.all().some(n=>n.textContent?.includes('较早活动已截断')))
})
